import { createHash } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import * as bcrypt from 'bcryptjs';
import { ActorType, AuthenticatedUserDto } from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { TenancyClsStore } from '../../tenancy/tenant-context';

/**
 * Unit-tests every I/O Matrix row from spec-core-authentication.md that
 * AuthService itself is responsible for (login, refresh rotation/reuse,
 * logout, and me()'s actor-type-aware permission check). The 401 case for
 * GET /api/auth/me (missing/invalid token) is JwtAuthGuard's job, not
 * AuthService's -- see jwt-auth.guard.spec-equivalent coverage below in
 * the "JwtAuthGuard" describe block, since by the time AuthService.me() is
 * called a decoded caller already exists.
 */

const ACCESS_SECRET = 'test-access-secret';
const REFRESH_SECRET = 'test-refresh-secret';

/** Minimal stand-in for ConfigService.get, keyed the same as env.validation.ts. */
class FakeConfigService {
  private readonly values: Record<string, string> = {
    JWT_ACCESS_SECRET: ACCESS_SECRET,
    JWT_REFRESH_SECRET: REFRESH_SECRET,
    JWT_ACCESS_EXPIRES_IN: '15m',
    JWT_REFRESH_EXPIRES_IN: '7d',
  };

  get<T = string>(key: string, defaultValue?: T): T {
    const value = this.values[key];
    return (value === undefined ? defaultValue : (value as unknown as T)) as T;
  }
}

interface PrismaMock {
  tenantUser: {
    findFirst: jest.Mock;
  };
  systemUser: {
    findFirst: jest.Mock;
  };
  refreshToken: {
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
}

function createPrismaMock(): PrismaMock {
  return {
    tenantUser: { findFirst: jest.fn() },
    systemUser: { findFirst: jest.fn() },
    refreshToken: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };
}

describe('AuthService', () => {
  let prisma: PrismaMock;
  let jwtService: JwtService;
  let service: AuthService;
  let passwordHash: string;

  const TENANT_ROLE = {
    name: 'Admin',
    rolePermissions: [{ permission: { code: 'auth.me.read' } }],
  };
  const SYSTEM_ROLE = {
    name: 'PlatformAdmin',
    rolePermissions: [{ permission: { code: 'system.me.read' } }],
  };

  beforeAll(async () => {
    // Low cost factor -- this only needs to be a valid bcrypt hash, not a
    // realistic production one, and running at default cost in a unit
    // suite is needlessly slow.
    passwordHash = await bcrypt.hash('correct-password', 4);
  });

  beforeEach(() => {
    prisma = createPrismaMock();
    jwtService = new JwtService({});
    service = new AuthService(
      prisma as unknown as PrismaService,
      jwtService,
      new FakeConfigService() as unknown as ConfigService,
    );
  });

  // -------------------------------------------------------------------
  // login
  // -------------------------------------------------------------------

  describe('login', () => {
    it('issues a tenant access token when x-tenant-id resolves a TenantUser (valid tenant login)', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'tu_1',
        tenantId: 'tenant_1',
        authAccountId: 'aa_1',
        name: 'Demo Admin',
        isActive: true,
        authAccount: {
          id: 'aa_1',
          email: 'admin@demo.local',
          passwordHash,
          isActive: true,
        },
        roles: [TENANT_ROLE],
      });

      const tokens = await service.login(
        { email: 'admin@demo.local', password: 'correct-password' },
        'tenant_1',
      );

      expect(tokens.accessToken).toEqual(expect.any(String));
      expect(tokens.refreshToken).toEqual(expect.any(String));
      expect(tokens.expiresIn).toBe(15 * 60);

      const decoded = jwtService.decode(tokens.accessToken) as Record<
        string,
        unknown
      >;
      expect(decoded.actorType).toBe(ActorType.TENANT);
      expect(decoded.tenantId).toBe('tenant_1');
      expect(decoded.tenantUserId).toBe('tu_1');
      expect(decoded.permissions).toContain('auth.me.read');

      expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
    });

    it('issues a system access token when no x-tenant-id header resolves a SystemUser (valid system login)', async () => {
      prisma.systemUser.findFirst.mockResolvedValue({
        id: 'su_1',
        authAccountId: 'aa_2',
        name: 'Demo Super Admin',
        isActive: true,
        authAccount: {
          id: 'aa_2',
          email: 'super@flexi.local',
          passwordHash,
          isActive: true,
        },
        roles: [SYSTEM_ROLE],
      });

      const tokens = await service.login(
        { email: 'super@flexi.local', password: 'correct-password' },
        undefined,
      );

      const decoded = jwtService.decode(tokens.accessToken) as Record<
        string,
        unknown
      >;
      expect(decoded.actorType).toBe(ActorType.SYSTEM);
      expect(decoded.systemUserId).toBe('su_1');
      expect(decoded.permissions).toContain('system.me.read');
    });

    it('rejects an unknown email with 401 INVALID_CREDENTIALS', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(null);

      await expect(
        service.login(
          { email: 'nobody@demo.local', password: 'whatever' },
          'tenant_1',
        ),
      ).rejects.toMatchObject({
        status: 401,
        response: { error: 'INVALID_CREDENTIALS' },
      });
    });

    it('rejects a wrong password with 401 INVALID_CREDENTIALS', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'tu_1',
        tenantId: 'tenant_1',
        authAccountId: 'aa_1',
        name: 'Demo Admin',
        isActive: true,
        authAccount: {
          id: 'aa_1',
          email: 'admin@demo.local',
          passwordHash,
          isActive: true,
        },
        roles: [TENANT_ROLE],
      });

      await expect(
        service.login(
          { email: 'admin@demo.local', password: 'wrong-password' },
          'tenant_1',
        ),
      ).rejects.toMatchObject({
        status: 401,
        response: { error: 'INVALID_CREDENTIALS' },
      });
    });

    it('rejects an inactive account with 401 INVALID_CREDENTIALS', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'tu_1',
        tenantId: 'tenant_1',
        authAccountId: 'aa_1',
        name: 'Demo Admin',
        isActive: true,
        authAccount: {
          id: 'aa_1',
          email: 'admin@demo.local',
          passwordHash,
          isActive: false,
        },
        roles: [TENANT_ROLE],
      });

      await expect(
        service.login(
          { email: 'admin@demo.local', password: 'correct-password' },
          'tenant_1',
        ),
      ).rejects.toMatchObject({
        status: 401,
        response: { error: 'INVALID_CREDENTIALS' },
      });
    });

    it('rejects when the email only backs a SystemUser but x-tenant-id was sent (actor-type mismatch)', async () => {
      // resolveTenantActor scopes its lookup to TenantUser rows only, so an
      // email that exclusively backs a SystemUser never resolves here.
      prisma.tenantUser.findFirst.mockResolvedValue(null);

      await expect(
        service.login(
          { email: 'super@flexi.local', password: 'correct-password' },
          'tenant_1',
        ),
      ).rejects.toMatchObject({
        status: 401,
        response: { error: 'INVALID_CREDENTIALS' },
      });
    });

    it('returns the exact same error message for unknown-email and wrong-password (no account enumeration)', async () => {
      prisma.tenantUser.findFirst.mockResolvedValueOnce(null);
      const unknownEmailError = (await service
        .login({ email: 'nobody@demo.local', password: 'whatever' }, 'tenant_1')
        .catch((error: unknown) => error)) as {
        response: { message: string };
      };

      prisma.tenantUser.findFirst.mockResolvedValueOnce({
        id: 'tu_1',
        tenantId: 'tenant_1',
        authAccountId: 'aa_1',
        name: 'Demo Admin',
        isActive: true,
        authAccount: {
          id: 'aa_1',
          email: 'admin@demo.local',
          passwordHash,
          isActive: true,
        },
        roles: [TENANT_ROLE],
      });
      const wrongPasswordError = (await service
        .login(
          { email: 'admin@demo.local', password: 'wrong-password' },
          'tenant_1',
        )
        .catch((error: unknown) => error)) as {
        response: { message: string };
      };

      expect(unknownEmailError.response.message).toBe(
        wrongPasswordError.response.message,
      );
    });
  });

  // -------------------------------------------------------------------
  // refresh
  // -------------------------------------------------------------------

  describe('refresh', () => {
    async function issueRefreshToken(authAccountId: string): Promise<string> {
      return jwtService.signAsync(
        { sub: authAccountId },
        { secret: REFRESH_SECRET, expiresIn: '7d' },
      );
    }

    function hashToken(token: string): string {
      // Mirrors AuthService's private hashToken -- duplicated here since
      // it's a private implementation detail, not something to export
      // just for tests.
      return createHash('sha256').update(token).digest('hex');
    }

    it('rotates a valid, unexpired, unrevoked refresh token (refresh rotation)', async () => {
      const rawToken = await issueRefreshToken('aa_1');
      const storedRow = {
        id: 'rt_1',
        authAccountId: 'aa_1',
        tokenHash: hashToken(rawToken),
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      };
      prisma.refreshToken.findUnique.mockResolvedValue(storedRow);
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      prisma.tenantUser.findFirst.mockResolvedValue({
        id: 'tu_1',
        tenantId: 'tenant_1',
        authAccountId: 'aa_1',
        name: 'Demo Admin',
        isActive: true,
        authAccount: {
          id: 'aa_1',
          email: 'admin@demo.local',
          passwordHash,
          isActive: true,
        },
        roles: [TENANT_ROLE],
      });

      const tokens = await service.refresh({ refreshToken: rawToken });

      expect(tokens.accessToken).toEqual(expect.any(String));
      expect(tokens.refreshToken).not.toBe(rawToken);
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { id: 'rt_1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('rejects a revoked token with 401 INVALID_REFRESH_TOKEN (refresh reuse)', async () => {
      const rawToken = await issueRefreshToken('aa_1');
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt_1',
        authAccountId: 'aa_1',
        tokenHash: hashToken(rawToken),
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(
        service.refresh({ refreshToken: rawToken }),
      ).rejects.toMatchObject({
        status: 401,
        response: { error: 'INVALID_REFRESH_TOKEN' },
      });
    });

    it('rejects an expired token with 401 INVALID_REFRESH_TOKEN', async () => {
      const rawToken = await issueRefreshToken('aa_1');
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt_1',
        authAccountId: 'aa_1',
        tokenHash: hashToken(rawToken),
        revokedAt: null,
        expiresAt: new Date(Date.now() - 60_000),
      });

      await expect(
        service.refresh({ refreshToken: rawToken }),
      ).rejects.toMatchObject({
        status: 401,
        response: { error: 'INVALID_REFRESH_TOKEN' },
      });
    });

    it('rejects an unknown token with 401 INVALID_REFRESH_TOKEN', async () => {
      await expect(
        service.refresh({ refreshToken: 'not-a-real-token' }),
      ).rejects.toMatchObject({
        status: 401,
        response: { error: 'INVALID_REFRESH_TOKEN' },
      });
    });

    it('rejects with 401 INVALID_REFRESH_TOKEN when a concurrent request already won the rotation race', async () => {
      // Simulates two concurrent refresh calls presenting the same token:
      // both pass the findUnique check, but only one `updateMany` actually
      // flips revokedAt (count: 1) -- the loser sees count: 0.
      const rawToken = await issueRefreshToken('aa_1');
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt_1',
        authAccountId: 'aa_1',
        tokenHash: hashToken(rawToken),
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.refresh({ refreshToken: rawToken }),
      ).rejects.toMatchObject({
        status: 401,
        response: { error: 'INVALID_REFRESH_TOKEN' },
      });
    });
  });

  // -------------------------------------------------------------------
  // logout
  // -------------------------------------------------------------------

  describe('logout', () => {
    const currentUser: AuthenticatedUserDto = {
      authAccountId: 'aa_1',
      actorType: ActorType.TENANT,
      tenantId: 'tenant_1',
      tenantUserId: 'tu_1',
      email: 'admin@demo.local',
      name: 'Demo Admin',
      roles: ['Admin'],
      permissions: ['auth.me.read'],
    };

    it('revokes a refresh token owned by the authenticated caller', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt_1',
        authAccountId: 'aa_1',
        tokenHash: 'irrelevant-in-this-mock',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });

      await service.logout({ refreshToken: 'raw-token' }, currentUser);

      expect(prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: 'rt_1' },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('rejects an unknown token with 401 INVALID_REFRESH_TOKEN', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(
        service.logout({ refreshToken: 'not-a-real-token' }, currentUser),
      ).rejects.toMatchObject({
        status: 401,
        response: { error: 'INVALID_REFRESH_TOKEN' },
      });
    });

    it('rejects a refresh token owned by a different account with 401 INVALID_REFRESH_TOKEN', async () => {
      // The token is found (tokenHash is now globally unique), but it
      // belongs to a different AuthAccount than the caller's.
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt_1',
        authAccountId: 'someone-elses-aa',
        tokenHash: 'irrelevant-in-this-mock',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(
        service.logout({ refreshToken: 'someone-elses-token' }, currentUser),
      ).rejects.toMatchObject({
        status: 401,
        response: { error: 'INVALID_REFRESH_TOKEN' },
      });
    });
  });

  // -------------------------------------------------------------------
  // me
  // -------------------------------------------------------------------

  describe('me', () => {
    it('returns the caller when a TenantUser holds auth.me.read', () => {
      const user: AuthenticatedUserDto = {
        authAccountId: 'aa_1',
        actorType: ActorType.TENANT,
        tenantId: 'tenant_1',
        tenantUserId: 'tu_1',
        email: 'admin@demo.local',
        name: 'Demo Admin',
        roles: ['Admin'],
        permissions: ['auth.me.read'],
      };

      expect(service.me(user)).toBe(user);
    });

    it('returns the caller when a SystemUser holds system.me.read', () => {
      const user: AuthenticatedUserDto = {
        authAccountId: 'aa_2',
        actorType: ActorType.SYSTEM,
        systemUserId: 'su_1',
        email: 'super@flexi.local',
        name: 'Demo Super Admin',
        roles: ['PlatformAdmin'],
        permissions: ['system.me.read'],
      };

      expect(service.me(user)).toBe(user);
    });

    it('rejects a TenantUser lacking auth.me.read with 403 FORBIDDEN', () => {
      const user: AuthenticatedUserDto = {
        authAccountId: 'aa_1',
        actorType: ActorType.TENANT,
        tenantId: 'tenant_1',
        tenantUserId: 'tu_1',
        email: 'admin@demo.local',
        name: 'Demo Admin',
        roles: ['SomeOtherRole'],
        permissions: [],
      };

      expect(() => service.me(user)).toThrow(ForbiddenException);
    });

    it('rejects a SystemUser lacking system.me.read with 403 FORBIDDEN', () => {
      const user: AuthenticatedUserDto = {
        authAccountId: 'aa_2',
        actorType: ActorType.SYSTEM,
        systemUserId: 'su_1',
        email: 'super@flexi.local',
        name: 'Demo Super Admin',
        roles: ['SomeOtherRole'],
        permissions: [],
      };

      expect(() => service.me(user)).toThrow(ForbiddenException);
    });
  });
});

// -------------------------------------------------------------------
// JwtAuthGuard -- covers the /me 401 I/O Matrix row (missing/expired/
// invalid token), which is this guard's responsibility, not AuthService's.
// -------------------------------------------------------------------

function mockContext(headers: Record<string, string> = {}): ExecutionContext {
  const request = { headers, user: undefined };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
    getHandler: () => (): void => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  const jwtService = new JwtService({});
  const configService = new FakeConfigService() as unknown as ConfigService;
  // Real ClsService backed by a real AsyncLocalStorage -- not a mock -- so
  // these tests exercise the exact set()/get() semantics production code
  // depends on (set() throws outside an active store, matching the CLS
  // rows of spec-schema-per-tenant-core.md's I/O matrix). Each call to
  // guard.canActivate() below runs inside cls.run(), mirroring the store
  // ClsModule's middleware opens for a real request.
  const cls = new ClsService<TenancyClsStore>(new AsyncLocalStorage());
  const guard = new JwtAuthGuard(jwtService, configService, cls);

  it('rejects a missing Authorization header with 401 UNAUTHORIZED', async () => {
    await cls.run(async () => {
      await expect(guard.canActivate(mockContext())).rejects.toMatchObject({
        status: 401,
        response: { error: 'UNAUTHORIZED' },
      });
    });
  });

  it('rejects an invalid token with 401 UNAUTHORIZED', async () => {
    await cls.run(async () => {
      await expect(
        guard.canActivate(mockContext({ authorization: 'Bearer not-a-jwt' })),
      ).rejects.toMatchObject({
        status: 401,
        response: { error: 'UNAUTHORIZED' },
      });
    });
  });

  it('rejects an expired token with 401 UNAUTHORIZED', async () => {
    const expiredToken = await jwtService.signAsync(
      { sub: 'aa_1', actorType: ActorType.TENANT, permissions: [] },
      { secret: ACCESS_SECRET, expiresIn: '-1s' },
    );

    await cls.run(async () => {
      await expect(
        guard.canActivate(
          mockContext({ authorization: `Bearer ${expiredToken}` }),
        ),
      ).rejects.toMatchObject({
        status: 401,
        response: { error: 'UNAUTHORIZED' },
      });
    });
  });

  it('accepts a valid token and populates request.user', async () => {
    const token = await jwtService.signAsync(
      {
        sub: 'aa_1',
        actorType: ActorType.TENANT,
        tenantId: 'tenant_1',
        tenantUserId: 'tu_1',
        email: 'admin@demo.local',
        name: 'Demo Admin',
        roles: ['Admin'],
        permissions: ['auth.me.read'],
      },
      { secret: ACCESS_SECRET, expiresIn: '15m' },
    );

    await cls.run(async () => {
      const context = mockContext({ authorization: `Bearer ${token}` });
      await expect(guard.canActivate(context)).resolves.toBe(true);

      const request = context.switchToHttp().getRequest<{
        user?: AuthenticatedUserDto;
      }>();
      expect(request.user).toMatchObject({
        authAccountId: 'aa_1',
        actorType: ActorType.TENANT,
        permissions: ['auth.me.read'],
      });
    });
  });

  // I/O matrix: "Valid tenant JWT" -- CLS store holds tenantId + schema.
  it('populates CLS tenantId/schema for a valid tenant token', async () => {
    const token = await jwtService.signAsync(
      {
        sub: 'aa_1',
        actorType: ActorType.TENANT,
        tenantId: 'tenant_1',
        tenantUserId: 'tu_1',
        email: 'admin@demo.local',
        name: 'Demo Admin',
        roles: ['Admin'],
        permissions: ['auth.me.read'],
      },
      { secret: ACCESS_SECRET, expiresIn: '15m' },
    );

    await cls.run(async () => {
      const context = mockContext({ authorization: `Bearer ${token}` });
      await guard.canActivate(context);

      expect(cls.get('tenantId')).toBe('tenant_1');
      expect(cls.get('schema')).toBe('tenant_tenant_1');
    });
  });

  // I/O matrix: "System (non-tenant) JWT" -- no tenantId claim, so CLS
  // never gets a schema; downstream TenantContext access must throw.
  it('leaves CLS tenantId/schema unset for a system (non-tenant) token', async () => {
    const token = await jwtService.signAsync(
      {
        sub: 'aa_sys_1',
        actorType: ActorType.SYSTEM,
        systemUserId: 'su_1',
        email: 'system@demo.local',
        name: 'System Admin',
        roles: ['SystemAdmin'],
        permissions: ['auth.me.read'],
      },
      { secret: ACCESS_SECRET, expiresIn: '15m' },
    );

    await cls.run(async () => {
      const context = mockContext({ authorization: `Bearer ${token}` });
      await guard.canActivate(context);

      expect(cls.get('tenantId')).toBeUndefined();
      expect(cls.get('schema')).toBeUndefined();
    });
  });
});

describe('PermissionsGuard', () => {
  it('allows a request whose user holds every required permission', () => {
    const reflector = new Reflector();
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(['auth.me.read']);
    const guard = new PermissionsGuard(reflector);

    const context = mockContext();
    (
      context.switchToHttp().getRequest() as { user: AuthenticatedUserDto }
    ).user = {
      authAccountId: 'aa_1',
      actorType: ActorType.TENANT,
      email: 'admin@demo.local',
      name: 'Demo Admin',
      roles: ['Admin'],
      permissions: ['auth.me.read'],
    };

    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects a request whose user is missing a required permission with 403 FORBIDDEN', () => {
    const reflector = new Reflector();
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(['auth.me.read']);
    const guard = new PermissionsGuard(reflector);

    const context = mockContext();
    (
      context.switchToHttp().getRequest() as { user: AuthenticatedUserDto }
    ).user = {
      authAccountId: 'aa_1',
      actorType: ActorType.TENANT,
      email: 'admin@demo.local',
      name: 'Demo Admin',
      roles: ['Guest'],
      permissions: [],
    };

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('allows any request when no @RequirePermissions() metadata is set', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const guard = new PermissionsGuard(reflector);

    expect(guard.canActivate(mockContext())).toBe(true);
  });
});
