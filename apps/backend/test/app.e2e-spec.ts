import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { FEATURE_MODULES } from '@flexi/shared-types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

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

      // The original (now-rotated) refresh token must be rejected.
      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken })
        .expect(401);

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
});
