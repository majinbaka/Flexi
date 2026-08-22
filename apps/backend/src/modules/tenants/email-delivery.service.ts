import { Injectable } from '@nestjs/common';

export interface SendEmailOutcome {
  delivered: boolean;
  errorCode?: string;
}

/**
 * Backup-email delivery for the tenant setup handoff (Story 2.5).
 *
 * Always resolves `{ delivered: false, errorCode: 'SMTP_NOT_CONFIGURED' }`
 * -- no `nodemailer`/real SMTP client and no `SMTP_*` config exist yet.
 * Real sending is deferred to the independently-shippable Mail & Template
 * module (`mail-templates.service.ts`, still a stub). This service is
 * written so a future story can swap this method's body for a real send
 * without touching the provisioning orchestration or its step-outcome
 * contract -- callers only ever see this `{ delivered, errorCode? }` shape.
 */
@Injectable()
export class EmailDeliveryService {
  async sendSetupInvite(
    _email: string,
    _tenantName: string,
  ): Promise<SendEmailOutcome> {
    return { delivered: false, errorCode: 'SMTP_NOT_CONFIGURED' };
  }
}
