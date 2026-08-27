import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  AuthenticatedUserDto,
  ForceResetPasswordResponseDto,
} from '@flexi/shared-types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AccountLifecycleService } from './account-lifecycle.service';
import { ForceResetPasswordDto } from './dto/force-reset-password.dto';

/** Administrative intervention on somebody else's account. */
@Controller('admin/users')
export class AdminUsersController {
  constructor(
    private readonly accountLifecycleService: AccountLifecycleService,
  ) {}

  /**
   * Replaces the target's password with a generated one, raises
   * `mustChangePassword` and revokes every live session.
   *
   * The response deliberately never carries the temporary password: it
   * leaves the server only through the mail transport, so the
   * administrator who triggered the reset cannot read the credential they
   * just created for somebody else.
   */
  @Post(':userId/force-reset-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  forceResetPassword(
    @Param('userId') userId: string,
    @Body() dto: ForceResetPasswordDto,
    @CurrentUser() user: AuthenticatedUserDto,
  ): Promise<ForceResetPasswordResponseDto> {
    return this.accountLifecycleService.forceResetPassword(userId, dto, user);
  }
}
