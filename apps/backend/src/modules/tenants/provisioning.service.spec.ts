import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { TenantProvisioningService } from './provisioning.service';
import { TENANT_PROVISIONING_START_JOB } from './provisioning.types';
import { TenantKnexService } from '../../tenancy/tenant-knex.service';
import { DynamicTablesService } from '../dynamic-tables/dynamic-tables.service';
import { TenancyClsStore } from '../../tenancy/tenant-context';

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

  function buildCls() {
    return {
      runWith: jest.fn((_context: unknown, fn: () => unknown) => fn()),
    } as unknown as ClsService<TenancyClsStore>;
  }

  function buildTenantKnexService() {
    return {
      raw: jest.fn().mockResolvedValue(undefined),
    } as unknown as TenantKnexService;
  }

  function buildDynamicTablesService() {
    return {
      ensureMetaTables: jest.fn().mockResolvedValue(undefined),
    } as unknown as DynamicTablesService;
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
      // Queues the first three call-specific responses (attempt claim's
      // SELECT + UPDATE...RETURNING, then updateAttemptSteps()'s first
      // FOR UPDATE SELECT), then falls back to returning `claimedAttemptRow`
      // for every subsequent call -- Story 2.2's schema/bootstrap steps each
      // add one more updateAttemptSteps() round trip (one more $queryRaw
      // FOR UPDATE SELECT) after tenant_creation's, so a fixed 3-call queue
      // is no longer enough.
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([attemptRow])
        .mockResolvedValueOnce([claimedAttemptRow])
        .mockResolvedValue([claimedAttemptRow]),
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
              id: 'tenant1',
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
    const cls = buildCls();
    const tenantKnexService = buildTenantKnexService();
    const dynamicTablesService = buildDynamicTablesService();
    const service = new TenantProvisioningService(
      prisma as never,
      buildConfigService(),
      queue as never,
      cls,
      tenantKnexService,
      dynamicTablesService,
    );

    return {
      prisma,
      queue,
      service,
      tx,
      cls,
      tenantKnexService,
      dynamicTablesService,
    };
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

  it('claims an accepted attempt and creates one PROVISIONING tenant, then provisions its schema', async () => {
    const { prisma, service, tx, cls, tenantKnexService, dynamicTablesService } =
      buildService();

    await service.startLifecycle('attempt-1');

    expect(tenantInsertValues(prisma)).toEqual(
      expect.arrayContaining([
        'Acme Co',
        'acme-co',
        'PROVISIONING',
        'attempt-1',
      ]),
    );

    // tenant_creation + schema_created + bootstrap_migrated each go through
    // their own updateAttemptSteps() transaction (1 $queryRaw FOR UPDATE
    // SELECT + 1 $executeRaw UPDATE apiece), on top of claimAttempt()'s own
    // 2 $queryRaw calls (SELECT accepted attempt + UPDATE...RETURNING).
    expect(tx.$queryRaw).toHaveBeenCalledTimes(5);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(3);

    // CLS populated with { tenantId, schema } before any TenantKnexService/
    // DynamicTablesService call -- both mocked calls happen inside the
    // cls.runWith() callback.
    expect(cls.runWith).toHaveBeenCalledWith(
      { tenantId: 'tenant1', schema: 'tenant_tenant1' },
      expect.any(Function),
    );
    expect(tenantKnexService.raw).toHaveBeenCalledWith(
      'CREATE SCHEMA IF NOT EXISTS ??',
      ['tenant_tenant1'],
    );
    expect(dynamicTablesService.ensureMetaTables).toHaveBeenCalledTimes(1);

    // Step outcomes are recorded as a bound jsonb param -- find the
    // $executeRaw call whose stepOutcomes JSON contains each new step and
    // assert it was recorded 'succeeded'.
    const executeArgs = tx.$executeRaw.mock.calls.map(
      (call) => (call[0] as { values?: unknown[] }).values ?? [],
    );
    const findStepJson = (step: string) =>
      executeArgs
        .flat()
        .find(
          (value): value is string =>
            typeof value === 'string' && value.includes(`"step":"${step}"`),
        );

    const schemaCreatedJson = findStepJson('schema_created');
    expect(schemaCreatedJson).toBeDefined();
    expect(schemaCreatedJson).toContain('"status":"succeeded"');

    const bootstrapMigratedJson = findStepJson('bootstrap_migrated');
    expect(bootstrapMigratedJson).toBeDefined();
    expect(bootstrapMigratedJson).toContain('"status":"succeeded"');
  });

  it('exits without duplicate creation when another worker already linked a tenant, and still provisions schema', async () => {
    const { prisma, service, tx, tenantKnexService, dynamicTablesService } =
      buildService();
    prisma.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([
        {
          id: 'tenantexisting',
          slug: 'acme-co',
          status: 'PROVISIONING',
          onboardingAttemptId: 'attempt-1',
        },
      ])
      // readAttemptStatus()'s own SELECT (findTenantByAttemptId's linked
      // branch checks the attempt's current status before continuing) --
      // 'provisioning' here, so the reset branch is not taken.
      .mockResolvedValueOnce([{ status: 'provisioning' }]);

    await service.startLifecycle('attempt-1');

    // recordTenantCreationSuccess + schema_created + bootstrap_migrated:
    // three updateAttemptSteps() rounds (no resume-path reset, since the
    // attempt's current status here is 'provisioning', not 'failed').
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
    expect(tenantKnexService.raw).toHaveBeenCalledWith(
      'CREATE SCHEMA IF NOT EXISTS ??',
      ['tenant_tenantexisting'],
    );
    expect(dynamicTablesService.ensureMetaTables).toHaveBeenCalledTimes(1);
  });

  it('provisions schema when a slug race resolves to this same attempt', async () => {
    const { prisma, service, tx, tenantKnexService, dynamicTablesService } =
      buildService();
    prisma.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce({ code: '23505' })
      .mockResolvedValueOnce([
        {
          id: 'tenantsamecuid',
          slug: 'acme-co',
          status: 'PROVISIONING',
          onboardingAttemptId: 'attempt-1',
        },
      ]);

    await service.startLifecycle('attempt-1');

    expect(tenantKnexService.raw).toHaveBeenCalledWith(
      'CREATE SCHEMA IF NOT EXISTS ??',
      ['tenant_tenantsamecuid'],
    );
    expect(dynamicTablesService.ensureMetaTables).toHaveBeenCalledTimes(1);

    const executeArgs = tx.$executeRaw.mock.calls.map(
      (call) => (call[0] as { values?: unknown[] }).values ?? [],
    );
    const findStepJson = (step: string) =>
      executeArgs
        .flat()
        .find(
          (value): value is string =>
            typeof value === 'string' && value.includes(`"step":"${step}"`),
        );
    expect(findStepJson('schema_created')).toContain('"status":"succeeded"');
    expect(findStepJson('bootstrap_migrated')).toContain(
      '"status":"succeeded"',
    );
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

  describe('schema provisioning and bootstrap migration (Story 2.2)', () => {
    function findStepJson(
      tx: { $executeRaw: jest.Mock },
      step: string,
    ): string | undefined {
      return tx.$executeRaw.mock.calls
        .map((call) => (call[0] as { values?: unknown[] }).values ?? [])
        .flat()
        .find(
          (value): value is string =>
            typeof value === 'string' && value.includes(`"step":"${step}"`),
        );
    }

    it('records schema_created as succeeded and calls resolveTenantSchema with the correct tenant id', async () => {
      const { service, tx, tenantKnexService } = buildService();

      await service.startLifecycle('attempt-1');

      expect(tenantKnexService.raw).toHaveBeenCalledWith(
        'CREATE SCHEMA IF NOT EXISTS ??',
        ['tenant_tenant1'],
      );
      const json = findStepJson(tx, 'schema_created');
      expect(json).toBeDefined();
      expect(json).toContain('"status":"succeeded"');
    });

    it('records schema_created as failed and re-throws when CREATE SCHEMA fails', async () => {
      const { prisma, service, tx, tenantKnexService } = buildService();
      (tenantKnexService.raw as jest.Mock).mockRejectedValueOnce(
        new Error('connection terminated unexpectedly'),
      );

      await expect(service.startLifecycle('attempt-1')).rejects.toThrow();

      const json = findStepJson(tx, 'schema_created');
      expect(json).toBeDefined();
      expect(json).toContain('"status":"failed"');
      expect(json).toContain('SCHEMA_CREATION_FAILED');
      // Safe error message only -- no raw error message/stack leaked into
      // the recorded step outcome.
      expect(json).not.toContain('connection terminated unexpectedly');

      // Attempt status must not be flipped to 'failed' by this story --
      // every updateAttemptSteps() call in the schema/bootstrap path passes
      // ATTEMPT_STATUS_PROVISIONING, never ATTEMPT_STATUS_FAILED.
      const statuses = tx.$executeRaw.mock.calls.map(
        (call) => (call[0] as { values?: unknown[] }).values?.[0],
      );
      expect(statuses).not.toContain('failed');
      void prisma;
    });

    it('records bootstrap_migrated as succeeded after schema_created succeeds', async () => {
      const { service, tx, dynamicTablesService } = buildService();

      await service.startLifecycle('attempt-1');

      expect(dynamicTablesService.ensureMetaTables).toHaveBeenCalledTimes(1);
      const json = findStepJson(tx, 'bootstrap_migrated');
      expect(json).toBeDefined();
      expect(json).toContain('"status":"succeeded"');
    });

    it('records bootstrap_migrated as failed and re-throws when ensureMetaTables throws', async () => {
      const { service, tx, dynamicTablesService } = buildService();
      (dynamicTablesService.ensureMetaTables as jest.Mock).mockRejectedValueOnce(
        new Error('relation "_meta_tables" already exists'),
      );

      await expect(service.startLifecycle('attempt-1')).rejects.toThrow();

      // schema_created must still have succeeded (bootstrap runs after it).
      const schemaJson = findStepJson(tx, 'schema_created');
      expect(schemaJson).toContain('"status":"succeeded"');

      const bootstrapJson = findStepJson(tx, 'bootstrap_migrated');
      expect(bootstrapJson).toBeDefined();
      expect(bootstrapJson).toContain('"status":"failed"');
      expect(bootstrapJson).toContain('BOOTSTRAP_MIGRATION_FAILED');
      expect(bootstrapJson).not.toContain('_meta_tables');

      const statuses = tx.$executeRaw.mock.calls.map(
        (call) => (call[0] as { values?: unknown[] }).values?.[0],
      );
      expect(statuses).not.toContain('failed');
    });

    it('worker retry: schema + tables already exist is a no-op and both steps still record succeeded', async () => {
      const { service, tx, tenantKnexService, dynamicTablesService } =
        buildService();
      // CREATE SCHEMA IF NOT EXISTS / ensureMetaTables() are themselves
      // idempotent -- a retry against pre-existing objects still resolves
      // without error, exactly like their mocked (no-op) behavior here.

      await service.startLifecycle('attempt-1');

      expect(tenantKnexService.raw).toHaveBeenCalledTimes(1);
      expect(dynamicTablesService.ensureMetaTables).toHaveBeenCalledTimes(1);
      expect(findStepJson(tx, 'schema_created')).toContain(
        '"status":"succeeded"',
      );
      expect(findStepJson(tx, 'bootstrap_migrated')).toContain(
        '"status":"succeeded"',
      );
    });

    it('resumes after a prior job-timeout failure: resets attempt status to provisioning before recording schema_created/bootstrap_migrated as succeeded', async () => {
      const { prisma, service, tx, tenantKnexService, dynamicTablesService } =
        buildService();

      // Simulate the state left behind by provisioning.worker.ts's
      // withTimeout() -> recordProvisioningTimeout(): a tenant is already
      // linked to the attempt (creation succeeded before the timeout), but
      // the attempt's own `status` column was set to 'failed'. BullMQ then
      // retries the same job, invoking startLifecycle() a second time.
      //
      // Stateful mock: `currentStatus` mirrors the real row's `status`
      // column. The resume-path reset is a direct, ungated
      // `prisma.$executeRaw()` UPDATE (see
      // resetAttemptStatusToProvisioning()) -- NOT routed through the
      // guarded updateAttemptSteps()/tx.$executeRaw path, since that guard
      // reads the row's still-'failed' status inside its own FOR UPDATE
      // transaction and would drop the reset write too. Once the reset
      // flips currentStatus to 'provisioning', every subsequent
      // updateAttemptSteps() call (tenant_creation, schema_created,
      // bootstrap_migrated) sees a non-'failed' row and is let through.
      let currentStatus = 'failed';
      prisma.$queryRaw
        .mockReset()
        // findTenantByAttemptId(): a tenant is already linked.
        .mockImplementationOnce(async () => [
          {
            id: 'tenant1',
            slug: 'acme-co',
            status: 'PROVISIONING',
            onboardingAttemptId: 'attempt-1',
          },
        ])
        // readAttemptStatus(): the attempt's current status, 'failed' from
        // the prior timeout -- read via `this.prisma.$queryRaw` directly
        // (not inside a transaction), so this is the second overall call.
        .mockImplementation(async () => [{ status: currentStatus }]);
      prisma.$executeRaw.mockReset().mockImplementation(async (query: unknown) => {
        const values = (query as { values?: unknown[] }).values ?? [];
        if (typeof values[0] === 'string') {
          currentStatus = values[0];
        }
        return 1;
      });
      tx.$queryRaw.mockReset().mockImplementation(async () => [
        {
          id: 'attempt-1',
          status: currentStatus,
          safePayload: attemptRow.safePayload,
          stepOutcomes: attemptRow.stepOutcomes,
        },
      ]);
      tx.$executeRaw.mockReset().mockResolvedValue(1);

      await service.startLifecycle('attempt-1');

      // The ungated reset ran and flipped the mirrored status.
      expect(prisma.$executeRaw).toHaveBeenCalledWith(
        expect.objectContaining({
          values: expect.arrayContaining(['provisioning', 'attempt-1']),
        }),
      );
      expect(currentStatus).toBe('provisioning');

      expect(tenantKnexService.raw).toHaveBeenCalledWith(
        'CREATE SCHEMA IF NOT EXISTS ??',
        ['tenant_tenant1'],
      );
      expect(dynamicTablesService.ensureMetaTables).toHaveBeenCalledTimes(1);

      const schemaJson = findStepJson(tx, 'schema_created');
      expect(schemaJson).toBeDefined();
      expect(schemaJson).toContain('"status":"succeeded"');

      const bootstrapJson = findStepJson(tx, 'bootstrap_migrated');
      expect(bootstrapJson).toBeDefined();
      expect(bootstrapJson).toContain('"status":"succeeded"');

      // None of this story's writes may set status back to 'failed'.
      const statuses = tx.$executeRaw.mock.calls.map(
        (call) => (call[0] as { values?: unknown[] }).values?.[0],
      );
      expect(statuses).not.toContain('failed');
    });
  });
});
