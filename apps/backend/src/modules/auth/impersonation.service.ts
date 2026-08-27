import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import {
  ActorType,
  AuthAuditEvent,
  AuthenticatedUserDto,
  ImpersonationTokenDto,
  SYSTEM_IMPERSONATION_CREATE_PERMISSION,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthAuditService } from './auth-audit.service';
import { AccessTokenPayload } from './auth.types';

const IMPERSONATION_TTL_SECONDS = 15 * 60;
const ACTIVE_TENANT_STATUS = 'ACTIVE';

/**
 * Creates and revokes the one cross-tenant path allowed by ADR-009. The
 * caller remains a SystemUser; the resulting access token carries only the
 * target TenantUser's permissions and is backed by a revocable record.
 */
@Injectable()
export class ImpersonationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly authAuditService: AuthAuditService,
  ) {}

  async start(
    currentUser: AuthenticatedUserDto,
    tenantIdHeader: string | undefined,
    tenantUserId: string,
  ): Promise<ImpersonationTokenDto> {
    this.assertSystemImpersonator(currentUser);

    const tenantId = tenantIdHeader?.trim();
    if (!tenantId) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: ['x-tenant-id is required for impersonation.'],
      });
    }

    const [target, tenant, settings] = await Promise.all([
      this.prisma.tenantUser.findFirst({
        where: {
          id: tenantUserId,
          tenantId,
          isActive: true,
          authAccount: { isActive: true },
        },
        include: {
          authAccount: true,
          roles: {
            include: { rolePermissions: { include: { permission: true } } },
          },
        },
      }),
      this.prisma.tenant.findFirst({
        where: { id: tenantId, status: ACTIVE_TENANT_STATUS },
        select: { id: true },
      }),
      this.prisma.tenantSettings.findUnique({
        where: { tenantId },
        select: { allowSystemImpersonation: true },
      }),
    ]);

    if (!tenant || !target) {
      throw new UnauthorizedException({
        error: 'UNAUTHORIZED',
        message: 'Target tenant user is unavailable.',
      });
    }
    if (!settings?.allowSystemImpersonation) {
      throw new ForbiddenException({
        error: 'IMPERSONATION_NOT_ALLOWED',
        message: 'This tenant has not enabled support impersonation.',
      });
    }

    const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_SECONDS * 1000);
    const session = await this.prisma.impersonationSession.create({
      data: {
        tenantId,
        targetAuthAccountId: target.authAccountId,
        targetTenantUserId: target.id,
        impersonatorId: currentUser.systemUserId!,
        expiresAt,
      },
      select: { id: true },
    });

    const payload: AccessTokenPayload = {
      sub: target.authAccountId,
      actorType: ActorType.TENANT,
      tenantId,
      tenantUserId: target.id,
      email: target.authAccount.email,
      name: target.name,
      roles: target.roles.map((role) => role.name),
      permissions: this.flattenPermissions(target.roles),
      mustChangePassword: target.authAccount.mustChangePassword,
      impersonatedBy: currentUser.systemUserId,
      impersonationSessionId: session.id,
    };
    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: '15m' as JwtSignOptions['expiresIn'],
    });

    await this.authAuditService.record({
      event: AuthAuditEvent.IMPERSONATION_STARTED,
      tenantId,
      subjectAuthAccountId: target.authAccountId,
      actorAuthAccountId: currentUser.authAccountId,
      impersonated: true,
      impersonatorId: currentUser.systemUserId,
      metadata: { impersonationSessionId: session.id },
    });

    return { accessToken, expiresIn: IMPERSONATION_TTL_SECONDS };
  }

  async end(currentUser: AuthenticatedUserDto): Promise<void> {
    if (
      !currentUser.impersonatedBy ||
      !currentUser.impersonationSessionId ||
      !currentUser.tenantId ||
      !currentUser.tenantUserId
    ) {
      throw new ForbiddenException({
        error: 'FORBIDDEN',
        message: 'No impersonation session is active.',
      });
    }

    const ended = await this.prisma.impersonationSession.updateMany({
      where: {
        id: currentUser.impersonationSessionId,
        tenantId: currentUser.tenantId,
        targetTenantUserId: currentUser.tenantUserId,
        impersonatorId: currentUser.impersonatedBy,
        endedAt: null,
      },
      data: { endedAt: new Date() },
    });
    if (ended.count !== 1) {
      throw new UnauthorizedException({
        error: 'UNAUTHORIZED',
        message: 'Impersonation session is no longer active.',
      });
    }

    await this.authAuditService.record({
      event: AuthAuditEvent.IMPERSONATION_ENDED,
      tenantId: currentUser.tenantId,
      subjectAuthAccountId: currentUser.authAccountId,
      actorAuthAccountId: currentUser.authAccountId,
      impersonated: true,
      impersonatorId: currentUser.impersonatedBy,
      metadata: { impersonationSessionId: currentUser.impersonationSessionId },
    });
  }

  private assertSystemImpersonator(currentUser: AuthenticatedUserDto): void {
    if (
      currentUser.impersonatedBy ||
      currentUser.actorType !== ActorType.SYSTEM ||
      !currentUser.systemUserId ||
      !currentUser.permissions.includes(SYSTEM_IMPERSONATION_CREATE_PERMISSION)
    ) {
      throw new ForbiddenException({
        error: 'FORBIDDEN',
        message: 'Insufficient permissions',
      });
    }
  }

  private flattenPermissions(
    roles: Array<{
      rolePermissions: Array<{ permission: { code: string } }>;
    }>,
  ): string[] {
    return Array.from(
      new Set(
        roles.flatMap((role) =>
          role.rolePermissions.map(({ permission }) => permission.code),
        ),
      ),
    );
  }
}
