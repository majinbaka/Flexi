import { EmailDeliveryService } from './email-delivery.service';

describe('EmailDeliveryService', () => {
  function buildService() {
    return new EmailDeliveryService();
  }

  it('always resolves { delivered: false, errorCode: SMTP_NOT_CONFIGURED } regardless of the email/tenantName arguments passed', async () => {
    const service = buildService();

    await expect(
      service.sendSetupInvite('admin@acme.example', 'Acme Co'),
    ).resolves.toEqual({
      delivered: false,
      errorCode: 'SMTP_NOT_CONFIGURED',
    });

    await expect(
      service.sendSetupInvite(
        'ops@another-tenant.example',
        'Another Tenant Inc.',
      ),
    ).resolves.toEqual({
      delivered: false,
      errorCode: 'SMTP_NOT_CONFIGURED',
    });
  });
});
