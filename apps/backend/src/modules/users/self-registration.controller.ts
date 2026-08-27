import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { SelfRegisterResponseDto } from '@flexi/shared-types';
import { TenantIdHeader } from '../../common/tenant-context.decorator';
import { SelfRegisterDto } from './dto/self-register.dto';
import { SelfRegistrationService } from './self-registration.service';

/**
 * Window and budget for public sign-up, per IP. Stricter than the
 * module-wide login default and matched to the password-recovery routes:
 * this is the only unauthenticated endpoint that *creates* rows, so a
 * caller who can drive it freely can fill a tenant's seats.
 *
 * Constants rather than env variables because `@Throttle` is a static
 * decorator, exactly as in `AuthController`.
 */
const SELF_REGISTER_THROTTLE_TTL_MS = 15 * 60 * 1000;
const SELF_REGISTER_THROTTLE_LIMIT = 5;

/**
 * Public sign-up.
 *
 * Deliberately `@Controller('auth')`, sharing the base path with
 * `AuthController` while living in `UsersModule`: registration needs the
 * quota, directory and settings services that module owns, and moving it
 * into `AuthModule` would make `AuthModule` import `UsersModule`, which
 * already imports `AuthModule`. A second controller on the same path costs
 * nothing -- the routes do not collide -- and is a far smaller price than
 * a `forwardRef` cycle between the two modules.
 */
@Controller('auth')
export class SelfRegistrationController {
  constructor(
    private readonly selfRegistrationService: SelfRegistrationService,
  ) {}

  /**
   * `x-tenant-id` names the tenant, the same signal login uses. Answers
   * `201`: a registration creates an account, whether or not it can be
   * used before an administrator approves it.
   */
  @Post('register')
  @UseGuards(ThrottlerGuard)
  @Throttle({
    default: {
      limit: SELF_REGISTER_THROTTLE_LIMIT,
      ttl: SELF_REGISTER_THROTTLE_TTL_MS,
    },
  })
  register(
    @Body() dto: SelfRegisterDto,
    @TenantIdHeader() tenantId?: string,
  ): Promise<SelfRegisterResponseDto> {
    return this.selfRegistrationService.register(dto, tenantId);
  }
}
