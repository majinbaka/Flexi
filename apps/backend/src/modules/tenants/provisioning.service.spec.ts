import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { TenantProvisioningService } from './provisioning.service';
import { TENANT_PROVISIONING_START_JOB } from './provisioning.types';
import { TenantKnexService } from '../../tenancy/tenant-knex.service';
import { DynamicTablesService } from '../dynamic-tables/dynamic-tables.service';
import { TenantSeedService } from './tenant-seed.service';
import { FirstAdminService } from './first-admin.service';
import { SetupLinkService } from './setup-link.service';
import { EmailDeliveryService } from './email-delivery.service';
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

  function buildTenantSeedService() {
    return {
      bootstrapSeed: jest.fn().mockResolvedValue(undefined),
    } as unknown as TenantSeedService;
  }

  function buildFirstAdminService() {
    return {
      assign: jest.fn().mockResolvedValue(undefined),
      deactivate: jest.fn().mockResolvedValue({}),
    } as unknown as FirstAdminService;
  }

  function buildSetupLinkService() {
    return {
      generate: jest.fn().mockResolvedValue({
        setupToken: 'raw-setup-token-value',
        expiresAt: new Date('2026-08-22T08:00:00.000Z'),
      }),
      revokeAll: jest.fn().mockResolvedValue(undefined),
    } as unknown as SetupLinkService;
  }

  function buildEmailDeliveryService() {
    return {
      sendSetupInvite: jest.fn().mockResolvedValue({
        delivered: false,
        errorCode: 'SMTP_NOT_CONFIGURED',
      }),
    } as unknown as EmailDeliveryService;
  }

  function buildPrisma() {
    // Live, mutable mirror of the attempt row's `stepOutcomes` -- every
    // `tx.$executeRaw` UPDATE in `updateAttemptSteps()` writes
    // `[status, JSON.stringify(stepOutcomes), attemptId]`; tracking that
    // write here lets both `tx.$queryRaw`'s own FOR UPDATE SELECT and the
    // top-level `readAttemptStepOutcomes()`/`readAttemptAuditRow()` re-query
    // mocks return what was ACTUALLY recorded during this test run, instead
    // of a static fixture -- required for Story 2.6's
    // `handleProvisioningFailure()` to see the real steps-1-6 outcomes when
    // deciding what to compensate.
    let liveStepOutcomes: unknown[] = [...attemptRow.stepOutcomes];

    const tx = {
      // Queues the first three call-specific responses (attempt claim's
      // SELECT + UPDATE...RETURNING, then updateAttemptSteps()'s first
      // FOR UPDATE SELECT), then falls back to returning the live
      // stepOutcomes mirror for every subsequent call -- Story 2.2's
      // schema/bootstrap steps each add one more updateAttemptSteps() round
      // trip (one more $queryRaw FOR UPDATE SELECT) after tenant_creation's,
      // and Story 2.6's activation + audit_finalized steps each add one
      // more too, on top of any compensation-driven writes.
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([attemptRow])
        .mockImplementationOnce(async () => [
          {
            ...attemptRow,
            status: 'provisioning',
            stepOutcomes: liveStepOutcomes,
          },
        ])
        .mockImplementation(async () => [
          {
            ...attemptRow,
            status: 'provisioning',
            stepOutcomes: liveStepOutcomes,
          },
        ]),
      $executeRaw: jest.fn(async (query: unknown) => {
        const values = (query as { values?: unknown[] }).values ?? [];
        // updateAttemptSteps()'s UPDATE binds [status, stepOutcomesJson,
        // attemptId] in that order -- mirror the write into
        // `liveStepOutcomes` so subsequent reads (including the
        // orchestrator's own compensation decision) see it.
        if (typeof values[1] === 'string') {
          try {
            const parsed = JSON.parse(values[1]);
            if (Array.isArray(parsed)) {
              liveStepOutcomes = parsed;
            }
          } catch {
            // Not a stepOutcomes JSON payload (e.g. a different UPDATE) --
            // ignore.
          }
        }
        return 1;
      }),
    };

    // Story 2.6 top-level (non-transactional) `this.prisma.$queryRaw` calls
    // are now SQL-shape-aware rather than call-count-ordered, since
    // `readAttemptAuditRow()` / `readAttemptStepOutcomes()` can run at
    // different points depending on success vs. failure. Anything selecting
    // `safePayload`+`actorIdentity` together is `readAttemptAuditRow()`;
    // anything selecting only `stepOutcomes` (no `safePayload`) is
    // `readAttemptStepOutcomes()`; anything selecting only `safePayload` is
    // `readAttemptSafePayload()`; anything selecting only `status` is
    // `readAttemptStatus()`. Tenant lookups (`findTenantByAttemptId`/
    // `findTenantBySlug`/tenant INSERT) are call-count-ordered as before,
    // queued ahead of this fallback via `mockImplementationOnce()`.
    const queryRaw = jest.fn(async (query: unknown): Promise<unknown[]> => {
      const sql = (query as { sql?: string }).sql ?? '';
      if (sql.includes('actorIdentity')) {
        return [
          {
            id: attemptRow.id,
            safePayload: attemptRow.safePayload,
            actorIdentity: { actorType: 'system', systemUserId: 'sysuser-1' },
            requestIdentity: {
              requestId: 'req-1',
              ipAddress: null,
              userAgent: null,
            },
            stepOutcomes: liveStepOutcomes,
          },
        ];
      }
      if (sql.includes('stepOutcomes') && !sql.includes('safePayload')) {
        return [{ stepOutcomes: liveStepOutcomes }];
      }
      if (sql.includes('safePayload')) {
        return [{ safePayload: attemptRow.safePayload }];
      }
      return [{ status: 'provisioning' }];
    });

    // Queue the tenant-lookup-specific responses ahead of the SQL-aware
    // fallback above: startLifecycle's findTenantByAttemptId,
    // createOrResolveTenant's findTenantByAttemptId, then the tenant
    // INSERT...RETURNING.
    queryRaw
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [
        {
          id: 'tenant1',
          slug: 'acme-co',
          status: 'PROVISIONING',
          onboardingAttemptId: 'attempt-1',
        },
      ]);

    // Live, mutable mirror of Tenant.status -- activation()'s conditional
    // `updateMany({ where: { status: { not: 'FAILED' } } })` guard needs a
    // stateful mock to exercise both the normal (count: 1) and blocked
    // (count: 0, tenant already FAILED) paths realistically, and
    // findUniqueOrThrow() needs to read back whatever updateMany() actually
    // set.
    let liveTenantStatus = 'PROVISIONING';

    return {
      tx,
      prisma: {
        $queryRaw: queryRaw,
        $executeRaw: jest.fn().mockResolvedValue(1),
        $transaction: jest.fn((callback) => callback(tx)),
        tenant: {
          update: jest.fn(
            async ({
              where,
              data,
            }: {
              where: { id: string };
              data: { status: string };
            }) => {
              liveTenantStatus = data.status;
              return {
                id: where.id,
                slug: 'acme-co',
                status: liveTenantStatus,
              };
            },
          ),
          updateMany: jest.fn(
            async ({
              where,
              data,
            }: {
              where: { id: string; status?: { not?: string } };
              data: { status: string };
            }) => {
              const blocked =
                where.status?.not !== undefined &&
                liveTenantStatus === where.status.not;
              if (blocked) {
                return { count: 0 };
              }
              liveTenantStatus = data.status;
              return { count: 1 };
            },
          ),
          findUniqueOrThrow: jest.fn(
            async ({ where }: { where: { id: string } }) => ({
              id: where.id,
              slug: 'acme-co',
              status: liveTenantStatus,
            }),
          ),
        },
        tenantOnboardingAuditLog: {
          upsert: jest.fn().mockResolvedValue(undefined),
        },
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
    const tenantSeedService = buildTenantSeedService();
    const firstAdminService = buildFirstAdminService();
    const setupLinkService = buildSetupLinkService();
    const emailDeliveryService = buildEmailDeliveryService();
    const service = new TenantProvisioningService(
      prisma as never,
      buildConfigService(),
      queue as never,
      cls,
      tenantKnexService,
      dynamicTablesService,
      tenantSeedService,
      firstAdminService,
      setupLinkService,
      emailDeliveryService,
    );

    return {
      prisma,
      queue,
      service,
      tx,
      cls,
      tenantKnexService,
      dynamicTablesService,
      tenantSeedService,
      firstAdminService,
      setupLinkService,
      emailDeliveryService,
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
    const {
      prisma,
      service,
      tx,
      cls,
      tenantKnexService,
      dynamicTablesService,
      tenantSeedService,
      firstAdminService,
      setupLinkService,
      emailDeliveryService,
    } = buildService();

    await service.startLifecycle('attempt-1');

    expect(tenantInsertValues(prisma)).toEqual(
      expect.arrayContaining([
        'Acme Co',
        'acme-co',
        'PROVISIONING',
        'attempt-1',
      ]),
    );

    // tenant_creation + schema_created + bootstrap_migrated + bootstrap_seeded
    // + first_admin_assigned + setup_link_generated + setup_email_sent +
    // activation + audit_finalized each go through their own
    // updateAttemptSteps() transaction (1 $queryRaw FOR UPDATE SELECT + 1
    // $executeRaw UPDATE apiece), on top of claimAttempt()'s own 2 $queryRaw
    // calls (SELECT accepted attempt + UPDATE...RETURNING).
    expect(tx.$queryRaw).toHaveBeenCalledTimes(11);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(9);

    // CLS populated with { tenantId, schema } before any TenantKnexService/
    // DynamicTablesService/TenantSeedService/FirstAdminService/
    // SetupLinkService call -- all mocked calls happen inside the
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
    expect(tenantSeedService.bootstrapSeed).toHaveBeenCalledTimes(1);
    expect(firstAdminService.assign).toHaveBeenCalledWith(
      'tenant1',
      'admin@acme.example',
    );
    expect(setupLinkService.generate).toHaveBeenCalledWith('tenant1');
    expect(emailDeliveryService.sendSetupInvite).toHaveBeenCalledWith(
      'admin@acme.example',
      'Acme Co',
    );

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

    const bootstrapSeededJson = findStepJson('bootstrap_seeded');
    expect(bootstrapSeededJson).toBeDefined();
    expect(bootstrapSeededJson).toContain('"status":"succeeded"');

    const firstAdminAssignedJson = findStepJson('first_admin_assigned');
    expect(firstAdminAssignedJson).toBeDefined();
    expect(firstAdminAssignedJson).toContain('"status":"succeeded"');

    const setupLinkGeneratedJson = findStepJson('setup_link_generated');
    expect(setupLinkGeneratedJson).toBeDefined();
    expect(setupLinkGeneratedJson).toContain('"status":"succeeded"');
    // Never logs/persists the raw token anywhere -- only safe metadata.
    expect(setupLinkGeneratedJson).not.toContain('raw-setup-token-value');

    const setupEmailSentJson = findStepJson('setup_email_sent');
    expect(setupEmailSentJson).toBeDefined();
    // No SMTP configured today -- always recorded failed, warning-only.
    expect(setupEmailSentJson).toContain('"status":"failed"');
    expect(setupEmailSentJson).toContain('SMTP_NOT_CONFIGURED');

    // Provisioning does not throw even though setup_email_sent failed --
    // backup email delivery is non-blocking.

    // Story 2.6: activation flips Tenant.status = ACTIVE after
    // sendBackupEmail() completes, then audit_finalized closes the workflow.
    expect(prisma.tenant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'tenant1',
          status: { not: 'FAILED' },
          onboardingAttempt: {
            is: { id: 'attempt-1', status: 'provisioning' },
          },
        },
        data: { status: 'ACTIVE' },
      }),
    );

    const activationJson = findStepJson('activation');
    expect(activationJson).toBeDefined();
    expect(activationJson).toContain('"status":"succeeded"');
    expect(activationJson).toContain('"tenantStatus":"ACTIVE"');

    const auditFinalizedJson = findStepJson('audit_finalized');
    expect(auditFinalizedJson).toBeDefined();
    expect(auditFinalizedJson).toContain('"status":"succeeded"');

    expect(prisma.tenantOnboardingAuditLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { attemptId: 'attempt-1' },
        create: expect.objectContaining({
          attemptId: 'attempt-1',
          tenantId: 'tenant1',
          finalStatus: 'succeeded',
        }),
        update: expect.objectContaining({
          tenantId: 'tenant1',
          finalStatus: 'succeeded',
        }),
      }),
    );

    // The attempt's own status column ends up 'succeeded', not left at
    // 'provisioning' or flipped to 'failed'.
    const finalAttemptStatus = tx.$executeRaw.mock.calls
      .map((call) => (call[0] as { values?: unknown[] }).values?.[0])
      .pop();
    expect(finalAttemptStatus).toBe('succeeded');
  });

  it('exits without duplicate creation when another worker already linked a tenant, and still provisions schema', async () => {
    const {
      prisma,
      service,
      tx,
      tenantKnexService,
      dynamicTablesService,
      tenantSeedService,
      firstAdminService,
    } = buildService();
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
      .mockResolvedValueOnce([{ status: 'provisioning' }])
      // Every subsequent top-level `this.prisma.$queryRaw` call --
      // readAttemptSafePayload() (assignFirstAdmin()'s/sendBackupEmail()'s
      // re-query) and readAttemptAuditRow() (finalizeAudit()'s re-query) --
      // is SQL-shape-aware, same as buildPrisma()'s own fallback.
      .mockImplementation(async (query: unknown) => {
        const sql = (query as { sql?: string }).sql ?? '';
        if (sql.includes('actorIdentity')) {
          return [
            {
              id: attemptRow.id,
              safePayload: attemptRow.safePayload,
              actorIdentity: { actorType: 'system', systemUserId: 'sysuser-1' },
              requestIdentity: {
                requestId: 'req-1',
                ipAddress: null,
                userAgent: null,
              },
              stepOutcomes: attemptRow.stepOutcomes,
            },
          ];
        }
        return [{ safePayload: attemptRow.safePayload }];
      });

    await service.startLifecycle('attempt-1');

    // recordTenantCreationSuccess + schema_created + bootstrap_migrated +
    // bootstrap_seeded + first_admin_assigned + setup_link_generated +
    // setup_email_sent + activation + audit_finalized: nine
    // updateAttemptSteps() rounds (no resume-path reset, since the
    // attempt's current status here is 'provisioning', not 'failed').
    expect(tx.$queryRaw).toHaveBeenCalledTimes(9);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(9);
    expect(tenantKnexService.raw).toHaveBeenCalledWith(
      'CREATE SCHEMA IF NOT EXISTS ??',
      ['tenant_tenantexisting'],
    );
    expect(dynamicTablesService.ensureMetaTables).toHaveBeenCalledTimes(1);
    expect(tenantSeedService.bootstrapSeed).toHaveBeenCalledTimes(1);
    expect(firstAdminService.assign).toHaveBeenCalledWith(
      'tenantexisting',
      'admin@acme.example',
    );
  });

  it('provisions schema when a slug race resolves to this same attempt', async () => {
    const {
      prisma,
      service,
      tx,
      tenantKnexService,
      dynamicTablesService,
      tenantSeedService,
      firstAdminService,
    } = buildService();
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
      ])
      // readAttemptSafePayload()'s own SELECT (assignFirstAdmin()'s re-query).
      .mockResolvedValue([{ safePayload: attemptRow.safePayload }]);

    await service.startLifecycle('attempt-1');

    expect(tenantKnexService.raw).toHaveBeenCalledWith(
      'CREATE SCHEMA IF NOT EXISTS ??',
      ['tenant_tenantsamecuid'],
    );
    expect(dynamicTablesService.ensureMetaTables).toHaveBeenCalledTimes(1);
    expect(tenantSeedService.bootstrapSeed).toHaveBeenCalledTimes(1);
    expect(firstAdminService.assign).toHaveBeenCalledWith(
      'tenantsamecuid',
      'admin@acme.example',
    );

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
    expect(findStepJson('bootstrap_seeded')).toContain('"status":"succeeded"');
    expect(findStepJson('first_admin_assigned')).toContain(
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
    tx.$queryRaw
      .mockReset()
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

    it('records schema_created as failed and re-throws when CREATE SCHEMA fails, then compensates and marks the attempt/tenant failed (Story 2.6)', async () => {
      const {
        prisma,
        service,
        tx,
        tenantKnexService,
        setupLinkService,
        firstAdminService,
      } = buildService();
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

      // Story 2.6: the orchestrator catch runs compensation and finalizes
      // the audit, so the attempt's own status column DOES reach 'failed'
      // (via audit_finalized's write) -- this supersedes the pre-2.6
      // "stays PROVISIONING" behavior.
      const statuses = tx.$executeRaw.mock.calls.map(
        (call) => (call[0] as { values?: unknown[] }).values?.[0],
      );
      expect(statuses).toContain('failed');
      expect(statuses[statuses.length - 1]).toBe('failed');

      // schema_created itself never succeeded, so schema-drop compensation
      // is skipped (spec Never: never drop a schema not confirmed created).
      expect(tenantKnexService.raw).not.toHaveBeenCalledWith(
        'DROP SCHEMA IF EXISTS ?? CASCADE',
        expect.anything(),
      );
      expect(setupLinkService.revokeAll).toHaveBeenCalledWith('tenant1');
      expect(firstAdminService.deactivate).toHaveBeenCalledWith('tenant1');

      expect(prisma.tenant.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tenant1' },
          data: { status: 'FAILED' },
        }),
      );
      expect(prisma.tenantOnboardingAuditLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { attemptId: 'attempt-1' },
          create: expect.objectContaining({ finalStatus: 'failed' }),
        }),
      );
    });

    it('records bootstrap_migrated as succeeded after schema_created succeeds', async () => {
      const { service, tx, dynamicTablesService } = buildService();

      await service.startLifecycle('attempt-1');

      expect(dynamicTablesService.ensureMetaTables).toHaveBeenCalledTimes(1);
      const json = findStepJson(tx, 'bootstrap_migrated');
      expect(json).toBeDefined();
      expect(json).toContain('"status":"succeeded"');
    });

    it('records bootstrap_migrated as failed and re-throws when ensureMetaTables throws, then compensates (drops the schema) and marks failed', async () => {
      const { service, tx, dynamicTablesService, tenantKnexService } =
        buildService();
      (
        dynamicTablesService.ensureMetaTables as jest.Mock
      ).mockRejectedValueOnce(
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

      // Story 2.6: attempt status reaches 'failed' via audit_finalized.
      const statuses = tx.$executeRaw.mock.calls.map(
        (call) => (call[0] as { values?: unknown[] }).values?.[0],
      );
      expect(statuses).toContain('failed');

      // schema_created DID succeed, so schema-drop compensation runs.
      expect(tenantKnexService.raw).toHaveBeenCalledWith(
        'DROP SCHEMA IF EXISTS ?? CASCADE',
        ['tenant_tenant1'],
      );
    });

    it('worker retry: schema + tables already exist is a no-op and both steps still record succeeded', async () => {
      const {
        service,
        tx,
        tenantKnexService,
        dynamicTablesService,
        tenantSeedService,
      } = buildService();
      // CREATE SCHEMA IF NOT EXISTS / ensureMetaTables() are themselves
      // idempotent -- a retry against pre-existing objects still resolves
      // without error, exactly like their mocked (no-op) behavior here.

      await service.startLifecycle('attempt-1');

      expect(tenantKnexService.raw).toHaveBeenCalledTimes(1);
      expect(dynamicTablesService.ensureMetaTables).toHaveBeenCalledTimes(1);
      expect(tenantSeedService.bootstrapSeed).toHaveBeenCalledTimes(1);
      expect(findStepJson(tx, 'schema_created')).toContain(
        '"status":"succeeded"',
      );
      expect(findStepJson(tx, 'bootstrap_migrated')).toContain(
        '"status":"succeeded"',
      );
      expect(findStepJson(tx, 'bootstrap_seeded')).toContain(
        '"status":"succeeded"',
      );
    });

    it('resumes after a prior job-timeout failure: resets attempt status to provisioning before recording schema_created/bootstrap_migrated as succeeded', async () => {
      const {
        prisma,
        service,
        tx,
        tenantKnexService,
        dynamicTablesService,
        tenantSeedService,
        firstAdminService,
        setupLinkService,
      } = buildService();

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
        // readAttemptStatus() (resume-path check), readAttemptSafePayload()
        // (assignFirstAdmin()'s/sendBackupEmail()'s re-query), and
        // readAttemptAuditRow() (finalizeAudit()'s re-query) all go through
        // this same top-level `this.prisma.$queryRaw` mock afterward --
        // distinguish by the queried column, mirroring the SQL text
        // inspection style used elsewhere in this suite.
        .mockImplementation(async (query: unknown) => {
          const sql = (query as { sql?: string }).sql ?? '';
          if (sql.includes('actorIdentity')) {
            return [
              {
                id: attemptRow.id,
                safePayload: attemptRow.safePayload,
                actorIdentity: {
                  actorType: 'system',
                  systemUserId: 'sysuser-1',
                },
                requestIdentity: {
                  requestId: 'req-1',
                  ipAddress: null,
                  userAgent: null,
                },
                stepOutcomes: attemptRow.stepOutcomes,
              },
            ];
          }
          if (sql.includes('safePayload')) {
            return [{ safePayload: attemptRow.safePayload }];
          }
          return [{ status: currentStatus }];
        });
      prisma.$executeRaw
        .mockReset()
        .mockImplementation(async (query: unknown) => {
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

      expect(tenantSeedService.bootstrapSeed).toHaveBeenCalledTimes(1);
      const bootstrapSeededJson = findStepJson(tx, 'bootstrap_seeded');
      expect(bootstrapSeededJson).toBeDefined();
      expect(bootstrapSeededJson).toContain('"status":"succeeded"');

      expect(firstAdminService.assign).toHaveBeenCalledWith(
        'tenant1',
        'admin@acme.example',
      );
      const firstAdminAssignedJson = findStepJson(tx, 'first_admin_assigned');
      expect(firstAdminAssignedJson).toBeDefined();
      expect(firstAdminAssignedJson).toContain('"status":"succeeded"');

      expect(setupLinkService.generate).toHaveBeenCalledWith('tenant1');
      const setupLinkGeneratedJson = findStepJson(tx, 'setup_link_generated');
      expect(setupLinkGeneratedJson).toBeDefined();
      expect(setupLinkGeneratedJson).toContain('"status":"succeeded"');

      const setupEmailSentJson = findStepJson(tx, 'setup_email_sent');
      expect(setupEmailSentJson).toBeDefined();

      // The resumed run completes the whole workflow successfully -- the
      // attempt-status level never reaches 'failed' at any point (index 0
      // of values on every tx UPDATE) -- setup_email_sent's own step-level
      // 'failed' outcome (no SMTP configured today) is unrelated and
      // expected. Story 2.6: it ends at 'succeeded' via activation +
      // audit_finalized.
      const statuses = tx.$executeRaw.mock.calls.map(
        (call) => (call[0] as { values?: unknown[] }).values?.[0],
      );
      expect(statuses).not.toContain('failed');
      expect(statuses[statuses.length - 1]).toBe('succeeded');

      expect(prisma.tenant.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'tenant1',
            status: { not: 'FAILED' },
            onboardingAttempt: {
              is: { id: 'attempt-1', status: 'provisioning' },
            },
          },
          data: { status: 'ACTIVE' },
        }),
      );
    });
  });

  describe('bootstrap defaults and tenant RBAC seed (Story 2.3)', () => {
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

    it('records bootstrap_seeded as succeeded after bootstrap_migrated succeeds', async () => {
      const { service, tx, tenantSeedService } = buildService();

      await service.startLifecycle('attempt-1');

      expect(tenantSeedService.bootstrapSeed).toHaveBeenCalledTimes(1);
      const json = findStepJson(tx, 'bootstrap_seeded');
      expect(json).toBeDefined();
      expect(json).toContain('"status":"succeeded"');
    });

    it('records bootstrap_seeded as failed and re-throws when bootstrapSeed throws, then compensates and marks failed (Story 2.6)', async () => {
      const { prisma, service, tx, tenantSeedService, tenantKnexService } =
        buildService();
      (tenantSeedService.bootstrapSeed as jest.Mock).mockRejectedValueOnce(
        new Error(
          'duplicate key value violates unique constraint "roles_name_unique"',
        ),
      );

      await expect(service.startLifecycle('attempt-1')).rejects.toThrow();

      // schema_created + bootstrap_migrated must still have succeeded
      // (bootstrap_seeded runs after both).
      expect(findStepJson(tx, 'schema_created')).toContain(
        '"status":"succeeded"',
      );
      expect(findStepJson(tx, 'bootstrap_migrated')).toContain(
        '"status":"succeeded"',
      );

      const bootstrapSeededJson = findStepJson(tx, 'bootstrap_seeded');
      expect(bootstrapSeededJson).toBeDefined();
      expect(bootstrapSeededJson).toContain('"status":"failed"');
      expect(bootstrapSeededJson).toContain('BOOTSTRAP_SEED_FAILED');
      // No raw SQL/error message leaked into the recorded step outcome.
      expect(bootstrapSeededJson).not.toContain('roles_name_unique');

      // Story 2.6: the orchestrator catch compensates (schema_created had
      // succeeded, so the schema is dropped) and the attempt/tenant reach
      // 'failed'.
      const statuses = tx.$executeRaw.mock.calls.map(
        (call) => (call[0] as { values?: unknown[] }).values?.[0],
      );
      expect(statuses).toContain('failed');
      expect(tenantKnexService.raw).toHaveBeenCalledWith(
        'DROP SCHEMA IF EXISTS ?? CASCADE',
        ['tenant_tenant1'],
      );
      expect(prisma.tenant.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'FAILED' } }),
      );
    });

    it('worker retry: seed already done is a no-op and bootstrap_seeded still records succeeded', async () => {
      const { service, tx, tenantSeedService } = buildService();
      // TenantSeedService.bootstrapSeed() is itself idempotent (hasTable()
      // guards + onConflict().ignore()) -- a retry against pre-existing
      // tables/rows still resolves without error, exactly like its mocked
      // (no-op) behavior here.

      await service.startLifecycle('attempt-1');

      expect(tenantSeedService.bootstrapSeed).toHaveBeenCalledTimes(1);
      expect(findStepJson(tx, 'bootstrap_seeded')).toContain(
        '"status":"succeeded"',
      );
    });

    it('populates CLS with { tenantId, schema } before calling bootstrapSeed', async () => {
      const { service, cls, tenantSeedService } = buildService();

      await service.startLifecycle('attempt-1');

      expect(cls.runWith).toHaveBeenCalledWith(
        { tenantId: 'tenant1', schema: 'tenant_tenant1' },
        expect.any(Function),
      );
      expect(tenantSeedService.bootstrapSeed).toHaveBeenCalledTimes(1);
    });
  });

  describe('first admin identity and tenant admin assignment (Story 2.4)', () => {
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

    it('records first_admin_assigned as succeeded after bootstrap_seeded succeeds, calling FirstAdminService.assign with the re-queried email', async () => {
      const { service, tx, tenantSeedService, firstAdminService } =
        buildService();

      await service.startLifecycle('attempt-1');

      expect(tenantSeedService.bootstrapSeed).toHaveBeenCalledTimes(1);
      expect(firstAdminService.assign).toHaveBeenCalledTimes(1);
      expect(firstAdminService.assign).toHaveBeenCalledWith(
        'tenant1',
        'admin@acme.example',
      );
      const json = findStepJson(tx, 'first_admin_assigned');
      expect(json).toBeDefined();
      expect(json).toContain('"status":"succeeded"');
    });

    it('records first_admin_assigned as failed and re-throws when FirstAdminService.assign throws, then compensates and marks failed (Story 2.6)', async () => {
      const { prisma, service, tx, firstAdminService, setupLinkService } =
        buildService();
      (firstAdminService.assign as jest.Mock).mockRejectedValueOnce(
        new Error(
          'duplicate key value violates unique constraint "auth_accounts_pkey"',
        ),
      );

      await expect(service.startLifecycle('attempt-1')).rejects.toThrow();

      // schema_created + bootstrap_migrated + bootstrap_seeded must still
      // have succeeded (first_admin_assigned runs after all three).
      expect(findStepJson(tx, 'schema_created')).toContain(
        '"status":"succeeded"',
      );
      expect(findStepJson(tx, 'bootstrap_migrated')).toContain(
        '"status":"succeeded"',
      );
      expect(findStepJson(tx, 'bootstrap_seeded')).toContain(
        '"status":"succeeded"',
      );

      const firstAdminAssignedJson = findStepJson(tx, 'first_admin_assigned');
      expect(firstAdminAssignedJson).toBeDefined();
      expect(firstAdminAssignedJson).toContain('"status":"failed"');
      expect(firstAdminAssignedJson).toContain('FIRST_ADMIN_ASSIGNMENT_FAILED');
      // No raw SQL/error message leaked into the recorded step outcome.
      expect(firstAdminAssignedJson).not.toContain('auth_accounts_pkey');

      // Story 2.6: the orchestrator catch compensates and the attempt/tenant
      // reach 'failed'. first_admin_assigned itself never succeeded, so
      // deactivate_first_admin still runs (idempotent no-op per the
      // Compensation Matrix), and setup-token revocation runs too (nothing
      // to revoke yet, also a no-op).
      const statuses = tx.$executeRaw.mock.calls.map(
        (call) => (call[0] as { values?: unknown[] }).values?.[0],
      );
      expect(statuses).toContain('failed');
      expect(firstAdminService.deactivate).toHaveBeenCalledWith('tenant1');
      expect(setupLinkService.revokeAll).toHaveBeenCalledWith('tenant1');
      expect(prisma.tenant.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'FAILED' } }),
      );
    });

    it('worker retry: assignment already done is a no-op and first_admin_assigned still records succeeded', async () => {
      const { service, tx, firstAdminService } = buildService();
      // FirstAdminService.assign() is itself idempotent (find-or-create +
      // upsert) -- a retry against a pre-existing AuthAccount/TenantUser/
      // Role still resolves without error, exactly like its mocked (no-op)
      // behavior here.

      await service.startLifecycle('attempt-1');

      expect(firstAdminService.assign).toHaveBeenCalledTimes(1);
      expect(findStepJson(tx, 'first_admin_assigned')).toContain(
        '"status":"succeeded"',
      );
    });

    it('populates CLS with { tenantId, schema } before calling FirstAdminService.assign', async () => {
      const { service, cls, firstAdminService } = buildService();

      await service.startLifecycle('attempt-1');

      expect(cls.runWith).toHaveBeenCalledWith(
        { tenantId: 'tenant1', schema: 'tenant_tenant1' },
        expect.any(Function),
      );
      expect(firstAdminService.assign).toHaveBeenCalledTimes(1);
    });

    it('records first_admin_assigned as failed and re-throws when the safe payload cannot be re-queried', async () => {
      const { prisma, service, tx, firstAdminService } = buildService();
      // readAttemptSafePayload()'s targeted SELECT resolves to no row --
      // e.g. the attempt was deleted between steps.
      prisma.$queryRaw
        .mockReset()
        .mockResolvedValueOnce([]) // findTenantByAttemptId: no linked tenant
        .mockResolvedValueOnce([]) // createOrResolveTenant's own lookup
        .mockResolvedValueOnce([
          {
            id: 'tenant1',
            slug: 'acme-co',
            status: 'PROVISIONING',
            onboardingAttemptId: 'attempt-1',
          },
        ]) // tenant INSERT...RETURNING
        .mockResolvedValue([]); // readAttemptSafePayload: no row found

      await expect(service.startLifecycle('attempt-1')).rejects.toThrow();

      expect(firstAdminService.assign).not.toHaveBeenCalled();
      const json = findStepJson(tx, 'first_admin_assigned');
      expect(json).toBeDefined();
      expect(json).toContain('"status":"failed"');
      expect(json).toContain('FIRST_ADMIN_ASSIGNMENT_FAILED');

      // Story 2.6: finalizeAudit()'s own re-query also finds no attempt row
      // in this scenario -- it must log and return rather than throw or
      // crash the job (the double-guarded never-rethrow shape).
      expect(prisma.tenantOnboardingAuditLog.upsert).not.toHaveBeenCalled();
    });
  });

  describe('setup link generation and backup email outcome (Story 2.5)', () => {
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

    it('records setup_link_generated as succeeded after first_admin_assigned succeeds, calling SetupLinkService.generate with the tenant id', async () => {
      const { service, tx, firstAdminService, setupLinkService } =
        buildService();

      await service.startLifecycle('attempt-1');

      expect(firstAdminService.assign).toHaveBeenCalledTimes(1);
      expect(setupLinkService.generate).toHaveBeenCalledTimes(1);
      expect(setupLinkService.generate).toHaveBeenCalledWith('tenant1');
      const json = findStepJson(tx, 'setup_link_generated');
      expect(json).toBeDefined();
      expect(json).toContain('"status":"succeeded"');
    });

    it('populates CLS with { tenantId, schema } before calling SetupLinkService.generate', async () => {
      const { service, cls, setupLinkService } = buildService();

      await service.startLifecycle('attempt-1');

      expect(cls.runWith).toHaveBeenCalledWith(
        { tenantId: 'tenant1', schema: 'tenant_tenant1' },
        expect.any(Function),
      );
      expect(setupLinkService.generate).toHaveBeenCalledTimes(1);
    });

    it('records setup_link_generated as failed and re-throws (never proceeding to setup_email_sent) when SetupLinkService.generate throws, then compensates and marks failed (Story 2.6)', async () => {
      const {
        prisma,
        service,
        tx,
        setupLinkService,
        firstAdminService,
        emailDeliveryService,
        tenantKnexService,
      } = buildService();
      (setupLinkService.generate as jest.Mock).mockRejectedValueOnce(
        new Error('No First Admin exists for this tenant yet.'),
      );

      await expect(service.startLifecycle('attempt-1')).rejects.toThrow();

      // first_admin_assigned must still have succeeded (setup_link_generated
      // runs after it).
      expect(findStepJson(tx, 'first_admin_assigned')).toContain(
        '"status":"succeeded"',
      );

      const json = findStepJson(tx, 'setup_link_generated');
      expect(json).toBeDefined();
      expect(json).toContain('"status":"failed"');
      expect(json).toContain('SETUP_LINK_GENERATION_FAILED');
      // No raw error message/token leaked into the recorded step outcome.
      expect(json).not.toContain('No First Admin exists');

      // The non-blocking email step never runs once link generation fails.
      expect(emailDeliveryService.sendSetupInvite).not.toHaveBeenCalled();

      // Story 2.6: the orchestrator catch compensates (first_admin_assigned
      // had succeeded, so the actor is deactivated; schema_created had
      // succeeded, so the schema is dropped) and the attempt/tenant reach
      // 'failed'.
      const statuses = tx.$executeRaw.mock.calls.map(
        (call) => (call[0] as { values?: unknown[] }).values?.[0],
      );
      expect(statuses).toContain('failed');
      expect(setupLinkService.revokeAll).toHaveBeenCalledWith('tenant1');
      expect(firstAdminService.deactivate).toHaveBeenCalledWith('tenant1');
      expect(tenantKnexService.raw).toHaveBeenCalledWith(
        'DROP SCHEMA IF EXISTS ?? CASCADE',
        ['tenant_tenant1'],
      );
      expect(prisma.tenant.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'FAILED' } }),
      );
    });

    it('records setup_email_sent as failed warning-only (SMTP_NOT_CONFIGURED) without failing provisioning, when setup_link_generated has succeeded', async () => {
      const { prisma, service, tx, emailDeliveryService } = buildService();

      await expect(
        service.startLifecycle('attempt-1'),
      ).resolves.toBeUndefined();

      expect(emailDeliveryService.sendSetupInvite).toHaveBeenCalledWith(
        'admin@acme.example',
        'Acme Co',
      );
      const json = findStepJson(tx, 'setup_email_sent');
      expect(json).toBeDefined();
      expect(json).toContain('"status":"failed"');
      expect(json).toContain('SMTP_NOT_CONFIGURED');

      // Never rethrown -- provisioning completes successfully overall
      // (activation + audit_finalized still run, ending at 'succeeded'),
      // and the attempt-status column is never flipped to 'failed' by this
      // step.
      const statuses = tx.$executeRaw.mock.calls.map(
        (call) => (call[0] as { values?: unknown[] }).values?.[0],
      );
      expect(statuses).not.toContain('failed');
      expect(statuses[statuses.length - 1]).toBe('succeeded');
      expect(prisma.tenant.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'ACTIVE' } }),
      );
    });

    it('records setup_email_sent as succeeded when EmailDeliveryService reports delivered', async () => {
      const { service, tx, emailDeliveryService } = buildService();
      (emailDeliveryService.sendSetupInvite as jest.Mock).mockResolvedValueOnce(
        { delivered: true },
      );

      await service.startLifecycle('attempt-1');

      const json = findStepJson(tx, 'setup_email_sent');
      expect(json).toBeDefined();
      expect(json).toContain('"status":"succeeded"');
    });

    it('falls back to SETUP_EMAIL_DELIVERY_FAILED when EmailDeliveryService resolves { delivered: false } with no errorCode', async () => {
      const { service, tx, emailDeliveryService } = buildService();
      (emailDeliveryService.sendSetupInvite as jest.Mock).mockResolvedValueOnce(
        { delivered: false },
      );

      await expect(
        service.startLifecycle('attempt-1'),
      ).resolves.toBeUndefined();

      const json = findStepJson(tx, 'setup_email_sent');
      expect(json).toBeDefined();
      expect(json).toContain('"status":"failed"');
      expect(json).toContain('SETUP_EMAIL_DELIVERY_FAILED');
    });

    it('records setup_email_sent as failed and does not rethrow when EmailDeliveryService.sendSetupInvite itself rejects', async () => {
      const { service, tx, emailDeliveryService } = buildService();
      (emailDeliveryService.sendSetupInvite as jest.Mock).mockRejectedValueOnce(
        new Error('unexpected email transport error'),
      );

      await expect(
        service.startLifecycle('attempt-1'),
      ).resolves.toBeUndefined();

      const json = findStepJson(tx, 'setup_email_sent');
      expect(json).toBeDefined();
      expect(json).toContain('"status":"failed"');
      expect(json).toContain('SETUP_EMAIL_DELIVERY_FAILED');
      expect(json).not.toContain('unexpected email transport error');
    });

    it('never logs or persists the raw setup token anywhere in recorded step outcomes', async () => {
      const { service, tx } = buildService();

      await service.startLifecycle('attempt-1');

      const allExecuteJson = tx.$executeRaw.mock.calls
        .map((call) => (call[0] as { values?: unknown[] }).values ?? [])
        .flat()
        .filter((value): value is string => typeof value === 'string')
        .join('\n');
      expect(allExecuteJson).not.toContain('raw-setup-token-value');
    });
  });

  describe('activation, compensation, and permanent audit (Story 2.6)', () => {
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

    it('activates the tenant and finalizes the audit as succeeded when all 6 required steps succeed', async () => {
      const { prisma, service, tx } = buildService();

      await service.startLifecycle('attempt-1');

      expect(prisma.tenant.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'tenant1',
            status: { not: 'FAILED' },
            onboardingAttempt: {
              is: { id: 'attempt-1', status: 'provisioning' },
            },
          },
          data: { status: 'ACTIVE' },
        }),
      );
      expect(findStepJson(tx, 'activation')).toContain('"status":"succeeded"');
      expect(findStepJson(tx, 'audit_finalized')).toContain(
        '"status":"succeeded"',
      );
      expect(prisma.tenantOnboardingAuditLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { attemptId: 'attempt-1' },
          create: expect.objectContaining({
            finalStatus: 'succeeded',
            compensation: Prisma.JsonNull,
          }),
        }),
      );
    });

    it('marks failed-needs-manual-cleanup and does not flip Tenant.status when a compensation sub-step itself throws', async () => {
      const { prisma, service, tenantKnexService, dynamicTablesService } =
        buildService();
      // bootstrap_migrated fails (schema_created already succeeded), then
      // the schema-drop compensation sub-step itself throws.
      (
        dynamicTablesService.ensureMetaTables as jest.Mock
      ).mockRejectedValueOnce(
        new Error('relation "_meta_tables" already exists'),
      );
      (tenantKnexService.raw as jest.Mock)
        .mockResolvedValueOnce(undefined) // CREATE SCHEMA succeeds
        .mockRejectedValueOnce(new Error('DROP SCHEMA timed out')); // compensation fails

      await expect(service.startLifecycle('attempt-1')).rejects.toThrow();

      // Manual-cleanup threshold: Tenant.status is never touched (neither
      // ACTIVE nor FAILED) once compensation itself fails.
      expect(prisma.tenant.update).not.toHaveBeenCalled();
      expect(prisma.tenant.updateMany).not.toHaveBeenCalled();

      expect(prisma.tenantOnboardingAuditLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            finalStatus: 'failed-needs-manual-cleanup',
            compensation: expect.arrayContaining([
              expect.objectContaining({
                step: 'schema_created',
                action: 'drop_tenant_schema',
                status: 'failed',
                // Known identifiers (tenant id, schema name) must be
                // recorded on the failed sub-step, not just a generic
                // message -- spec Boundaries/Acceptance Criteria.
                detail: expect.stringContaining('tenantId=tenant1'),
              }),
            ]),
          }),
        }),
      );
      const upsertCall = (prisma.tenantOnboardingAuditLog.upsert as jest.Mock)
        .mock.calls[0][0];
      const schemaCompensation = upsertCall.create.compensation.find(
        (c: { step: string }) => c.step === 'schema_created',
      );
      expect(schemaCompensation.detail).toContain('schema=tenant_tenant1');
      // Never a raw error message or stack trace.
      expect(schemaCompensation.detail).not.toContain('DROP SCHEMA timed out');
    });

    it('records TenantUser/AuthAccount/Role ids in the compensation detail when deactivate_first_admin itself fails', async () => {
      const { prisma, service, dynamicTablesService, firstAdminService } =
        buildService();
      (
        dynamicTablesService.ensureMetaTables as jest.Mock
      ).mockRejectedValueOnce(
        new Error('relation "_meta_tables" already exists'),
      );
      (firstAdminService.deactivate as jest.Mock).mockRejectedValueOnce(
        Object.assign(new Error('connection lost mid-delete'), {
          // FirstAdminService.deactivate() found these ids before the
          // delete itself failed -- a caller compensating a failure needs
          // them even though deactivate() never returned normally here.
        }),
      );

      await expect(service.startLifecycle('attempt-1')).rejects.toThrow();

      const upsertCall = (prisma.tenantOnboardingAuditLog.upsert as jest.Mock)
        .mock.calls[0][0];
      const firstAdminCompensation = upsertCall.create.compensation.find(
        (c: { step: string }) => c.step === 'first_admin_assigned',
      );
      expect(firstAdminCompensation.status).toBe('failed');
      expect(firstAdminCompensation.detail).toContain('tenantId=tenant1');
      // Never a raw error message or stack trace.
      expect(firstAdminCompensation.detail).not.toContain(
        'connection lost mid-delete',
      );
    });

    it('remaining compensation sub-steps still run even when one sub-step throws', async () => {
      const {
        service,
        dynamicTablesService,
        setupLinkService,
        firstAdminService,
        tenantKnexService,
      } = buildService();
      (
        dynamicTablesService.ensureMetaTables as jest.Mock
      ).mockRejectedValueOnce(
        new Error('relation "_meta_tables" already exists'),
      );
      (setupLinkService.revokeAll as jest.Mock).mockRejectedValueOnce(
        new Error('connection lost'),
      );

      await expect(service.startLifecycle('attempt-1')).rejects.toThrow();

      // revoke_setup_tokens failed, but deactivate_first_admin and
      // drop_tenant_schema were still attempted afterward.
      expect(firstAdminService.deactivate).toHaveBeenCalledWith('tenant1');
      expect(tenantKnexService.raw).toHaveBeenCalledWith(
        'DROP SCHEMA IF EXISTS ?? CASCADE',
        ['tenant_tenant1'],
      );
    });

    it('idempotent full-job retry: activation on an already-ACTIVE tenant and a repeat audit upsert do not throw', async () => {
      const { prisma, service } = buildService();
      // Tenant is already ACTIVE (a prior run completed activation before
      // the retry) -- the conditional updateMany() (status not FAILED) is
      // a safe no-op status-wise: it re-sets the same ACTIVE value and
      // still reports count: 1, since ACTIVE is not FAILED.

      await expect(
        service.startLifecycle('attempt-1'),
      ).resolves.toBeUndefined();

      expect(prisma.tenant.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'ACTIVE' } }),
      );
      // The audit upsert is keyed on attemptId and does not throw even
      // though this is (conceptually) a second write for the same attempt.
      expect(prisma.tenantOnboardingAuditLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { attemptId: 'attempt-1' } }),
      );
    });

    it('activation is blocked (and does not overwrite) when Tenant.status is already FAILED', async () => {
      const { prisma, service } = buildService();
      (prisma.tenant.updateMany as jest.Mock).mockResolvedValueOnce({
        count: 0,
      });

      await expect(service.startLifecycle('attempt-1')).rejects.toThrow(
        /already FAILED/,
      );

      expect(prisma.tenant.findUniqueOrThrow).not.toHaveBeenCalled();
      // Compensation still runs (steps 1-6 had succeeded in this scenario)
      // and the audit is still finalized -- activation being blocked is
      // just another steps-1-through-6-equivalent failure from the
      // orchestrator's point of view.
      expect(prisma.tenantOnboardingAuditLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            finalStatus: expect.stringMatching(
              /^(failed|failed-needs-manual-cleanup)$/,
            ),
          }),
        }),
      );
    });

    it('does not write a stale step or activate after the worker aborts a timed-out lifecycle', async () => {
      const { prisma, service, emailDeliveryService, tx } = buildService();
      let resolveEmail: ((value: { delivered: boolean }) => void) | undefined;
      (emailDeliveryService.sendSetupInvite as jest.Mock).mockImplementation(
        () =>
          new Promise<{ delivered: boolean }>((resolve) => {
            resolveEmail = resolve;
          }),
      );
      const abortController = new AbortController();

      const lifecycle = service.startLifecycle(
        'attempt-1',
        abortController.signal,
      );

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(emailDeliveryService.sendSetupInvite).toHaveBeenCalledTimes(1);

      // Mirrors TenantProvisioningWorker's ordering: fence the stale
      // lifecycle before durable timeout compensation runs.
      abortController.abort();
      resolveEmail?.({ delivered: false });

      await expect(lifecycle).rejects.toThrow('was cancelled');
      expect(prisma.tenant.updateMany).not.toHaveBeenCalled();
      expect(findStepJson(tx, 'setup_email_sent')).toBeUndefined();
      expect(findStepJson(tx, 'activation')).toBeUndefined();
    });

    describe('retry after a terminal attempt status (finding 2)', () => {
      function mockLinkedTenantAtStatus(
        prisma: { $queryRaw: jest.Mock },
        attemptStatus: string,
      ): void {
        // startLifecycle()'s resume path: findTenantByAttemptId() finds a
        // linked tenant, then readAttemptStatus() reports the attempt's
        // current (already-terminal) status.
        (prisma.$queryRaw as jest.Mock)
          .mockReset()
          .mockImplementation(async (query: unknown) => {
            const sql = (query as { sql?: string }).sql ?? '';
            if (sql.includes('FROM "tenants"')) {
              return [
                {
                  id: 'tenant1',
                  slug: 'acme-co',
                  status: 'ACTIVE',
                  onboardingAttemptId: 'attempt-1',
                },
              ];
            }
            return [{ status: attemptStatus }];
          });
      }

      it('a retry landing on "succeeded" is a true no-op: resolves without touching any step, compensation, or audit write', async () => {
        const {
          prisma,
          service,
          tenantKnexService,
          dynamicTablesService,
          tenantSeedService,
          firstAdminService,
          setupLinkService,
          emailDeliveryService,
        } = buildService();
        mockLinkedTenantAtStatus(prisma, 'succeeded');

        await expect(
          service.startLifecycle('attempt-1'),
        ).resolves.toBeUndefined();

        // Nothing from the provisioning pipeline runs again.
        expect(tenantKnexService.raw).not.toHaveBeenCalled();
        expect(dynamicTablesService.ensureMetaTables).not.toHaveBeenCalled();
        expect(tenantSeedService.bootstrapSeed).not.toHaveBeenCalled();
        expect(firstAdminService.assign).not.toHaveBeenCalled();
        expect(firstAdminService.deactivate).not.toHaveBeenCalled();
        expect(setupLinkService.generate).not.toHaveBeenCalled();
        expect(setupLinkService.revokeAll).not.toHaveBeenCalled();
        expect(emailDeliveryService.sendSetupInvite).not.toHaveBeenCalled();
        expect(prisma.tenant.update).not.toHaveBeenCalled();
        expect(prisma.tenant.updateMany).not.toHaveBeenCalled();
        expect(prisma.tenantOnboardingAuditLog.upsert).not.toHaveBeenCalled();
      });

      it('a retry landing on "failed-needs-manual-cleanup" throws instead of silently resolving, and does not auto-resume compensation', async () => {
        const {
          prisma,
          service,
          tenantKnexService,
          firstAdminService,
          setupLinkService,
        } = buildService();
        mockLinkedTenantAtStatus(prisma, 'failed-needs-manual-cleanup');

        await expect(service.startLifecycle('attempt-1')).rejects.toThrow(
          /failed-needs-manual-cleanup and requires operator intervention/,
        );

        // Manual-cleanup is a deliberate human-intervention stop -- this
        // path must not auto-resume compensation or touch Tenant.status.
        expect(tenantKnexService.raw).not.toHaveBeenCalled();
        expect(firstAdminService.deactivate).not.toHaveBeenCalled();
        expect(setupLinkService.revokeAll).not.toHaveBeenCalled();
        expect(prisma.tenant.update).not.toHaveBeenCalled();
        expect(prisma.tenant.updateMany).not.toHaveBeenCalled();
        // No new audit write either -- the audit row already recorded the
        // manual-cleanup outcome and the exact stuck resources on the
        // original failing run.
        expect(prisma.tenantOnboardingAuditLog.upsert).not.toHaveBeenCalled();
      });
    });

    it('recordProvisioningTimeout() with no linked tenant finalizes the audit with a null tenantId and skips compensation', async () => {
      const { prisma, service } = buildService();
      // findTenantByAttemptId() queries "tenants" -- return none linked.
      // readAttemptAuditRow() (finalizeAudit()'s re-query) queries
      // "tenant_onboarding_attempts" and must still resolve so the audit
      // write itself can proceed.
      (prisma.$queryRaw as jest.Mock)
        .mockReset()
        .mockImplementation(async (query: unknown) => {
          const sql = (query as { sql?: string }).sql ?? '';
          if (sql.includes('FROM "tenants"')) {
            return [];
          }
          return [
            {
              id: attemptRow.id,
              safePayload: attemptRow.safePayload,
              actorIdentity: { actorType: 'system', systemUserId: 'sysuser-1' },
              requestIdentity: {
                requestId: 'req-1',
                ipAddress: null,
                userAgent: null,
              },
              stepOutcomes: attemptRow.stepOutcomes,
            },
          ];
        });

      await service.recordProvisioningTimeout('attempt-1');

      expect(prisma.tenant.update).not.toHaveBeenCalled();
      expect(prisma.tenant.updateMany).not.toHaveBeenCalled();
      expect(prisma.tenantOnboardingAuditLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            tenantId: null,
            finalStatus: 'failed',
          }),
        }),
      );
    });

    it('recordProvisioningTimeout() with a linked tenant runs compensation and marks the tenant FAILED', async () => {
      const { prisma, service, setupLinkService, firstAdminService } =
        buildService();
      (prisma.$queryRaw as jest.Mock).mockReset().mockResolvedValue([
        {
          id: 'tenant1',
          slug: 'acme-co',
          status: 'PROVISIONING',
          onboardingAttemptId: 'attempt-1',
        },
      ]);

      await service.recordProvisioningTimeout('attempt-1');

      expect(setupLinkService.revokeAll).toHaveBeenCalledWith('tenant1');
      expect(firstAdminService.deactivate).toHaveBeenCalledWith('tenant1');
      expect(prisma.tenant.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tenant1' },
          data: { status: 'FAILED' },
        }),
      );
      expect(prisma.tenantOnboardingAuditLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            tenantId: 'tenant1',
            finalStatus: 'failed',
          }),
        }),
      );
    });

    it('never persists plaintext setup tokens, passwords, stack traces, or raw SQL in the audit row', async () => {
      const { prisma, service } = buildService();

      await service.startLifecycle('attempt-1');

      const upsertCall = (prisma.tenantOnboardingAuditLog.upsert as jest.Mock)
        .mock.calls[0][0];
      const serialized = JSON.stringify(upsertCall);
      expect(serialized).not.toContain('raw-setup-token-value');
      expect(serialized).not.toContain('connection terminated');
      expect(serialized).not.toContain('DROP SCHEMA');
      expect(serialized).not.toContain('CREATE SCHEMA');
    });
  });
});
