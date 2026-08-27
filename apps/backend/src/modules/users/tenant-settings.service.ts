import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ActorType,
  AuthAuditEvent,
  AuthenticatedUserDto,
  SYSTEM_SETTINGS_MANAGE_PERMISSION,
  TENANT_SETTINGS_MANAGE_PERMISSION,
  TenantSettingsDto,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthAuditService } from '../auth/auth-audit.service';
import { UpdateTenantSettingsDto } from './dto/update-tenant-settings.dto';

/**
 * The policy a tenant with no `tenant_settings` row runs under -- and,
 * identically, the column defaults the row is created with. Registration
 * off, approval required, no role: every default is the closed direction,
 * so a tenant that has never been configured can never be the permissive
 * case, and "no row" needs no special handling anywhere but here.
 */
const DEFAULT_SETTINGS = {
  allowSelfRegistration: false,
  allowedEmailDomains: [] as string[],
  defaultRoleId: null as string | null,
  defaultRoleName: null as string | null,
  requireApproval: true,
} as const;

/**
 * A bare hostname: dot-separated labels of letters, digits and hyphens,
 * with at least one dot. Deliberately not an RFC-complete grammar -- it
 * exists to catch an address (`bob@acme.com`), a URL or a stray word being
 * saved as a domain, which would silently never match anything.
 */
const DOMAIN_PATTERN =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const SETTINGS_SELECT = {
  tenantId: true,
  allowSelfRegistration: true,
  allowedEmailDomains: true,
  defaultRoleId: true,
  requireApproval: true,
  updatedAt: true,
  defaultRole: { select: { name: true } },
} satisfies Prisma.TenantSettingsSelect;

type SettingsRow = Prisma.TenantSettingsGetPayload<{
  select: typeof SETTINGS_SELECT;
}>;

/**
 * The columns one `PATCH` actually touches. Typed narrowly rather than as
 * `Prisma.TenantSettingsUncheckedUpdateInput` so it can be spread into the
 * `create` branch of the upsert too -- that input type carries its own
 * optional `tenantId`, which would collide with the one supplied there.
 */
interface TenantSettingsPatch {
  allowSelfRegistration?: boolean;
  allowedEmailDomains?: string[];
  defaultRoleId?: string | null;
  requireApproval?: boolean;
}

/**
 * What the registration path needs to know about a tenant, with the
 * "no row" case already resolved to the defaults.
 */
export interface EffectiveTenantSettings {
  tenantId: string;
  allowSelfRegistration: boolean;
  allowedEmailDomains: string[];
  defaultRoleId: string | null;
  defaultRoleName: string | null;
  requireApproval: boolean;
  configured: boolean;
  updatedAt: Date | null;
}

/**
 * Reads and writes one tenant's self-registration policy, and is the only
 * place that knows what an unconfigured tenant's policy is.
 *
 * Two callers, two very different needs. `SelfRegistrationService` asks
 * `resolveEffectiveSettings()` what the rules are, unauthenticated and on
 * a public request path. The `GET`/`PATCH` routes are administrative and
 * carry a caller whose actor type decides both which permission applies
 * and which tenant they may address. Keeping both in one service is what
 * makes "no row means the closed policy" a single fact rather than two
 * implementations that could drift into disagreeing.
 *
 * The required permission is asserted here rather than through
 * `@RequirePermissions()`, for the same reason `AccountLifecycleService`
 * does it: the code depends on the caller (`tenant.settings.manage` for a
 * TenantUser, `system.settings.manage` for a SystemUser), which the guard
 * cannot know at decoration time.
 */
@Injectable()
export class TenantSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authAuditService: AuthAuditService,
  ) {}

  /** The caller's own tenant, or -- for a system caller -- the one named. */
  async getSettings(
    currentUser: AuthenticatedUserDto,
    tenantIdHeader?: string,
  ): Promise<TenantSettingsDto> {
    const tenantId = await this.resolveTargetTenant(
      currentUser,
      tenantIdHeader,
    );

    return this.toDto(await this.resolveEffectiveSettings(tenantId));
  }

  /**
   * Applies the fields the body actually carries and leaves the rest
   * alone, creating the row on the first write (`upsert`). The `create`
   * branch supplies only the patched columns: everything else falls to the
   * schema defaults, which are the same closed policy the tenant was
   * already running under, so the first write can never quietly change a
   * setting the caller did not mention.
   *
   * A body that changes nothing writes nothing -- no empty row appears
   * just because somebody opened the screen and saved it.
   */
  async updateSettings(
    dto: UpdateTenantSettingsDto,
    currentUser: AuthenticatedUserDto,
    tenantIdHeader?: string,
  ): Promise<TenantSettingsDto> {
    const tenantId = await this.resolveTargetTenant(
      currentUser,
      tenantIdHeader,
    );
    const before = await this.resolveEffectiveSettings(tenantId);

    const patch: TenantSettingsPatch = {};
    const changed: string[] = [];

    if (dto.allowSelfRegistration !== undefined) {
      patch.allowSelfRegistration = dto.allowSelfRegistration;
      changed.push('allowSelfRegistration');
    }
    if (dto.allowedEmailDomains !== undefined) {
      patch.allowedEmailDomains = this.normalizeDomains(
        dto.allowedEmailDomains,
      );
      changed.push('allowedEmailDomains');
    }
    if (dto.defaultRoleId !== undefined) {
      patch.defaultRoleId =
        dto.defaultRoleId === null
          ? null
          : await this.requireTenantRole(tenantId, dto.defaultRoleId);
      changed.push('defaultRoleId');
    }
    if (dto.requireApproval !== undefined) {
      patch.requireApproval = dto.requireApproval;
      changed.push('requireApproval');
    }

    if (changed.length === 0) {
      return this.toDto(before);
    }

    const row = await this.prisma.tenantSettings.upsert({
      where: { tenantId },
      create: { tenantId, ...patch },
      update: patch,
      select: SETTINGS_SELECT,
    });

    const after = this.fromRow(tenantId, row);

    await this.authAuditService.record({
      event: AuthAuditEvent.TENANT_SETTINGS_UPDATED,
      tenantId,
      actorAuthAccountId: currentUser.authAccountId,
      metadata: {
        changed: changed.join(','),
        allowSelfRegistration: after.allowSelfRegistration,
        allowedEmailDomainCount: after.allowedEmailDomains.length,
        defaultRoleId: after.defaultRoleId,
        requireApproval: after.requireApproval,
      },
    });

    // Only when the switch actually moved: a PATCH that re-sends the value
    // it already had has changed nothing worth a second event.
    if (before.allowSelfRegistration !== after.allowSelfRegistration) {
      await this.authAuditService.record({
        event: after.allowSelfRegistration
          ? AuthAuditEvent.SELF_REGISTRATION_ENABLED
          : AuthAuditEvent.SELF_REGISTRATION_DISABLED,
        tenantId,
        actorAuthAccountId: currentUser.authAccountId,
        metadata: {
          allowedEmailDomainCount: after.allowedEmailDomains.length,
          defaultRoleId: after.defaultRoleId,
          requireApproval: after.requireApproval,
        },
      });
    }

    return this.toDto(after);
  }

  /**
   * The policy in force for a tenant, whether or not it has a row. Used by
   * the public registration path, so it takes a tenant id rather than a
   * caller and asserts no permission of its own.
   */
  async resolveEffectiveSettings(
    tenantId: string,
  ): Promise<EffectiveTenantSettings> {
    const row = await this.prisma.tenantSettings.findUnique({
      where: { tenantId },
      select: SETTINGS_SELECT,
    });

    return this.fromRow(tenantId, row);
  }

  private fromRow(
    tenantId: string,
    row: SettingsRow | null,
  ): EffectiveTenantSettings {
    if (!row) {
      return {
        tenantId,
        ...DEFAULT_SETTINGS,
        configured: false,
        updatedAt: null,
      };
    }

    return {
      tenantId,
      allowSelfRegistration: row.allowSelfRegistration,
      allowedEmailDomains: row.allowedEmailDomains,
      defaultRoleId: row.defaultRoleId,
      defaultRoleName: row.defaultRole?.name ?? null,
      requireApproval: row.requireApproval,
      configured: true,
      updatedAt: row.updatedAt,
    };
  }

  private toDto(settings: EffectiveTenantSettings): TenantSettingsDto {
    return {
      tenantId: settings.tenantId,
      allowSelfRegistration: settings.allowSelfRegistration,
      allowedEmailDomains: settings.allowedEmailDomains,
      defaultRoleId: settings.defaultRoleId,
      defaultRoleName: settings.defaultRoleName,
      requireApproval: settings.requireApproval,
      configured: settings.configured,
      updatedAt: settings.updatedAt?.toISOString() ?? null,
    };
  }

  /**
   * Lowercases, trims, strips a leading `@` (an administrator typing
   * `@acme.com` means the same thing), drops blanks and de-duplicates.
   * What survives has to look like a hostname: a whitelist entry that can
   * never match an address is worse than a rejected one, because it looks
   * like it is protecting something.
   */
  private normalizeDomains(domains: string[]): string[] {
    const normalized: string[] = [];

    for (const raw of domains) {
      const domain = raw.trim().toLowerCase().replace(/^@+/, '').trim();

      if (!domain) {
        continue;
      }

      if (!DOMAIN_PATTERN.test(domain)) {
        throw new BadRequestException({
          error: 'VALIDATION_ERROR',
          message: [
            `allowedEmailDomains contains "${raw}", which is not a bare domain such as "acme.com".`,
          ],
        });
      }

      if (!normalized.includes(domain)) {
        normalized.push(domain);
      }
    }

    return normalized;
  }

  /**
   * A default role must belong to the tenant it will be granted in.
   * Another tenant's role id resolves to nothing here rather than to a
   * cross-tenant grant at registration time.
   */
  private async requireTenantRole(
    tenantId: string,
    roleId: string,
  ): Promise<string> {
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, tenantId },
      select: { id: true },
    });

    if (!role) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: ['defaultRoleId does not name a role of this tenant.'],
      });
    }

    return role.id;
  }

  /**
   * Which tenant this call is about, and whether the caller may act on it.
   *
   * A tenant caller is pinned to the tenant in their own verified token --
   * `x-tenant-id` cannot move them elsewhere. A header naming a *different*
   * tenant is refused rather than ignored: silently rewriting the target of
   * a write is the kind of thing that looks like it worked.
   *
   * A system caller has no tenant of their own, so the header is how they
   * say which one they mean, and is required.
   */
  private async resolveTargetTenant(
    currentUser: AuthenticatedUserDto,
    tenantIdHeader: string | undefined,
  ): Promise<string> {
    const header = tenantIdHeader?.trim();

    if (currentUser.actorType === ActorType.TENANT) {
      this.assertPermission(currentUser, TENANT_SETTINGS_MANAGE_PERMISSION);

      if (!currentUser.tenantId) {
        throw new ForbiddenException({
          error: 'FORBIDDEN',
          message: 'This token is not scoped to a tenant.',
        });
      }

      if (header && header !== currentUser.tenantId) {
        throw new ForbiddenException({
          error: 'FORBIDDEN',
          message:
            'A tenant caller can only manage the settings of its own tenant.',
        });
      }

      return currentUser.tenantId;
    }

    this.assertPermission(currentUser, SYSTEM_SETTINGS_MANAGE_PERMISSION);

    if (!header) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: [
          'x-tenant-id is required: a system caller must say which tenant.',
        ],
      });
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: header },
      select: { id: true },
    });

    if (!tenant) {
      throw new NotFoundException({
        error: 'TENANT_NOT_FOUND',
        message: 'No such tenant.',
      });
    }

    return tenant.id;
  }

  private assertPermission(
    currentUser: AuthenticatedUserDto,
    required: string,
  ): void {
    if (!currentUser.permissions.includes(required)) {
      throw new ForbiddenException({
        error: 'FORBIDDEN',
        message: 'Insufficient permissions',
      });
    }
  }
}
