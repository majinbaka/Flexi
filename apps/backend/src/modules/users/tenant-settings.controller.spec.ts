import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import {
  ActorType,
  AuthenticatedUserDto,
  TENANT_SETTINGS_MANAGE_PERMISSION,
} from '@flexi/shared-types';
import { PERMISSIONS_METADATA_KEY } from '../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantSettingsController } from './tenant-settings.controller';
import { TenantSettingsService } from './tenant-settings.service';

describe('TenantSettingsController', () => {
  const caller: AuthenticatedUserDto = {
    authAccountId: 'auth_admin',
    actorType: ActorType.TENANT,
    tenantId: 'tenant_1',
    tenantUserId: 'tu_admin',
    email: 'admin@acme.example',
    name: 'Admin',
    roles: ['TENANT_ADMIN'],
    permissions: [TENANT_SETTINGS_MANAGE_PERMISSION],
  };

  function buildService(): jest.Mocked<TenantSettingsService> {
    return {
      getSettings: jest.fn(),
      updateSettings: jest.fn(),
    } as unknown as jest.Mocked<TenantSettingsService>;
  }

  it('passes the caller and the header through to the service', async () => {
    const service = buildService();
    const controller = new TenantSettingsController(service);
    const dto = { allowSelfRegistration: true };

    await controller.getSettings(caller, 'tenant_1');
    await controller.updateSettings(dto, caller, 'tenant_1');

    expect(service.getSettings).toHaveBeenCalledWith(caller, 'tenant_1');
    expect(service.updateSettings).toHaveBeenCalledWith(
      dto,
      caller,
      'tenant_1',
    );
  });

  it('works without a header, which is the tenant-caller case', async () => {
    const service = buildService();
    const controller = new TenantSettingsController(service);

    await controller.getSettings(caller);

    expect(service.getSettings).toHaveBeenCalledWith(caller, undefined);
  });

  /**
   * Authentication is a guard's job; the permission is not, because which
   * code applies depends on the caller's actor type. The service asserts
   * it, exactly as `AccountLifecycleService` does.
   */
  it.each(['getSettings', 'updateSettings'] as const)(
    'guards %s with JwtAuthGuard and no static permission',
    (route) => {
      const method = TenantSettingsController.prototype[route];

      expect(Reflect.getMetadata(GUARDS_METADATA, method)).toEqual([
        JwtAuthGuard,
      ]);
      expect(
        Reflect.getMetadata(PERMISSIONS_METADATA_KEY, method),
      ).toBeUndefined();
    },
  );
});
