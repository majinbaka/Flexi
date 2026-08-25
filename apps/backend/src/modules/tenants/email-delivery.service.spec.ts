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
