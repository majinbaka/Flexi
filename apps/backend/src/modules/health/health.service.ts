import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface HealthStatus {
  status: 'ok';
}

type DependencyStatus = 'ok' | 'error';

export interface ReadinessStatus {
  status: 'ok' | 'error';
  checks: {
    database: DependencyStatus;
    queue: DependencyStatus;
  };
}

export const READINESS_TIMEOUT_MS = 1000;

/**
 * Minimal liveness signal for the backend process itself -- complements the
 * docker-compose healthchecks on postgres/redis, which only cover those two
 * services, not the Nest app.
 */
@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  getStatus(): HealthStatus {
    return { status: 'ok' };
  }

  /**
   * Checks the application's two persistent dependencies without creating a
   * job or running queue migrations. BullMQ's PostgreSQL backend stores its
   * migration ledger in `bullmq.migration`, so reading that relation verifies
   * that the queue storage is available as well as the primary Prisma path.
   */
  async getReadiness(): Promise<ReadinessStatus> {
    const [database, queue] = await Promise.all([
      this.checkDependency(() => this.prisma.$queryRaw`SELECT 1`),
      this.checkDependency(
        () => this.prisma.$queryRaw`SELECT 1 FROM bullmq.migration LIMIT 1`,
      ),
    ]);

    return {
      status: database === 'ok' && queue === 'ok' ? 'ok' : 'error',
      checks: { database, queue },
    };
  }

  private async checkDependency(
    check: () => PromiseLike<unknown>,
  ): Promise<DependencyStatus> {
    try {
      await this.withTimeout(check());
      return 'ok';
    } catch {
      // Readiness deliberately exposes dependency names and their state only;
      // database/connection error text can include deployment details.
      return 'error';
    }
  }

  private withTimeout<T>(operation: PromiseLike<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Readiness check timed out'));
      }, READINESS_TIMEOUT_MS);

      operation.then(
        (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
  }
}
