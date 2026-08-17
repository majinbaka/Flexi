import { Controller, Get } from '@nestjs/common';
import { HealthService, HealthStatus } from './health.service';

/**
 * GET /api/health -> { success:true, data:{ status:'ok' }, error:null }
 * (envelope applied globally via APP_INTERCEPTOR, see app.module.ts).
 */
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  getStatus(): HealthStatus {
    return this.healthService.getStatus();
  }
}
