import { Injectable } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { TenantProvisioningService } from './provisioning.service';
import {
  TENANT_PROVISIONING_QUEUE_NAME,
  TenantProvisioningJobData,
} from './provisioning.types';

class TenantProvisioningTimeoutError extends Error {}

@Injectable()
@Processor(TENANT_PROVISIONING_QUEUE_NAME)
export class TenantProvisioningWorker extends WorkerHost {
  constructor(
    private readonly provisioningService: TenantProvisioningService,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  async process(job: Job<TenantProvisioningJobData>): Promise<void> {
    const timeoutMs = this.configService.get<number>(
      'TENANT_PROVISIONING_JOB_TIMEOUT_MS',
      60000,
    );

    try {
      await this.withTimeout(
        this.provisioningService.startLifecycle(job.data.attemptId),
        timeoutMs,
        job.data.attemptId,
      );
    } catch (error) {
      if (error instanceof TenantProvisioningTimeoutError) {
        await this.provisioningService.recordProvisioningTimeout(
          job.data.attemptId,
        );
      }
      throw error;
    }
  }

  private async withTimeout<T>(
    work: Promise<T>,
    timeoutMs: number,
    attemptId: string,
  ): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(
          new TenantProvisioningTimeoutError(
            `Tenant provisioning attempt ${attemptId} exceeded ${timeoutMs}ms timeout.`,
          ),
        );
      }, timeoutMs);
    });

    try {
      return await Promise.race([work, timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}
