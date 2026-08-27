import { Controller, Param, Patch, UseGuards } from '@nestjs/common';
import {
  AccountLifecycleResponseDto,
  AuthenticatedUserDto,
} from '@flexi/shared-types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AccountLifecycleService } from './account-lifecycle.service';

/**
 * Account activation and deactivation.
 *
 * The required permission (`tenant.user.manage` or `system.user.manage`)
 * depends on the caller's actor type, so it is asserted in the service
 * rather than through a static `@RequirePermissions()` -- the same reason
 * `GET /api/auth/me` resolves its own permission.
 */
@Controller('users')
export class UsersController {
  constructor(
    private readonly accountLifecycleService: AccountLifecycleService,
  ) {}

  /**
   * Deactivates an account and revokes every live session it holds. Access
   * tokens already issued keep working for their remaining lifetime, at
   * most fifteen minutes; the next refresh or login then fails.
   */
  @Patch(':userId/deactivate')
  @UseGuards(JwtAuthGuard)
  deactivate(
    @Param('userId') userId: string,
    @CurrentUser() user: AuthenticatedUserDto,
  ): Promise<AccountLifecycleResponseDto> {
    return this.accountLifecycleService.deactivate(userId, user);
  }

  @Patch(':userId/activate')
  @UseGuards(JwtAuthGuard)
  activate(
    @Param('userId') userId: string,
    @CurrentUser() user: AuthenticatedUserDto,
  ): Promise<AccountLifecycleResponseDto> {
    return this.accountLifecycleService.activate(userId, user);
  }
}
