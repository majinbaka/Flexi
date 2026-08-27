import { createHash } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import {
  FEATURE_MODULES,
  SYSTEM_TENANTS_ONBOARD_PERMISSION,
  SYSTEM_TENANTS_READ_PERMISSION,
  SYSTEM_TENANTS_SETUP_LINK_PERMISSION,
} from '@flexi/shared-types';
import type { AppModule as AppModuleType } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TENANT_PROVISIONING_QUEUE_NAME } from '../src/modules/tenants/provisioning.types';
import { resolveTenantSchema } from '../src/tenancy/resolve-tenant-schema';

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
  provisioningJobId: string | null;
  safePayload: unknown;
  actorIdentity: unknown;
  requestIdentity: unknown;
  idempotencyKey: string;
  idempotencyIdentity: unknown;
  stepOutcomes: unknown;
}

const TERMINAL_ATTEMPT_STATUSES = new Set([
  'succeeded',
  'failed',
  'failed-needs-manual-cleanup',
]);
const TERMINAL_JOB_STATES = new Set(['completed', 'failed']);
const PROVISIONING_POLL_INTERVAL_MS = 100;
const PROVISIONING_POLL_ATTEMPTS = 50;
const ONBOARDING_STATUS_POLL_INTERVAL_MS = 25;
const ONBOARDING_STATUS_POLL_ATTEMPTS = 200;

describe('AppModule (e2e)', () => {
  let app: INestApplication;
  let provisioningQueue: Queue;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    provisioningQueue = moduleFixture.get<Queue>(
      getQueueToken(TENANT_PROVISIONING_QUEUE_NAME),
    );
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

      for (const status of ['PROVISIONING', 'FAILED', 'SUSPENDED']) {
        await prisma.$executeRaw(
          Prisma.sql`
            UPDATE "tenants"
            SET "status" = ${status}
            WHERE "id" = ${tenantId}
          `,
        );
        await request(app.getHttpServer())
          .post('/api/auth/login')
          .set('x-tenant-id', tenantId)
          .send({ email, password })
          .expect(401);
        await request(app.getHttpServer())
          .get('/api/auth/me')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(401);
        await prisma.$executeRaw(
          Prisma.sql`
            UPDATE "tenants"
            SET "status" = 'ACTIVE'
            WHERE "id" = ${tenantId}
          `,
        );
      }

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

  /**
   * Password recovery end to end against the real database.
   *
   * SMTP is disabled under `NODE_ENV=test`, so the emailed code cannot be
   * read back -- and it is a SHA-256 hash at rest, so it cannot be
   * recovered from the row either. The request half is therefore verified
   * by what it persists, and the redemption half by planting a row whose
   * plaintext this test already knows.
   *
   * Both routes carry their own throttle budget (3 and 5 per 15 minutes),
   * which is small enough that the request counts below are deliberate:
   * the fourth `forgot-password` call is the assertion that the budget is
   * real, not an accident.
   */
  describe('Password recovery (tenant actor)', () => {
    let prisma: PrismaService;
    let tenantId: string;
    let authAccountId: string;
    const email = `e2e-recovery-${Date.now()}@example.com`;
    const originalPassword = 'E2eOriginal123!';
    const newPassword = 'E2eReplacement456!';
    const plantedOtp = '424242';

    function hashOtp(otp: string): string {
      return createHash('sha256').update(otp).digest('hex');
    }

    beforeAll(async () => {
      prisma = app.get(PrismaService);

      const tenant = await prisma.tenant.create({
        data: {
          name: 'E2E Recovery Tenant',
          slug: `e2e-recovery-${Date.now()}`,
        },
      });
      tenantId = tenant.id;

      const authAccount = await prisma.authAccount.create({
        data: { email, passwordHash: await bcrypt.hash(originalPassword, 4) },
      });
      authAccountId = authAccount.id;

      await prisma.tenantUser.create({
        data: {
          tenantId,
          authAccountId: authAccount.id,
          name: 'E2E Recovery User',
        },
      });
    });

    afterAll(async () => {
      await prisma.tenant.delete({ where: { id: tenantId } });
      await prisma.authAccount.delete({ where: { id: authAccountId } });
    });

    it('issues exactly one code, stays silent about unknown addresses, and enforces its budget', async () => {
      // 1. A live account: answers 200 and persists a hash-only row.
      await request(app.getHttpServer())
        .post('/api/auth/forgot-password')
        .set('x-tenant-id', tenantId)
        .send({ email })
        .expect(200)
        .expect((response) => {
          expect(response.body).toEqual({
            success: true,
            data: {},
            error: null,
          });
        });

      const issued = await prisma.passwordResetOtp.findMany({
        where: { authAccountId },
      });
      expect(issued).toHaveLength(1);
      expect(issued[0].otpHash).toMatch(/^[0-9a-f]{64}$/);
      expect(issued[0].consumedAt).toBeNull();
      expect(issued[0].attemptCount).toBe(0);
      expect(issued[0].expiresAt.getTime()).toBeGreaterThan(Date.now());

      // 2. Immediately again: the 60-second cooldown suppresses the resend,
      //    with an identical response.
      await request(app.getHttpServer())
        .post('/api/auth/forgot-password')
        .set('x-tenant-id', tenantId)
        .send({ email })
        .expect(200);
      await expect(
        prisma.passwordResetOtp.count({ where: { authAccountId } }),
      ).resolves.toBe(1);

      // 3. An address with no account: same 200, same empty body, nothing
      //    written -- the endpoint cannot be used to enumerate accounts.
      await request(app.getHttpServer())
        .post('/api/auth/forgot-password')
        .set('x-tenant-id', tenantId)
        .send({ email: `e2e-nobody-${Date.now()}@example.com` })
        .expect(200)
        .expect((response) => {
          expect(response.body).toEqual({
            success: true,
            data: {},
            error: null,
          });
        });

      // 4. Budget spent.
      await request(app.getHttpServer())
        .post('/api/auth/forgot-password')
        .set('x-tenant-id', tenantId)
        .send({ email })
        .expect(429);
    });

    it('redeems a code once, revokes every session, and rejects the replay', async () => {
      // A live session that the reset must kill.
      const login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .set('x-tenant-id', tenantId)
        .send({ email, password: originalPassword })
        .expect(200);
      const refreshToken = login.body.data.refreshToken as string;

      // Plant a code whose plaintext this test knows, replacing whatever
      // the previous test issued.
      await prisma.passwordResetOtp.updateMany({
        where: { authAccountId, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await prisma.passwordResetOtp.create({
        data: {
          authAccountId,
          otpHash: hashOtp(plantedOtp),
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        },
      });

      // A wrong code spends an attempt without burning the code.
      await request(app.getHttpServer())
        .post('/api/auth/reset-password')
        .set('x-tenant-id', tenantId)
        .send({ email, otp: '000000', newPassword })
        .expect(400)
        .expect((response) => {
          expect(response.body.error.code).toBe('INVALID_OTP');
        });

      const afterWrongAttempt = await prisma.passwordResetOtp.findFirst({
        where: { authAccountId, consumedAt: null },
      });
      expect(afterWrongAttempt?.attemptCount).toBe(1);

      // A weak password is rejected on its own terms, before the code is
      // ever looked at -- so it costs no further attempt.
      await request(app.getHttpServer())
        .post('/api/auth/reset-password')
        .set('x-tenant-id', tenantId)
        .send({ email, otp: plantedOtp, newPassword: 'weak' })
        .expect(400)
        .expect((response) => {
          expect(response.body.error.code).toBe('PASSWORD_POLICY_VIOLATION');
        });
      await expect(
        prisma.passwordResetOtp
          .findFirst({ where: { authAccountId, consumedAt: null } })
          .then((row) => row?.attemptCount),
      ).resolves.toBe(1);

      // The real thing.
      await request(app.getHttpServer())
        .post('/api/auth/reset-password')
        .set('x-tenant-id', tenantId)
        .send({ email, otp: plantedOtp, newPassword })
        .expect(200);

      // The code is consumed, so replaying it is just another invalid code.
      await request(app.getHttpServer())
        .post('/api/auth/reset-password')
        .set('x-tenant-id', tenantId)
        .send({ email, otp: plantedOtp, newPassword })
        .expect(400)
        .expect((response) => {
          expect(response.body.error.code).toBe('INVALID_OTP');
        });

      // The session that existed before the reset is dead.
      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken })
        .expect(401);

      // And the new password is the one that works.
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .set('x-tenant-id', tenantId)
        .send({ email, password: originalPassword })
        .expect(401);
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .set('x-tenant-id', tenantId)
        .send({ email, password: newPassword })
        .expect(200);
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

    async function createAcceptedOnboardingAttempt(input: {
      idempotencyKey: string;
      tenantName: string;
      tenantSlug: string;
      firstAdminEmail: string;
      plan: 'starter' | 'growth' | 'enterprise';
    }) {
      const response = await request(app.getHttpServer())
        .post('/api/v1/super-admin/tenants')
        .set('Authorization', `Bearer ${permittedSystemAccessToken}`)
        .set('Idempotency-Key', input.idempotencyKey)
        .send({
          tenantName: input.tenantName,
          tenantSlug: input.tenantSlug,
          firstAdminEmail: input.firstAdminEmail,
          plan: input.plan,
        })
        .expect(202);

      acceptedAttemptIds.push(response.body.data.id as string);
      return response.body.data as {
        id: string;
        safePayload: {
          tenantName: string;
          tenantSlug: string;
          firstAdminEmail: string;
          plan: string;
        };
      };
    }

    async function waitForTerminalProvisioning(
      attemptId: string,
      slug: string,
    ) {
      for (let index = 0; index < PROVISIONING_POLL_ATTEMPTS; index += 1) {
        const [tenant] = await prisma.$queryRaw<
          Array<{
            id: string;
            slug: string;
            status: string;
            onboardingAttemptId: string | null;
          }>
        >(
          Prisma.sql`
            SELECT
              "id",
              "slug",
              "status",
              "onboardingAttemptId"
            FROM "tenants"
            WHERE "slug" = ${slug}
            LIMIT 1
          `,
        );
        const [attempt] = await prisma.$queryRaw<AttemptRow[]>(
          Prisma.sql`
            SELECT
              "actorSystemUserId",
              "status",
              "provisioningJobId",
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
        const audit = await prisma.tenantOnboardingAuditLog.findUnique({
          where: { attemptId },
          select: { finalStatus: true },
        });
        const job = await provisioningQueue.getJob(
          `tenant-provisioning-${attemptId}`,
        );
        const jobState = job ? await job.getState() : null;

        const stepOutcomes = Array.isArray(attempt?.stepOutcomes)
          ? attempt.stepOutcomes
          : [];
        const auditFinalized = stepOutcomes.some(
          (outcome) =>
            typeof outcome === 'object' &&
            outcome !== null &&
            (outcome as { step?: unknown }).step === 'audit_finalized' &&
            (outcome as { status?: unknown }).status === 'succeeded',
        );

        if (
          tenant &&
          attempt &&
          TERMINAL_ATTEMPT_STATUSES.has(attempt.status) &&
          audit?.finalStatus === attempt.status &&
          auditFinalized &&
          (job === undefined ||
            job === null ||
            TERMINAL_JOB_STATES.has(jobState ?? ''))
        ) {
          return { tenant, attempt, audit, job };
        }

        await new Promise((resolve) =>
          setTimeout(resolve, PROVISIONING_POLL_INTERVAL_MS),
        );
      }

      throw new Error(
        `Timed out waiting for terminal provisioning attempt ${attemptId}`,
      );
    }

    async function pollOnboardingAttemptStatus(attemptId: string) {
      const observedStatuses = new Set<string>();

      for (let index = 0; index < ONBOARDING_STATUS_POLL_ATTEMPTS; index += 1) {
        const response = await request(app.getHttpServer())
          .get(`/api/v1/super-admin/tenants/onboarding-attempts/${attemptId}`)
          .set('Authorization', `Bearer ${permittedSystemAccessToken}`)
          .expect(200);
        const data = response.body.data as {
          status: string;
          audit: { finalStatus: string } | null;
        };
        observedStatuses.add(data.status);

        if (TERMINAL_ATTEMPT_STATUSES.has(data.status)) {
          return { data: response.body.data, observedStatuses };
        }

        await new Promise((resolve) =>
          setTimeout(resolve, ONBOARDING_STATUS_POLL_INTERVAL_MS),
        );
      }

      throw new Error(
        `Timed out polling onboarding attempt status ${attemptId}`,
      );
    }

    beforeAll(async () => {
      prisma = app.get(PrismaService);
      const passwordHash = await bcrypt.hash(password, 4);

      const onboardingPermission = await prisma.permission.upsert({
        where: { code: SYSTEM_TENANTS_ONBOARD_PERMISSION },
        update: {},
        create: {
          code: SYSTEM_TENANTS_ONBOARD_PERMISSION,
          description: 'Start tenant onboarding intake as a SystemUser',
          scope: 'SYSTEM',
        },
      });
      const tenantReadPermission = await prisma.permission.upsert({
        where: { code: SYSTEM_TENANTS_READ_PERMISSION },
        update: {},
        create: {
          code: SYSTEM_TENANTS_READ_PERMISSION,
          description: 'List tenant records as a SystemUser',
          scope: 'SYSTEM',
        },
      });
      const setupLinkPermission = await prisma.permission.upsert({
        where: { code: SYSTEM_TENANTS_SETUP_LINK_PERMISSION },
        update: {},
        create: {
          code: SYSTEM_TENANTS_SETUP_LINK_PERMISSION,
          description: 'Regenerate a tenant setup link as a SystemUser',
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
              { permissionId: tenantReadPermission.id },
              { permissionId: setupLinkPermission.id },
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
      const terminalProvisioning = await Promise.all(
        acceptedAttemptIds.map(async (attemptId) => {
          const attempt = await prisma.tenantOnboardingAttempt.findUnique({
            where: { id: attemptId },
            select: { safePayload: true },
          });
          const payload = attempt?.safePayload as { tenantSlug?: string };

          return waitForTerminalProvisioning(
            attemptId,
            payload.tenantSlug ?? '',
          );
        }),
      );
      const provisionedTenantIds = terminalProvisioning.map(
        ({ tenant }) => tenant.id,
      );
      const firstAdminAuthAccounts = await prisma.tenantUser.findMany({
        where: { tenantId: { in: provisionedTenantIds } },
        select: { authAccountId: true },
      });

      await Promise.all(
        terminalProvisioning.map(async ({ job }) => {
          if (job) {
            await job.remove();
          }
        }),
      );
      await prisma.tenantOnboardingAuditLog.deleteMany({
        where: { attemptId: { in: acceptedAttemptIds } },
      });
      await prisma.tenant.deleteMany({
        where: { id: { in: provisionedTenantIds } },
      });
      await prisma.authAccount.deleteMany({
        where: {
          id: {
            in: firstAdminAuthAccounts.map(
              ({ authAccountId }) => authAccountId,
            ),
          },
        },
      });
      await Promise.all(
        provisionedTenantIds.map((tenantId) =>
          prisma.$executeRaw(
            Prisma.sql`DROP SCHEMA IF EXISTS ${Prisma.raw(resolveTenantSchema(tenantId))} CASCADE`,
          ),
        ),
      );
      await prisma.tenantOnboardingAttempt.deleteMany({
        where: { id: { in: acceptedAttemptIds } },
      });
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

    it('lists tenants for a SystemUser with tenant read permission', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/super-admin/tenants')
        .set('Authorization', `Bearer ${permittedSystemAccessToken}`)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: {
          items: expect.arrayContaining([
            expect.objectContaining({ id: existingTenantId }),
          ]),
          meta: {
            total: expect.any(Number),
            page: 1,
            pageSize: 20,
          },
        },
        error: null,
      });
    });

    it('returns 401 when tenant list has no access token', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/super-admin/tenants')
        .expect(401);

      expect(response.body).toEqual({
        success: false,
        data: null,
        error: { code: 'UNAUTHORIZED', message: expect.any(String) },
      });
    });

    it('returns 403 when a SystemUser lacks tenant read permission', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/super-admin/tenants')
        .set('Authorization', `Bearer ${unpermittedSystemAccessToken}`)
        .expect(403);

      expect(response.body).toEqual({
        success: false,
        data: null,
        error: { code: 'FORBIDDEN', message: expect.any(String) },
      });
    });

    it('returns 401, 403, and 404 for unavailable onboarding attempt status reads', async () => {
      const path = `/api/v1/super-admin/tenants/onboarding-attempts/missing-${runId}`;

      await request(app.getHttpServer())
        .get(path)
        .expect(401)
        .then((response) => {
          expect(response.body).toEqual({
            success: false,
            data: null,
            error: { code: 'UNAUTHORIZED', message: expect.any(String) },
          });
        });

      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${unpermittedSystemAccessToken}`)
        .expect(403)
        .then((response) => {
          expect(response.body).toEqual({
            success: false,
            data: null,
            error: { code: 'FORBIDDEN', message: expect.any(String) },
          });
        });

      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${permittedSystemAccessToken}`)
        .expect(404)
        .then((response) => {
          expect(response.body).toEqual({
            success: false,
            data: null,
            error: {
              code: 'ONBOARDING_ATTEMPT_NOT_FOUND',
              message: 'Onboarding attempt was not found.',
            },
          });
        });
    });

    it('polls a permitted onboarding attempt from accepted through provisioning to a redacted terminal result', async () => {
      await provisioningQueue.pause();
      let attemptId: string | undefined;

      try {
        const created = await createAcceptedOnboardingAttempt({
          idempotencyKey: `idem-status-poll-${runId}`,
          tenantName: 'E2E Status Poll Tenant',
          tenantSlug: `e2e-status-poll-${runId}`,
          firstAdminEmail: 'admin@status-poll.example',
          plan: 'growth',
        });
        attemptId = created.id;

        const acceptedResponse = await request(app.getHttpServer())
          .get(`/api/v1/super-admin/tenants/onboarding-attempts/${attemptId}`)
          .set('Authorization', `Bearer ${permittedSystemAccessToken}`)
          .expect(200);
        expect(acceptedResponse.body).toMatchObject({
          success: true,
          data: {
            id: attemptId,
            status: 'accepted',
            audit: null,
          },
          error: null,
        });

        await provisioningQueue.resume();
        const { data, observedStatuses } =
          await pollOnboardingAttemptStatus(attemptId);

        expect(['accepted', ...observedStatuses]).toEqual(
          expect.arrayContaining(['accepted', 'provisioning']),
        );
        expect(TERMINAL_ATTEMPT_STATUSES.has(data.status)).toBe(true);
        expect(data.audit).toEqual(
          expect.objectContaining({
            finalStatus: data.status,
            recordedAt: expect.any(String),
          }),
        );
        expect(data).toEqual(
          expect.objectContaining({
            id: attemptId,
            stepOutcomes: expect.any(Array),
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
          }),
        );
        expect(data).not.toHaveProperty('safePayload');
        expect(data).not.toHaveProperty('actorIdentity');
        expect(data).not.toHaveProperty('requestIdentity');
        expect(data).not.toHaveProperty('idempotencyIdentity');
        expect(JSON.stringify(data)).not.toContain('admin@status-poll.example');
        expect(JSON.stringify(data)).not.toContain(`idem-status-poll-${runId}`);
      } finally {
        await provisioningQueue.resume();
      }

      expect(attemptId).toEqual(expect.any(String));
    });

    it('returns an available slug envelope for a SystemUser with onboarding permission', async () => {
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

    it('regenerates a setup link for a SystemUser with setup-link permission', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/super-admin/tenants/${tenantActorTenantId}/setup-link`)
        .set('Authorization', `Bearer ${permittedSystemAccessToken}`)
        .expect(201);

      expect(response.body).toEqual({
        success: true,
        data: {
          tenantId: tenantActorTenantId,
          setupToken: expect.any(String),
          expiresAt: expect.any(String),
        },
        error: null,
      });
    });

    it('returns 401 when setup link regeneration has no access token', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/super-admin/tenants/${tenantActorTenantId}/setup-link`)
        .expect(401);

      expect(response.body).toEqual({
        success: false,
        data: null,
        error: { code: 'UNAUTHORIZED', message: expect.any(String) },
      });
    });

    it('returns 403 when a SystemUser lacks setup-link permission', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/super-admin/tenants/${tenantActorTenantId}/setup-link`)
        .set('Authorization', `Bearer ${unpermittedSystemAccessToken}`)
        .expect(403);

      expect(response.body).toEqual({
        success: false,
        data: null,
        error: { code: 'FORBIDDEN', message: expect.any(String) },
      });
    });

    it('creates a durable onboarding attempt and asynchronously starts tenant lifecycle for a permitted SystemUser', async () => {
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
          idempotencyOutcome: {
            replayed: false,
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

      const { tenant, attempt, audit } = await waitForTerminalProvisioning(
        attemptId,
        tenantSlug,
      );
      expect(tenant).toEqual({
        id: expect.any(String),
        slug: tenantSlug,
        status: 'ACTIVE',
        onboardingAttemptId: attemptId,
      });
      await expect(prisma.tenant.count()).resolves.toBe(
        beforeCounts.tenants + 1,
      );
      await expect(prisma.authAccount.count()).resolves.toBe(
        beforeCounts.authAccounts + 1,
      );
      await expect(prisma.tenantUser.count()).resolves.toBe(
        beforeCounts.tenantUsers + 1,
      );
      await expect(prisma.role.count()).resolves.toBe(beforeCounts.roles + 1);
      await expect(prisma.logEntry.count()).resolves.toBe(
        beforeCounts.logEntries,
      );

      expect(attempt.actorSystemUserId).toBe(
        response.body.data.actorIdentity.systemUserId,
      );
      expect(attempt.status).toBe('succeeded');
      expect(attempt.provisioningJobId).toBe(
        `tenant-provisioning-${attemptId}`,
      );
      expect(attempt.safePayload).toEqual({
        tenantName: 'E2E Attempt Tenant',
        tenantSlug,
        firstAdminEmail: 'admin@attempt.example',
        plan: 'growth' as const,
      });
      expect(attempt.actorIdentity).toEqual(response.body.data.actorIdentity);
      expect(attempt.requestIdentity).toEqual(
        response.body.data.requestIdentity,
      );
      expect(attempt.idempotencyKey).toBe(`idem-${runId}`);
      expect(attempt.idempotencyIdentity).toEqual({
        key: `idem-${runId}`,
        source: 'header',
      });
      expect(attempt.stepOutcomes).toHaveLength(14);
      expect(attempt.stepOutcomes).toEqual(
        expect.arrayContaining([
          ...response.body.data.stepOutcomes,
          {
            step: 'provisioning_start',
            status: 'running',
            occurredAt: expect.any(String),
          },
          {
            step: 'tenant_creation',
            status: 'succeeded',
            occurredAt: expect.any(String),
            tenantId: tenant.id,
            tenantSlug,
            tenantStatus: 'PROVISIONING',
          },
          {
            step: 'schema_created',
            status: 'succeeded',
            occurredAt: expect.any(String),
            tenantId: tenant.id,
          },
          {
            step: 'bootstrap_migrated',
            status: 'succeeded',
            occurredAt: expect.any(String),
            tenantId: tenant.id,
          },
          {
            step: 'bootstrap_seeded',
            status: 'succeeded',
            occurredAt: expect.any(String),
            tenantId: tenant.id,
          },
          {
            step: 'first_admin_assigned',
            status: 'succeeded',
            occurredAt: expect.any(String),
            tenantId: tenant.id,
          },
          {
            step: 'setup_link_generated',
            status: 'succeeded',
            occurredAt: expect.any(String),
            tenantId: tenant.id,
          },
          {
            step: 'setup_email_sent',
            status: 'failed',
            occurredAt: expect.any(String),
            tenantId: tenant.id,
            errorCode: 'SMTP_NOT_CONFIGURED',
            message: 'Backup setup email delivery failed.',
          },
          {
            step: 'activation',
            status: 'succeeded',
            occurredAt: expect.any(String),
            tenantId: tenant.id,
            tenantSlug,
            tenantStatus: 'ACTIVE',
          },
          {
            step: 'audit_finalized',
            status: 'succeeded',
            occurredAt: expect.any(String),
            tenantId: tenant.id,
          },
        ]),
      );
      expect(audit).toEqual({ finalStatus: 'succeeded' });
      expect(JSON.stringify(attempt.safePayload)).not.toContain(
        'must-not-be-persisted',
      );
    });

    it('returns the existing onboarding attempt for a matching idempotent retry without inserting a duplicate', async () => {
      const seed = await createAcceptedOnboardingAttempt({
        idempotencyKey: `idem-retry-${runId}`,
        tenantName: 'E2E Retry Tenant',
        tenantSlug: `e2e-retry-${runId}`,
        firstAdminEmail: 'ADMIN@RETRY.EXAMPLE',
        plan: 'growth' as const,
      });
      const before = await countOnboardingAttempts();
      const response = await request(app.getHttpServer())
        .post('/api/v1/super-admin/tenants')
        .set('Authorization', `Bearer ${permittedSystemAccessToken}`)
        .set('Idempotency-Key', `idem-retry-${runId}`)
        .set('x-request-id', `request-retry-${runId}`)
        .send({
          tenantName: ' E2E Retry Tenant ',
          tenantSlug: `e2e-retry-${runId}`,
          firstAdminEmail: 'admin@retry.example',
          plan: 'growth',
        })
        .expect(202);

      expect(response.body).toMatchObject({
        success: true,
        data: {
          id: seed.id,
          safePayload: {
            tenantName: 'E2E Retry Tenant',
            tenantSlug: `e2e-retry-${runId}`,
            firstAdminEmail: 'admin@retry.example',
            plan: 'growth',
          },
          idempotencyOutcome: {
            replayed: true,
            existingAttemptId: seed.id,
          },
        },
        error: null,
      });
      expect(['accepted', 'provisioning', 'succeeded']).toContain(
        response.body.data.status,
      );
      const terminal = await waitForTerminalProvisioning(
        seed.id,
        `e2e-retry-${runId}`,
      );
      expect(terminal.attempt.status).toBe('succeeded');
      expect(terminal.tenant.status).toBe('ACTIVE');
      await expect(countOnboardingAttempts()).resolves.toBe(before);
    });

    it('returns a safe idempotency conflict for mismatched payload reuse without inserting state', async () => {
      const seed = await createAcceptedOnboardingAttempt({
        idempotencyKey: `idem-conflict-${runId}`,
        tenantName: 'E2E Conflict Seed Tenant',
        tenantSlug: `e2e-conflict-seed-${runId}`,
        firstAdminEmail: 'admin@conflict-seed.example',
        plan: 'starter',
      });
      const before = await countOnboardingAttempts();
      const response = await request(app.getHttpServer())
        .post('/api/v1/super-admin/tenants')
        .set('Authorization', `Bearer ${permittedSystemAccessToken}`)
        .set('Idempotency-Key', `idem-conflict-${runId}`)
        .send({
          tenantName: 'Different E2E Tenant',
          tenantSlug: `e2e-different-${runId}`,
          firstAdminEmail: 'admin@different.example',
          plan: 'enterprise',
        })
        .expect(409);

      expect(response.body).toEqual({
        success: false,
        data: null,
        error: {
          code: 'IDEMPOTENCY_CONFLICT',
          message: expect.any(String),
          existingAttemptId: seed.id,
        },
      });
      await expect(countOnboardingAttempts()).resolves.toBe(before);
    });

    it('repeatedly handles concurrent matching idempotent submits with one persisted attempt per key', async () => {
      const before = await countOnboardingAttempts();
      const rounds = await Promise.all(
        Array.from({ length: 3 }, async (_, index) => {
          const tenantSlug = `e2e-concurrent-${runId}-${index}`;
          const idempotencyKey = `idem-concurrent-${runId}-${index}`;
          const payload = {
            tenantName: `E2E Concurrent Tenant ${index}`,
            tenantSlug,
            firstAdminEmail: `admin-concurrent-${index}@example.com`,
            plan: 'growth' as const,
          };
          const responses = await Promise.all([
            request(app.getHttpServer())
              .post('/api/v1/super-admin/tenants')
              .set('Authorization', `Bearer ${permittedSystemAccessToken}`)
              .set('Idempotency-Key', idempotencyKey)
              .send(payload)
              .expect(202),
            request(app.getHttpServer())
              .post('/api/v1/super-admin/tenants')
              .set('Authorization', `Bearer ${permittedSystemAccessToken}`)
              .set('Idempotency-Key', idempotencyKey)
              .send(payload)
              .expect(202),
          ]);

          const attemptIds = responses.map(
            (response) => response.body.data.id as string,
          );
          expect(new Set(attemptIds).size).toBe(1);
          expect(
            responses.map((response) => response.body.data.idempotencyOutcome),
          ).toEqual(
            expect.arrayContaining([
              { replayed: false },
              { replayed: true, existingAttemptId: attemptIds[0] },
            ]),
          );

          return attemptIds[0];
        }),
      );

      acceptedAttemptIds.push(...rounds);
      await expect(countOnboardingAttempts()).resolves.toBe(
        before + rounds.length,
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
