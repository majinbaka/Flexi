import { Injectable } from '@nestjs/common';
import { NotImplementedStatus } from '@flexi/shared-types';

/**
 * Stub service for the "cron-jobs" feature area. Holds no business logic yet --
 * see the specs under apps/frontend/src/docs/specifications/ for the
 * real scope of this module.
 */
@Injectable()
export class CronJobsService {
  getStatus(): NotImplementedStatus {
    return { status: 'not-implemented' };
  }
}
