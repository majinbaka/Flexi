import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
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
    } as unknown as jest.Mocked<TenantsService>;
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
        authAccountId: 'auth-1',
        actorType: ActorType.SYSTEM,
        systemUserId: 'sys-1',
        email: 'ops@flexi.local',
        name: 'Ops',
        roles: ['PlatformAdmin'],
        permissions: [SYSTEM_TENANTS_ONBOARD_PERMISSION],
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
      authAccountId: 'auth-1',
      actorType: ActorType.SYSTEM,
      systemUserId: 'sys-1',
      email: 'ops@flexi.local',
      name: 'Ops',
      roles: ['PlatformAdmin'],
      permissions: [SYSTEM_TENANTS_ONBOARD_PERMISSION],
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
      authAccountId: 'auth-1',
      actorType: ActorType.SYSTEM,
      systemUserId: 'sys-1',
      email: 'ops@flexi.local',
      name: 'Ops',
      roles: ['PlatformAdmin'],
      permissions: [SYSTEM_TENANTS_ONBOARD_PERMISSION],
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
        authAccountId: 'auth-1',
        actorType: ActorType.SYSTEM,
        systemUserId: 'sys-1',
        email: 'ops@flexi.local',
        name: 'Ops',
        roles: ['PlatformAdmin'],
        permissions: [SYSTEM_TENANTS_ONBOARD_PERMISSION],
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
});
