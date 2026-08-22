import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { TenantProvisioningService } from './provisioning.service';
import { TENANT_PROVISIONING_START_JOB } from './provisioning.types';

describe('TenantProvisioningService', () => {
  const attemptRow = {
    id: 'attempt-1',
    status: 'accepted',
    safePayload: {
      tenantName: 'Acme Co',
      tenantSlug: 'acme-co',
      firstAdminEmail: 'admin@acme.example',
      plan: 'growth',
    },
    stepOutcomes: [
      {
        step: 'permission_check',
        status: 'succeeded',
        occurredAt: '2026-08-21T08:00:00.000Z',
      },
    ],
  };

  function buildConfigService() {
    return {
      get: jest.fn((key: string) =>
        key === 'TENANT_PROVISIONING_JOB_RETRY_COUNT' ? 3 : undefined,
      ),
    } as unknown as ConfigService;
  }

  function buildQueue() {
    return {
      add: jest.fn().mockResolvedValue(undefined),
    } as unknown as Queue;
  }

  function buildPrisma() {
    const claimedAttemptRow = {
      ...attemptRow,
      status: 'provisioning',
      stepOutcomes: [
        ...attemptRow.stepOutcomes,
        {
          step: 'provisioning_start',
          status: 'running',
          occurredAt: '2026-08-21T08:01:00.000Z',
        },
      ],
    };
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([attemptRow])
        .mockResolvedValueOnce([claimedAttemptRow])
        .mockResolvedValueOnce([claimedAttemptRow]),
      $executeRaw: jest.fn().mockResolvedValue(1),
    };

    return {
      tx,
      prisma: {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              id: 'tenant-1',
              slug: 'acme-co',
              status: 'PROVISIONING',
              onboardingAttemptId: 'attempt-1',
            },
          ]),
        $executeRaw: jest.fn().mockResolvedValue(1),
        $transaction: jest.fn((callback) => callback(tx)),
      },
    };
  }

  function tenantInsertValues(prisma: { $queryRaw: jest.Mock }) {
    const insertCall = prisma.$queryRaw.mock.calls.find((call) =>
      ((call[0] as { values?: unknown[] }).values ?? []).includes(
        'PROVISIONING',
      ),
    );

    return (insertCall?.[0] as { values?: unknown[] } | undefined)?.values;
  }

  function buildService() {
    const { prisma, tx } = buildPrisma();
    const queue = buildQueue();
    const service = new TenantProvisioningService(
      prisma as never,
      buildConfigService(),
      queue as never,
    );

    return { prisma, queue, service, tx };
  }
  it('enqueues accepted attempts with stable job id and retry options', async () => {
    const { prisma, queue, service } = buildService();

    await service.enqueueAcceptedAttempt('attempt-1');

    expect(queue.add).toHaveBeenCalledWith(
      TENANT_PROVISIONING_START_JOB,
      { attemptId: 'attempt-1' },
      {
        jobId: 'tenant-provisioning-attempt-1',
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      },
    );
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(
      (prisma.$executeRaw.mock.calls[0][0] as { values?: unknown[] }).values,
    ).toEqual(
      expect.arrayContaining(['tenant-provisioning-attempt-1', 'attempt-1']),
    );
  });

  it('claims an accepted attempt and creates one PROVISIONING tenant', async () => {
    const { prisma, service, tx } = buildService();

    await service.startLifecycle('attempt-1');

    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(tenantInsertValues(prisma)).toEqual(
      expect.arrayContaining([
        'Acme Co',
        'acme-co',
        'PROVISIONING',
        'attempt-1',
      ]),
    );
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('exits without duplicate creation when another worker already linked a tenant', async () => {
    const { prisma, service, tx } = buildService();
    prisma.$queryRaw.mockReset().mockResolvedValueOnce([
      {
        id: 'tenant-existing',
        slug: 'acme-co',
        status: 'PROVISIONING',
        onboardingAttemptId: 'attempt-1',
      },
    ]);

    await service.startLifecycle('attempt-1');

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('records safe failure when a slug race belongs to another attempt', async () => {
    const { prisma, service, tx } = buildService();
    prisma.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce({ code: '23505' })
      .mockResolvedValueOnce([
        {
          id: 'tenant-other',
          slug: 'acme-co',
          status: 'ACTIVE',
          onboardingAttemptId: 'attempt-other',
        },
      ]);

    await service.startLifecycle('attempt-1');

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const executeArg = tx.$executeRaw.mock.calls[0][0] as {
      values?: unknown[];
    };
    expect(executeArg.values).toEqual(
      expect.arrayContaining([
        'failed',
        expect.stringContaining('TENANT_SLUG_CONFLICT'),
        'attempt-1',
      ]),
    );
  });

  it('records safe failure for an accepted attempt with invalid safe payload', async () => {
    const { prisma, service, tx } = buildService();
    tx.$queryRaw.mockReset()
      .mockResolvedValueOnce([
        {
          ...attemptRow,
          safePayload: {
            tenantName: '',
            tenantSlug: 'Bad Slug',
            firstAdminEmail: 'not-an-email',
            plan: 'unknown',
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          ...attemptRow,
          status: 'provisioning',
          safePayload: {
            tenantName: '',
            tenantSlug: 'Bad Slug',
            firstAdminEmail: 'not-an-email',
            plan: 'unknown',
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          ...attemptRow,
          status: 'provisioning',
          safePayload: {
            tenantName: '',
            tenantSlug: 'Bad Slug',
            firstAdminEmail: 'not-an-email',
            plan: 'unknown',
          },
          stepOutcomes: [null, 'bad', ...attemptRow.stepOutcomes],
        },
      ]);

    await service.startLifecycle('attempt-1');

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        values: expect.arrayContaining([
          'failed',
          expect.stringContaining('INVALID_SAFE_PAYLOAD'),
          'attempt-1',
        ]),
      }),
    );
  });

  it('records a durable timeout failure on the attempt', async () => {
    const { service, tx } = buildService();

    await service.recordProvisioningTimeout('attempt-1');

    expect(tx.$executeRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        values: expect.arrayContaining([
          'failed',
          expect.stringContaining('PROVISIONING_TIMEOUT'),
          'attempt-1',
        ]),
      }),
    );
  });
});
