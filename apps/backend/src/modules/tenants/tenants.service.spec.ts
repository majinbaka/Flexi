import { BadRequestException, HttpException } from '@nestjs/common';
import {
  ActorType,
  SYSTEM_TENANTS_ONBOARD_PERMISSION,
  TenantOnboardingActorIdentityDto,
  validateTenantOnboardingInput,
} from '@flexi/shared-types';
import { TenantsService } from './tenants.service';

describe('TenantsService', () => {
  function buildPrisma(existingTenant: { id: string } | null = null) {
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
      $queryRaw: jest.fn().mockResolvedValue([
        {
          id: 'attempt-1',
          createdAt: new Date('2026-08-21T08:00:00.000Z'),
          updatedAt: new Date('2026-08-21T08:00:00.000Z'),
        },
      ]),
    };
  }

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

  it('returns available for a valid unused slug without creating tenant state', async () => {
    const prisma = buildPrisma();
    const service = new TenantsService(prisma as never);

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
    const prisma = buildPrisma({ id: 'tenant-1' });
    const service = new TenantsService(prisma as never);

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
      const prisma = buildPrisma();
      const service = new TenantsService(prisma as never);

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
    const prisma = buildPrisma();
    const service = new TenantsService(prisma as never);

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
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw.mock.calls[0][0]).toEqual(expect.any(Object));
    expect(prisma.tenant.create).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(prisma.authAccount.create).not.toHaveBeenCalled();
    expect(prisma.tenantUser.create).not.toHaveBeenCalled();
    expect(prisma.role.create).not.toHaveBeenCalled();
  });

  it('rejects invalid attempt payload before querying or creating state', async () => {
    const prisma = buildPrisma();
    const service = new TenantsService(prisma as never);

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
  });

  it('requires an idempotency identity before querying or creating state', async () => {
    const prisma = buildPrisma();
    const service = new TenantsService(prisma as never);

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
  });

  it('combines invalid payload and missing idempotency errors before querying or creating state', async () => {
    const prisma = buildPrisma();
    const service = new TenantsService(prisma as never);

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
  });

  it('rejects an idempotency key with unsupported format before querying or creating state', async () => {
    const prisma = buildPrisma();
    const service = new TenantsService(prisma as never);

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
  });

  it('uses the body idempotency key when the header is absent', async () => {
    const prisma = buildPrisma();
    const service = new TenantsService(prisma as never);

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
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale SystemUser token before inserting an attempt', async () => {
    const prisma = buildPrisma();
    prisma.systemUser.findFirst.mockResolvedValue(null);
    const service = new TenantsService(prisma as never);

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

    expect(prisma.tenant.findUnique).toHaveBeenCalled();
    expect(prisma.systemUser.findFirst).toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('rejects an existing tenant slug before creating an attempt', async () => {
    const prisma = buildPrisma({ id: 'tenant-1' });
    const service = new TenantsService(prisma as never);

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

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.tenant.create).not.toHaveBeenCalled();
    expect(prisma.authAccount.create).not.toHaveBeenCalled();
    expect(prisma.tenantUser.create).not.toHaveBeenCalled();
    expect(prisma.role.create).not.toHaveBeenCalled();
  });
});
