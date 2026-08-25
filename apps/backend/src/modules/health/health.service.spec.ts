import { PrismaService } from '../../prisma/prisma.service';
import { HealthService, READINESS_TIMEOUT_MS } from './health.service';

describe('HealthService', () => {
  function buildPrisma(): { $queryRaw: jest.Mock } {
    return {
      $queryRaw: jest.fn(),
    };
  }

  it('reports ready when Prisma and PostgreSQL-backed queue storage respond', async () => {
    const prisma = buildPrisma();
    prisma.$queryRaw.mockResolvedValue({});
    const service = new HealthService(prisma as unknown as PrismaService);

    await expect(service.getReadiness()).resolves.toEqual({
      status: 'ok',
      checks: { database: 'ok', queue: 'ok' },
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('reports aggregate failure when a dependency rejects without exposing its error', async () => {
    const prisma = buildPrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('password=secret host=db.internal'));
    const service = new HealthService(prisma as unknown as PrismaService);

    await expect(service.getReadiness()).resolves.toEqual({
      status: 'error',
      checks: { database: 'ok', queue: 'error' },
    });
  });

  it('marks an unresponsive dependency as failed after the short timeout', async () => {
    jest.useFakeTimers();
    const prisma = buildPrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce({})
      .mockImplementationOnce(() => new Promise<void>(() => undefined));
    const service = new HealthService(prisma as unknown as PrismaService);

    const readiness = service.getReadiness();
    await jest.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);

    await expect(readiness).resolves.toEqual({
      status: 'error',
      checks: { database: 'ok', queue: 'error' },
    });
    jest.useRealTimers();
  });
});
