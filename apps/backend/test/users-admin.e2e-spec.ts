import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import {
  ActorType,
  AUTH_ERROR_CODES,
  SYSTEM_USER_MANAGE_PERMISSION,
  SYSTEM_USER_READ_PERMISSION,
  TENANT_USER_INVITE_PERMISSION,
  TENANT_USER_MANAGE_PERMISSION,
  TENANT_USER_READ_PERMISSION,
  TenantUserStatus,
  USER_ERROR_CODES,
  UserSummaryDto,
} from '@flexi/shared-types';
import type { AppModule as AppModuleType } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { UserQuotaService } from '../src/modules/users/user-quota.service';

// Raised for the same reason the other e2e files raise it: this suite signs
// in several times and the module-wide login throttle would otherwise start
// answering 429 partway through. It must be assigned before AppModule is
// evaluated -- ConfigModule/ThrottlerModule read it the moment they load --
// hence the lazy require below rather than a hoisted static import.
process.env.AUTH_THROTTLE_LIMIT = '50';
process.env.AUTH_THROTTLE_TTL = '60';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AppModule } = require('../src/app.module') as {
  AppModule: typeof AppModuleType;
};

const PASSWORD = 'E2ePassword123!';

/**
 * `GET/PATCH/POST /api/users` against a live database (issue #192).
 *
 * The unit tests pin the branch logic with a mocked Prisma; what this file
 * is for is everything a mock cannot show: that the routes are mounted
 * where the specification says (including that `GET /api/users/invites`
 * still reaches the invite listing rather than being swallowed by
 * `GET /api/users/:userId`), that the envelope and status codes are what a
 * client actually receives, that a lock really lands in `tenant_users` and
 * really stops the next login, that a locked user still occupies a seat,
 * and above all that nothing addressed by id crosses a tenant boundary --
 * a caller of tenant A holding the exact `userId` of a user of tenant B is
 * answered `404`, never `403`.
 *
 * Permission rows are read from the migrated catalog rather than invented,
 * as the other suites do -- if a code this story relies on were missing
 * from the catalog migration, this suite should fail rather than paper
 * over it with a locally-created row.
 */
describe('User administration (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userQuotaService: UserQuotaService;

  const runId = Date.now().toString();
  const adminEmail = `e2e-users-admin-${runId}@example.com`;
  const memberEmail = `e2e-users-member-${runId}@example.com`;
  const pendingEmail = `e2e-users-pending-${runId}@example.com`;
  const removedEmail = `e2e-users-removed-${runId}@example.com`;
  const otherTenantEmail = `e2e-users-other-${runId}@example.com`;
  const systemEmail = `e2e-users-system-${runId}@example.com`;

  let tenantId: string;
  let otherTenantId: string;
  let memberRoleId: string;
  let leadRoleId: string;
  let otherTenantRoleId: string;
  let adminUserId: string;
  let memberUserId: string;
  let pendingUserId: string;
  let removedUserId: string;
  let otherTenantUserId: string;
  let systemUserId: string;
  let adminToken: string;
  let systemToken: string;
  const createdAuthAccountIds: string[] = [];

  async function createTenantUser(options: {
    email: string;
    name: string;
    tenantId: string;
    status?: TenantUserStatus;
    isActive?: boolean;
    roleIds?: string[];
  }): Promise<string> {
    const account = await prisma.authAccount.create({
      data: {
        email: options.email,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
      },
    });
    createdAuthAccountIds.push(account.id);

    const tenantUser = await prisma.tenantUser.create({
      data: {
        tenantId: options.tenantId,
        authAccountId: account.id,
        name: options.name,
        status: options.status ?? TenantUserStatus.ACTIVE,
        isActive: options.isActive ?? true,
        ...(options.roleIds?.length
          ? { roles: { connect: options.roleIds.map((id) => ({ id })) } }
          : {}),
      },
      select: { id: true },
    });

    return tenantUser.id;
  }

  function login(email: string, headerTenantId?: string) {
    const call = request(app.getHttpServer()).post('/api/auth/login');
    if (headerTenantId) {
      call.set('x-tenant-id', headerTenantId);
    }
    return call.send({ email, password: PASSWORD });
  }

  function asAdmin(method: 'get' | 'patch' | 'post', path: string) {
    return request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${adminToken}`);
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    // Applied imperatively by main.ts rather than by AppModule's providers,
    // so a test that boots the module has to replicate them.
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    userQuotaService = app.get(UserQuotaService);

    const [tenantRead, tenantManage, tenantInvite, systemRead, systemManage] =
      await Promise.all([
        prisma.permission.findUnique({
          where: { code: TENANT_USER_READ_PERMISSION },
        }),
        prisma.permission.findUnique({
          where: { code: TENANT_USER_MANAGE_PERMISSION },
        }),
        prisma.permission.findUnique({
          where: { code: TENANT_USER_INVITE_PERMISSION },
        }),
        prisma.permission.findUnique({
          where: { code: SYSTEM_USER_READ_PERMISSION },
        }),
        prisma.permission.findUnique({
          where: { code: SYSTEM_USER_MANAGE_PERMISSION },
        }),
      ]);

    // From the catalog migration, not from this file.
    expect(tenantRead).not.toBeNull();
    expect(tenantManage).not.toBeNull();
    expect(tenantInvite).not.toBeNull();
    expect(systemRead).not.toBeNull();
    expect(systemManage).not.toBeNull();

    const tenant = await prisma.tenant.create({
      data: { name: 'E2E Users Tenant', slug: `e2e-users-${runId}` },
    });
    tenantId = tenant.id;

    const otherTenant = await prisma.tenant.create({
      data: {
        name: 'E2E Users Other Tenant',
        slug: `e2e-users-other-${runId}`,
      },
    });
    otherTenantId = otherTenant.id;

    const adminRole = await prisma.role.create({
      data: {
        tenantId,
        name: 'E2E Users Admin',
        rolePermissions: {
          create: [
            { permissionId: tenantRead!.id },
            { permissionId: tenantManage!.id },
            { permissionId: tenantInvite!.id },
          ],
        },
      },
    });
    const memberRole = await prisma.role.create({
      data: { tenantId, name: 'E2E Users Member' },
    });
    memberRoleId = memberRole.id;
    const leadRole = await prisma.role.create({
      data: { tenantId, name: 'E2E Users Lead' },
    });
    leadRoleId = leadRole.id;
    const otherTenantRole = await prisma.role.create({
      data: { tenantId: otherTenantId, name: 'E2E Users Other Role' },
    });
    otherTenantRoleId = otherTenantRole.id;

    adminUserId = await createTenantUser({
      email: adminEmail,
      name: 'E2E Tenant Admin',
      tenantId,
      roleIds: [adminRole.id],
    });
    memberUserId = await createTenantUser({
      email: memberEmail,
      name: 'E2E Member',
      tenantId,
      roleIds: [memberRoleId],
    });
    pendingUserId = await createTenantUser({
      email: pendingEmail,
      name: 'E2E Pending',
      tenantId,
      status: TenantUserStatus.PENDING_APPROVAL,
      isActive: false,
      roleIds: [memberRoleId],
    });
    removedUserId = await createTenantUser({
      email: removedEmail,
      name: 'E2E Removed',
      tenantId,
      status: TenantUserStatus.DELETED,
      isActive: false,
    });
    otherTenantUserId = await createTenantUser({
      email: otherTenantEmail,
      name: 'E2E Other Tenant Member',
      tenantId: otherTenantId,
      roleIds: [otherTenantRoleId],
    });

    const systemRole = await prisma.role.create({
      data: {
        name: `E2E Users System ${runId}`,
        rolePermissions: {
          create: [
            { permissionId: systemRead!.id },
            { permissionId: systemManage!.id },
          ],
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
    const systemUser = await prisma.systemUser.create({
      data: {
        authAccountId: systemAccount.id,
        name: 'E2E System Admin',
        roles: { connect: [{ id: systemRole.id }] },
      },
      select: { id: true },
    });
    systemUserId = systemUser.id;

    // Real logins rather than hand-minted tokens: the header convention
    // (`x-tenant-id` present -> tenant actor, absent -> system actor) is
    // part of what these routes are resolved by.
    adminToken = (await login(adminEmail, tenantId).expect(200)).body.data
      .accessToken;
    systemToken = (await login(systemEmail).expect(200)).body.data.accessToken;
  });

  afterAll(async () => {
    await prisma.authAuditLog.deleteMany({
      where: { tenantId: { in: [tenantId, otherTenantId] } },
    });
    await prisma.tenant.deleteMany({
      where: { id: { in: [tenantId, otherTenantId] } },
    });
    await prisma.role.deleteMany({
      where: { name: `E2E Users System ${runId}` },
    });
    await prisma.authAccount.deleteMany({
      where: {
        OR: [
          { id: { in: createdAuthAccountIds } },
          { email: { contains: runId } },
        ],
      },
    });
    await app.close();
  });

  describe('GET /api/users', () => {
    it('lists only the caller tenant, hides deleted users and leaks no secrets', async () => {
      const response = await asAdmin('get', '/api/users').expect(200);
      const items = response.body.data.items as UserSummaryDto[];

      expect(response.body.success).toBe(true);
      expect(items.map((item) => item.id).sort()).toEqual(
        [adminUserId, memberUserId, pendingUserId].sort(),
      );
      expect(items.some((item) => item.id === removedUserId)).toBe(false);
      expect(items.every((item) => item.tenantId === tenantId)).toBe(true);
      expect(response.body.data.meta).toEqual({
        total: 3,
        page: 1,
        pageSize: 20,
      });

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain('passwordHash');
      expect(serialized).not.toContain('tokenHash');
      expect(serialized).not.toContain(PASSWORD);
    });

    it('filters by status, role and keyword', async () => {
      const pending = await asAdmin(
        'get',
        `/api/users?status=${TenantUserStatus.PENDING_APPROVAL}`,
      ).expect(200);
      expect(
        (pending.body.data.items as UserSummaryDto[]).map((item) => item.id),
      ).toEqual([pendingUserId]);

      const deleted = await asAdmin(
        'get',
        `/api/users?status=${TenantUserStatus.DELETED}`,
      ).expect(200);
      expect(
        (deleted.body.data.items as UserSummaryDto[]).map((item) => item.id),
      ).toEqual([removedUserId]);

      const byRole = await asAdmin(
        'get',
        `/api/users?roleId=${memberRoleId}`,
      ).expect(200);
      expect(
        (byRole.body.data.items as UserSummaryDto[])
          .map((item) => item.id)
          .sort(),
      ).toEqual([memberUserId, pendingUserId].sort());

      const byEmail = await asAdmin(
        'get',
        `/api/users?keyword=${encodeURIComponent(memberEmail)}`,
      ).expect(200);
      expect(
        (byEmail.body.data.items as UserSummaryDto[]).map((item) => item.id),
      ).toEqual([memberUserId]);

      const byName = await asAdmin(
        'get',
        '/api/users?keyword=e2e%20member',
      ).expect(200);
      expect(
        (byName.body.data.items as UserSummaryDto[]).map((item) => item.id),
      ).toEqual([memberUserId]);
    });

    it('paginates and rejects a page that is not a positive integer', async () => {
      const firstPage = await asAdmin(
        'get',
        '/api/users?page=1&pageSize=2',
      ).expect(200);
      expect(firstPage.body.data.items).toHaveLength(2);
      expect(firstPage.body.data.meta).toEqual({
        total: 3,
        page: 1,
        pageSize: 2,
      });

      const secondPage = await asAdmin(
        'get',
        '/api/users?page=2&pageSize=2',
      ).expect(200);
      expect(secondPage.body.data.items).toHaveLength(1);

      const rejected = await asAdmin('get', '/api/users?page=0').expect(400);
      expect(rejected.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('shows a system caller SystemUsers and nobody else', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/users')
        .set('Authorization', `Bearer ${systemToken}`)
        .expect(200);

      const items = response.body.data.items as UserSummaryDto[];
      expect(items.every((item) => item.actorType === ActorType.SYSTEM)).toBe(
        true,
      );
      expect(items.every((item) => item.tenantId === null)).toBe(true);
      expect(items.some((item) => item.id === systemUserId)).toBe(true);
      expect(items.some((item) => item.id === memberUserId)).toBe(false);
    });

    /**
     * Route-order regression: `GET users/:userId` is declared in the same
     * module as `GET users/invites`, and Express answers with the first
     * match. If the controllers were ever registered the other way round,
     * this call would come back as `404 USER_NOT_FOUND` for a user called
     * "invites".
     */
    it('still reaches the invite listing at /api/users/invites', async () => {
      const response = await asAdmin('get', '/api/users/invites').expect(200);

      expect(Array.isArray(response.body.data)).toBe(true);
    });
  });

  describe('GET /api/users/:userId', () => {
    it('returns one user of the caller tenant', async () => {
      const response = await asAdmin(
        'get',
        `/api/users/${memberUserId}`,
      ).expect(200);

      expect(response.body.data).toEqual(
        expect.objectContaining({
          id: memberUserId,
          email: memberEmail,
          fullName: 'E2E Member',
          status: TenantUserStatus.ACTIVE,
          isActive: true,
          mustChangePassword: false,
        }),
      );
      expect(response.body.data.roles).toEqual([
        { id: memberRoleId, name: 'E2E Users Member' },
      ]);
    });

    it('answers 404, not 403, for a user of another tenant', async () => {
      const response = await asAdmin(
        'get',
        `/api/users/${otherTenantUserId}`,
      ).expect(404);

      expect(response.body.error.code).toBe(AUTH_ERROR_CODES.USER_NOT_FOUND);
    });
  });

  describe('PATCH /api/users/:userId', () => {
    it('changes full name and role', async () => {
      const response = await asAdmin('patch', `/api/users/${memberUserId}`)
        .send({ fullName: 'E2E Member Renamed', roleId: leadRoleId })
        .expect(200);

      expect(response.body.data).toEqual(
        expect.objectContaining({ fullName: 'E2E Member Renamed' }),
      );
      expect(response.body.data.roles).toEqual([
        { id: leadRoleId, name: 'E2E Users Lead' },
      ]);

      // Put the fixture back for the tests that follow.
      await asAdmin('patch', `/api/users/${memberUserId}`)
        .send({ fullName: 'E2E Member', roleId: memberRoleId })
        .expect(200);
    });

    it('refuses a Tenant Admin changing their own role', async () => {
      const response = await asAdmin('patch', `/api/users/${adminUserId}`)
        .send({ roleId: leadRoleId })
        .expect(403);

      expect(response.body.error.code).toBe(
        USER_ERROR_CODES.CANNOT_CHANGE_OWN_ROLE,
      );
      // The role really did not move.
      const stillAdmin = await asAdmin(
        'get',
        `/api/users/${adminUserId}`,
      ).expect(200);
      expect(stillAdmin.body.data.roles).toEqual([
        expect.objectContaining({ name: 'E2E Users Admin' }),
      ]);
    });

    it('refuses a role belonging to another tenant', async () => {
      await asAdmin('patch', `/api/users/${memberUserId}`)
        .send({ roleId: otherTenantRoleId })
        .expect(400);
    });

    it('cannot edit a user of another tenant, even with their exact id', async () => {
      const response = await asAdmin('patch', `/api/users/${otherTenantUserId}`)
        .send({ fullName: 'Hijacked' })
        .expect(404);

      expect(response.body.error.code).toBe(AUTH_ERROR_CODES.USER_NOT_FOUND);
      const untouched = await prisma.tenantUser.findUnique({
        where: { id: otherTenantUserId },
        select: { name: true },
      });
      expect(untouched?.name).toBe('E2E Other Tenant Member');
    });
  });

  describe('POST /api/users/direct-create', () => {
    const createdEmail = () => `e2e-users-created-${runId}@example.com`;

    it('creates an active seat that must change its password', async () => {
      const response = await asAdmin('post', '/api/users/direct-create')
        .send({
          email: createdEmail().toUpperCase(),
          fullName: 'E2E Directly Created',
          roleId: memberRoleId,
        })
        .expect(201);

      expect(response.body.data.user).toEqual(
        expect.objectContaining({
          email: createdEmail(),
          fullName: 'E2E Directly Created',
          status: TenantUserStatus.ACTIVE,
          isActive: true,
          mustChangePassword: true,
        }),
      );
      expect(response.body.data.seatUsage.usedSeats).toBeGreaterThan(0);
      // The generated password leaves the server only by mail.
      expect(JSON.stringify(response.body)).not.toContain('password');

      const stored = await prisma.tenantUser.findUnique({
        where: { id: response.body.data.user.id },
        select: { tenantId: true, status: true, isActive: true },
      });
      expect(stored).toEqual({
        tenantId,
        status: TenantUserStatus.ACTIVE,
        isActive: true,
      });
    });

    it('refuses an address already used inside the tenant', async () => {
      const response = await asAdmin('post', '/api/users/direct-create')
        .send({ email: memberEmail, fullName: 'Duplicate' })
        .expect(409);

      expect(response.body.error.code).toBe(
        USER_ERROR_CODES.EMAIL_ALREADY_EXISTS,
      );
    });

    /**
     * ADR-009: uniqueness is per tenant. The same address in another
     * tenant is a different account and must not be refused -- nor may the
     * refusal above be a way to learn that it exists elsewhere.
     */
    it('accepts an address that only exists in another tenant', async () => {
      await asAdmin('post', '/api/users/direct-create')
        .send({ email: otherTenantEmail, fullName: 'Same Address, Our Tenant' })
        .expect(201);
    });

    it('refuses a system caller', async () => {
      await request(app.getHttpServer())
        .post('/api/users/direct-create')
        .set('Authorization', `Bearer ${systemToken}`)
        .send({ email: `e2e-users-sys-${runId}@example.com`, fullName: 'Nope' })
        .expect(403);
    });
  });

  describe('PATCH /api/users/:userId/approve', () => {
    it('moves pending_approval to active and lets the account log in', async () => {
      // Refused before approval: `isActive` is false, and login reads
      // `isActive` rather than `status`.
      await login(pendingEmail, tenantId).expect(401);

      const response = await asAdmin(
        'patch',
        `/api/users/${pendingUserId}/approve`,
      ).expect(200);

      expect(response.body.data.user).toEqual(
        expect.objectContaining({
          status: TenantUserStatus.ACTIVE,
          isActive: true,
        }),
      );
      await login(pendingEmail, tenantId).expect(200);
    });

    it('refuses a second approval loudly', async () => {
      const response = await asAdmin(
        'patch',
        `/api/users/${pendingUserId}/approve`,
      ).expect(400);

      expect(response.body.error.code).toBe(
        USER_ERROR_CODES.INVALID_STATUS_TRANSITION,
      );
    });

    it('cannot approve across the tenant boundary', async () => {
      const response = await asAdmin(
        'patch',
        `/api/users/${otherTenantUserId}/approve`,
      ).expect(404);

      expect(response.body.error.code).toBe(AUTH_ERROR_CODES.USER_NOT_FOUND);
    });
  });

  describe('PATCH /api/users/:userId/lock and /unlock', () => {
    it('locks out a live session, keeps the seat, and unlocks again', async () => {
      const session = await login(memberEmail, tenantId).expect(200);
      const refreshToken = session.body.data.refreshToken as string;

      const seatsBefore = await userQuotaService.usedSeats(tenantId);

      const locked = await asAdmin(
        'patch',
        `/api/users/${memberUserId}/lock`,
      ).expect(200);

      expect(locked.body.data.user).toEqual(
        expect.objectContaining({
          status: TenantUserStatus.LOCKED,
          // Cleared in the same write as the status, or a locked user
          // could still authenticate.
          isActive: false,
        }),
      );
      expect(locked.body.data.revokedSessionCount).toBeGreaterThanOrEqual(1);

      // The session it held is dead, and so is the next login attempt.
      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken })
        .expect(401);
      await login(memberEmail, tenantId).expect(401);

      // ...but the seat is still theirs: a suspension is not a departure.
      await expect(userQuotaService.usedSeats(tenantId)).resolves.toBe(
        seatsBefore,
      );

      const relocked = await asAdmin(
        'patch',
        `/api/users/${memberUserId}/lock`,
      ).expect(400);
      expect(relocked.body.error.code).toBe(
        USER_ERROR_CODES.INVALID_STATUS_TRANSITION,
      );

      const unlocked = await asAdmin(
        'patch',
        `/api/users/${memberUserId}/unlock`,
      ).expect(200);
      expect(unlocked.body.data.user).toEqual(
        expect.objectContaining({
          status: TenantUserStatus.ACTIVE,
          isActive: true,
        }),
      );
      await login(memberEmail, tenantId).expect(200);
    });

    it('refuses an administrator locking themselves out', async () => {
      const response = await asAdmin(
        'patch',
        `/api/users/${adminUserId}/lock`,
      ).expect(400);

      expect(response.body.error.code).toBe(USER_ERROR_CODES.CANNOT_LOCK_SELF);
    });

    it('cannot lock or unlock a user of another tenant', async () => {
      await asAdmin('patch', `/api/users/${otherTenantUserId}/lock`).expect(
        404,
      );
      await asAdmin('patch', `/api/users/${otherTenantUserId}/unlock`).expect(
        404,
      );

      const untouched = await prisma.tenantUser.findUnique({
        where: { id: otherTenantUserId },
        select: { status: true, isActive: true },
      });
      expect(untouched).toEqual({
        status: TenantUserStatus.ACTIVE,
        isActive: true,
      });
    });
  });
});
