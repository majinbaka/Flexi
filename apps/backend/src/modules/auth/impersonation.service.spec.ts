import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ActorType,
  AuthAuditEvent,
  AuthenticatedUserDto,
  SYSTEM_IMPERSONATION_CREATE_PERMISSION,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthAuditService } from './auth-audit.service';
import { ImpersonationService } from './impersonation.service';

const ACCESS_SECRET = 'test-access-secret';
const SYSTEM_CALLER: AuthenticatedUserDto = {
  authAccountId: 'auth_system_1',
  actorType: ActorType.SYSTEM,
  systemUserId: 'system_user_1',
  email: 'support@flexi.local',
  name: 'Support',
  roles: ['PlatformAdmin'],
  permissions: [SYSTEM_IMPERSONATION_CREATE_PERMISSION],
};

function prismaMock() {
  return {
    tenantUser: { findFirst: jest.fn() },
    tenant: { findFirst: jest.fn() },
    tenantSettings: { findUnique: jest.fn() },
    impersonationSession: {
      create: jest.fn(),
      updateMany: jest.fn(),
    },
  };
}

describe('ImpersonationService', () => {
  let prisma: ReturnType<typeof prismaMock>;
  let audit: { record: jest.Mock };
  let jwtService: JwtService;
  let service: ImpersonationService;

  beforeEach(() => {
    prisma = prismaMock();
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    jwtService = new JwtService({});
    service = new ImpersonationService(
      prisma as unknown as PrismaService,
      jwtService,
      {
        get: jest.fn().mockReturnValue(ACCESS_SECRET),
      } as unknown as ConfigService,
      audit as unknown as AuthAuditService,
    );
  });

  it('mints a tenant-pinned 15-minute access token without any refresh token', async () => {
    prisma.tenantUser.findFirst.mockResolvedValue({
      id: 'tenant_user_1',
      tenantId: 'tenant_1',
      authAccountId: 'auth_tenant_1',
      name: 'Tenant Admin',
      authAccount: {
        email: 'admin@tenant.local',
        mustChangePassword: false,
      },
      roles: [
        {
          name: 'Admin',
          rolePermissions: [
            { permission: { code: 'dynamic-tables.rows.read' } },
          ],
        },
      ],
    });
    prisma.tenant.findFirst.mockResolvedValue({ id: 'tenant_1' });
    prisma.tenantSettings.findUnique.mockResolvedValue({
      allowSystemImpersonation: true,
    });
    prisma.impersonationSession.create.mockResolvedValue({ id: 'imp_1' });

    const result = await service.start(
      SYSTEM_CALLER,
      'tenant_1',
      'tenant_user_1',
    );
    const payload = await jwtService.verifyAsync(result.accessToken, {
      secret: ACCESS_SECRET,
    });

    expect(result.expiresIn).toBe(15 * 60);
    expect(payload).toMatchObject({
      sub: 'auth_tenant_1',
      actorType: ActorType.TENANT,
      tenantId: 'tenant_1',
      tenantUserId: 'tenant_user_1',
      impersonatedBy: 'system_user_1',
      impersonationSessionId: 'imp_1',
      permissions: ['dynamic-tables.rows.read'],
    });
    expect(prisma.impersonationSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant_1',
        targetTenantUserId: 'tenant_user_1',
        impersonatorId: 'system_user_1',
        expiresAt: expect.any(Date),
      }),
      select: { id: true },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: AuthAuditEvent.IMPERSONATION_STARTED,
        impersonated: true,
        impersonatorId: 'system_user_1',
      }),
    );
  });

  it('requires the tenant opt-in before it creates a session', async () => {
    prisma.tenantUser.findFirst.mockResolvedValue({ id: 'tenant_user_1' });
    prisma.tenant.findFirst.mockResolvedValue({ id: 'tenant_1' });
    prisma.tenantSettings.findUnique.mockResolvedValue({
      allowSystemImpersonation: false,
    });

    await expect(
      service.start(SYSTEM_CALLER, 'tenant_1', 'tenant_user_1'),
    ).rejects.toMatchObject({
      status: 403,
      response: { error: 'IMPERSONATION_NOT_ALLOWED' },
    });
    expect(prisma.impersonationSession.create).not.toHaveBeenCalled();
  });

  it('rejects nested impersonation before it can inspect the target', async () => {
    await expect(
      service.start(
        { ...SYSTEM_CALLER, impersonatedBy: 'system_user_0' },
        'tenant_1',
        'tenant_user_1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.tenantUser.findFirst).not.toHaveBeenCalled();
  });

  it('ends exactly the active delegated session and audits the ending', async () => {
    prisma.impersonationSession.updateMany.mockResolvedValue({ count: 1 });
    const user: AuthenticatedUserDto = {
      ...SYSTEM_CALLER,
      actorType: ActorType.TENANT,
      systemUserId: undefined,
      tenantId: 'tenant_1',
      tenantUserId: 'tenant_user_1',
      authAccountId: 'auth_tenant_1',
      impersonatedBy: 'system_user_1',
      impersonationSessionId: 'imp_1',
    };

    await service.end(user);

    expect(prisma.impersonationSession.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'imp_1',
        tenantId: 'tenant_1',
        targetTenantUserId: 'tenant_user_1',
        impersonatorId: 'system_user_1',
        endedAt: null,
      }),
      data: { endedAt: expect.any(Date) },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: AuthAuditEvent.IMPERSONATION_ENDED,
        impersonated: true,
        impersonatorId: 'system_user_1',
      }),
    );
  });
});
