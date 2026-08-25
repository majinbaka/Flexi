import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { SentMessageInfo, Transporter } from 'nodemailer';

export interface SendEmailOutcome {
  delivered: boolean;
  errorCode?: string;
}

type SmtpErrorCode =
  | 'SMTP_AUTH_FAILED'
  | 'SMTP_DELIVERY_FAILED'
  | 'SMTP_NOT_CONFIGURED'
  | 'SMTP_RECIPIENT_REJECTED'
  | 'SMTP_TIMEOUT';

/**
 * SMTP delivery for the one-time First Admin setup invitation. The transporter
 * is configured once for the process; a raw setup token is accepted only for
 * this call, used to construct the message, and is never logged or persisted.
 */
@Injectable()
export class EmailDeliveryService {
  private readonly transporter: Transporter | null;
  private readonly from: string | undefined;
  private readonly setupAccountUrlBase: string;

  constructor(private readonly configService: ConfigService) {
    const smtpEnabled = this.configService.get<boolean>('SMTP_ENABLED');
    this.from = this.configService.get<string>('SMTP_FROM');
    this.setupAccountUrlBase =
      this.configService.get<string>('SETUP_ACCOUNT_URL_BASE') ??
      'http://localhost:5173';

    this.transporter = smtpEnabled
      ? nodemailer.createTransport({
          host: this.configService.get<string>('SMTP_HOST'),
          port: this.configService.get<number>('SMTP_PORT'),
          secure: this.configService.get<boolean>('SMTP_SECURE') ?? false,
          auth: {
            user: this.configService.get<string>('SMTP_USERNAME'),
            pass: this.configService.get<string>('SMTP_PASSWORD'),
          },
          connectionTimeout: this.configService.get<number>('SMTP_TIMEOUT_MS'),
          greetingTimeout: this.configService.get<number>('SMTP_TIMEOUT_MS'),
          socketTimeout: this.configService.get<number>('SMTP_TIMEOUT_MS'),
        })
      : null;
  }

  async sendSetupInvite(
    email: string,
    tenantName: string,
    setupToken: string,
  ): Promise<SendEmailOutcome> {
    if (!this.transporter || !this.from) {
      return { delivered: false, errorCode: 'SMTP_NOT_CONFIGURED' };
    }

    const setupUrl = this.createSetupUrl(setupToken);

    try {
      const result = await this.transporter.sendMail({
        from: this.from,
        to: email,
        subject: 'Complete your account setup',
        text: `Complete setup for ${tenantName}: ${setupUrl}`,
        html: `<p>Complete setup for ${escapeHtml(tenantName)}:</p><p><a href="${escapeHtml(setupUrl)}">Complete your account setup</a></p>`,
      });

      if (this.wasRecipientRejected(result)) {
        return { delivered: false, errorCode: 'SMTP_RECIPIENT_REJECTED' };
      }

      return { delivered: true };
    } catch (error) {
      return { delivered: false, errorCode: this.errorCodeFor(error) };
    }
  }

  private createSetupUrl(setupToken: string): string {
    const setupUrl = new URL('/setup-account', this.setupAccountUrlBase);
    setupUrl.searchParams.set('token', setupToken);
    return setupUrl.toString();
  }

  private wasRecipientRejected(result: SentMessageInfo): boolean {
    return Array.isArray(result.rejected) && result.rejected.length > 0;
  }

  private errorCodeFor(error: unknown): SmtpErrorCode {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;

    if (code === 'EAUTH') {
      return 'SMTP_AUTH_FAILED';
    }
    if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
      return 'SMTP_TIMEOUT';
    }
    if (code === 'EENVELOPE') {
      return 'SMTP_RECIPIENT_REJECTED';
    }
    return 'SMTP_DELIVERY_FAILED';
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}
