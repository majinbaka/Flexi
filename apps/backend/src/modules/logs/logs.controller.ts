import { Controller, Get } from '@nestjs/common';
import { NotImplementedStatus } from '@flexi/shared-types';
import { LogsService } from './logs.service';

/**
 * Stub controller for the "logs" feature area.
 * Single placeholder route: GET /api/logs -> { success:true, data:{ status:'not-implemented' } }
 * (envelope applied globally by ResponseInterceptor).
 */
@Controller('logs')
export class LogsController {
  constructor(private readonly logsService: LogsService) {}

  @Get()
  getStatus(): NotImplementedStatus {
    return this.logsService.getStatus();
  }
}
