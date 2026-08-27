import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { EmailDeliveryService } from './email-delivery.service';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

describe('EmailDeliveryService', () => {
  const createTransport = nodemailer.createTransport as jest.Mock;

  function buildConfig(values: Record<string, unknown>) {
    return {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
  }

  function buildService(values: Record<string, unknown> = {}) {
    return new EmailDeliveryService(
      buildConfig({
        SMTP_ENABLED: true,
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: 587,
        SMTP_USERNAME: 'smtp-user',
        SMTP_PASSWORD: 'smtp-password',
        SMTP_FROM: 'noreply@example.com',
        SMTP_SECURE: false,
        SMTP_TIMEOUT_MS: 2500,
        SETUP_ACCOUNT_URL_BASE: 'https://app.example.com',
        ...values,
      }),
    );
  }

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns SMTP_NOT_CONFIGURED without creating a transporter when disabled', async () => {
    const service = buildService({ SMTP_ENABLED: false });

    await expect(
      service.sendSetupInvite('admin@acme.example', 'Acme Co', 'raw-token'),
    ).resolves.toEqual({
      delivered: false,
      errorCode: 'SMTP_NOT_CONFIGURED',
    });
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('sends an escaped minimal invitation with a setup URL and configures one bounded transporter', async () => {
    const sendMail = jest.fn().mockResolvedValue({ rejected: [] });
    createTransport.mockReturnValue({ sendMail });

    const service = buildService();
    await expect(
      service.sendSetupInvite(
        'admin@acme.example',
        'Acme <Operations>',
        'raw-token',
      ),
    ).resolves.toEqual({ delivered: true });

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.example.com',
        port: 587,
        connectionTimeout: 2500,
        greetingTimeout: 2500,
        socketTimeout: 2500,
      }),
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'noreply@example.com',
        to: 'admin@acme.example',
        subject: 'Complete your account setup',
        text: expect.stringContaining(
          'https://app.example.com/setup-account?token=raw-token',
        ),
        html: expect.stringContaining('Acme &lt;Operations&gt;'),
      }),
    );
  });

  it.each([
    ['ETIMEDOUT', 'SMTP_TIMEOUT'],
    ['EAUTH', 'SMTP_AUTH_FAILED'],
    ['ECONNECTION', 'SMTP_DELIVERY_FAILED'],
  ])(
    'maps %s provider errors to the stable %s code',
    async (code, errorCode) => {
      const sendMail = jest.fn().mockRejectedValue({ code });
      createTransport.mockReturnValue({ sendMail });
      const service = buildService();

      await expect(
        service.sendSetupInvite('admin@acme.example', 'Acme Co', 'raw-token'),
      ).resolves.toEqual({ delivered: false, errorCode });
    },
  );

  describe('sendPasswordResetOtp', () => {
    it('returns SMTP_NOT_CONFIGURED without creating a transporter when disabled', async () => {
      const service = buildService({ SMTP_ENABLED: false });

      await expect(
        service.sendPasswordResetOtp('user@acme.example', '123456', 5),
      ).resolves.toEqual({
        delivered: false,
        errorCode: 'SMTP_NOT_CONFIGURED',
      });
      expect(createTransport).not.toHaveBeenCalled();
    });

    /**
     * The code travels in the body, never in the link: a secret in a URL
     * survives in browser history, `Referer` headers and proxy logs. The
     * link therefore points at the form only, with the address pre-filled.
     */
    it('puts the code in the body and keeps it out of the link', async () => {
      const sendMail = jest.fn().mockResolvedValue({ rejected: [] });
      createTransport.mockReturnValue({ sendMail });
      const service = buildService();

      await expect(
        service.sendPasswordResetOtp('user@acme.example', '123456', 5),
      ).resolves.toEqual({ delivered: true });

      const [message] = sendMail.mock.calls[0];
      expect(message).toEqual(
        expect.objectContaining({
          from: 'noreply@example.com',
          to: 'user@acme.example',
          subject: 'Your password reset code',
        }),
      );
      expect(message.text).toContain('123456');
      expect(message.text).toContain('expires in 5 minutes');
      expect(message.text).toContain(
        'https://app.example.com/reset-password?email=user%40acme.example',
      );
      expect(message.html).toContain('<strong>123456</strong>');
      expect(message.html).not.toContain(
        'reset-password?email=user%40acme.example&',
      );
      expect(`${message.text}${message.html}`).not.toContain('token=123456');
    });

    it.each([
      ['ETIMEDOUT', 'SMTP_TIMEOUT'],
      ['EAUTH', 'SMTP_AUTH_FAILED'],
      ['EENVELOPE', 'SMTP_RECIPIENT_REJECTED'],
    ])(
      'maps %s provider errors to the stable %s code',
      async (code, errorCode) => {
        const sendMail = jest.fn().mockRejectedValue({ code });
        createTransport.mockReturnValue({ sendMail });
        const service = buildService();

        await expect(
          service.sendPasswordResetOtp('user@acme.example', '123456', 5),
        ).resolves.toEqual({ delivered: false, errorCode });
      },
    );

    it('maps recipient rejection', async () => {
      const sendMail = jest
        .fn()
        .mockResolvedValue({ rejected: ['user@acme.example'] });
      createTransport.mockReturnValue({ sendMail });
      const service = buildService();

      await expect(
        service.sendPasswordResetOtp('user@acme.example', '123456', 5),
      ).resolves.toEqual({
        delivered: false,
        errorCode: 'SMTP_RECIPIENT_REJECTED',
      });
    });
  });

  describe('sendTemporaryPassword', () => {
    it('returns SMTP_NOT_CONFIGURED without creating a transporter when disabled', async () => {
      const service = buildService({ SMTP_ENABLED: false });

      await expect(
        service.sendTemporaryPassword('user@acme.example', 'Tmp!Passw0rd123'),
      ).resolves.toEqual({
        delivered: false,
        errorCode: 'SMTP_NOT_CONFIGURED',
      });
      expect(createTransport).not.toHaveBeenCalled();
    });

    it('sends the password in the body with a sign-in link', async () => {
      const sendMail = jest.fn().mockResolvedValue({ rejected: [] });
      createTransport.mockReturnValue({ sendMail });
      const service = buildService();

      await expect(
        service.sendTemporaryPassword('user@acme.example', 'Tmp!Passw0rd123'),
      ).resolves.toEqual({ delivered: true });

      const [message] = sendMail.mock.calls[0];
      expect(message).toEqual(
        expect.objectContaining({
          to: 'user@acme.example',
          subject: 'Your password was reset by an administrator',
        }),
      );
      expect(message.text).toContain('Tmp!Passw0rd123');
      expect(message.text).toContain('https://app.example.com/login');
      // The password is HTML-escaped, so a special character in it cannot
      // break out of the markup.
      expect(message.html).toContain('Tmp!Passw0rd123');
    });

    it('escapes a password containing HTML metacharacters', async () => {
      const sendMail = jest.fn().mockResolvedValue({ rejected: [] });
      createTransport.mockReturnValue({ sendMail });
      const service = buildService();

      await service.sendTemporaryPassword('user@acme.example', 'a<b>&"c');

      const [message] = sendMail.mock.calls[0];
      expect(message.html).toContain('a&lt;b&gt;&amp;&quot;c');
      expect(message.html).not.toContain('<b>');
    });

    it('maps recipient rejection', async () => {
      const sendMail = jest
        .fn()
        .mockResolvedValue({ rejected: ['user@acme.example'] });
      createTransport.mockReturnValue({ sendMail });
      const service = buildService();

      await expect(
        service.sendTemporaryPassword('user@acme.example', 'Tmp!Passw0rd123'),
      ).resolves.toEqual({
        delivered: false,
        errorCode: 'SMTP_RECIPIENT_REJECTED',
      });
    });
  });

  it('maps recipient rejection without exposing provider details', async () => {
    const sendMail = jest.fn().mockResolvedValue({
      rejected: ['admin@acme.example'],
    });
    createTransport.mockReturnValue({ sendMail });
    const service = buildService();

    await expect(
      service.sendSetupInvite('admin@acme.example', 'Acme Co', 'raw-token'),
    ).resolves.toEqual({
      delivered: false,
      errorCode: 'SMTP_RECIPIENT_REJECTED',
    });
  });
});
