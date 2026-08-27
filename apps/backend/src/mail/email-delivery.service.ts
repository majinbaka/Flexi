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
 * SMTP delivery for the transactional messages the platform sends itself:
 * the one-time First Admin setup invitation and the password-reset code.
 * The transporter is configured once for the process; a raw setup token or
 * OTP is accepted only for the duration of the call that builds the
 * message, and is never logged or persisted.
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

  /**
   * Delivers a password-reset code. The raw OTP reaches this method, goes
   * straight into the message body and is never logged -- the caller has
   * only ever persisted its SHA-256 hash.
   *
   * The message carries the code itself rather than a one-click link: a
   * link would put the secret in a URL, where it survives in browser
   * history, `Referer` headers and proxy logs. `resetUrl` therefore points
   * at the form only, with the address pre-filled so the holder does not
   * have to retype it.
   */
  async sendPasswordResetOtp(
    email: string,
    otp: string,
    expiresInMinutes: number,
  ): Promise<SendEmailOutcome> {
    if (!this.transporter || !this.from) {
      return { delivered: false, errorCode: 'SMTP_NOT_CONFIGURED' };
    }

    const resetUrl = this.createResetPasswordUrl(email);

    try {
      const result = await this.transporter.sendMail({
        from: this.from,
        to: email,
        subject: 'Your password reset code',
        text:
          `Your password reset code is ${otp}. ` +
          `It expires in ${expiresInMinutes} minutes. ` +
          `Enter it at ${resetUrl}. ` +
          'If you did not request a password reset, ignore this message.',
        html:
          `<p>Your password reset code is <strong>${escapeHtml(otp)}</strong>.</p>` +
          `<p>It expires in ${expiresInMinutes} minutes. ` +
          `<a href="${escapeHtml(resetUrl)}">Enter it here</a>.</p>` +
          '<p>If you did not request a password reset, ignore this message.</p>',
      });

      if (this.wasRecipientRejected(result)) {
        return { delivered: false, errorCode: 'SMTP_RECIPIENT_REJECTED' };
      }

      return { delivered: true };
    } catch (error) {
      return { delivered: false, errorCode: this.errorCodeFor(error) };
    }
  }

  /**
   * Delivers an administrator-generated temporary password. Like the reset
   * code, it reaches this method raw, goes straight into the message body
   * and is never logged -- and it is deliberately not in the API response
   * of the call that generated it, so this transport is the only way it
   * leaves the server.
   */
  async sendTemporaryPassword(
    email: string,
    temporaryPassword: string,
  ): Promise<SendEmailOutcome> {
    if (!this.transporter || !this.from) {
      return { delivered: false, errorCode: 'SMTP_NOT_CONFIGURED' };
    }

    const signInUrl = new URL('/login', this.setupAccountUrlBase).toString();

    try {
      const result = await this.transporter.sendMail({
        from: this.from,
        to: email,
        subject: 'Your password was reset by an administrator',
        text:
          `An administrator reset your password. Your temporary password is ${temporaryPassword}. ` +
          `Sign in at ${signInUrl} and choose a new password straight away -- ` +
          'you will be asked to before you can do anything else.',
        html:
          '<p>An administrator reset your password. Your temporary password is ' +
          `<strong>${escapeHtml(temporaryPassword)}</strong>.</p>` +
          `<p><a href="${escapeHtml(signInUrl)}">Sign in</a> and choose a new password ` +
          'straight away -- you will be asked to before you can do anything else.</p>',
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

  /**
   * Deliberately reuses `SETUP_ACCOUNT_URL_BASE`, which env validation
   * already constrains to a bare HTTP(S) origin and cross-checks against
   * `CORS_ORIGIN` in production: it is the frontend origin, not something
   * specific to the setup flow. A second variable naming the same origin
   * would only give the two a way to drift apart.
   */
  private createResetPasswordUrl(email: string): string {
    const resetUrl = new URL('/reset-password', this.setupAccountUrlBase);
    resetUrl.searchParams.set('email', email);
    return resetUrl.toString();
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
