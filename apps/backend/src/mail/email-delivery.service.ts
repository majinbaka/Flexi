import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { USER_INVITE_ACCEPT_PATH } from '@flexi/shared-types';
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
 * the one-time First Admin setup invitation, the user invitation, the
 * password-reset code and an admin-generated temporary password. The
 * transporter is configured once for the process; a raw token, OTP or
 * password is accepted only for the duration of the call that builds the
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

    const signInUrl = this.createSignInUrl();

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

  /**
   * Delivers a user invitation. Same hash-only contract as the First Admin
   * setup message: the raw token reaches this method, goes straight into
   * the link and is never logged -- only its SHA-256 hash was persisted.
   *
   * The link points at `/accept-invite`, not `/setup-account`: the two
   * flows ask for different things (an invitee supplies a full name as
   * well as a password) and are redeemed by different endpoints, so they
   * cannot share a screen.
   */
  async sendUserInvite(
    email: string,
    tenantName: string,
    inviteToken: string,
    expiresInHours: number,
  ): Promise<SendEmailOutcome> {
    if (!this.transporter || !this.from) {
      return { delivered: false, errorCode: 'SMTP_NOT_CONFIGURED' };
    }

    const acceptUrl = this.createAcceptInviteUrl(inviteToken);

    try {
      const result = await this.transporter.sendMail({
        from: this.from,
        to: email,
        subject: `You have been invited to ${tenantName}`,
        text:
          `You have been invited to join ${tenantName}. ` +
          `Accept the invitation at ${acceptUrl}. ` +
          `The link expires in ${expiresInHours} hours.`,
        html:
          `<p>You have been invited to join ${escapeHtml(tenantName)}.</p>` +
          `<p><a href="${escapeHtml(acceptUrl)}">Accept the invitation</a> ` +
          `-- the link expires in ${expiresInHours} hours.</p>`,
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
   * Welcomes somebody who has just registered themselves into a tenant
   * that does not review sign-ups -- their account is already active, so
   * the message is a pointer to the sign-in page and nothing else. It
   * carries no credential: they chose their own password and it never
   * reached this service.
   */
  async sendSelfRegistrationWelcome(
    email: string,
    tenantName: string,
  ): Promise<SendEmailOutcome> {
    if (!this.transporter || !this.from) {
      return { delivered: false, errorCode: 'SMTP_NOT_CONFIGURED' };
    }

    const signInUrl = this.createSignInUrl();

    try {
      const result = await this.transporter.sendMail({
        from: this.from,
        to: email,
        subject: `Welcome to ${tenantName}`,
        text:
          `Your account on ${tenantName} is ready. ` +
          `Sign in at ${signInUrl} with the password you chose.`,
        html:
          `<p>Your account on ${escapeHtml(tenantName)} is ready.</p>` +
          `<p><a href="${escapeHtml(signInUrl)}">Sign in</a> with the password you chose.</p>`,
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
   * Tells a tenant's administrators that somebody is waiting for approval.
   *
   * Recipients go in `bcc` with the tenant's own `from` address in `to`:
   * one message rather than one per administrator, without putting the
   * whole administrator list in a header every one of them can read.
   */
  async sendSelfRegistrationPendingApproval(
    adminEmails: string[],
    tenantName: string,
    registrantEmail: string,
  ): Promise<SendEmailOutcome> {
    if (!this.transporter || !this.from) {
      return { delivered: false, errorCode: 'SMTP_NOT_CONFIGURED' };
    }

    if (adminEmails.length === 0) {
      return { delivered: false, errorCode: 'SMTP_RECIPIENT_REJECTED' };
    }

    try {
      const result = await this.transporter.sendMail({
        from: this.from,
        to: this.from,
        bcc: adminEmails,
        subject: `A new user is waiting for approval on ${tenantName}`,
        text:
          `${registrantEmail} has registered on ${tenantName} and is waiting for approval. ` +
          'Review the request on the Users screen.',
        html:
          `<p><strong>${escapeHtml(registrantEmail)}</strong> has registered on ` +
          `${escapeHtml(tenantName)} and is waiting for approval.</p>` +
          '<p>Review the request on the Users screen.</p>',
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
   * The `/accept-invite?token=...` URL an invitation links to. Public so
   * the invite service can put the same URL in the response of the call
   * that minted the token, without rebuilding it from a second copy of the
   * frontend origin.
   */
  createAcceptInviteUrl(inviteToken: string): string {
    const acceptUrl = new URL(
      USER_INVITE_ACCEPT_PATH,
      this.setupAccountUrlBase,
    );
    acceptUrl.searchParams.set('token', inviteToken);
    return acceptUrl.toString();
  }

  /**
   * The frontend's sign-in page. Same origin as every other link this
   * service builds -- see `createResetPasswordUrl` for why that is
   * `SETUP_ACCOUNT_URL_BASE` rather than a second variable.
   */
  private createSignInUrl(): string {
    return new URL('/login', this.setupAccountUrlBase).toString();
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
