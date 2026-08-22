// Bootstraps just enough data to exercise Core Auth end-to-end locally:
// one demo tenant, one demo TenantUser ("Admin" role), one demo SystemUser
// ("PlatformAdmin" role), and the two permissions each role needs.
// Run via `pnpm --filter @flexi/backend prisma:seed` (wired through the
// `prisma.seed` config in package.json, so `prisma migrate dev` also runs
// it automatically after applying migrations).
//
// Idempotent: safe to re-run against an already-seeded database (uses
// upsert throughout).

import { PrismaClient } from '@prisma/client';
import { SYSTEM_TENANTS_ONBOARD_PERMISSION } from '@flexi/shared-types';
import * as bcrypt from 'bcryptjs';


const DEMO_TENANT_SLUG = 'demo';
const DEMO_TENANT_ADMIN_EMAIL = 'admin@demo.local';
const DEMO_TENANT_ADMIN_PASSWORD = 'Demo123!';
const DEMO_SYSTEM_ADMIN_EMAIL = 'super@flexi.local';
const DEMO_SYSTEM_ADMIN_PASSWORD = 'Super123!';

const TENANT_ME_PERMISSION = 'auth.me.read';
const SYSTEM_ME_PERMISSION = 'system.me.read';

async function main(): Promise<void> {
  // This seed creates accounts with hardcoded, publicly-known passwords and
  // is wired into `prisma migrate dev` -- refuse to run it against a
  // production database.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to run the demo seed script with NODE_ENV=production.',
    );
  }

  const passwordSaltRounds = 10;

  // --- Permissions (global catalog) -----------------------------------
  const authMeReadPermission = await prisma.permission.upsert({
    where: { code: TENANT_ME_PERMISSION },
    update: { scope: 'TENANT' },
    create: {
      code: TENANT_ME_PERMISSION,
      description: 'Read own profile via GET /api/auth/me (TenantUser)',
      scope: 'TENANT',
    },
  });

  const systemMeReadPermission = await prisma.permission.upsert({
    where: { code: SYSTEM_ME_PERMISSION },
    update: { scope: 'SYSTEM' },
    create: {
      code: SYSTEM_ME_PERMISSION,
      description: 'Read own profile via GET /api/auth/me (SystemUser)',
      scope: 'SYSTEM',
    },
  });

  const systemTenantsOnboardPermission = await prisma.permission.upsert({
    where: { code: SYSTEM_TENANTS_ONBOARD_PERMISSION },
    update: { scope: 'SYSTEM' },
    create: {
      code: SYSTEM_TENANTS_ONBOARD_PERMISSION,
      description: 'Start tenant onboarding intake as a SystemUser',
      scope: 'SYSTEM',
    },
  });

  // --- Demo tenant ------------------------------------------------------
  const demoTenant = await prisma.tenant.upsert({
    where: { slug: DEMO_TENANT_SLUG },
    update: {},
    create: { name: 'Demo Tenant', slug: DEMO_TENANT_SLUG },
  });

  // --- Tenant "Admin" role, scoped to the demo tenant --------------------
  const adminRole = await prisma.role.upsert({
    where: { tenantId_name: { tenantId: demoTenant.id, name: 'Admin' } },
    update: {},
    create: {
      tenantId: demoTenant.id,
      name: 'Admin',
      description: 'Demo tenant admin role',
    },
  });

  await assignPermissionToRole(adminRole, authMeReadPermission);

  // --- Demo TenantUser (admin@demo.local) --------------------------------
  const tenantAuthAccount = await findOrCreateAuthAccount(
    DEMO_TENANT_ADMIN_EMAIL,
    DEMO_TENANT_ADMIN_PASSWORD,
    passwordSaltRounds,
    async (email) =>
      prisma.tenantUser.findFirst({
        where: { tenantId: demoTenant.id, authAccount: { email } },
        select: { authAccountId: true },
      }),
  );

  const existingTenantUser = await prisma.tenantUser.findFirst({
    where: { authAccountId: tenantAuthAccount.id },
  });

  if (existingTenantUser) {
    await prisma.tenantUser.update({
      where: { id: existingTenantUser.id },
      data: { roles: { set: [{ id: adminRole.id }] } },
    });
  } else {
    await prisma.tenantUser.create({
      data: {
        tenantId: demoTenant.id,
        authAccountId: tenantAuthAccount.id,
        name: 'Demo Admin',
        roles: { connect: [{ id: adminRole.id }] },
      },
    });
  }

  // --- System "PlatformAdmin" role, not scoped to any tenant -------------
  // A system role has tenantId: null. Postgres treats each NULL as
  // distinct under a unique index, so [tenantId, name] can't dedupe system
  // roles the way it dedupes tenant roles -- find-then-create by hand
  // instead of upsert to keep this idempotent.
  const existingPlatformAdminRole = await prisma.role.findFirst({
    where: { tenantId: null, name: 'PlatformAdmin' },
  });
  const platformAdminRole =
    existingPlatformAdminRole ??
    (await prisma.role.create({
      data: {
        tenantId: null,
        name: 'PlatformAdmin',
        description: 'Demo platform-level Super Admin role',
      },
    }));

  await assignPermissionToRole(platformAdminRole, systemMeReadPermission);
  await assignPermissionToRole(
    platformAdminRole,
    systemTenantsOnboardPermission,
  );

  // --- Demo SystemUser (super@flexi.local) --------------------------------
  const systemAuthAccount = await findOrCreateAuthAccount(
    DEMO_SYSTEM_ADMIN_EMAIL,
    DEMO_SYSTEM_ADMIN_PASSWORD,
    passwordSaltRounds,
    async (email) =>
      prisma.systemUser.findFirst({
        where: { authAccount: { email } },
        select: { authAccountId: true },
      }),
  );

  const existingSystemUser = await prisma.systemUser.findFirst({
    where: { authAccountId: systemAuthAccount.id },
  });

  if (existingSystemUser) {
    await prisma.systemUser.update({
      where: { id: existingSystemUser.id },
      data: { roles: { set: [{ id: platformAdminRole.id }] } },
    });
  } else {
    await prisma.systemUser.create({
      data: {
        authAccountId: systemAuthAccount.id,
        name: 'Demo Super Admin',
        roles: { connect: [{ id: platformAdminRole.id }] },
      },
    });
  }

  console.log('Seed complete:');
  console.log(
    `  Tenant login:  email=${DEMO_TENANT_ADMIN_EMAIL} password=${DEMO_TENANT_ADMIN_PASSWORD} x-tenant-id=${demoTenant.id} (slug: ${demoTenant.slug})`,
  );
  console.log(
    `  System login:  email=${DEMO_SYSTEM_ADMIN_EMAIL} password=${DEMO_SYSTEM_ADMIN_PASSWORD} (no x-tenant-id header)`,
  );
}

/**
 * Creates a RolePermission link, enforcing the one live scope rule the
 * spec requires at every link-creation point: a Role with a tenantId set
 * (a tenant role) can never hold a SYSTEM-scope Permission. This is the
 * only place RolePermission links are created today (no RBAC admin CRUD
 * API exists yet), so this is also the only enforcement point.
 */
async function assignPermissionToRole(
  role: { id: string; tenantId: string | null },
  permission: { id: string; code: string; scope: string },
): Promise<void> {
  if (role.tenantId !== null && permission.scope === 'SYSTEM') {
    throw new Error(
      `Refusing to grant SYSTEM-scope permission "${permission.code}" to ` +
        `tenant role ${role.id}: a tenant role can never hold a SYSTEM permission.`,
    );
  }

  await prisma.rolePermission.upsert({
    where: {
      roleId_permissionId: { roleId: role.id, permissionId: permission.id },
    },
    update: {},
    create: { roleId: role.id, permissionId: permission.id },
  });
}

/**
 * Finds the AuthAccount already backing the given scope's actor (via the
 * supplied lookup), or creates a brand-new AuthAccount + bcrypt hash if
 * none exists yet. Re-running the seed never rotates an existing account's
 * password.
 */
async function findOrCreateAuthAccount(
  email: string,
  password: string,
  saltRounds: number,
  findExistingActorAuthAccountId: (
    email: string,
  ) => Promise<{ authAccountId: string } | null>,
): Promise<{ id: string; email: string }> {
  const existingActor = await findExistingActorAuthAccountId(email);
  if (existingActor) {
    const account = await prisma.authAccount.findUniqueOrThrow({
      where: { id: existingActor.authAccountId },
    });
    return account;
  }

  const passwordHash = await bcrypt.hash(password, saltRounds);
  return prisma.authAccount.create({
    data: { email, passwordHash },
  });
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
