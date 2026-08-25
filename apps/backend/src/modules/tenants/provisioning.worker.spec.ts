import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { TenantProvisioningService } from './provisioning.service';
import { TenantProvisioningWorker } from './provisioning.worker';
import { TenantProvisioningJobData } from './provisioning.types';

describe('TenantProvisioningWorker', () => {
  function buildConfigService(timeoutMs = 5): ConfigService {
    return {
      get: jest.fn((key: string, defaultValue?: number) =>
        key === 'TENANT_PROVISIONING_JOB_TIMEOUT_MS' ? timeoutMs : defaultValue,
      ),
    } as unknown as ConfigService;
  }

  it('records durable timeout failure before rethrowing the timed-out job', async () => {
    const provisioningService = {
      startLifecycle: jest.fn(() => new Promise<void>(() => undefined)),
      recordProvisioningTimeout: jest.fn().mockResolvedValue(undefined),
    } as unknown as TenantProvisioningService;
    const worker = new TenantProvisioningWorker(
      provisioningService,
      buildConfigService(),
    );

    await expect(
      worker.process({
        data: { attemptId: 'attempt-timeout' },
      } as Job<TenantProvisioningJobData>),
    ).rejects.toThrow('exceeded 5ms timeout');

    expect(provisioningService.recordProvisioningTimeout).toHaveBeenCalledWith(
      'attempt-timeout',
    );
  });
});
