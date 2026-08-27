import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  AuthenticatedUserDto,
  CreatedUserInviteDto,
  InviteUsersResponseDto,
  RedeemUserInviteResponseDto,
  TENANT_USER_INVITE_PERMISSION,
  TENANT_USER_READ_PERMISSION,
  UserInviteDto,
} from '@flexi/shared-types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { CreateUserInvitesDto } from './dto/create-user-invites.dto';
import { RedeemUserInviteDto } from './dto/redeem-user-invite.dto';
import { UserInviteService } from './user-invite.service';

/**
 * The invite lifecycle.
 *
 * Every route but `redeem` is tenant-scoped and behind a permission --
 * `tenant.user.invite` to change an invite, `tenant.user.read` merely to
 * look at the list. Unlike the account-lifecycle routes, the required
 * permission is static: inviting is a tenant-only flow (`tenant.user.invite`
 * has no SYSTEM counterpart), so the guard can assert it rather than the
 * service.
 *
 * `redeem` carries no guard at all: its caller holds an emailed token and
 * has, by construction, no session yet.
 */
@Controller('users/invites')
export class UserInvitesController {
  constructor(private readonly userInviteService: UserInviteService) {}

  /**
   * Invites a batch of addresses. All or nothing: if the tenant cannot
   * seat every address, or any of them is already a member, nothing at all
   * is created.
   *
   * The response is the only place the raw tokens are ever readable -- they
   * are stored as SHA-256 hashes, so no later call can recover them.
   */
  @Post()
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(TENANT_USER_INVITE_PERMISSION)
  createInvites(
    @Body() dto: CreateUserInvitesDto,
    @CurrentUser() user: AuthenticatedUserDto,
  ): Promise<InviteUsersResponseDto> {
    return this.userInviteService.createInvites(dto, user);
  }

  @Get()
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(TENANT_USER_READ_PERMISSION)
  listInvites(
    @CurrentUser() user: AuthenticatedUserDto,
  ): Promise<UserInviteDto[]> {
    return this.userInviteService.listInvites(user);
  }

  /**
   * Public. Declared before `:inviteId/...` for readability only -- the
   * two cannot collide, since this path has one segment and those have
   * two.
   */
  @Post('redeem')
  @HttpCode(HttpStatus.OK)
  redeemInvite(
    @Body() dto: RedeemUserInviteDto,
  ): Promise<RedeemUserInviteResponseDto> {
    return this.userInviteService.redeemInvite(dto);
  }

  /** Retires the invite and issues a fresh token to the same address. */
  @Post(':inviteId/resend')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(TENANT_USER_INVITE_PERMISSION)
  resendInvite(
    @Param('inviteId') inviteId: string,
    @CurrentUser() user: AuthenticatedUserDto,
  ): Promise<CreatedUserInviteDto> {
    return this.userInviteService.resendInvite(inviteId, user);
  }

  /** Withdraws the invite and frees the seat it was holding. */
  @Post(':inviteId/revoke')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(TENANT_USER_INVITE_PERMISSION)
  revokeInvite(
    @Param('inviteId') inviteId: string,
    @CurrentUser() user: AuthenticatedUserDto,
  ): Promise<UserInviteDto> {
    return this.userInviteService.revokeInvite(inviteId, user);
  }
}
