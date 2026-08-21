import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { FEATURE_MODULES } from '@flexi/shared-types';
import type { AppModule as AppModuleType } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// Override the throttle limit for this whole e2e run. This must happen
// before AppModule is evaluated at all -- ConfigModule/ThrottlerModule
// resolve and cache AUTH_THROTTLE_LIMIT the moment their providing module
// loads, and a static top-level `import { AppModule } from '../src/app.module'`
// is hoisted by the module system to run before any of this file's own
// top-level statements, so setting process.env here would already be too
// late. AppModule is therefore required lazily inside beforeAll below,
// after this assignment has run. Kept well above the handful of
// login/refresh calls the pre-existing tests in this file make (2 login, 3
// refresh in the happy-path test; 2 login, 4 refresh in the session-family
// kill-switch test) so none of them trip it, while staying low enough that
// the dedicated overflow test below (AUTH_THROTTLE_LIMIT + 1 requests) stays
// fast and deterministic without waiting out a real TTL window.
process.env.AUTH_THROTTLE_LIMIT = '20';
process.env.AUTH_THROTTLE_TTL = '60';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AppModule } = require('../src/app.module') as {
  AppModule: typeof AppModuleType;
};

/**
 * Boots the real AppModule (Prisma connects to whatever DATABASE_URL is set
 * to -- run `docker compose up -d` + `apps/backend/.env` configured first,
 * same as `pnpm --filter backend start:dev`) and exercises every stub
 * module's placeholder route.
 *
 * Iterating FEATURE_MODULES (from @flexi/shared-types) rather than a
 * hardcoded list means this test fails if AppModule's registered modules
 * ever drift from the canonical module-id list shared with the frontend.
 *
 * `auth` is excluded from the not-implemented sweep below: Core Auth
 * (spec-core-authentication.md) replaced its stub with real routes
 * (login/refresh/logout/me), so `GET /api/auth` with no matching route now
 * 404s like any other unmatched path -- it's covered by its own assertion
 * instead.
 */
const STUB_FEATURE_MODULES = FEATURE_MODULES.filter(
  (moduleId) => moduleId !== 'auth',
);

interface CountRow {
  count: bigint;
}

interface AttemptRow {
  actorSystemUserId: string | null;
  status: string;
  safePayload: unknown;
  actorIdentity: unknown;
  requestIdentity: unknown;
  idempotencyKey: string;
  idempotencyIdentity: unknown;
  stepOutcomes: unknown;
}

describe('AppModule (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // main.ts sets this imperatively at bootstrap time; replicate it here
    // since it's an application-level call, not something AppModule's own
    // providers would apply automatically.
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(STUB_FEATURE_MODULES)(
    'GET /api/%s returns the not-implemented envelope',
    async (moduleId) => {
      const response = await request(app.getHttpServer())
        .get(`/api/${moduleId}`)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: { status: 'not-implemented' },
        error: null,
      });
    },
  );

  it('GET /api/auth/me with no token returns 401 UNAUTHORIZED', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/auth/me')
      .expect(401);

    expect(response.body).toEqual({
      success: false,
      data: null,
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
  });

  it('POST /api/auth/login with bad credentials returns 401 INVALID_CREDENTIALS', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong-password' })
      .expect(401);

    expect(response.body).toEqual({
      success: false,
      data: null,
      error: { code: 'INVALID_CREDENTIALS', message: expect.any(String) },
    });
  });

  it('POST /api/auth/logout with no token returns 401 UNAUTHORIZED', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/logout')
      .send({ refreshToken: 'irrelevant' })
      .expect(401);

    expect(response.body).toEqual({
      success: false,
      data: null,
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
  });

  describe('Core Auth happy path (tenant actor)', () => {
    let prisma: PrismaService;
    let tenantId: string;
    let authAccountId: string;
    const email = `e2e-happy-path-${Date.now()}@example.com`;
    const password = 'E2ePassword123!';

    beforeAll(async () => {
      prisma = app.get(PrismaService);

      const tenant = await prisma.tenant.create({
        data: {
          name: 'E2E Happy Path Tenant',
          slug: `e2e-happy-path-${Date.now()}`,
        },
      });
      tenantId = tenant.id;

      const permission = await prisma.permission.upsert({
        where: { code: 'auth.me.read' },
        update: {},
        create: {
          code: 'auth.me.read',
          description: 'Read own profile via GET /api/auth/me (TenantUser)',
          scope: 'TENANT',
        },
      });

      const role = await prisma.role.create({
        data: {
          tenantId,
          name: 'E2E Role',
          rolePermissions: { create: [{ permissionId: permission.id }] },
        },
      });

      const authAccount = await prisma.authAccount.create({
        data: { email, passwordHash: await bcrypt.hash(password, 4) },
      });
      authAccountId = authAccount.id;

      await prisma.tenantUser.create({
        data: {
          tenantId,
          authAccountId: authAccount.id,
          name: 'E2E Happy Path User',
          roles: { connect: [{ id: role.id }] },
        },
      });
    });

    afterAll(async () => {
      // Tenant delete cascades TenantUser/Role/RolePermission (onDelete:
      // Cascade); AuthAccount and its RefreshTokens are not tenant-scoped
      // and must be cleaned up separately.
      await prisma.tenant.delete({ where: { id: tenantId } });
      await prisma.authAccount.delete({ where: { id: authAccountId } });
    });

    it('logs in, reads /me, rotates via refresh, and logs out', async () => {
      const loginResponse = await request(app.getHttpServer())
        .post('/api/auth/login')
        .set('x-tenant-id', tenantId)
        .send({ email, password })
        .expect(200);

      const { accessToken, refreshToken } = loginResponse.body.data as {
        accessToken: string;
        refreshToken: string;
      };
      expect(accessToken).toEqual(expect.any(String));
      expect(refreshToken).toEqual(expect.any(String));

      const meResponse = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(meResponse.body.data).toMatchObject({
        email,
        actorType: 'tenant',
      });

      const refreshResponse = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken })
        .expect(200);
      const rotated = refreshResponse.body.data as {
        accessToken: string;
        refreshToken: string;
      };
      expect(rotated.accessToken).toEqual(expect.any(String));
      expect(rotated.refreshToken).not.toBe(refreshToken);

      await request(app.getHttpServer())
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${rotated.accessToken}`)
        .send({ refreshToken: rotated.refreshToken })
        .expect(200);

      // The just-logged-out refresh token must be rejected too.
      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken: rotated.refreshToken })
        .expect(401);

      // The original (now-rotated) refresh token is also rejected -- checked
      // last since presenting it (already-revoked reuse) now triggers the
      // session-family kill-switch, which would otherwise revoke the live
      // `rotated.refreshToken` used just above.
      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken })
        .expect(401);
    });

    it('reusing an already-revoked refresh token revokes every other live session for that account (session-family kill-switch)', async () => {
      // Two independent logins for the same account -- two live refresh tokens.
      const loginA = await request(app.getHttpServer())
        .post('/api/auth/login')
        .set('x-tenant-id', tenantId)
        .send({ email, password })
        .expect(200);
      const loginB = await request(app.getHttpServer())
        .post('/api/auth/login')
        .set('x-tenant-id', tenantId)
        .send({ email, password })
        .expect(200);
      const refreshTokenA = loginA.body.data.refreshToken as string;
      const refreshTokenB = loginB.body.data.refreshToken as string;

      // Rotate session A once, so the original token A is now revoked.
      const rotatedA = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken: refreshTokenA })
        .expect(200);

      // Replaying the now-revoked original token A is the theft signal.
      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken: refreshTokenA })
        .expect(401);

      // Session B, never reused or revoked itself, must now be dead too --
      // proving the kill-switch actually revoked a live session it did not
      // touch directly, not just the replayed token itself.
      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken: refreshTokenB })
        .expect(401);

      // The rotated token from session A was also live (unrevoked) at the
      // moment the kill-switch fired, so it is caught by the same mass
      // revoke and must be rejected too.
      const rotatedAToken = rotatedA.body.data.refreshToken as string;
      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken: rotatedAToken })
        .expect(401);
    });
  });

  describe('Tenant onboarding slug preflight', () => {
    let prisma: PrismaService;
    let existingTenantId: string;
    let tenantActorTenantId: string;
    let permittedSystemAuthAccountId: string;
    let unpermittedSystemAuthAccountId: string;
    let tenantActorAuthAccountId: string;
    let permittedRoleId: string;
    let unpermittedRoleId: string;
    let tenantRoleId: string;
    const acceptedAttemptIds: string[] = [];
    let permittedSystemAccessToken: string;
    let unpermittedSystemAccessToken: string;
    let tenantActorAccessToken: string;

    const runId = Date.now();
    const password = 'E2ePassword123!';
    const permittedSystemEmail = `e2e-onboard-system-${runId}@example.com`;
    const unpermittedSystemEmail = `e2e-onboard-viewer-${runId}@example.com`;
    const tenantActorEmail = `e2e-onboard-tenant-${runId}@example.com`;

    async function countOnboardingAttempts(): Promise<number> {
      const [row] = await prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*)::bigint AS count FROM "tenant_onboarding_attempts"
      `;

      return Number(row?.count ?? 0n);
    }

    beforeAll(async () => {
      prisma = app.get(PrismaService);
      const passwordHash = await bcrypt.hash(password, 4);

      const onboardingPermission = await prisma.permission.upsert({
        where: { code: 'system.tenants.onboard' },
        update: {},
        create: {
          code: 'system.tenants.onboard',
          description: 'Start tenant onboarding intake as a SystemUser',
          scope: 'SYSTEM',
        },
      });
      const systemReadPermission = await prisma.permission.upsert({
        where: { code: 'system.me.read' },
        update: {},
        create: {
          code: 'system.me.read',
          description: 'Read own profile via GET /api/auth/me (SystemUser)',
          scope: 'SYSTEM',
        },
      });

      const existingTenant = await prisma.tenant.create({
        data: {
          name: 'E2E Existing Slug Tenant',
          slug: `e2e-existing-${runId}`,
        },
      });
      existingTenantId = existingTenant.id;

      const tenantActorTenant = await prisma.tenant.create({
        data: {
          name: 'E2E Tenant Actor Tenant',
          slug: `e2e-tenant-actor-${runId}`,
        },
      });
      tenantActorTenantId = tenantActorTenant.id;

      const permittedRole = await prisma.role.create({
        data: {
          tenantId: null,
          name: `E2E Onboarding Admin ${runId}`,
          rolePermissions: {
            create: [
              { permissionId: onboardingPermission.id },
              { permissionId: systemReadPermission.id },
            ],
          },
        },
      });
      permittedRoleId = permittedRole.id;

      const unpermittedRole = await prisma.role.create({
        data: {
          tenantId: null,
          name: `E2E Onboarding Viewer ${runId}`,
          rolePermissions: {
            create: [{ permissionId: systemReadPermission.id }],
          },
        },
      });
      unpermittedRoleId = unpermittedRole.id;

      const tenantRole = await prisma.role.create({
        data: {
          tenantId: tenantActorTenantId,
          name: `E2E Tenant Spoof ${runId}`,
          rolePermissions: {
            create: [{ permissionId: onboardingPermission.id }],
          },
        },
      });
      tenantRoleId = tenantRole.id;

      const permittedAuthAccount = await prisma.authAccount.create({
        data: { email: permittedSystemEmail, passwordHash },
      });
      permittedSystemAuthAccountId = permittedAuthAccount.id;
      await prisma.systemUser.create({
        data: {
          authAccountId: permittedAuthAccount.id,
          name: 'E2E Onboarding Admin',
          roles: { connect: [{ id: permittedRoleId }] },
        },
      });

      const unpermittedAuthAccount = await prisma.authAccount.create({
        data: { email: unpermittedSystemEmail, passwordHash },
      });
      unpermittedSystemAuthAccountId = unpermittedAuthAccount.id;
      await prisma.systemUser.create({
        data: {
          authAccountId: unpermittedAuthAccount.id,
          name: 'E2E Onboarding Viewer',
          roles: { connect: [{ id: unpermittedRoleId }] },
        },
      });

      const tenantAuthAccount = await prisma.authAccount.create({
        data: { email: tenantActorEmail, passwordHash },
      });
      tenantActorAuthAccountId = tenantAuthAccount.id;
      await prisma.tenantUser.create({
        data: {
          tenantId: tenantActorTenantId,
          authAccountId: tenantAuthAccount.id,
          name: 'E2E Tenant Actor',
          roles: { connect: [{ id: tenantRoleId }] },
        },
      });

      const permittedLogin = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: permittedSystemEmail, password })
        .expect(200);
      permittedSystemAccessToken = permittedLogin.body.data.accessToken;

      const unpermittedLogin = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: unpermittedSystemEmail, password })
        .expect(200);
      unpermittedSystemAccessToken = unpermittedLogin.body.data.accessToken;

      const tenantLogin = await request(app.getHttpServer())
        .post('/api/auth/login')
        .set('x-tenant-id', tenantActorTenantId)
        .send({ email: tenantActorEmail, password })
        .expect(200);
      tenantActorAccessToken = tenantLogin.body.data.accessToken;
    });

    afterAll(async () => {
      if (acceptedAttemptIds.length > 0) {
        await prisma.$executeRaw(
          Prisma.sql`
            DELETE FROM "tenant_onboarding_attempts"
            WHERE "id" IN (${Prisma.join(acceptedAttemptIds)})
          `,
        );
      }
      await prisma.tenant.delete({ where: { id: tenantActorTenantId } });
      await prisma.tenant.delete({ where: { id: existingTenantId } });
      await prisma.authAccount.deleteMany({
        where: {
          id: {
            in: [
              permittedSystemAuthAccountId,
              unpermittedSystemAuthAccountId,
              tenantActorAuthAccountId,
            ],
          },
        },
      });
      await prisma.role.deleteMany({
        where: {
          id: { in: [permittedRoleId, unpermittedRoleId, tenantRoleId] },
        },
      });
    });

    it('returns an available slug envelope for a permitted SystemUser', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/super-admin/tenants/slug-availability')
        .set('Authorization', `Bearer ${permittedSystemAccessToken}`)
        .query({ slug: `e2e-available-${runId}` })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: {
          slug: `e2e-available-${runId}`,
          available: true,
          reason: 'available',
        },
        error: null,
      });
    });

    it('returns a safe conflict envelope for an existing tenant slug', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/super-admin/tenants/slug-availability')
        .set('Authorization', `Bearer ${permittedSystemAccessToken}`)
        .query({ slug: `e2e-existing-${runId}` })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: {
          slug: `e2e-existing-${runId}`,
          available: false,
          reason: 'already_in_use',
        },
        error: null,
      });
    });

    it('returns 401 when slug preflight has no access token', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/super-admin/tenants/slug-availability')
        .query({ slug: `e2e-available-${runId}` })
        .expect(401);

      expect(response.body).toEqual({
        success: false,
        data: null,
        error: { code: 'UNAUTHORIZED', message: expect.any(String) },
      });
    });

    it('returns 403 for a SystemUser without tenant onboarding permission', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/super-admin/tenants/slug-availability')
        .set('Authorization', `Bearer ${unpermittedSystemAccessToken}`)
        .query({ slug: `e2e-available-${runId}` })
        .expect(403);

      expect(response.body).toEqual({
        success: false,
        data: null,
        error: { code: 'FORBIDDEN', message: expect.any(String) },
      });
    });

    it('returns 403 for a tenant actor even if its token carries the permission code', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/super-admin/tenants/slug-availability')
        .set('Authorization', `Bearer ${tenantActorAccessToken}`)
        .query({ slug: `e2e-available-${runId}` })
        .expect(403);

      expect(response.body).toEqual({
        success: false,
        data: null,
        error: { code: 'FORBIDDEN', message: expect.any(String) },
      });
    });

    it('creates a durable onboarding attempt for a permitted SystemUser without creating tenant state', async () => {
      const tenantSlug = `e2e-attempt-${runId}`;
      const beforeCounts = {
        tenants: await prisma.tenant.count(),
        authAccounts: await prisma.authAccount.count(),
        tenantUsers: await prisma.tenantUser.count(),
        roles: await prisma.role.count(),
        logEntries: await prisma.logEntry.count(),
      };
      const response = await request(app.getHttpServer())
        .post('/api/v1/super-admin/tenants')
        .set('Authorization', `Bearer ${permittedSystemAccessToken}`)
        .set('Idempotency-Key', `idem-${runId}`)
        .set('x-request-id', `request-${runId}`)
        .set('User-Agent', 'supertest')
        .send({
          tenantName: 'E2E Attempt Tenant',
          tenantSlug,
          firstAdminEmail: 'ADMIN@ATTEMPT.EXAMPLE',
          plan: 'growth',
          password: 'must-not-be-persisted',
          setupToken: 'must-not-be-persisted',
        })
        .expect(202);

      expect(response.body).toEqual({
        success: true,
        data: {
          id: expect.any(String),
          status: 'accepted',
          safePayload: {
            tenantName: 'E2E Attempt Tenant',
            tenantSlug,
            firstAdminEmail: 'admin@attempt.example',
            plan: 'growth',
          },
          actorIdentity: expect.objectContaining({
            actorType: 'system',
            authAccountId: permittedSystemAuthAccountId,
            email: permittedSystemEmail,
            permissions: expect.arrayContaining(['system.tenants.onboard']),
            systemUserId: expect.any(String),
          }),
          requestIdentity: {
            requestId: `request-${runId}`,
            ipAddress: expect.any(String),
            userAgent: expect.any(String),
          },
          idempotencyIdentity: {
            key: `idem-${runId}`,
            source: 'header',
          },
          stepOutcomes: [
            {
              step: 'permission_check',
              status: 'succeeded',
              occurredAt: expect.any(String),
            },
            {
              step: 'payload_validation',
              status: 'succeeded',
              occurredAt: expect.any(String),
            },
            {
              step: 'slug_availability',
              status: 'succeeded',
              occurredAt: expect.any(String),
            },
            {
              step: 'attempt_reservation',
              status: 'succeeded',
              occurredAt: expect.any(String),
            },
          ],
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
        error: null,
      });

      const attemptId = response.body.data.id as string;
      acceptedAttemptIds.push(attemptId);

      await expect(
        prisma.tenant.findUnique({ where: { slug: tenantSlug } }),
      ).resolves.toBeNull();
      await expect(prisma.tenant.count()).resolves.toBe(beforeCounts.tenants);
      await expect(prisma.authAccount.count()).resolves.toBe(
        beforeCounts.authAccounts,
      );
      await expect(prisma.tenantUser.count()).resolves.toBe(
        beforeCounts.tenantUsers,
      );
      await expect(prisma.role.count()).resolves.toBe(beforeCounts.roles);
      await expect(prisma.logEntry.count()).resolves.toBe(
        beforeCounts.logEntries,
      );

      const [attempt] = await prisma.$queryRaw<AttemptRow[]>(
        Prisma.sql`
          SELECT
            "actorSystemUserId",
            "status",
            "safePayload",
            "actorIdentity",
            "requestIdentity",
            "idempotencyKey",
            "idempotencyIdentity",
            "stepOutcomes"
          FROM "tenant_onboarding_attempts"
          WHERE "id" = ${attemptId}
        `,
      );
      expect(attempt.actorSystemUserId).toBe(
        response.body.data.actorIdentity.systemUserId,
      );
      expect(attempt.status).toBe('accepted');
      expect(attempt.safePayload).toEqual({
        tenantName: 'E2E Attempt Tenant',
        tenantSlug,
        firstAdminEmail: 'admin@attempt.example',
        plan: 'growth',
      });
      expect(attempt.actorIdentity).toEqual(response.body.data.actorIdentity);
      expect(attempt.requestIdentity).toEqual(response.body.data.requestIdentity);
      expect(attempt.idempotencyKey).toBe(`idem-${runId}`);
      expect(attempt.idempotencyIdentity).toEqual({
        key: `idem-${runId}`,
        source: 'header',
      });
      expect(attempt.stepOutcomes).toEqual(response.body.data.stepOutcomes);
      expect(JSON.stringify(attempt.safePayload)).not.toContain(
        'must-not-be-persisted',
      );
    });

    it('returns 401 when create attempt has no access token before creating state', async () => {
      const before = await countOnboardingAttempts();
      const response = await request(app.getHttpServer())
        .post('/api/v1/super-admin/tenants')
        .set('Idempotency-Key', `idem-no-token-${runId}`)
        .send({
          tenantName: 'No Token Tenant',
          tenantSlug: `e2e-no-token-${runId}`,
          firstAdminEmail: 'admin@no-token.example',
          plan: 'growth',
        })
        .expect(401);

      expect(response.body).toEqual({
        success: false,
        data: null,
        error: { code: 'UNAUTHORIZED', message: expect.any(String) },
      });
      await expect(countOnboardingAttempts()).resolves.toBe(before);
    });

    it('returns 400 when create attempt has no idempotency key before creating state', async () => {
      const before = await countOnboardingAttempts();
      const response = await request(app.getHttpServer())
        .post('/api/v1/super-admin/tenants')
        .set('Authorization', `Bearer ${permittedSystemAccessToken}`)
        .send({
          tenantName: 'No Idempotency Tenant',
          tenantSlug: `e2e-no-idempotency-${runId}`,
          firstAdminEmail: 'admin@no-idempotency.example',
          plan: 'growth',
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        data: null,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Tenant onboarding request is invalid.',
          fields: {
            idempotencyKey: 'IDEMPOTENCY_KEY_REQUIRED',
          },
        },
      });
      await expect(countOnboardingAttempts()).resolves.toBe(before);
    });

    it('returns 403 when create attempt is called by a SystemUser without permission before creating state', async () => {
      const before = await countOnboardingAttempts();
      const response = await request(app.getHttpServer())
        .post('/api/v1/super-admin/tenants')
        .set('Authorization', `Bearer ${unpermittedSystemAccessToken}`)
        .set('Idempotency-Key', `idem-unpermitted-${runId}`)
        .send({
          tenantName: 'Unpermitted Tenant',
          tenantSlug: `e2e-unpermitted-${runId}`,
          firstAdminEmail: 'admin@unpermitted.example',
          plan: 'growth',
        })
        .expect(403);

      expect(response.body).toEqual({
        success: false,
        data: null,
        error: { code: 'FORBIDDEN', message: expect.any(String) },
      });
      await expect(countOnboardingAttempts()).resolves.toBe(before);
    });

    it('returns 403 when create attempt is called by a tenant actor before creating state', async () => {
      const before = await countOnboardingAttempts();
      const response = await request(app.getHttpServer())
        .post('/api/v1/super-admin/tenants')
        .set('Authorization', `Bearer ${tenantActorAccessToken}`)
        .set('Idempotency-Key', `idem-tenant-actor-${runId}`)
        .send({
          tenantName: 'Tenant Actor Tenant',
          tenantSlug: `e2e-tenant-actor-attempt-${runId}`,
          firstAdminEmail: 'admin@tenant-actor.example',
          plan: 'growth',
        })
        .expect(403);

      expect(response.body).toEqual({
        success: false,
        data: null,
        error: { code: 'FORBIDDEN', message: expect.any(String) },
      });
      await expect(countOnboardingAttempts()).resolves.toBe(before);
    });

    it('returns 400 for invalid create attempt payload before creating state', async () => {
      const before = await countOnboardingAttempts();
      const response = await request(app.getHttpServer())
        .post('/api/v1/super-admin/tenants')
        .set('Authorization', `Bearer ${permittedSystemAccessToken}`)
        .set('Idempotency-Key', `idem-invalid-${runId}`)
        .send({
          tenantName: '',
          tenantSlug: 'Bad Slug',
          firstAdminEmail: 'not-an-email',
          plan: 'unknown',
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        data: null,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Tenant onboarding request is invalid.',
          fields: {
            tenantName: 'TENANT_NAME_REQUIRED',
            tenantSlug: 'SLUG_FORMAT',
            firstAdminEmail: 'EMAIL_FORMAT',
            plan: 'PLAN_REQUIRED',
          },
        },
      });
      await expect(countOnboardingAttempts()).resolves.toBe(before);
    });

    it('returns 409 for an existing tenant slug before creating an attempt', async () => {
      const before = await countOnboardingAttempts();
      const response = await request(app.getHttpServer())
        .post('/api/v1/super-admin/tenants')
        .set('Authorization', `Bearer ${permittedSystemAccessToken}`)
        .set('Idempotency-Key', `idem-duplicate-${runId}`)
        .send({
          tenantName: 'Duplicate Tenant',
          tenantSlug: `e2e-existing-${runId}`,
          firstAdminEmail: 'admin@duplicate.example',
          plan: 'growth',
        })
        .expect(409);

      expect(response.body).toEqual({
        success: false,
        data: null,
        error: { code: 'SLUG_ALREADY_IN_USE', message: expect.any(String) },
      });
      await expect(countOnboardingAttempts()).resolves.toBe(before);
    });
  });

  it('GET /api/health returns an ok envelope', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/health')
      .expect(200);

    expect(response.body).toEqual({
      success: true,
      data: { status: 'ok' },
      error: null,
    });
  });

  it('GET /api/does-not-exist returns the standard error envelope', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/does-not-exist')
      .expect(404);

    expect(response.body.success).toBe(false);
    expect(response.body.data).toBeNull();
    expect(response.body.error).toEqual(
      expect.objectContaining({
        code: expect.any(String),
        message: expect.any(String),
      }),
    );
  });

  /**
   * spec-auth-rate-limiting.md (Spec Change Log, loop 1): the metadata-only
   * controller-spec test proves the `@UseGuards(ThrottlerGuard)` decorator
   * is present, but NOT that it actually throttles -- a miswired guard
   * (e.g. options resolving to Infinity, canActivate always true) would
   * still pass that test. This block is the one place that boots the real
   * DI graph and asserts an actual HTTP 429 once AUTH_THROTTLE_LIMIT is
   * exceeded, closing that gap. AUTH_THROTTLE_LIMIT is overridden to 20 at
   * the top of this file (see process.env.AUTH_THROTTLE_LIMIT above) --
   * comfortably above the handful of login/refresh calls the earlier tests
   * in this file already made on the same IP-keyed bucket, so those aren't
   * affected, and low enough that sending LIMIT + 1 requests here is fast.
   */
  describe('Rate limiting on login/refresh', () => {
    const THROTTLE_LIMIT = Number(process.env.AUTH_THROTTLE_LIMIT);

    it('returns 429 on the request after the login limit is exceeded', async () => {
      let lastStatus = 0;
      for (let i = 0; i < THROTTLE_LIMIT + 1; i += 1) {
        const response = await request(app.getHttpServer())
          .post('/api/auth/login')
          .send({ email: 'rate-limit-probe@example.com', password: 'wrong' });
        lastStatus = response.status;
      }

      expect(lastStatus).toBe(429);
    });

    it('returns 429 on the request after the refresh limit is exceeded', async () => {
      let lastStatus = 0;
      for (let i = 0; i < THROTTLE_LIMIT + 1; i += 1) {
        const response = await request(app.getHttpServer())
          .post('/api/auth/refresh')
          .send({ refreshToken: 'bogus-refresh-token' });
        lastStatus = response.status;
      }

      expect(lastStatus).toBe(429);
    });

    it('never throttles GET /api/auth/me even past the login/refresh limit', async () => {
      let sawThrottled = false;
      for (let i = 0; i < THROTTLE_LIMIT + 1; i += 1) {
        const response = await request(app.getHttpServer()).get('/api/auth/me');
        if (response.status === 429) {
          sawThrottled = true;
        }
      }

      expect(sawThrottled).toBe(false);
    });

    it('never throttles POST /api/auth/logout even past the login/refresh limit', async () => {
      let sawThrottled = false;
      for (let i = 0; i < THROTTLE_LIMIT + 1; i += 1) {
        const response = await request(app.getHttpServer())
          .post('/api/auth/logout')
          .send({ refreshToken: 'irrelevant' });
        if (response.status === 429) {
          sawThrottled = true;
        }
      }

      expect(sawThrottled).toBe(false);
    });
  });
});
