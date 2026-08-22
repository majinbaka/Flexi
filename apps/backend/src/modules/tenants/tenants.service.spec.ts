import { BadRequestException, HttpException } from '@nestjs/common';
import {
  ActorType,
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

  function buildService(
    prisma = buildPrisma(),
    provisioningService = buildProvisioningService(),
  ) {
    return {
      prisma,
      provisioningService,
      service: new TenantsService(
        prisma as never,
        provisioningService as never,
      ),
    };
  }

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

  it('recovers a concurrent unique-key race by returning the winning matching attempt', async () => {
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
      .mockRejectedValueOnce({ code: '23505' })
      .mockResolvedValueOnce([winningAttempt]);
    const provisioningService = buildProvisioningService();
    const service = new TenantsService(
      prisma as never,
      provisioningService as never,
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

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    expect(prisma.tenant.create).not.toHaveBeenCalled();
    expect(provisioningService.enqueueAcceptedAttempt).toHaveBeenCalledWith(
      'attempt-winning',
    );
  });

  it('recovers a concurrent unique-key race by rejecting when the winning attempt has a different payload', async () => {
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
      .mockRejectedValueOnce({ code: '23505' })
      .mockResolvedValueOnce([winningAttempt]);
    const provisioningService = buildProvisioningService();
    const service = new TenantsService(
      prisma as never,
      provisioningService as never,
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

  it('rejects a stale SystemUser token before inserting an attempt', async () => {
    const prisma = buildPrisma();
    prisma.systemUser.findFirst.mockResolvedValue(null);
    const provisioningService = buildProvisioningService();
    const service = new TenantsService(
      prisma as never,
      provisioningService as never,
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
});
