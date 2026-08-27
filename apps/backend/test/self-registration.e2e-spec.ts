import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import {
  AuthAuditEvent,
  SYSTEM_SETTINGS_MANAGE_PERMISSION,
  TENANT_SETTINGS_MANAGE_PERMISSION,
  TENANT_USER_MANAGE_PERMISSION,
  TenantUserStatus,
  USER_ERROR_CODES,
} from '@flexi/shared-types';
import type { AppModule as AppModuleType } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// Raised for the same reason the other e2e files raise it: this suite signs
// in several times, and the module-wide login throttle would otherwise start
// answering 429 partway through. It must be assigned before AppModule is
// evaluated -- ConfigModule/ThrottlerModule read it the moment they load --
// hence the lazy require below rather than a hoisted static import.
//
// It does NOT move the budget for `POST /api/auth/register`, which carries
// its own `@Throttle` (5 per 15 minutes). That limit is handled two
// different ways here: the policy suite overrides ThrottlerGuard away, and
// the rate-limit suite at the bottom keeps the real one and spends the
// budget deliberately.
process.env.AUTH_THROTTLE_LIMIT = '50';
process.env.AUTH_THROTTLE_TTL = '60';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AppModule } = require('../src/app.module') as {
  AppModule: typeof AppModuleType;
};

const PASSWORD = 'E2ePassword123!';
const WEAK_PASSWORD = 'weak';

interface RegisterBody {
  email: string;
  fullName: string;
  password: string;
  confirmPassword: string;
}

function registerBody(email: string): RegisterBody {
  return {
    email,
    fullName: 'E2E Registrant',
    password: PASSWORD,
    confirmPassword: PASSWORD,
  };
}

/**
 * `POST /api/auth/register` and `GET`/`PATCH /api/tenant-settings` against a
 * live database (issue #191).
 *
 * The unit tests already pin the branch logic with a mocked Prisma; what
 * this file is for is everything a mock cannot show: that the routes are
 * mounted where the specification says, that the response envelope and
 * status codes are what a client actually receives, that a registration
 * really lands in `tenant_users` with the right status, role and
 * `isActive`, and that the resulting account can (or cannot) log in.
 *
 * Permission rows are read from the migrated catalog rather than invented,
 * as `dynamic-tables.e2e-spec.ts` does -- if a code this story relies on
 * were missing from the catalog migration, this suite should fail rather
 * than paper over it with a locally-created row.
 */
describe('Self-registration and tenant settings (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const runId = Date.now().toString();
  const adminEmail = `e2e-selfreg-admin-${runId}@example.com`;
  const systemEmail = `e2e-selfreg-system-${runId}@example.com`;

  let tenantId: string;
  let otherTenantId: string;
  let memberRoleId: string;
  let otherTenantRoleId: string;
  let adminAccessToken: string;
  let systemAccessToken: string;
  const createdAuthAccountIds: string[] = [];

  /** Puts the tenant's policy in a known state before a test drives it. */
  async function setPolicy(policy: {
    allowSelfRegistration: boolean;
    allowedEmailDomains?: string[];
    defaultRoleId?: string | null;
    requireApproval?: boolean;
    targetTenantId?: string;
  }): Promise<void> {
    const target = policy.targetTenantId ?? tenantId;
    const data = {
      allowSelfRegistration: policy.allowSelfRegistration,
      allowedEmailDomains: policy.allowedEmailDomains ?? [],
      defaultRoleId:
        policy.defaultRoleId === undefined
          ? memberRoleId
          : policy.defaultRoleId,
      requireApproval: policy.requireApproval ?? false,
    };

    await prisma.tenantSettings.upsert({
      where: { tenantId: target },
      create: { tenantId: target, ...data },
      update: data,
    });
  }

  async function clearPolicy(target = tenantId): Promise<void> {
    await prisma.tenantSettings.deleteMany({ where: { tenantId: target } });
  }

  function register(body: RegisterBody, headerTenantId?: string) {
    const call = request(app.getHttpServer()).post('/api/auth/register');
    if (headerTenantId !== undefined) {
      call.set('x-tenant-id', headerTenantId);
    }
    return call.send(body);
  }

  /** Every account this suite creates, so `afterAll` can remove them. */
  async function trackAccount(email: string): Promise<void> {
    const account = await prisma.authAccount.findFirst({
      where: { email },
      select: { id: true },
    });
    if (account) {
      createdAuthAccountIds.push(account.id);
    }
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Registration is rate-limited to 5 requests per 15 minutes per IP,
      // and every request in this suite comes from the same loopback
      // address. The limiter is real behaviour and is asserted in its own
      // suite below, with an app that keeps the guard; here it is out of
      // the way so the policy branches can each have a request.
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    // Both of these are applied imperatively by main.ts rather than by
    // AppModule's providers, so a test that boots the module has to
    // replicate them. The pipe matters here: without it the DTO's
    // `@IsEmail()`/`@IsNotEmpty()` never run, and a malformed body would
    // reach the service instead of being answered `400`.
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    prisma = app.get(PrismaService);

    const [
      tenantSettingsPermission,
      systemSettingsPermission,
      userManagePermission,
    ] = await Promise.all([
      prisma.permission.findUnique({
        where: { code: TENANT_SETTINGS_MANAGE_PERMISSION },
      }),
      prisma.permission.findUnique({
        where: { code: SYSTEM_SETTINGS_MANAGE_PERMISSION },
      }),
      prisma.permission.findUnique({
        where: { code: TENANT_USER_MANAGE_PERMISSION },
      }),
    ]);

    // From the catalog migration, not from this file.
    expect(tenantSettingsPermission).not.toBeNull();
    expect(systemSettingsPermission).not.toBeNull();
    expect(userManagePermission).not.toBeNull();

    const tenant = await prisma.tenant.create({
      data: {
        name: 'E2E Self-Registration Tenant',
        slug: `e2e-selfreg-${runId}`,
      },
    });
    tenantId = tenant.id;

    const otherTenant = await prisma.tenant.create({
      data: {
        name: 'E2E Self-Registration Other Tenant',
        slug: `e2e-selfreg-other-${runId}`,
      },
    });
    otherTenantId = otherTenant.id;

    // The administrator holds both codes: `tenant.settings.manage` to drive
    // the routes under test, `tenant.user.manage` so the pending-approval
    // notice has somebody to look up.
    const adminRole = await prisma.role.create({
      data: {
        tenantId,
        name: 'E2E Self-Registration Admin',
        rolePermissions: {
          create: [
            { permissionId: tenantSettingsPermission!.id },
            { permissionId: userManagePermission!.id },
          ],
        },
      },
    });

    const memberRole = await prisma.role.create({
      data: { tenantId, name: 'E2E Self-Registration Member' },
    });
    memberRoleId = memberRole.id;

    const otherTenantRole = await prisma.role.create({
      data: { tenantId: otherTenantId, name: 'E2E Other Tenant Role' },
    });
    otherTenantRoleId = otherTenantRole.id;

    const adminAccount = await prisma.authAccount.create({
      data: { email: adminEmail, passwordHash: await bcrypt.hash(PASSWORD, 4) },
    });
    createdAuthAccountIds.push(adminAccount.id);
    await prisma.tenantUser.create({
      data: {
        tenantId,
        authAccountId: adminAccount.id,
        name: 'E2E Tenant Admin',
        roles: { connect: [{ id: adminRole.id }] },
      },
    });

    const systemRole = await prisma.role.create({
      data: {
        name: `E2E Self-Registration System ${runId}`,
        rolePermissions: {
          create: [{ permissionId: systemSettingsPermission!.id }],
        },
      },
    });
    const systemAccount = await prisma.authAccount.create({
      data: {
        email: systemEmail,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
      },
    });
    createdAuthAccountIds.push(systemAccount.id);
    await prisma.systemUser.create({
      data: {
        authAccountId: systemAccount.id,
        name: 'E2E System Admin',
        roles: { connect: [{ id: systemRole.id }] },
      },
    });

    // Real logins rather than hand-minted tokens: the header convention
    // (`x-tenant-id` present -> tenant actor, absent -> system actor) is
    // part of what this file is here to exercise.
    const tenantLogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('x-tenant-id', tenantId)
      .send({ email: adminEmail, password: PASSWORD })
      .expect(200);
    adminAccessToken = (tenantLogin.body.data as { accessToken: string })
      .accessToken;

    const systemLogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: systemEmail, password: PASSWORD })
      .expect(200);
    systemAccessToken = (systemLogin.body.data as { accessToken: string })
      .accessToken;
  });

  afterAll(async () => {
    // Tenant delete cascades its settings, roles and memberships;
    // AuthAccounts and audit rows are not tenant-scoped.
    await prisma.authAuditLog.deleteMany({
      where: { tenantId: { in: [tenantId, otherTenantId] } },
    });
    await prisma.tenant.deleteMany({
      where: { id: { in: [tenantId, otherTenantId] } },
    });
    await prisma.role.deleteMany({
      where: { name: `E2E Self-Registration System ${runId}` },
    });
    await prisma.authAccount.deleteMany({
      where: {
        OR: [
          { id: { in: createdAuthAccountIds } },
          // Anything this run created and did not track, so a failed
          // assertion mid-suite cannot leave accounts behind.
          { email: { contains: runId } },
        ],
      },
    });
    await app.close();
  });

  describe('POST /api/auth/register', () => {
    it('refuses a tenant that has never been configured', async () => {
      await clearPolicy();

      const response = await register(
        registerBody(`e2e-unconfigured-${runId}@acme.example`),
        tenantId,
      ).expect(403);

      expect(response.body).toEqual({
        success: false,
        data: null,
        error: {
          code: USER_ERROR_CODES.SELF_REG_DISABLED,
          message: expect.any(String),
        },
      });
      await expect(
        prisma.tenantUser.count({
          where: {
            tenantId,
            authAccount: { email: { contains: 'unconfigured' } },
          },
        }),
      ).resolves.toBe(0);
    });

    it('refuses a request that names no tenant', async () => {
      const response = await register(
        registerBody(`e2e-no-header-${runId}@acme.example`),
      ).expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    /**
     * The endpoint must not be usable to find out which tenants exist, so
     * an unknown id is answered exactly as a closed tenant is.
     */
    it('answers an unknown tenant the same way as a closed one', async () => {
      const response = await register(
        registerBody(`e2e-unknown-tenant-${runId}@acme.example`),
        'tenant_does_not_exist',
      ).expect(403);

      expect(response.body.error.code).toBe(USER_ERROR_CODES.SELF_REG_DISABLED);
    });

    /**
     * The DTO is asserted by the global `ValidationPipe`, so a malformed
     * body never reaches the service. The code it answers with is the
     * pipe's own `Bad Request` rather than the platform's
     * `VALIDATION_ERROR`, which is how every DTO-level failure in this
     * application already behaves -- asserted here as it is, not as it
     * arguably ought to be, so a later change to that shape is caught.
     */
    it('rejects a malformed body before any policy is consulted', async () => {
      await setPolicy({ allowSelfRegistration: true });

      const response = await request(app.getHttpServer())
        .post('/api/auth/register')
        .set('x-tenant-id', tenantId)
        .send({ email: 'not-an-email', fullName: '', password: PASSWORD })
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        data: null,
        error: { code: 'Bad Request' },
      });
      await expect(
        prisma.authAccount.count({ where: { email: 'not-an-email' } }),
      ).resolves.toBe(0);
    });

    /** Fail closed: an enabled toggle with no role is not an open tenant. */
    it('refuses when registration is enabled with no default role', async () => {
      await setPolicy({ allowSelfRegistration: true, defaultRoleId: null });

      const response = await register(
        registerBody(`e2e-no-role-${runId}@acme.example`),
        tenantId,
      ).expect(403);

      expect(response.body.error.code).toBe(USER_ERROR_CODES.SELF_REG_DISABLED);
    });

    it('refuses an address outside the domain whitelist', async () => {
      await setPolicy({
        allowSelfRegistration: true,
        allowedEmailDomains: ['acme.example'],
      });

      const response = await register(
        registerBody(`e2e-outsider-${runId}@evil.example`),
        tenantId,
      ).expect(400);

      expect(response.body.error.code).toBe(
        USER_ERROR_CODES.DOMAIN_NOT_ALLOWED,
      );
    });

    /**
     * The acceptance criterion of the story: the toggle dominates the
     * domain check, so a closed tenant gives up nothing about its policy.
     */
    it('answers SELF_REG_DISABLED, not DOMAIN_NOT_ALLOWED, when both fail', async () => {
      await setPolicy({
        allowSelfRegistration: false,
        allowedEmailDomains: ['acme.example'],
      });

      const response = await register(
        registerBody(`e2e-closed-outsider-${runId}@evil.example`),
        tenantId,
      ).expect(403);

      expect(response.body.error.code).toBe(USER_ERROR_CODES.SELF_REG_DISABLED);
    });

    it('refuses a full tenant and creates nothing', async () => {
      await setPolicy({ allowSelfRegistration: true });
      const seatsBefore = await prisma.tenantUser.count({
        where: { tenantId },
      });
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { maxUsers: seatsBefore },
      });

      try {
        const response = await register(
          registerBody(`e2e-quota-${runId}@acme.example`),
          tenantId,
        ).expect(400);

        expect(response.body.error.code).toBe(USER_ERROR_CODES.QUOTA_EXCEEDED);
        await expect(
          prisma.tenantUser.count({ where: { tenantId } }),
        ).resolves.toBe(seatsBefore);
      } finally {
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { maxUsers: -1 },
        });
      }
    });

    it('refuses a password that breaks the policy', async () => {
      await setPolicy({ allowSelfRegistration: true });

      const response = await request(app.getHttpServer())
        .post('/api/auth/register')
        .set('x-tenant-id', tenantId)
        .send({
          ...registerBody(`e2e-weak-${runId}@acme.example`),
          password: WEAK_PASSWORD,
          confirmPassword: WEAK_PASSWORD,
        })
        .expect(400);

      expect(response.body.error.code).toBe('PASSWORD_POLICY_VIOLATION');
    });

    it('creates a pending member, grants the default role and audits it', async () => {
      await setPolicy({ allowSelfRegistration: true, requireApproval: true });
      const email = `e2e-pending-${runId}@acme.example`;

      const response = await register(registerBody(email), tenantId).expect(
        201,
      );
      await trackAccount(email);

      expect(response.body.data).toEqual({
        tenantId,
        userId: expect.any(String),
        email,
        status: TenantUserStatus.PENDING_APPROVAL,
        requiresApproval: true,
      });

      const member = await prisma.tenantUser.findFirst({
        where: { tenantId, authAccount: { email } },
        select: {
          id: true,
          name: true,
          status: true,
          isActive: true,
          authAccountId: true,
          roles: { select: { id: true } },
        },
      });
      expect(member).toMatchObject({
        name: 'E2E Registrant',
        status: TenantUserStatus.PENDING_APPROVAL,
        isActive: false,
        roles: [{ id: memberRoleId }],
      });

      // `isActive: false` is the authentication gate, so the account exists
      // but cannot sign in until somebody approves it.
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .set('x-tenant-id', tenantId)
        .send({ email, password: PASSWORD })
        .expect(401);

      const audited = await prisma.authAuditLog.findFirst({
        where: {
          tenantId,
          event: AuthAuditEvent.USER_SELF_REGISTERED,
          subjectAuthAccountId: member!.authAccountId,
        },
      });
      expect(audited).toMatchObject({
        actorAuthAccountId: null,
        metadata: expect.objectContaining({
          email,
          status: TenantUserStatus.PENDING_APPROVAL,
          requiresApproval: true,
          roleId: memberRoleId,
        }),
      });
      // The password never reaches the trail.
      expect(JSON.stringify(audited?.metadata)).not.toContain(PASSWORD);
    });

    it('reports a repeat of the same address as a conflict', async () => {
      await setPolicy({ allowSelfRegistration: true, requireApproval: true });
      const email = `e2e-duplicate-${runId}@acme.example`;

      await register(registerBody(email), tenantId).expect(201);
      await trackAccount(email);

      const response = await register(registerBody(email), tenantId).expect(
        409,
      );
      expect(response.body.error.code).toBe(
        USER_ERROR_CODES.EMAIL_ALREADY_EXISTS,
      );
      await expect(
        prisma.tenantUser.count({
          where: { tenantId, authAccount: { email } },
        }),
      ).resolves.toBe(1);
    });

    it('creates an active member who can sign in straight away', async () => {
      await setPolicy({
        allowSelfRegistration: true,
        requireApproval: false,
        allowedEmailDomains: ['acme.example'],
      });
      // Normalization is part of the contract: the address is stored
      // lowercased, which is the only form login looks for. (Surrounding
      // whitespace never gets this far -- `@IsEmail()` rejects it at the
      // pipe, exactly as it does on login.)
      const email = `e2e-active-${runId}@acme.example`;

      const response = await register(
        { ...registerBody(email), email: `E2E-Active-${runId}@ACME.example` },
        tenantId,
      ).expect(201);
      await trackAccount(email);

      expect(response.body.data).toMatchObject({
        email,
        status: TenantUserStatus.ACTIVE,
        requiresApproval: false,
      });
      await expect(
        prisma.tenantUser.findFirst({
          where: { tenantId, authAccount: { email } },
          select: { status: true, isActive: true },
        }),
      ).resolves.toEqual({ status: TenantUserStatus.ACTIVE, isActive: true });

      await request(app.getHttpServer())
        .post('/api/auth/login')
        .set('x-tenant-id', tenantId)
        .send({ email, password: PASSWORD })
        .expect(200);
    });
  });

  describe('GET/PATCH /api/tenant-settings', () => {
    function get(token: string, headerTenantId?: string) {
      const call = request(app.getHttpServer()).get('/api/tenant-settings');
      if (headerTenantId !== undefined) {
        call.set('x-tenant-id', headerTenantId);
      }
      return call.set('Authorization', `Bearer ${token}`);
    }

    function patch(
      token: string,
      body: Record<string, unknown>,
      headerTenantId?: string,
    ) {
      const call = request(app.getHttpServer()).patch('/api/tenant-settings');
      if (headerTenantId !== undefined) {
        call.set('x-tenant-id', headerTenantId);
      }
      return call.set('Authorization', `Bearer ${token}`).send(body);
    }

    it('requires a token', async () => {
      await request(app.getHttpServer())
        .get('/api/tenant-settings')
        .expect(401);
    });

    it('reports the closed defaults for a tenant with no row', async () => {
      await clearPolicy();

      const response = await get(adminAccessToken).expect(200);

      expect(response.body.data).toEqual({
        tenantId,
        allowSelfRegistration: false,
        allowedEmailDomains: [],
        defaultRoleId: null,
        defaultRoleName: null,
        requireApproval: true,
        configured: false,
        updatedAt: null,
      });
    });

    it('creates the row on first write and normalizes the domains', async () => {
      await clearPolicy();

      const response = await patch(adminAccessToken, {
        allowSelfRegistration: true,
        allowedEmailDomains: ['@ACME.example', ' acme.example ', '', '   '],
        defaultRoleId: memberRoleId,
      }).expect(200);

      expect(response.body.data).toMatchObject({
        tenantId,
        allowSelfRegistration: true,
        allowedEmailDomains: ['acme.example'],
        defaultRoleId: memberRoleId,
        defaultRoleName: 'E2E Self-Registration Member',
        // Untouched by this patch, so it kept the schema default rather
        // than being reset to anything this request implied.
        requireApproval: true,
        configured: true,
      });
    });

    it('applies only the fields the body carries', async () => {
      await setPolicy({
        allowSelfRegistration: true,
        allowedEmailDomains: ['acme.example'],
        requireApproval: true,
      });

      const response = await patch(adminAccessToken, {
        requireApproval: false,
      }).expect(200);

      expect(response.body.data).toMatchObject({
        allowSelfRegistration: true,
        allowedEmailDomains: ['acme.example'],
        defaultRoleId: memberRoleId,
        requireApproval: false,
      });
    });

    it('clears the default role on an explicit null', async () => {
      await setPolicy({ allowSelfRegistration: true });

      const response = await patch(adminAccessToken, {
        defaultRoleId: null,
      }).expect(200);

      expect(response.body.data).toMatchObject({
        defaultRoleId: null,
        defaultRoleName: null,
      });
    });

    /**
     * A whitelist entry that can never match an address is worse than a
     * rejected one: it looks like it is protecting something.
     */
    it('refuses a domain that is really an address', async () => {
      const response = await patch(adminAccessToken, {
        allowedEmailDomains: ['bob@acme.example'],
      }).expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('refuses a default role belonging to another tenant', async () => {
      const response = await patch(adminAccessToken, {
        defaultRoleId: otherTenantRoleId,
      }).expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    /**
     * A tenant caller's token pins the tenant. Pointing the header
     * elsewhere is refused rather than silently ignored.
     */
    it('refuses a tenant caller naming another tenant', async () => {
      const response = await patch(
        adminAccessToken,
        { allowSelfRegistration: true },
        otherTenantId,
      ).expect(403);

      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('requires a system caller to name a tenant', async () => {
      const response = await get(systemAccessToken).expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('reports an unknown tenant as missing to a system caller', async () => {
      const response = await get(
        systemAccessToken,
        'tenant_does_not_exist',
      ).expect(404);

      expect(response.body.error.code).toBe('TENANT_NOT_FOUND');
    });

    it('lets a system caller read and write the tenant it names', async () => {
      await clearPolicy(otherTenantId);

      const written = await patch(
        systemAccessToken,
        { allowSelfRegistration: true, defaultRoleId: otherTenantRoleId },
        otherTenantId,
      ).expect(200);
      expect(written.body.data).toMatchObject({
        tenantId: otherTenantId,
        allowSelfRegistration: true,
        defaultRoleId: otherTenantRoleId,
      });

      const read = await get(adminAccessToken).expect(200);
      // The other tenant's write did not touch this one.
      expect(read.body.data.tenantId).toBe(tenantId);
    });

    it('refuses a tenant caller without tenant.settings.manage', async () => {
      const email = `e2e-plain-member-${runId}@acme.example`;
      const account = await prisma.authAccount.create({
        data: { email, passwordHash: await bcrypt.hash(PASSWORD, 4) },
      });
      createdAuthAccountIds.push(account.id);
      await prisma.tenantUser.create({
        data: {
          tenantId,
          authAccountId: account.id,
          name: 'E2E Plain Member',
          roles: { connect: [{ id: memberRoleId }] },
        },
      });

      const login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .set('x-tenant-id', tenantId)
        .send({ email, password: PASSWORD })
        .expect(200);
      const token = (login.body.data as { accessToken: string }).accessToken;

      const response = await get(token).expect(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    /**
     * Opening a tenant to public sign-up is the one settings change with a
     * security consequence, so it is findable by event alone.
     */
    it('audits the write and the toggle when registration is opened', async () => {
      await setPolicy({ allowSelfRegistration: false });
      await prisma.authAuditLog.deleteMany({ where: { tenantId } });

      await patch(adminAccessToken, { allowSelfRegistration: true }).expect(
        200,
      );

      const events = await prisma.authAuditLog.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'asc' },
        select: { event: true },
      });
      expect(events.map(({ event }) => event)).toEqual([
        AuthAuditEvent.TENANT_SETTINGS_UPDATED,
        AuthAuditEvent.SELF_REGISTRATION_ENABLED,
      ]);
    });

    it('records no toggle event when the flag did not move', async () => {
      await setPolicy({ allowSelfRegistration: true });
      await prisma.authAuditLog.deleteMany({ where: { tenantId } });

      await patch(adminAccessToken, { allowSelfRegistration: true }).expect(
        200,
      );

      const events = await prisma.authAuditLog.findMany({
        where: { tenantId },
        select: { event: true },
      });
      expect(events.map(({ event }) => event)).toEqual([
        AuthAuditEvent.TENANT_SETTINGS_UPDATED,
      ]);
    });
  });
});

/**
 * The rate limit, with the real `ThrottlerGuard` in place.
 *
 * Its own application instance because the storage is per-app and the suite
 * above deliberately overrides the guard away. The tenant here is left
 * closed on purpose: a `403` costs the budget exactly as a successful
 * registration does -- the guard runs before the handler -- so the limit can
 * be reached without creating six accounts.
 */
describe('POST /api/auth/register rate limiting (e2e)', () => {
  const REGISTER_THROTTLE_LIMIT = 5;

  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  const runId = `${Date.now()}-throttle`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    const tenant = await prisma.tenant.create({
      data: {
        name: 'E2E Throttle Tenant',
        slug: `e2e-selfreg-throttle-${runId}`,
      },
    });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await prisma.tenant.delete({ where: { id: tenantId } });
    await app.close();
  });

  it('answers 429 once the per-IP budget is spent', async () => {
    for (let attempt = 0; attempt < REGISTER_THROTTLE_LIMIT; attempt += 1) {
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .set('x-tenant-id', tenantId)
        .send(registerBody(`e2e-throttle-${runId}-${attempt}@acme.example`))
        .expect(403);
    }

    const response = await request(app.getHttpServer())
      .post('/api/auth/register')
      .set('x-tenant-id', tenantId)
      .send(registerBody(`e2e-throttle-${runId}-over@acme.example`))
      .expect(429);

    expect(response.body).toEqual({
      success: false,
      data: null,
      error: { code: 'TOO_MANY_REQUESTS', message: expect.any(String) },
    });
    // Nothing was created along the way: every attempt hit a closed tenant.
    await expect(
      prisma.tenantUser.count({ where: { tenantId } }),
    ).resolves.toBe(0);
  });
});
