import {
  BadRequestException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ActorType,
  RedeemSetupTokenRequestDto,
  SYSTEM_TENANTS_ONBOARD_PERMISSION,
  TenantOnboardingActorIdentityDto,
  TenantOnboardingAttemptDto,
  validateTenantOnboardingInput,
} from '@flexi/shared-types';
import { TenantsService } from './tenants.service';

describe('TenantsService', () => {
  const actorIdentity: TenantOnboardingActorIdentityDto = {
    actorType: ActorType.SYSTEM,
    authAccountId: 'auth-1',
    systemUserId: 'sys-1',
    email: 'ops@flexi.local',
    name: 'Ops',
    roles: ['PlatformAdmin'],
    permissions: [SYSTEM_TENANTS_ONBOARD_PERMISSION],
  };

  const requestContext = {
    requestId: 'request-1',
    ipAddress: '127.0.0.1',
    userAgent: 'jest',
    idempotencyKey: 'idem-header-1',
  };

  function buildAttemptRow(
    overrides: Partial<TenantOnboardingAttemptDto> = {},
  ) {
    return {
      id: overrides.id ?? 'attempt-1',
      status: overrides.status ?? 'accepted',
      safePayload: overrides.safePayload ?? {
        tenantName: 'Acme Co',
        tenantSlug: 'acme-co',
        firstAdminEmail: 'admin@acme.example',
        plan: 'growth',
      },
      actorIdentity: overrides.actorIdentity ?? actorIdentity,
      requestIdentity: overrides.requestIdentity ?? {
        requestId: 'request-1',
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
      },
      idempotencyIdentity: overrides.idempotencyIdentity ?? {
        key: 'idem-header-1',
        source: 'header',
      },
      stepOutcomes: overrides.stepOutcomes ?? [
        {
          step: 'permission_check',
          status: 'succeeded',
          occurredAt: '2026-08-21T08:00:00.000Z',
        },
        {
          step: 'payload_validation',
          status: 'succeeded',
          occurredAt: '2026-08-21T08:00:00.000Z',
        },
        {
          step: 'slug_availability',
          status: 'succeeded',
          occurredAt: '2026-08-21T08:00:00.000Z',
        },
        {
          step: 'attempt_reservation',
          status: 'succeeded',
          occurredAt: '2026-08-21T08:00:00.000Z',
        },
      ],
      createdAt: new Date(overrides.createdAt ?? '2026-08-21T08:00:00.000Z'),
      updatedAt: new Date(overrides.updatedAt ?? '2026-08-21T08:00:00.000Z'),
    };
  }

  function buildPrisma(
    existingTenant: { id: string } | null = null,
    queryResults: unknown[][] = [[], [buildAttemptRow()]],
  ) {
    const queryRaw = jest.fn();
    for (const result of queryResults) {
      queryRaw.mockResolvedValueOnce(result);
    }
    queryRaw.mockResolvedValue([]);

    return {
      tenant: {
        findUnique: jest.fn().mockResolvedValue(existingTenant),
        create: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      tenantOnboardingAttempt: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      tenantOnboardingAuditLog: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      systemUser: {
        findFirst: jest.fn().mockResolvedValue({ id: 'sys-1' }),
      },
      authAccount: {
        create: jest.fn(),
      },
      tenantUser: {
        create: jest.fn(),
      },
      role: {
        create: jest.fn(),
      },
      $queryRaw: queryRaw,
    };
  }

  function buildProvisioningService() {
    return {
      enqueueAcceptedAttempt: jest.fn().mockResolvedValue(undefined),
    };
  }

  function buildSetupLinkService() {
    return {
      generate: jest.fn().mockResolvedValue({
        setupToken: 'raw-setup-token-value',
        expiresAt: new Date('2026-08-22T08:00:00.000Z'),
      }),
      redeem: jest.fn().mockResolvedValue(undefined),
    };
  }

  function buildService(
    prisma = buildPrisma(),
    provisioningService = buildProvisioningService(),
    setupLinkService = buildSetupLinkService(),
  ) {
    return {
      prisma,
      provisioningService,
      setupLinkService,
      service: new TenantsService(
        prisma as never,
        provisioningService as never,
        setupLinkService as never,
      ),
    };
  }

  describe('getOnboardingAttemptStatus (Task 21)', () => {
    it('returns the safe progress projection and terminal audit summary', async () => {
      const prisma = buildPrisma();
      prisma.tenantOnboardingAttempt.findUnique.mockResolvedValue({
        id: 'attempt-1',
        status: 'succeeded',
        stepOutcomes: [
          {
            step: 'tenant_creation',
            status: 'succeeded',
            occurredAt: '2026-08-21T08:01:00.000Z',
            tenantId: 'tenant-1',
            tenantSlug: 'acme-co',
            tenantStatus: 'PROVISIONING',
            message: 'This is deliberately not part of the read contract.',
            setupToken: 'raw-setup-token-value',
          },
          {
            step: 'activation',
            status: 'failed',
            occurredAt: '2026-08-21T08:02:00.000Z',
            errorCode: 'ACTIVATION_FAILED',
            stack: 'sensitive stack trace',
            sql: 'UPDATE tenants ...',
          },
        ],
        createdAt: new Date('2026-08-21T08:00:00.000Z'),
        updatedAt: new Date('2026-08-21T08:03:00.000Z'),
      });
      prisma.tenantOnboardingAuditLog.findUnique.mockResolvedValue({
        finalStatus: 'succeeded',
        compensation: [
          {
            step: 'setup_link_generated',
            action: 'revoke_setup_tokens',
            status: 'skipped',
            detail: 'must not be returned by the progress API',
            password: 'never-return-this',
          },
        ],
        createdAt: new Date('2026-08-21T08:03:00.000Z'),
      });
      const { service } = buildService(prisma);

      await expect(
        service.getOnboardingAttemptStatus('attempt-1'),
      ).resolves.toEqual({
        id: 'attempt-1',
        status: 'succeeded',
        stepOutcomes: [
          {
            step: 'tenant_creation',
            status: 'succeeded',
            occurredAt: '2026-08-21T08:01:00.000Z',
            tenantId: 'tenant-1',
            tenantSlug: 'acme-co',
            tenantStatus: 'PROVISIONING',
          },
          {
            step: 'activation',
            status: 'failed',
            occurredAt: '2026-08-21T08:02:00.000Z',
            errorCode: 'ACTIVATION_FAILED',
          },
        ],
        audit: {
          finalStatus: 'succeeded',
          recordedAt: '2026-08-21T08:03:00.000Z',
          compensation: [
            {
              step: 'setup_link_generated',
              action: 'revoke_setup_tokens',
              status: 'skipped',
            },
          ],
        },
        createdAt: '2026-08-21T08:00:00.000Z',
        updatedAt: '2026-08-21T08:03:00.000Z',
      });

      expect(prisma.tenantOnboardingAttempt.findUnique).toHaveBeenCalledWith({
        where: { id: 'attempt-1' },
        select: {
          id: true,
          status: true,
          stepOutcomes: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      expect(prisma.tenantOnboardingAuditLog.findUnique).toHaveBeenCalledWith({
        where: { attemptId: 'attempt-1' },
        select: {
          finalStatus: true,
          compensation: true,
          createdAt: true,
        },
      });
    });

    it('returns a stable 404 when the attempt does not exist', async () => {
      const { service } = buildService();

      await expect(
        service.getOnboardingAttemptStatus('missing-attempt'),
      ).rejects.toMatchObject({
        response: {
          error: 'ONBOARDING_ATTEMPT_NOT_FOUND',
          message: 'Onboarding attempt was not found.',
        },
      });
    });

    it('does not fabricate a terminal audit record for an in-flight attempt', async () => {
      const prisma = buildPrisma();
      prisma.tenantOnboardingAttempt.findUnique.mockResolvedValue({
        id: 'attempt-1',
        status: 'provisioning',
        stepOutcomes: [],
        createdAt: new Date('2026-08-21T08:00:00.000Z'),
        updatedAt: new Date('2026-08-21T08:01:00.000Z'),
      });
      const { service } = buildService(prisma);

      await expect(
        service.getOnboardingAttemptStatus('attempt-1'),
      ).resolves.toMatchObject({
        status: 'provisioning',
        stepOutcomes: [],
        audit: null,
      });
    });
  });

  it('returns available for a valid unused slug without creating tenant state', async () => {
    const { prisma, service } = buildService();

    await expect(service.checkSlugAvailability('acme-co')).resolves.toEqual({
      slug: 'acme-co',
      available: true,
      reason: 'available',
    });

    expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { slug: 'acme-co' },
      select: { id: true },
    });
    expect(prisma.tenant.create).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('returns a safe conflict state for an existing slug', async () => {
    const { prisma, service } = buildService(buildPrisma({ id: 'tenant-1' }));

    await expect(service.checkSlugAvailability('demo')).resolves.toEqual({
      slug: 'demo',
      available: false,
      reason: 'already_in_use',
    });

    expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { slug: 'demo' },
      select: { id: true },
    });
    expect(prisma.tenant.create).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it.each(['Acme', 'acme co', 'acme_co', '-acme', 'acme-', 'acme--co', 'ab'])(
    'rejects invalid slug format %s before querying Prisma',
    async (slug) => {
      const { prisma, service } = buildService();

      await expect(service.checkSlugAvailability(slug)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
      expect(prisma.tenant.create).not.toHaveBeenCalled();
    },
  );

  it('validates required onboarding fields before submit is available', () => {
    expect(
      validateTenantOnboardingInput({
        tenantName: '',
        tenantSlug: '',
        firstAdminEmail: '',
        plan: '',
      }),
    ).toEqual({
      tenantName: 'TENANT_NAME_REQUIRED',
      tenantSlug: 'SLUG_REQUIRED',
      firstAdminEmail: 'EMAIL_REQUIRED',
      plan: 'PLAN_REQUIRED',
    });
  });

  it('validates onboarding email, slug, and plan formats before preflight', () => {
    expect(
      validateTenantOnboardingInput({
        tenantName: 'Acme Co',
        tenantSlug: 'Acme Co',
        firstAdminEmail: 'not-an-email',
        plan: 'unknown',
      }),
    ).toEqual({
      tenantSlug: 'SLUG_FORMAT',
      firstAdminEmail: 'EMAIL_FORMAT',
      plan: 'PLAN_REQUIRED',
    });
  });

  it('accepts valid onboarding field values', () => {
    expect(
      validateTenantOnboardingInput({
        tenantName: 'Acme Co',
        tenantSlug: 'acme-co',
        firstAdminEmail: 'admin@acme.example',
        plan: 'growth',
      }),
    ).toEqual({});
  });

  // EMAIL_PATTERN in @flexi/shared-types was rewritten into dot-free domain
  // labels to remove the quadratic backtracking CodeQL flagged
  // (js/polynomial-redos). These pin both halves of that change: the shapes
  // it must still accept, and the degenerate address it must now reject
  // instead of chewing through it.
  it.each([
    ['admin@acme.example', {}],
    ['first.last@sub.acme.co.uk', {}],
    ['admin+tag@mail.acme.example', {}],
    ['admin@acme', { firstAdminEmail: 'EMAIL_FORMAT' }],
    ['admin@acme.', { firstAdminEmail: 'EMAIL_FORMAT' }],
    ['admin@.example', { firstAdminEmail: 'EMAIL_FORMAT' }],
    ['admin@acme..example', { firstAdminEmail: 'EMAIL_FORMAT' }],
    ['@acme.example', { firstAdminEmail: 'EMAIL_FORMAT' }],
  ])('validates onboarding email %s', (firstAdminEmail, expected) => {
    expect(
      validateTenantOnboardingInput({
        tenantName: 'Acme Co',
        tenantSlug: 'acme-co',
        firstAdminEmail,
        plan: 'growth',
      }),
    ).toEqual(expected);
  });

  it('rejects a long malformed onboarding email without backtracking', () => {
    // Quadratic under the previous pattern: ~34s at this length, and the
    // growth was 16x per 4x of input. Anything near the old curve trips the
    // timeout rather than silently passing.
    const firstAdminEmail = `!@${'!.'.repeat(160_000)} `;
    const startedAt = process.hrtime.bigint();

    expect(
      validateTenantOnboardingInput({
        tenantName: 'Acme Co',
        tenantSlug: 'acme-co',
        firstAdminEmail,
        plan: 'growth',
      }),
    ).toEqual({ firstAdminEmail: 'EMAIL_FORMAT' });

    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('creates a durable onboarding attempt for valid normalized input', async () => {
    const { prisma, provisioningService, service } = buildService();

    await expect(
      service.createOnboardingAttempt(
        {
          tenantName: '  Acme Co  ',
          tenantSlug: 'acme-co',
          firstAdminEmail: ' ADMIN@ACME.EXAMPLE ',
          plan: 'growth',
          idempotencyKey: 'body-key-ignored',
        },
        actorIdentity,
        requestContext,
      ),
    ).resolves.toEqual({
      id: 'attempt-1',
      status: 'accepted',
      safePayload: {
        tenantName: 'Acme Co',
        tenantSlug: 'acme-co',
        firstAdminEmail: 'admin@acme.example',
        plan: 'growth',
      },
      actorIdentity,
      requestIdentity: {
        requestId: 'request-1',
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
      },
      idempotencyIdentity: {
        key: 'idem-header-1',
        source: 'header',
      },
      idempotencyOutcome: {
        replayed: false,
      },
      stepOutcomes: [
        {
          step: 'permission_check',
          status: 'succeeded',
          occurredAt: expect.any(String),
        },
        {
          step: 'payload_validation',
          status: 'succeeded',
          occurredAt: expect.any(String),
        },
        {
          step: 'slug_availability',
          status: 'succeeded',
          occurredAt: expect.any(String),
        },
        {
          step: 'attempt_reservation',
          status: 'succeeded',
          occurredAt: expect.any(String),
        },
      ],
      createdAt: '2026-08-21T08:00:00.000Z',
      updatedAt: '2026-08-21T08:00:00.000Z',
    });

    expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { slug: 'acme-co' },
      select: { id: true },
    });
    expect(prisma.systemUser.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'sys-1',
        isActive: true,
      },
      select: { id: true },
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.$queryRaw.mock.calls[0][0]).toEqual(expect.any(Object));
    expect(prisma.$queryRaw.mock.calls[1][0]).toEqual(expect.any(Object));
    expect(provisioningService.enqueueAcceptedAttempt).toHaveBeenCalledWith(
      'attempt-1',
    );
    expect(prisma.tenant.create).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(prisma.authAccount.create).not.toHaveBeenCalled();
    expect(prisma.tenantUser.create).not.toHaveBeenCalled();
    expect(prisma.role.create).not.toHaveBeenCalled();
  });

  it('rejects invalid attempt payload before querying or creating state', async () => {
    const { prisma, provisioningService, service } = buildService();

    try {
      await service.createOnboardingAttempt(
        {
          tenantName: '',
          tenantSlug: 'Bad Slug',
          firstAdminEmail: 'not-an-email',
          plan: 'unknown' as never,
        },
        actorIdentity,
        requestContext,
      );
      throw new Error('expected createOnboardingAttempt to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as HttpException).getResponse()).toEqual({
        error: 'VALIDATION_ERROR',
        message: 'Tenant onboarding request is invalid.',
        fields: {
          tenantName: 'TENANT_NAME_REQUIRED',
          tenantSlug: 'SLUG_FORMAT',
          firstAdminEmail: 'EMAIL_FORMAT',
          plan: 'PLAN_REQUIRED',
        },
      });
    }

    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.tenant.create).not.toHaveBeenCalled();
    expect(provisioningService.enqueueAcceptedAttempt).not.toHaveBeenCalled();
  });

  it('requires an idempotency identity before querying or creating state', async () => {
    const { prisma, provisioningService, service } = buildService();

    try {
      await service.createOnboardingAttempt(
        {
          tenantName: 'Acme Co',
          tenantSlug: 'acme-co',
          firstAdminEmail: 'admin@acme.example',
          plan: 'growth',
        },
        actorIdentity,
        {
          ...requestContext,
          idempotencyKey: null,
        },
      );
      throw new Error('expected createOnboardingAttempt to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as HttpException).getResponse()).toEqual({
        error: 'VALIDATION_ERROR',
        message: 'Tenant onboarding request is invalid.',
        fields: {
          idempotencyKey: 'IDEMPOTENCY_KEY_REQUIRED',
        },
      });
    }

    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.systemUser.findFirst).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(provisioningService.enqueueAcceptedAttempt).not.toHaveBeenCalled();
  });

  it('combines invalid payload and missing idempotency errors before querying or creating state', async () => {
    const { prisma, provisioningService, service } = buildService();

    try {
      await service.createOnboardingAttempt(
        {
          tenantName: '',
          tenantSlug: 'Bad Slug',
          firstAdminEmail: 'not-an-email',
          plan: 'unknown' as never,
        },
        actorIdentity,
        {
          ...requestContext,
          idempotencyKey: null,
        },
      );
      throw new Error('expected createOnboardingAttempt to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as HttpException).getResponse()).toEqual({
        error: 'VALIDATION_ERROR',
        message: 'Tenant onboarding request is invalid.',
        fields: {
          tenantName: 'TENANT_NAME_REQUIRED',
          tenantSlug: 'SLUG_FORMAT',
          firstAdminEmail: 'EMAIL_FORMAT',
          plan: 'PLAN_REQUIRED',
          idempotencyKey: 'IDEMPOTENCY_KEY_REQUIRED',
        },
      });
    }

    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.systemUser.findFirst).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(provisioningService.enqueueAcceptedAttempt).not.toHaveBeenCalled();
  });

  it('rejects an idempotency key with unsupported format before querying or creating state', async () => {
    const { prisma, provisioningService, service } = buildService();

    try {
      await service.createOnboardingAttempt(
        {
          tenantName: 'Acme Co',
          tenantSlug: 'acme-co',
          firstAdminEmail: 'admin@acme.example',
          plan: 'growth',
        },
        actorIdentity,
        {
          ...requestContext,
          idempotencyKey: 'bad key with spaces',
        },
      );
      throw new Error('expected createOnboardingAttempt to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as HttpException).getResponse()).toEqual({
        error: 'VALIDATION_ERROR',
        message: 'Tenant onboarding request is invalid.',
        fields: {
          idempotencyKey: 'IDEMPOTENCY_KEY_FORMAT',
        },
      });
    }

    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.systemUser.findFirst).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(provisioningService.enqueueAcceptedAttempt).not.toHaveBeenCalled();
  });

  it('uses the body idempotency key when the header is absent', async () => {
    const prisma = buildPrisma(null, [
      [],
      [
        buildAttemptRow({
          idempotencyIdentity: {
            key: 'body-key-1',
            source: 'body',
          },
        }),
      ],
    ]);
    const provisioningService = buildProvisioningService();
    const service = new TenantsService(
      prisma as never,
      provisioningService as never,
      buildSetupLinkService() as never,
    );

    const result = await service.createOnboardingAttempt(
      {
        tenantName: 'Acme Co',
        tenantSlug: 'acme-co',
        firstAdminEmail: 'admin@acme.example',
        plan: 'starter',
        idempotencyKey: 'body-key-1',
      },
      actorIdentity,
      {
        ...requestContext,
        idempotencyKey: null,
      },
    );

    expect(result.idempotencyIdentity).toEqual({
      key: 'body-key-1',
      source: 'body',
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(provisioningService.enqueueAcceptedAttempt).toHaveBeenCalledWith(
      'attempt-1',
    );
  });

  it('returns the existing attempt for a matching idempotent retry before slug recheck', async () => {
    const existingAttempt = buildAttemptRow({
      id: 'attempt-existing',
      safePayload: {
        tenantName: 'Acme Co',
        tenantSlug: 'acme-co',
        firstAdminEmail: 'admin@acme.example',
        plan: 'growth',
      },
    });
    const prisma = buildPrisma({ id: 'tenant-1' }, [[existingAttempt]]);
    const provisioningService = buildProvisioningService();
    const service = new TenantsService(
      prisma as never,
      provisioningService as never,
      buildSetupLinkService() as never,
    );

    await expect(
      service.createOnboardingAttempt(
        {
          tenantName: ' Acme Co ',
          tenantSlug: 'acme-co',
          firstAdminEmail: 'ADMIN@ACME.EXAMPLE',
          plan: 'growth',
        },
        actorIdentity,
        requestContext,
      ),
    ).resolves.toMatchObject({
      id: 'attempt-existing',
      idempotencyOutcome: {
        replayed: true,
        existingAttemptId: 'attempt-existing',
      },
    });

    expect(prisma.systemUser.findFirst).toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.tenant.create).not.toHaveBeenCalled();
    expect(prisma.authAccount.create).not.toHaveBeenCalled();
    expect(prisma.tenantUser.create).not.toHaveBeenCalled();
    expect(prisma.role.create).not.toHaveBeenCalled();
    expect(provisioningService.enqueueAcceptedAttempt).toHaveBeenCalledWith(
      'attempt-existing',
    );
  });

  it('rejects idempotency reuse with a different normalized safe payload', async () => {
    const existingAttempt = buildAttemptRow({
      id: 'attempt-existing',
      safePayload: {
        tenantName: 'Acme Co',
        tenantSlug: 'acme-co',
        firstAdminEmail: 'admin@acme.example',
        plan: 'growth',
      },
    });
    const prisma = buildPrisma(null, [[existingAttempt]]);
    const provisioningService = buildProvisioningService();
    const service = new TenantsService(
      prisma as never,
      provisioningService as never,
      buildSetupLinkService() as never,
    );

    await expect(
      service.createOnboardingAttempt(
        {
          tenantName: 'Acme Co Renamed',
          tenantSlug: 'acme-co',
          firstAdminEmail: 'admin@acme.example',
          plan: 'growth',
        },
        actorIdentity,
        requestContext,
      ),
    ).rejects.toMatchObject({
      response: {
        error: 'IDEMPOTENCY_CONFLICT',
        message:
          'Idempotency key has already been used for a different onboarding payload.',
        existingAttemptId: 'attempt-existing',
      },
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.tenant.create).not.toHaveBeenCalled();
    expect(prisma.authAccount.create).not.toHaveBeenCalled();
    expect(prisma.tenantUser.create).not.toHaveBeenCalled();
    expect(prisma.role.create).not.toHaveBeenCalled();
    expect(provisioningService.enqueueAcceptedAttempt).not.toHaveBeenCalled();
  });

  it('re-reads through a raw-query unique-key visibility race and returns the winning matching attempt', async () => {
    const winningAttempt = buildAttemptRow({
      id: 'attempt-winning',
      safePayload: {
        tenantName: 'Acme Co',
        tenantSlug: 'acme-co',
        firstAdminEmail: 'admin@acme.example',
        plan: 'growth',
      },
    });
    const prisma = buildPrisma(null, []);
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError(
          'Raw query failed with unique constraint violation.',
          {
            code: 'P2010',
            clientVersion: '7.9.1',
            meta: {
              driverAdapterError: {
                cause: { originalCode: '23505' },
              },
            },
          },
        ),
      )
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([winningAttempt]);
    const provisioningService = buildProvisioningService();
    const service = new TenantsService(
      prisma as never,
      provisioningService as never,
      buildSetupLinkService() as never,
    );

    await expect(
      service.createOnboardingAttempt(
        {
          tenantName: 'Acme Co',
          tenantSlug: 'acme-co',
          firstAdminEmail: 'admin@acme.example',
          plan: 'growth',
        },
        actorIdentity,
        requestContext,
      ),
    ).resolves.toMatchObject({
      id: 'attempt-winning',
      idempotencyOutcome: {
        replayed: true,
        existingAttemptId: 'attempt-winning',
      },
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
    expect(prisma.tenant.create).not.toHaveBeenCalled();
    expect(provisioningService.enqueueAcceptedAttempt).toHaveBeenCalledWith(
      'attempt-winning',
    );
  });

  it('re-reads a raw-query unique-key race and rejects when the winning attempt has a different payload', async () => {
    const winningAttempt = buildAttemptRow({
      id: 'attempt-winning-conflict',
      safePayload: {
        tenantName: 'Different Co',
        tenantSlug: 'different-co',
        firstAdminEmail: 'admin@different.example',
        plan: 'enterprise',
      },
    });
    const prisma = buildPrisma(null, []);
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError(
          'Raw query failed with unique constraint violation.',
          {
            code: 'P2010',
            clientVersion: '7.9.1',
            meta: { code: '23505' },
          },
        ),
      )
      .mockResolvedValueOnce([winningAttempt]);
    const provisioningService = buildProvisioningService();
    const service = new TenantsService(
      prisma as never,
      provisioningService as never,
      buildSetupLinkService() as never,
    );

    await expect(
      service.createOnboardingAttempt(
        {
          tenantName: 'Acme Co',
          tenantSlug: 'acme-co',
          firstAdminEmail: 'admin@acme.example',
          plan: 'growth',
        },
        actorIdentity,
        requestContext,
      ),
    ).rejects.toMatchObject({
      response: {
        error: 'IDEMPOTENCY_CONFLICT',
        existingAttemptId: 'attempt-winning-conflict',
      },
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    expect(prisma.tenant.create).not.toHaveBeenCalled();
    expect(provisioningService.enqueueAcceptedAttempt).not.toHaveBeenCalled();
  });

  it('returns a safe retryable response when a unique-key winner stays invisible', async () => {
    const prisma = buildPrisma(null, []);
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce({ code: '23505' })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const provisioningService = buildProvisioningService();
    const service = new TenantsService(
      prisma as never,
      provisioningService as never,
      buildSetupLinkService() as never,
    );

    await expect(
      service.createOnboardingAttempt(
        {
          tenantName: 'Acme Co',
          tenantSlug: 'acme-co',
          firstAdminEmail: 'admin@acme.example',
          plan: 'growth',
        },
        actorIdentity,
        requestContext,
      ),
    ).rejects.toMatchObject({
      response: {
        error: 'ONBOARDING_RESERVATION_PENDING',
      },
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(5);
    expect(provisioningService.enqueueAcceptedAttempt).not.toHaveBeenCalled();
  });

  it('rejects a stale SystemUser token before inserting an attempt', async () => {
    const prisma = buildPrisma();
    prisma.systemUser.findFirst.mockResolvedValue(null);
    const provisioningService = buildProvisioningService();
    const service = new TenantsService(
      prisma as never,
      provisioningService as never,
      buildSetupLinkService() as never,
    );

    await expect(
      service.createOnboardingAttempt(
        {
          tenantName: 'Acme Co',
          tenantSlug: 'acme-co',
          firstAdminEmail: 'admin@acme.example',
          plan: 'starter',
        },
        actorIdentity,
        requestContext,
      ),
    ).rejects.toMatchObject({
      response: {
        error: 'FORBIDDEN',
        message: 'Tenant onboarding is only available to active System users.',
      },
    });

    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.systemUser.findFirst).toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(provisioningService.enqueueAcceptedAttempt).not.toHaveBeenCalled();
  });

  it('rejects an existing tenant slug before creating an attempt', async () => {
    const prisma = buildPrisma({ id: 'tenant-1' });
    const provisioningService = buildProvisioningService();
    const service = new TenantsService(
      prisma as never,
      provisioningService as never,
      buildSetupLinkService() as never,
    );

    await expect(
      service.createOnboardingAttempt(
        {
          tenantName: 'Acme Co',
          tenantSlug: 'acme-co',
          firstAdminEmail: 'admin@acme.example',
          plan: 'enterprise',
        },
        actorIdentity,
        requestContext,
      ),
    ).rejects.toMatchObject({
      response: {
        error: 'SLUG_ALREADY_IN_USE',
        message: 'Slug is already in use.',
      },
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.tenant.create).not.toHaveBeenCalled();
    expect(prisma.authAccount.create).not.toHaveBeenCalled();
    expect(prisma.tenantUser.create).not.toHaveBeenCalled();
    expect(prisma.role.create).not.toHaveBeenCalled();
    expect(provisioningService.enqueueAcceptedAttempt).not.toHaveBeenCalled();
  });

  describe('listTenants (Story 3.1)', () => {
    function buildTenantRow(
      overrides: Partial<{
        id: string;
        name: string;
        slug: string;
        status: string;
        createdAt: Date;
        onboardingAttempt: {
          status: string;
          safePayload: unknown;
          actorIdentity: unknown;
        } | null;
      }> = {},
    ) {
      return {
        id: overrides.id ?? 'tenant-1',
        name: overrides.name ?? 'Acme Co',
        slug: overrides.slug ?? 'acme-co',
        status: overrides.status ?? 'ACTIVE',
        createdAt: overrides.createdAt ?? new Date('2026-08-21T08:00:00.000Z'),
        onboardingAttempt:
          overrides.onboardingAttempt !== undefined
            ? overrides.onboardingAttempt
            : {
                status: 'succeeded',
                safePayload: { plan: 'growth' },
                actorIdentity: { name: 'Ops' },
              },
      };
    }

    it('returns paginated rows joined with the latest attempt on the happy path', async () => {
      const tenantRow = buildTenantRow();
      const prisma = buildPrisma();
      prisma.tenant.findMany.mockResolvedValue([tenantRow]);
      prisma.tenant.count.mockResolvedValue(1);
      const { service } = buildService(prisma);

      await expect(service.listTenants({})).resolves.toEqual({
        items: [
          {
            id: 'tenant-1',
            name: 'Acme Co',
            slug: 'acme-co',
            status: 'ACTIVE',
            plan: 'growth',
            createdAt: '2026-08-21T08:00:00.000Z',
            latestAttemptStatus: 'succeeded',
            actorName: 'Ops',
          },
        ],
        meta: { total: 1, page: 1, pageSize: 20 },
      });

      expect(prisma.tenant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {},
          include: { onboardingAttempt: true },
          skip: 0,
          take: 20,
        }),
      );
      expect(prisma.tenant.count).toHaveBeenCalledWith({ where: {} });
    });

    it('renders a safe placeholder for a tenant with no onboarding attempt', async () => {
      const tenantRow = buildTenantRow({ onboardingAttempt: null });
      const prisma = buildPrisma();
      prisma.tenant.findMany.mockResolvedValue([tenantRow]);
      prisma.tenant.count.mockResolvedValue(1);
      const { service } = buildService(prisma);

      await expect(service.listTenants({})).resolves.toMatchObject({
        items: [
          {
            plan: null,
            latestAttemptStatus: null,
            actorName: null,
          },
        ],
      });
    });

    it('applies status, keyword, and date-range filters with AND logic using one shared where clause', async () => {
      const prisma = buildPrisma();
      const { service } = buildService(prisma);

      await service.listTenants({
        status: 'ACTIVE',
        keyword: 'acme',
        createdFrom: '2026-01-01',
        createdTo: '2026-12-31',
      });

      const expectedWhere = {
        status: 'ACTIVE',
        createdAt: {
          gte: new Date('2026-01-01'),
          lte: new Date('2026-12-31T23:59:59.999Z'),
        },
        OR: [
          { name: { contains: 'acme', mode: 'insensitive' } },
          { slug: { contains: 'acme', mode: 'insensitive' } },
        ],
      };
      expect(prisma.tenant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere }),
      );
      expect(prisma.tenant.count).toHaveBeenCalledWith({
        where: expectedWhere,
      });
    });

    it('treats a date-only createdTo as inclusive of the whole day', async () => {
      const prisma = buildPrisma();
      const { service } = buildService(prisma);

      await service.listTenants({ createdTo: '2026-12-31' });

      expect(prisma.tenant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            createdAt: { lte: new Date('2026-12-31T23:59:59.999Z') },
          },
        }),
      );
    });

    it('uses a createdTo timestamp as-is when it already carries a time component', async () => {
      const prisma = buildPrisma();
      const { service } = buildService(prisma);

      await service.listTenants({ createdTo: '2026-12-31T10:00:00.000Z' });

      expect(prisma.tenant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            createdAt: { lte: new Date('2026-12-31T10:00:00.000Z') },
          },
        }),
      );
    });

    it('escapes SQL LIKE metacharacters in the keyword before filtering', async () => {
      const prisma = buildPrisma();
      const { service } = buildService(prisma);

      await service.listTenants({ keyword: '100%_off\\' });

      expect(prisma.tenant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              {
                name: { contains: '100\\%\\_off\\\\', mode: 'insensitive' },
              },
              {
                slug: { contains: '100\\%\\_off\\\\', mode: 'insensitive' },
              },
            ],
          },
        }),
      );
    });

    it('rejects an inverted createdFrom/createdTo date range', async () => {
      const { service } = buildService();

      await expect(
        service.listTenants({
          createdFrom: '2026-12-31',
          createdTo: '2026-01-01',
        }),
      ).rejects.toMatchObject({
        response: { error: 'VALIDATION_ERROR' },
      });
    });

    it.each(['createdFrom', 'createdTo'] as const)(
      'rejects an unparseable %s date string',
      async (field) => {
        const { service } = buildService();

        await expect(
          service.listTenants({ [field]: 'not-a-date' }),
        ).rejects.toMatchObject({
          response: { error: 'VALIDATION_ERROR' },
        });
      },
    );

    it.each([0, -1, 1.5, NaN])(
      'rejects a non-positive or non-integer page value: %s',
      async (page) => {
        const { service } = buildService();

        await expect(
          service.listTenants({ page: page as number }),
        ).rejects.toMatchObject({
          response: { error: 'VALIDATION_ERROR' },
        });
      },
    );

    it.each([0, -1, 1.5, NaN])(
      'rejects a non-positive or non-integer pageSize value: %s',
      async (pageSize) => {
        const { service } = buildService();

        await expect(
          service.listTenants({ pageSize: pageSize as number }),
        ).rejects.toMatchObject({
          response: { error: 'VALIDATION_ERROR' },
        });
      },
    );

    it('clamps a pageSize above the max upper bound instead of rejecting it', async () => {
      const prisma = buildPrisma();
      const { service } = buildService(prisma);

      await expect(
        service.listTenants({ pageSize: 500 }),
      ).resolves.toMatchObject({
        meta: { pageSize: 100 },
      });
      expect(prisma.tenant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });

    it('rejects an invalid status filter value', async () => {
      const { service } = buildService();

      await expect(
        service.listTenants({ status: 'NOT_A_STATUS' as never }),
      ).rejects.toMatchObject({
        response: { error: 'VALIDATION_ERROR' },
      });
    });

    it('applies page-based pagination offsets', async () => {
      const prisma = buildPrisma();
      const { service } = buildService(prisma);

      await service.listTenants({ page: 3, pageSize: 10 });

      expect(prisma.tenant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
    });
  });

  describe('regenerateSetupLink (Story 2.5)', () => {
    it('delegates entirely to SetupLinkService.generate and returns the raw token + expiry once', async () => {
      const { setupLinkService, service } = buildService();

      await expect(
        service.regenerateSetupLink('tenant-1', actorIdentity),
      ).resolves.toEqual({
        tenantId: 'tenant-1',
        setupToken: 'raw-setup-token-value',
        expiresAt: '2026-08-22T08:00:00.000Z',
      });

      expect(setupLinkService.generate).toHaveBeenCalledWith('tenant-1');
      expect(setupLinkService.generate).toHaveBeenCalledTimes(1);
    });

    it('propagates NotFoundException from SetupLinkService.generate (no First Admin yet)', async () => {
      const setupLinkService = {
        generate: jest.fn().mockRejectedValue(
          new NotFoundException({
            error: 'FIRST_ADMIN_NOT_FOUND',
            message: 'No First Admin exists for this tenant yet.',
          }),
        ),
        redeem: jest.fn(),
      };
      const { service } = buildService(
        buildPrisma(),
        buildProvisioningService(),
        setupLinkService,
      );

      await expect(
        service.regenerateSetupLink('tenant-without-admin', actorIdentity),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('redeemSetupToken (Task 16)', () => {
    it('delegates redemption and returns the identity-free success contract', async () => {
      const { setupLinkService, service } = buildService();
      const dto: RedeemSetupTokenRequestDto = {
        token: 'raw-setup-token-value',
        password: 'First-admin-password',
      };

      await expect(service.redeemSetupToken(dto)).resolves.toEqual({
        status: 'completed',
      });

      expect(setupLinkService.redeem).toHaveBeenCalledWith(dto);
      expect(setupLinkService.redeem).toHaveBeenCalledTimes(1);
    });

    it('preserves the opaque redemption error from the domain service', async () => {
      const setupLinkService = {
        generate: jest.fn(),
        redeem: jest.fn().mockRejectedValue(
          new BadRequestException({
            error: 'INVALID_SETUP_TOKEN',
            message: 'The setup link is invalid or has expired.',
          }),
        ),
      };
      const { service } = buildService(
        buildPrisma(),
        buildProvisioningService(),
        setupLinkService,
      );

      await expect(
        service.redeemSetupToken({
          token: 'invalid-token',
          password: 'First-admin-password',
        }),
      ).rejects.toMatchObject({
        response: {
          error: 'INVALID_SETUP_TOKEN',
          message: 'The setup link is invalid or has expired.',
        },
      });
    });
  });
});
