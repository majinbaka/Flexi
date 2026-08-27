import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { AuthAuditEvent } from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { TenancyClsStore } from '../../tenancy/tenant-context';

/**
 * Non-secret context recorded alongside an event. An OTP, a temporary
 * password, a token or a password hash must never be put in here -- the
 * type is deliberately narrow (no `unknown`) so a raw object carrying a
 * secret field cannot be passed in by accident.
 */
export type AuthAuditMetadata = Record<
  string,
  string | number | boolean | null
>;

export interface AuthAuditEntry {
  event: AuthAuditEvent;
  tenantId?: string | null;
  /** The account the event happened *to*. */
  subjectAuthAccountId?: string | null;
  /** The account that caused it, when that is somebody else. */
  actorAuthAccountId?: string | null;
  impersonated?: boolean;
  impersonatorId?: string | null;
  metadata?: AuthAuditMetadata;
}

/**
 * Append-only trail for password recovery, session revocation and account
 * lifecycle actions.
 *
 * Writes are best-effort: a failed audit insert is logged and swallowed
 * rather than propagated. The alternative -- failing the request -- would
 * mean a database hiccup on this one table could stop a user from
 * completing a password reset whose real work already committed, leaving
 * them locked out with a valid new password. The same trade-off
 * `TenantProvisioningService` already makes for its onboarding audit.
 */
@Injectable()
export class AuthAuditService {
  private readonly logger = new Logger(AuthAuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly cls?: ClsService<TenancyClsStore>,
  ) {}

  async record(entry: AuthAuditEntry): Promise<void> {
    try {
      await this.prisma.authAuditLog.create({
        data: {
          event: entry.event,
          tenantId: entry.tenantId ?? null,
          subjectAuthAccountId: entry.subjectAuthAccountId ?? null,
          actorAuthAccountId: entry.actorAuthAccountId ?? null,
          impersonated:
            entry.impersonated ?? Boolean(this.cls?.get('impersonatedBy')),
          impersonatorId:
            entry.impersonatorId ?? this.cls?.get('impersonatedBy') ?? null,
          metadata: (entry.metadata ?? undefined) as
            Prisma.InputJsonValue | undefined,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Could not record auth audit event ${entry.event}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}
