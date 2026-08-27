import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ActorType,
  AuthAuditEvent,
  AuthenticatedUserDto,
  SYSTEM_SETTINGS_MANAGE_PERMISSION,
  TENANT_SETTINGS_MANAGE_PERMISSION,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthAuditService } from '../auth/auth-audit.service';
import { TenantSettingsService } from './tenant-settings.service';

const TENANT_ID = 'tenant_1';
const OTHER_TENANT_ID = 'tenant_2';
const ROLE_ID = 'role_member';
const UPDATED_AT = new Date('2026-08-20T10:00:00.000Z');

interface PrismaMock {
  tenant: { findUnique: jest.Mock };
  role: { findFirst: jest.Mock };
  tenantSettings: { findUnique: jest.Mock; upsert: jest.Mock };
}

function settingsRow(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT_ID,
    allowSelfRegistration: false,
    allowedEmailDomains: [] as string[],
    defaultRoleId: null as string | null,
    requireApproval: true,
    updatedAt: UPDATED_AT,
    defaultRole: null as { name: string } | null,
    ...overrides,
  };
}

function createPrismaMock(): PrismaMock {
  const prisma: PrismaMock = {
    tenant: {
      findUnique: jest.fn().mockResolvedValue({ id: OTHER_TENANT_ID }),
    },
    role: { findFirst: jest.fn().mockResolvedValue({ id: ROLE_ID }) },
    tenantSettings: {
      // No row until a test says otherwise: the unconfigured tenant is the
      // case every default is chosen for.
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
    },
  };

  // Merges the patch onto whatever `findUnique` is currently returning, so
  // a test asserting on the response is asserting on the patch it sent.
  prisma.tenantSettings.upsert.mockImplementation(
    ({
      where,
      update,
    }: {
      where: { tenantId: string };
      update: Record<string, unknown>;
    }) => ({
      ...settingsRow({ tenantId: where.tenantId }),
      ...update,
      defaultRole:
        update.defaultRoleId === undefined || update.defaultRoleId === null
          ? null
          : { name: 'Member' },
    }),
  );

  return prisma;
}

function tenantCaller(
  permissions: string[] = [TENANT_SETTINGS_MANAGE_PERMISSION],
): AuthenticatedUserDto {
  return {
    authAccountId: 'auth_tenant_admin',
    actorType: ActorType.TENANT,
    tenantId: TENANT_ID,
    tenantUserId: 'tu_admin',
    email: 'admin@acme.example',
    name: 'Admin',
    roles: ['TENANT_ADMIN'],
    permissions,
  };
}

function systemCaller(
  permissions: string[] = [SYSTEM_SETTINGS_MANAGE_PERMISSION],
): AuthenticatedUserDto {
  return {
    authAccountId: 'auth_system_admin',
    actorType: ActorType.SYSTEM,
    systemUserId: 'su_admin',
    email: 'root@flexi.example',
    name: 'Super Admin',
    roles: ['SUPER_ADMIN'],
    permissions,
  };
}

describe('TenantSettingsService', () => {
  let prisma: PrismaMock;
  let audit: jest.Mocked<AuthAuditService>;
  let service: TenantSettingsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    audit = {
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AuthAuditService>;
    service = new TenantSettingsService(
      prisma as unknown as PrismaService,
      audit,
    );
  });

  describe('getSettings', () => {
    /**
     * The whole point of the defaults: a tenant nobody has configured is
     * closed, and says so in the same shape a configured one does.
     */
    it('reports the closed defaults for a tenant with no row', async () => {
      await expect(service.getSettings(tenantCaller())).resolves.toEqual({
        tenantId: TENANT_ID,
        allowSelfRegistration: false,
        allowSystemImpersonation: false,
        allowedEmailDomains: [],
        defaultRoleId: null,
        defaultRoleName: null,
        requireApproval: true,
        configured: false,
        updatedAt: null,
      });
    });

    it('reports a stored row, role name included', async () => {
      prisma.tenantSettings.findUnique.mockResolvedValue(
        settingsRow({
          allowSelfRegistration: true,
          allowedEmailDomains: ['acme.com'],
          defaultRoleId: ROLE_ID,
          requireApproval: false,
          defaultRole: { name: 'Member' },
        }),
      );

      await expect(service.getSettings(tenantCaller())).resolves.toEqual({
        tenantId: TENANT_ID,
        allowSelfRegistration: true,
        allowedEmailDomains: ['acme.com'],
        defaultRoleId: ROLE_ID,
        defaultRoleName: 'Member',
        requireApproval: false,
        configured: true,
        updatedAt: UPDATED_AT.toISOString(),
      });
    });

    it('refuses a tenant caller without tenant.settings.manage', async () => {
      await expect(service.getSettings(tenantCaller([]))).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.tenantSettings.findUnique).not.toHaveBeenCalled();
    });

    it('refuses a system caller without system.settings.manage', async () => {
      await expect(
        service.getSettings(systemCaller([]), OTHER_TENANT_ID),
      ).rejects.toThrow(ForbiddenException);
    });

    /**
     * A tenant caller is pinned to their own token's tenant. Pointing the
     * header somewhere else is refused rather than ignored -- silently
     * rewriting the target of a read (and, on PATCH, of a write) is the
     * kind of thing that looks like it worked.
     */
    it('refuses a tenant caller naming another tenant in the header', async () => {
      await expect(
        service.getSettings(tenantCaller(), OTHER_TENANT_ID),
      ).rejects.toThrow(ForbiddenException);
    });

    it('accepts a tenant caller echoing their own tenant in the header', async () => {
      await expect(
        service.getSettings(tenantCaller(), ` ${TENANT_ID} `),
      ).resolves.toEqual(expect.objectContaining({ tenantId: TENANT_ID }));
    });

    it('requires a system caller to say which tenant', async () => {
      await expect(service.getSettings(systemCaller())).rejects.toThrow(
        BadRequestException,
      );
    });

    it('reads the tenant a system caller named', async () => {
      await expect(
        service.getSettings(systemCaller(), OTHER_TENANT_ID),
      ).resolves.toEqual(
        expect.objectContaining({ tenantId: OTHER_TENANT_ID }),
      );
      expect(prisma.tenantSettings.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: OTHER_TENANT_ID } }),
      );
    });

    it('reports an unknown tenant as missing to a system caller', async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);

      await expect(
        service.getSettings(systemCaller(), 'tenant_gone'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateSettings', () => {
    it('writes only the fields the body carries', async () => {
      await service.updateSettings(
        { allowSelfRegistration: true },
        tenantCaller(),
      );

      expect(prisma.tenantSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: TENANT_ID },
          create: { tenantId: TENANT_ID, allowSelfRegistration: true },
          update: { allowSelfRegistration: true },
        }),
      );
    });

    /**
     * `null` clears the role and `undefined` leaves it alone -- the two
     * cannot be collapsed, or a caller flipping the toggle would wipe the
     * role in the same breath.
     */
    it('clears the default role on an explicit null, without a role lookup', async () => {
      await service.updateSettings({ defaultRoleId: null }, tenantCaller());

      expect(prisma.role.findFirst).not.toHaveBeenCalled();
      expect(prisma.tenantSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { defaultRoleId: null } }),
      );
    });

    it('accepts a default role of the target tenant', async () => {
      await service.updateSettings({ defaultRoleId: ROLE_ID }, tenantCaller());

      expect(prisma.role.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: ROLE_ID, tenantId: TENANT_ID },
        }),
      );
      expect(prisma.tenantSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { defaultRoleId: ROLE_ID } }),
      );
    });

    it('refuses a default role that is not the tenant own, writing nothing', async () => {
      prisma.role.findFirst.mockResolvedValue(null);

      await expect(
        service.updateSettings(
          { defaultRoleId: 'role_elsewhere' },
          tenantCaller(),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.tenantSettings.upsert).not.toHaveBeenCalled();
    });

    it('normalizes domains: lowercase, no leading @, no blanks, no duplicates', async () => {
      await service.updateSettings(
        {
          allowedEmailDomains: [
            '@ACME.com',
            '  acme.com ',
            '',
            '   ',
            'sub.Acme.co.uk',
          ],
        },
        tenantCaller(),
      );

      expect(prisma.tenantSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: { allowedEmailDomains: ['acme.com', 'sub.acme.co.uk'] },
        }),
      );
    });

    /**
     * A whitelist entry that can never match an address is worse than a
     * rejected one: it looks like it is protecting something.
     */
    it.each([['bob@acme.com'], ['https://acme.com'], ['acme'], ['-acme.com']])(
      'refuses %s as a domain and writes nothing',
      async (domain) => {
        await expect(
          service.updateSettings(
            { allowedEmailDomains: [domain] },
            tenantCaller(),
          ),
        ).rejects.toThrow(BadRequestException);
        expect(prisma.tenantSettings.upsert).not.toHaveBeenCalled();
      },
    );

    it('accepts an empty list, which means any domain', async () => {
      await service.updateSettings({ allowedEmailDomains: [] }, tenantCaller());

      expect(prisma.tenantSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { allowedEmailDomains: [] } }),
      );
    });

    it('writes nothing for a body that changes nothing', async () => {
      await expect(service.updateSettings({}, tenantCaller())).resolves.toEqual(
        expect.objectContaining({ configured: false }),
      );

      expect(prisma.tenantSettings.upsert).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('writes the tenant a system caller named', async () => {
      await service.updateSettings(
        { requireApproval: false },
        systemCaller(),
        OTHER_TENANT_ID,
      );

      expect(prisma.tenantSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: OTHER_TENANT_ID } }),
      );
    });

    it('refuses a tenant caller pointing the header at another tenant', async () => {
      await expect(
        service.updateSettings(
          { allowSelfRegistration: true },
          tenantCaller(),
          OTHER_TENANT_ID,
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.tenantSettings.upsert).not.toHaveBeenCalled();
    });

    describe('audit', () => {
      it('records the write and the toggle when registration is opened', async () => {
        await service.updateSettings(
          { allowSelfRegistration: true, requireApproval: false },
          tenantCaller(),
        );

        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            event: AuthAuditEvent.TENANT_SETTINGS_UPDATED,
            tenantId: TENANT_ID,
            actorAuthAccountId: 'auth_tenant_admin',
            metadata: expect.objectContaining({
              changed: 'allowSelfRegistration,requireApproval',
              allowSelfRegistration: true,
              requireApproval: false,
            }),
          }),
        );
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            event: AuthAuditEvent.SELF_REGISTRATION_ENABLED,
            tenantId: TENANT_ID,
          }),
        );
      });

      it('records the toggle when registration is closed again', async () => {
        prisma.tenantSettings.findUnique.mockResolvedValue(
          settingsRow({ allowSelfRegistration: true }),
        );

        await service.updateSettings(
          { allowSelfRegistration: false },
          tenantCaller(),
        );

        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            event: AuthAuditEvent.SELF_REGISTRATION_DISABLED,
          }),
        );
      });

      /** Re-sending the value it already had moved no switch. */
      it('records no toggle event when the flag did not change', async () => {
        prisma.tenantSettings.findUnique.mockResolvedValue(
          settingsRow({ allowSelfRegistration: true }),
        );

        await service.updateSettings(
          { allowSelfRegistration: true },
          tenantCaller(),
        );

        const events = audit.record.mock.calls.map(([entry]) => entry.event);
        expect(events).toEqual([AuthAuditEvent.TENANT_SETTINGS_UPDATED]);
      });
    });
  });

  describe('resolveEffectiveSettings', () => {
    /**
     * The public registration path reads through this, and must see the
     * closed policy -- not a null row it would have to interpret itself.
     */
    it('resolves a missing row to the closed defaults', async () => {
      await expect(
        service.resolveEffectiveSettings(TENANT_ID),
      ).resolves.toEqual({
        tenantId: TENANT_ID,
        allowSelfRegistration: false,
        allowSystemImpersonation: false,
        allowedEmailDomains: [],
        defaultRoleId: null,
        defaultRoleName: null,
        requireApproval: true,
        configured: false,
        updatedAt: null,
      });
    });

    it('asserts no permission of its own', async () => {
      prisma.tenantSettings.findUnique.mockResolvedValue(
        settingsRow({ allowSelfRegistration: true }),
      );

      await expect(
        service.resolveEffectiveSettings(TENANT_ID),
      ).resolves.toEqual(
        expect.objectContaining({
          allowSelfRegistration: true,
          configured: true,
        }),
      );
    });
  });
});
