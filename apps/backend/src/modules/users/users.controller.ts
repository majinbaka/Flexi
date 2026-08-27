import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  AccountLifecycleResponseDto,
  AuthenticatedUserDto,
  DirectCreateUserResponseDto,
  UserDetailDto,
  UserListQueryDto,
  UserListResponseDto,
  UserStatusChangeResponseDto,
  UserDeletionResponseDto,
} from '@flexi/shared-types';
import { parseQueryNumber } from '../../common/query-number';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AccountLifecycleService } from './account-lifecycle.service';
import { DirectCreateUserDto } from './dto/direct-create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { DeleteUserDto } from './dto/delete-user.dto';
import { UserDeletionService } from './user-deletion.service';
import { UsersAdminService } from './users-admin.service';

/**
 * User administration and the account lifecycle.
 *
 * Not one of these routes carries a `@RequirePermissions()`: every
 * operation here has a TENANT/SYSTEM *pair* of permission codes and only
 * the request knows which one applies, so the check happens in the service
 * -- the same reason `GET /api/auth/me` resolves its own. See
 * `assertActorPermission`.
 *
 * The scope of a route is a filter, not a check: a tenant caller addresses
 * `TenantUser`s of their own tenant and a system caller `SystemUser`s. A
 * `:userId` outside the caller's scope answers `404 USER_NOT_FOUND`, never
 * `403` -- a `403` would confirm that the id belongs to somebody
 * somewhere.
 *
 * `direct-create`, `approve`, `lock` and `unlock` are tenant-only, and a
 * system caller is refused `403`. That is not an omission: `status` is a
 * `TenantUser` column, so a SystemUser has nothing to approve, lock or
 * unlock (`deactivate` below is what takes a SystemUser's access away),
 * and creating a platform-level SystemUser is not a flow the Users
 * specification describes -- the same reasoning that leaves
 * `tenant.user.invite` without a SYSTEM counterpart.
 */
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersAdminService: UsersAdminService,
    private readonly accountLifecycleService: AccountLifecycleService,
    private readonly userDeletionService: UserDeletionService,
  ) {}

  /** Paginated, filterable listing of the caller's own scope. */
  @Get()
  @UseGuards(JwtAuthGuard)
  listUsers(
    @Query() query: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUserDto,
  ): Promise<UserListResponseDto> {
    return this.usersAdminService.listUsers(this.toUserListQuery(query), user);
  }

  /**
   * Seats a user directly, without an invitation to redeem. Tenant-only.
   *
   * Declared before `GET :userId` for readability only -- the two cannot
   * collide, since they differ in method as well as in path.
   */
  @Post('direct-create')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard)
  directCreate(
    @Body() dto: DirectCreateUserDto,
    @CurrentUser() user: AuthenticatedUserDto,
  ): Promise<DirectCreateUserResponseDto> {
    return this.usersAdminService.directCreate(dto, user);
  }

  @Get(':userId')
  @UseGuards(JwtAuthGuard)
  getUser(
    @Param('userId') userId: string,
    @CurrentUser() user: AuthenticatedUserDto,
  ): Promise<UserDetailDto> {
    return this.usersAdminService.getUser(userId, user);
  }

  /** Full name and role. Nobody may change their own role. */
  @Patch(':userId')
  @UseGuards(JwtAuthGuard)
  updateUser(
    @Param('userId') userId: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() user: AuthenticatedUserDto,
  ): Promise<UserDetailDto> {
    return this.usersAdminService.updateUser(userId, dto, user);
  }

  /** `pending_approval` -> `active`, and nothing else. Tenant-only. */
  @Patch(':userId/approve')
  @UseGuards(JwtAuthGuard)
  approveUser(
    @Param('userId') userId: string,
    @CurrentUser() user: AuthenticatedUserDto,
  ): Promise<UserStatusChangeResponseDto> {
    return this.usersAdminService.approveUser(userId, user);
  }

  /**
   * Suspends an active member: `locked`, `isActive` cleared in the same
   * write and every live session revoked in the same transaction. The seat
   * stays taken -- a suspension is not a departure. Tenant-only.
   */
  @Patch(':userId/lock')
  @UseGuards(JwtAuthGuard)
  lockUser(
    @Param('userId') userId: string,
    @CurrentUser() user: AuthenticatedUserDto,
  ): Promise<UserStatusChangeResponseDto> {
    return this.usersAdminService.lockUser(userId, user);
  }

  /** `locked` -> `active`, restoring `isActive` in the same write. */
  @Patch(':userId/unlock')
  @UseGuards(JwtAuthGuard)
  unlockUser(
    @Param('userId') userId: string,
    @CurrentUser() user: AuthenticatedUserDto,
  ): Promise<UserStatusChangeResponseDto> {
    return this.usersAdminService.unlockUser(userId, user);
  }

  /**
   * A normal delete preserves the membership as `deleted`; `mode=hard`
   * removes it only after protected dynamic rows have been transferred.
   */
  @Delete(':userId')
  @UseGuards(JwtAuthGuard)
  deleteUser(
    @Param('userId') userId: string,
    @Query() query: DeleteUserDto,
    @CurrentUser() user: AuthenticatedUserDto,
  ): Promise<UserDeletionResponseDto> {
    return this.userDeletionService.deleteUser(
      userId,
      query.mode ?? 'soft',
      query.transferToUserId,
      user,
    );
  }

  /**
   * Deactivates an account and revokes every live session it holds. Access
   * tokens already issued keep working for their remaining lifetime, at
   * most fifteen minutes; the next refresh or login then fails.
   *
   * Distinct from `lock`: this one moves `isActive` alone and works in
   * either scope, where `lock` also moves a `TenantUser`'s `status`.
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

  /**
   * Express query values are strings (or arrays of them).
   * `parseQueryNumber()` leaves an unusable number as `NaN` so the service
   * reports a validation error rather than silently substituting a
   * pagination default -- the same parser the Dynamic Tables listings use,
   * so a blank `?page=` means one thing across the whole API. The filters
   * stay raw here and are validated in the service, next to the caller
   * whose scope decides whether they apply at all.
   */
  private toUserListQuery(query: Record<string, unknown>): UserListQueryDto {
    return {
      status: this.firstString(query.status) as
        UserListQueryDto['status'] | undefined,
      roleId: this.firstString(query.roleId),
      keyword: this.firstString(query.keyword),
      page: parseQueryNumber(query.page),
      pageSize: parseQueryNumber(query.pageSize),
    };
  }

  /**
   * Repeated query params collapse to the first value, as elsewhere, and a
   * blank one means "no filter" rather than "match the empty string" -- so
   * a UI that always sends `?status=` gets the unfiltered listing instead
   * of a validation error.
   */
  private firstString(value: unknown): string | undefined {
    const scalar = Array.isArray(value) ? value[0] : value;

    return typeof scalar === 'string' && scalar.trim()
      ? scalar.trim()
      : undefined;
  }
}
