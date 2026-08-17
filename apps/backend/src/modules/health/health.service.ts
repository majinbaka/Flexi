import { Injectable } from '@nestjs/common';

export interface HealthStatus {
  status: 'ok';
}

/**
 * Minimal liveness signal for the backend process itself -- complements the
 * docker-compose healthchecks on postgres/redis, which only cover those two
 * services, not the Nest app.
 */
@Injectable()
export class HealthService {
  getStatus(): HealthStatus {
    return { status: 'ok' };
  }
}
