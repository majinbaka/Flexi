import { Controller, Get } from '@nestjs/common';
import { NotImplementedStatus } from '@flexi/shared-types';
import { CronJobsService } from './cron-jobs.service';

/**
 * Stub controller for the "cron-jobs" feature area.
 * Single placeholder route: GET /api/cron-jobs -> { success:true, data:{ status:'not-implemented' } }
 * (envelope applied globally by ResponseInterceptor).
 */
@Controller('cron-jobs')
export class CronJobsController {
  constructor(private readonly cronJobsService: CronJobsService) {}

  @Get()
  getStatus(): NotImplementedStatus {
    return this.cronJobsService.getStatus();
  }
}
