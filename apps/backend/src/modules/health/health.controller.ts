import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthService, HealthStatus, ReadinessStatus } from './health.service';

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

  /**
   * GET /api/health/ready checks dependencies required to serve work, while
   * GET /api/health remains a process-only liveness signal.
   */
  @Get('ready')
  async getReadiness(): Promise<ReadinessStatus> {
    const readiness = await this.healthService.getReadiness();

    if (readiness.status === 'error') {
      throw new ServiceUnavailableException({
        error: 'READINESS_UNAVAILABLE',
        message: 'One or more required dependencies are unavailable',
        checks: readiness.checks,
      });
    }

    return readiness;
  }
}
