import 'reflect-metadata';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { PERMISSIONS_METADATA_KEY } from '../auth/decorators/require-permissions.decorator';
import { SelfRegistrationController } from './self-registration.controller';
import { SelfRegistrationService } from './self-registration.service';

/**
 * `@Throttle` stores one metadata key per field, each suffixed with the
 * name of the throttler it configures -- see `@nestjs/throttler`'s
 * `throttler.decorator.ts`. The constants are not exported from the
 * package root, so they are spelled out here rather than deep-imported
 * from its `dist`.
 */
const THROTTLER_LIMIT_KEY = 'THROTTLER:LIMITdefault';
const THROTTLER_TTL_KEY = 'THROTTLER:TTLdefault';

describe('SelfRegistrationController', () => {
  function buildService(): jest.Mocked<SelfRegistrationService> {
    return {
      register: jest.fn(),
    } as unknown as jest.Mocked<SelfRegistrationService>;
  }

  it('passes the body and the tenant header to the service', async () => {
    const service = buildService();
    const controller = new SelfRegistrationController(service);
    const dto = {
      email: 'new@acme.com',
      fullName: 'New Person',
      password: 'Str0ng!Password',
      confirmPassword: 'Str0ng!Password',
    };

    await controller.register(dto, 'tenant_1');

    expect(service.register).toHaveBeenCalledWith(dto, 'tenant_1');
  });

  /**
   * The caller has no session by construction, so the only guard is the
   * rate limiter -- this is the one unauthenticated endpoint that creates
   * rows, and a caller who can drive it freely can fill a tenant's seats.
   */
  it('is public but rate-limited per IP', () => {
    const method = SelfRegistrationController.prototype.register;

    expect(Reflect.getMetadata(GUARDS_METADATA, method)).toEqual([
      ThrottlerGuard,
    ]);
    expect(
      Reflect.getMetadata(PERMISSIONS_METADATA_KEY, method),
    ).toBeUndefined();

    expect(Reflect.getMetadata(THROTTLER_LIMIT_KEY, method)).toBe(5);
    expect(Reflect.getMetadata(THROTTLER_TTL_KEY, method)).toBe(15 * 60 * 1000);
  });

  /** A registration creates an account, approved or not: `201`. */
  it('answers 201 and lives under /auth/register', () => {
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        SelfRegistrationController.prototype.register,
      ),
    ).toBeUndefined();
    expect(Reflect.getMetadata(PATH_METADATA, SelfRegistrationController)).toBe(
      'auth',
    );
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        SelfRegistrationController.prototype.register,
      ),
    ).toBe('register');
  });
});
