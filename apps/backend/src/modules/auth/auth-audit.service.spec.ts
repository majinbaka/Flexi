import { AuthAuditEvent } from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthAuditService } from './auth-audit.service';

describe('AuthAuditService', () => {
  let create: jest.Mock;
  let service: AuthAuditService;

  beforeEach(() => {
    create = jest.fn().mockResolvedValue({});
    service = new AuthAuditService({
      authAuditLog: { create },
    } as unknown as PrismaService);
  });

  it('writes the event with its actor, subject and metadata', async () => {
    await service.record({
      event: AuthAuditEvent.ADMIN_FORCE_PASSWORD_RESET,
      tenantId: 'tenant_1',
      subjectAuthAccountId: 'auth_subject',
      actorAuthAccountId: 'auth_actor',
      metadata: { revokedSessionCount: 2 },
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        event: AuthAuditEvent.ADMIN_FORCE_PASSWORD_RESET,
        tenantId: 'tenant_1',
        subjectAuthAccountId: 'auth_subject',
        actorAuthAccountId: 'auth_actor',
        impersonated: false,
        impersonatorId: null,
        metadata: { revokedSessionCount: 2 },
      },
    });
  });

  /**
   * A self-service action has no third-party actor, and a SystemUser has no
   * tenant. Both are stored as explicit nulls rather than being left out,
   * so a row never distinguishes "not applicable" from "column missing".
   */
  it('normalises absent tenant and actor to null', async () => {
    await service.record({
      event: AuthAuditEvent.PASSWORD_CHANGED,
      subjectAuthAccountId: 'auth_subject',
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        event: AuthAuditEvent.PASSWORD_CHANGED,
        tenantId: null,
        subjectAuthAccountId: 'auth_subject',
        actorAuthAccountId: null,
        impersonated: false,
        impersonatorId: null,
        metadata: undefined,
      },
    });
  });

  /**
   * Audit writes are best-effort. Propagating this failure would mean a
   * hiccup on the audit table could fail a password reset whose real work
   * has already committed, leaving the holder locked out with a password
   * they believe is set.
   */
  it('swallows a write failure instead of failing the caller', async () => {
    create.mockRejectedValue(new Error('connection terminated'));

    await expect(
      service.record({
        event: AuthAuditEvent.PASSWORD_RESET_SUCCESS,
        subjectAuthAccountId: 'auth_subject',
      }),
    ).resolves.toBeUndefined();
  });
});
