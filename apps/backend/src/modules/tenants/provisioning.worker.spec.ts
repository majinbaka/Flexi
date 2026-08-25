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
    expect(provisioningService.startLifecycle).toHaveBeenCalledWith(
      'attempt-timeout',
      expect.objectContaining({ aborted: true }),
    );
  });

  it('uses a fresh, non-aborted signal when BullMQ retries a timed-out job', async () => {
    const provisioningService = {
      startLifecycle: jest
        .fn()
        .mockImplementationOnce(() => new Promise<void>(() => undefined))
        .mockResolvedValueOnce(undefined),
      recordProvisioningTimeout: jest.fn().mockResolvedValue(undefined),
    } as unknown as TenantProvisioningService;
    const worker = new TenantProvisioningWorker(
      provisioningService,
      buildConfigService(),
    );
    const job = {
      data: { attemptId: 'attempt-retry' },
    } as Job<TenantProvisioningJobData>;

    await expect(worker.process(job)).rejects.toThrow('exceeded 5ms timeout');
    await expect(worker.process(job)).resolves.toBeUndefined();

    const [, timedOutSignal] = (provisioningService.startLifecycle as jest.Mock)
      .mock.calls[0];
    const [, retrySignal] = (provisioningService.startLifecycle as jest.Mock)
      .mock.calls[1];
    expect(timedOutSignal).not.toBe(retrySignal);
    expect(timedOutSignal.aborted).toBe(true);
    expect(retrySignal.aborted).toBe(false);
    expect(provisioningService.recordProvisioningTimeout).toHaveBeenCalledTimes(
      1,
    );
  });
});
