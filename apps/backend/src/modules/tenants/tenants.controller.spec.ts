import 'reflect-metadata';
import { ForbiddenException, HttpStatus } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
} from '@nestjs/common/constants';
import type { Request } from 'express';
import {
  ActorType,
  SYSTEM_TENANTS_ONBOARD_PERMISSION,
} from '@flexi/shared-types';
import { PERMISSIONS_METADATA_KEY } from '../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

describe('TenantsController', () => {
  function buildService(): jest.Mocked<TenantsService> {
    return {
      getStatus: jest.fn(),
      checkSlugAvailability: jest.fn(),
      createOnboardingAttempt: jest.fn(),
    } as unknown as jest.Mocked<TenantsService>;
  }

  const permittedSystemUser = {
    authAccountId: 'auth-1',
    actorType: ActorType.SYSTEM,
    systemUserId: 'sys-1',
    email: 'ops@flexi.local',
    name: 'Ops',
    roles: ['PlatformAdmin'],
    permissions: [SYSTEM_TENANTS_ONBOARD_PERMISSION],
  };

  function buildRequest(): Request {
    return {
      ip: '127.0.0.1',
      headers: {
        'x-request-id': 'request-1',
        'idempotency-key': 'idem-1',
        'user-agent': 'jest',
      },
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
  }

  it('keeps the legacy tenant status stub route delegated to the service', () => {
    const service = buildService();
    service.getStatus.mockReturnValue({ status: 'not-implemented' });
    const controller = new TenantsController(service);

    expect(controller.getStatus()).toEqual({ status: 'not-implemented' });
    expect(service.getStatus).toHaveBeenCalledTimes(1);
  });

  it('delegates slug availability for permitted System users', async () => {
    const service = buildService();
    service.checkSlugAvailability.mockResolvedValue({
      slug: 'acme-co',
      available: true,
      reason: 'available',
    });
    const controller = new TenantsController(service);

    await expect(
      controller.checkSlugAvailability('acme-co', {
        ...permittedSystemUser,
      }),
    ).resolves.toEqual({
      slug: 'acme-co',
      available: true,
      reason: 'available',
    });

    expect(service.checkSlugAvailability).toHaveBeenCalledWith('acme-co');
  });

  it('normalizes non-string slug query values before delegating', async () => {
    const service = buildService();
    service.checkSlugAvailability.mockResolvedValue({
      slug: '',
      available: false,
      reason: 'already_in_use',
    });
    const controller = new TenantsController(service);

    await controller.checkSlugAvailability(['one', 'two'], {
      ...permittedSystemUser,
    });

    expect(service.checkSlugAvailability).toHaveBeenCalledWith('');
  });

  it('normalizes missing slug query values before delegating', async () => {
    const service = buildService();
    service.checkSlugAvailability.mockResolvedValue({
      slug: '',
      available: false,
      reason: 'already_in_use',
    });
    const controller = new TenantsController(service);

    await controller.checkSlugAvailability(undefined, {
      ...permittedSystemUser,
    });

    expect(service.checkSlugAvailability).toHaveBeenCalledWith('');
  });

  it('normalizes object-shaped slug query values before delegating', async () => {
    const service = buildService();
    service.checkSlugAvailability.mockResolvedValue({
      slug: '',
      available: false,
      reason: 'already_in_use',
    });
    const controller = new TenantsController(service);

    await controller.checkSlugAvailability(
      { nested: 'slug' },
      {
        ...permittedSystemUser,
      },
    );

    expect(service.checkSlugAvailability).toHaveBeenCalledWith('');
  });

  it('blocks tenant actors before slug availability is delegated', () => {
    const service = buildService();
    const controller = new TenantsController(service);

    expect(() =>
      controller.checkSlugAvailability('acme-co', {
        authAccountId: 'auth-1',
        actorType: ActorType.TENANT,
        tenantId: 'tenant-1',
        tenantUserId: 'user-1',
        email: 'admin@tenant.local',
        name: 'Tenant Admin',
        roles: ['Admin'],
        permissions: [SYSTEM_TENANTS_ONBOARD_PERMISSION],
      }),
    ).toThrow(ForbiddenException);

    expect(service.checkSlugAvailability).not.toHaveBeenCalled();
  });

  it('requires authentication and tenant onboarding permission metadata on slug availability', () => {
    const method = TenantsController.prototype.checkSlugAvailability;

    expect(Reflect.getMetadata(GUARDS_METADATA, method)).toEqual([
      JwtAuthGuard,
      PermissionsGuard,
    ]);
    expect(Reflect.getMetadata(PERMISSIONS_METADATA_KEY, method)).toEqual([
      SYSTEM_TENANTS_ONBOARD_PERMISSION,
    ]);
  });

  it('delegates onboarding attempt creation for permitted System users', async () => {
    const service = buildService();
    service.createOnboardingAttempt.mockResolvedValue({
      id: 'attempt-1',
      status: 'accepted',
      safePayload: {
        tenantName: 'Acme Co',
        tenantSlug: 'acme-co',
        firstAdminEmail: 'admin@acme.example',
        plan: 'growth',
      },
      actorIdentity: {
        ...permittedSystemUser,
        actorType: ActorType.SYSTEM,
      },
      requestIdentity: {
        requestId: 'request-1',
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
      },
      idempotencyIdentity: {
        key: 'idem-1',
        source: 'header',
      },
      idempotencyOutcome: {
        replayed: false,
      },
      stepOutcomes: [],
      createdAt: '2026-08-21T08:00:00.000Z',
      updatedAt: '2026-08-21T08:00:00.000Z',
    });
    const controller = new TenantsController(service);
    const body = {
      tenantName: 'Acme Co',
      tenantSlug: 'acme-co',
      firstAdminEmail: 'admin@acme.example',
      plan: 'growth' as const,
    };

    await expect(
      controller.createOnboardingAttempt(
        body,
        permittedSystemUser,
        buildRequest(),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        id: 'attempt-1',
        status: 'accepted',
      }),
    );

    expect(service.createOnboardingAttempt).toHaveBeenCalledWith(
      body,
      {
        actorType: ActorType.SYSTEM,
        authAccountId: 'auth-1',
        systemUserId: 'sys-1',
        email: 'ops@flexi.local',
        name: 'Ops',
        roles: ['PlatformAdmin'],
        permissions: [SYSTEM_TENANTS_ONBOARD_PERMISSION],
      },
      {
        requestId: 'request-1',
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
        idempotencyKey: 'idem-1',
      },
    );
  });

  it('blocks tenant actors before onboarding attempt creation is delegated', () => {
    const service = buildService();
    const controller = new TenantsController(service);

    expect(() =>
      controller.createOnboardingAttempt(
        {
          tenantName: 'Acme Co',
          tenantSlug: 'acme-co',
          firstAdminEmail: 'admin@acme.example',
          plan: 'growth',
        },
        {
          authAccountId: 'auth-1',
          actorType: ActorType.TENANT,
          tenantId: 'tenant-1',
          tenantUserId: 'user-1',
          email: 'admin@tenant.local',
          name: 'Tenant Admin',
          roles: ['Admin'],
          permissions: [SYSTEM_TENANTS_ONBOARD_PERMISSION],
        },
        buildRequest(),
      ),
    ).toThrow(ForbiddenException);

    expect(service.createOnboardingAttempt).not.toHaveBeenCalled();
  });

  it('normalizes request headers and permits undefined bodies before create delegation', async () => {
    const service = buildService();
    service.createOnboardingAttempt.mockResolvedValue({
      id: 'attempt-1',
      status: 'accepted',
      safePayload: {
        tenantName: '',
        tenantSlug: '',
        firstAdminEmail: '',
        plan: 'starter',
      },
      actorIdentity: {
        ...permittedSystemUser,
        actorType: ActorType.SYSTEM,
      },
      requestIdentity: {
        requestId: 'request-2',
        ipAddress: '10.0.0.1',
        userAgent: null,
      },
      idempotencyIdentity: {
        key: 'idem-2',
        source: 'header',
      },
      idempotencyOutcome: {
        replayed: false,
      },
      stepOutcomes: [],
      createdAt: '2026-08-21T08:00:00.000Z',
      updatedAt: '2026-08-21T08:00:00.000Z',
    });
    const controller = new TenantsController(service);

    await controller.createOnboardingAttempt(undefined, permittedSystemUser, {
      headers: {
        'x-request-id': [' request-2 '],
        'idempotency-key': [' idem-2 '],
        'user-agent': '   ',
      },
      socket: { remoteAddress: '10.0.0.1' },
    } as unknown as Request);

    expect(service.createOnboardingAttempt).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ systemUserId: 'sys-1' }),
      {
        requestId: 'request-2',
        ipAddress: '10.0.0.1',
        userAgent: null,
        idempotencyKey: 'idem-2',
      },
    );
  });

  it('requires authentication, tenant onboarding permission, and 202 metadata on create attempt', () => {
    const method = TenantsController.prototype.createOnboardingAttempt;

    expect(Reflect.getMetadata(GUARDS_METADATA, method)).toEqual([
      JwtAuthGuard,
      PermissionsGuard,
    ]);
    expect(Reflect.getMetadata(PERMISSIONS_METADATA_KEY, method)).toEqual([
      SYSTEM_TENANTS_ONBOARD_PERMISSION,
    ]);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, method)).toBe(
      HttpStatus.ACCEPTED,
    );
  });
});
