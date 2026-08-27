import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import {
  AUTH_ERROR_CODES,
  AuthAuditEvent,
  SelfRegisterResponseDto,
  TENANT_USER_MANAGE_PERMISSION,
  TenantUserStatus,
  USER_ERROR_CODES,
  validatePasswordStrength,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailDeliveryService } from '../../mail/email-delivery.service';
import { AuthAuditService } from '../auth/auth-audit.service';
import { SelfRegisterDto } from './dto/self-register.dto';
import { TenantSettingsService } from './tenant-settings.service';
import { TenantUserDirectoryService } from './tenant-user-directory.service';
import { UserQuotaService } from './user-quota.service';

const PASSWORD_SALT_ROUNDS = 10;
const ACTIVE_TENANT_STATUS = 'ACTIVE';

/**
 * Upper bound on how many administrators one pending-approval notice is
 * addressed to. A tenant with more than this many user managers does not
 * need every one of them told; the request is already visible on the Users
 * screen.
 */
const MAX_APPROVAL_NOTICE_RECIPIENTS = 25;

/**
 * Public sign-up: `POST /api/auth/register`.
 *
 * The tenant comes from the `x-tenant-id` header, exactly as it does for
 * login -- there is no other way to say which tenant a public caller means,
 * and reusing the login convention keeps one rule instead of two.
 *
 * The order of the checks is part of the contract, not an implementation
 * detail (Users specification, "Self-registration"): toggle, then domain,
 * then quota, then the initial state. An address outside the whitelist
 * arriving at a tenant that has registration switched off is answered
 * `403 SELF_REG_DISABLED`, never `400 DOMAIN_NOT_ALLOWED` -- a closed
 * tenant gives up nothing about its policy, not even which domains it
 * would have accepted.
 *
 * Three situations collapse into that same `403`: registration is off, the
 * tenant does not exist or is not active, and registration is on but no
 * default role has been chosen. The first two make the endpoint useless
 * for discovering which tenants exist; the third is the fail-closed
 * direction -- an enabled toggle with no role would otherwise admit
 * strangers holding no permissions at all, which is a stranger inside the
 * tenant either way.
 */
@Injectable()
export class SelfRegistrationService {
  private readonly logger = new Logger(SelfRegistrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantSettingsService: TenantSettingsService,
    private readonly userQuotaService: UserQuotaService,
    private readonly tenantUserDirectoryService: TenantUserDirectoryService,
    private readonly emailDeliveryService: EmailDeliveryService,
    private readonly authAuditService: AuthAuditService,
  ) {}

  async register(
    dto: SelfRegisterDto,
    tenantIdHeader?: string,
  ): Promise<SelfRegisterResponseDto> {
    const tenantId = tenantIdHeader?.trim();

    // Missing header is a malformed request, not a policy decision: it
    // names no tenant to have a policy. Saying so discloses nothing -- the
    // caller has told us nothing to confirm or deny.
    if (!tenantId) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: ['x-tenant-id is required to register.'],
      });
    }

    // 1. Toggle.
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, status: ACTIVE_TENANT_STATUS },
      select: { id: true, name: true },
    });
    if (!tenant) {
      throw this.selfRegistrationDisabled();
    }

    const settings =
      await this.tenantSettingsService.resolveEffectiveSettings(tenantId);
    if (!settings.allowSelfRegistration) {
      throw this.selfRegistrationDisabled();
    }
    if (!settings.defaultRoleId) {
      this.logger.warn(
        `Tenant ${tenantId} has self-registration enabled with no default role; refusing registrations.`,
      );
      throw this.selfRegistrationDisabled();
    }
    const defaultRoleId = settings.defaultRoleId;

    const email = this.tenantUserDirectoryService.normalizeEmail(dto.email);

    // 2. Domain whitelist.
    this.assertDomainAllowed(email, settings.allowedEmailDomains);

    // 3. Quota. Before anything is written, so a full tenant creates
    // nothing at all.
    await this.userQuotaService.assertSeatsAvailable(tenantId, 1);

    // The body is validated only once the tenant has agreed to hear the
    // request at all: a closed tenant answers `SELF_REG_DISABLED` even to
    // a caller whose password would not have passed the policy.
    const fullName = dto.fullName.trim();
    if (!fullName) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: ['fullName must not be blank.'],
      });
    }
    if (dto.password !== dto.confirmPassword) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: ['password and confirmPassword do not match.'],
      });
    }
    this.assertPasswordMeetsPolicy(dto.password);

    // 4. Initial state.
    const requiresApproval = settings.requireApproval;
    const status = requiresApproval
      ? TenantUserStatus.PENDING_APPROVAL
      : TenantUserStatus.ACTIVE;

    const passwordHash = await bcrypt.hash(dto.password, PASSWORD_SALT_ROUNDS);

    const created = await this.prisma.$transaction(async (tx) => {
      // Inside the transaction it guards, so the read sits with the write
      // -- the same contract every other creation path uses. Two
      // simultaneous registrations of one address can still both pass;
      // ADR-009's unique index is what will finally close that.
      await this.tenantUserDirectoryService.assertEmailAvailable(
        tenantId,
        email,
        tx,
      );

      const authAccount = await tx.authAccount.create({
        data: { email, passwordHash },
        select: { id: true },
      });

      // `isActive` is the membership's authentication gate, and it is what
      // approval flips -- `AuthService` never reads `status`. The role is
      // granted now even for a pending membership: it cannot be used until
      // the account can log in, and deferring it would leave approval
      // having to re-derive which role the policy named at registration
      // time.
      const tenantUser = await tx.tenantUser.create({
        data: {
          tenantId,
          authAccountId: authAccount.id,
          name: fullName,
          status,
          isActive: !requiresApproval,
          roles: { connect: { id: defaultRoleId } },
        },
        select: { id: true },
      });

      return { userId: tenantUser.id, authAccountId: authAccount.id };
    });

    // After the commit, and never fatal: the account exists either way,
    // and unwinding a committed registration because an SMTP server was
    // briefly unreachable would be worse than a message that has to be
    // sent again.
    const emailDelivered = requiresApproval
      ? await this.notifyApprovers(tenantId, tenant.name, email)
      : await this.welcome(email, tenant.name);

    await this.authAuditService.record({
      event: AuthAuditEvent.USER_SELF_REGISTERED,
      tenantId,
      subjectAuthAccountId: created.authAccountId,
      metadata: {
        userId: created.userId,
        email,
        status,
        requiresApproval,
        roleId: defaultRoleId,
        emailDelivered,
      },
    });

    return {
      tenantId,
      userId: created.userId,
      email,
      status,
      requiresApproval,
    };
  }

  /**
   * An empty whitelist means "any domain", not "no domain" -- the list
   * only ever narrows. The toggle is what closes a tenant, and it has
   * already been checked by the time this runs.
   */
  private assertDomainAllowed(email: string, allowedDomains: string[]): void {
    if (allowedDomains.length === 0) {
      return;
    }

    // The address is already lowercased and trimmed, and class-validator
    // has already established that it is an address, so everything after
    // the last `@` is its domain.
    const domain = email.slice(email.lastIndexOf('@') + 1);

    if (!allowedDomains.includes(domain)) {
      throw new BadRequestException({
        error: USER_ERROR_CODES.DOMAIN_NOT_ALLOWED,
        message:
          'This tenant only accepts registrations from its allowed email domains.',
      });
    }
  }

  /** Mails the registrant. Reports delivery rather than raising on it. */
  private async welcome(email: string, tenantName: string): Promise<boolean> {
    const outcome = await this.emailDeliveryService.sendSelfRegistrationWelcome(
      email,
      tenantName,
    );

    if (!outcome.delivered) {
      this.logger.warn(
        `Self-registration welcome delivery failed: ${outcome.errorCode ?? 'unknown error'}`,
      );
    }

    return outcome.delivered;
  }

  /**
   * Tells the people who can act on it. "Who can approve" is read from the
   * permission catalog rather than from a role name: a tenant that renamed
   * or split its admin role still gets the notice, and one that has not
   * granted `tenant.user.manage` to anybody gets a log line instead of a
   * silent drop.
   */
  private async notifyApprovers(
    tenantId: string,
    tenantName: string,
    registrantEmail: string,
  ): Promise<boolean> {
    const approvers = await this.prisma.tenantUser.findMany({
      where: {
        tenantId,
        status: TenantUserStatus.ACTIVE,
        isActive: true,
        roles: {
          some: {
            rolePermissions: {
              some: { permission: { code: TENANT_USER_MANAGE_PERMISSION } },
            },
          },
        },
      },
      select: { authAccount: { select: { email: true } } },
      take: MAX_APPROVAL_NOTICE_RECIPIENTS,
    });

    const recipients = approvers.map((approver) => approver.authAccount.email);

    if (recipients.length === 0) {
      this.logger.warn(
        `Tenant ${tenantId} has a registration awaiting approval but no active user with ${TENANT_USER_MANAGE_PERMISSION} to notify.`,
      );
      return false;
    }

    const outcome =
      await this.emailDeliveryService.sendSelfRegistrationPendingApproval(
        recipients,
        tenantName,
        registrantEmail,
      );

    if (!outcome.delivered) {
      this.logger.warn(
        `Self-registration approval notice delivery failed: ${outcome.errorCode ?? 'unknown error'}`,
      );
    }

    return outcome.delivered;
  }

  private assertPasswordMeetsPolicy(password: string): void {
    const violations = validatePasswordStrength(password);

    if (violations.length > 0) {
      throw new BadRequestException({
        error: AUTH_ERROR_CODES.PASSWORD_POLICY_VIOLATION,
        message: violations,
      });
    }
  }

  /**
   * `403`, per the Users specification's error table. Deliberately says
   * nothing about which of the three reasons applies.
   */
  private selfRegistrationDisabled(): ForbiddenException {
    return new ForbiddenException({
      error: USER_ERROR_CODES.SELF_REG_DISABLED,
      message: 'This tenant is not open for self-registration.',
    });
  }
}
