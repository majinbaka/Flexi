import { Module } from '@nestjs/common';
import { MailModule } from '../../mail/mail.module';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AccountLifecycleService } from './account-lifecycle.service';
import { AdminUsersController } from './admin-users.controller';
import { TenantUserDirectoryService } from './tenant-user-directory.service';
import { UserInvitesController } from './user-invites.controller';
import { UserInviteService } from './user-invite.service';
import { UserQuotaService } from './user-quota.service';
import { UsersController } from './users.controller';

/**
 * Account activation, deactivation, admin-forced password resets and the
 * invite lifecycle, plus the rules every user-creation path shares.
 *
 * `UserQuotaService` and `TenantUserDirectoryService` carry no routes of
 * their own -- they are shared by every path that can create a seat, so
 * seat accounting and per-tenant email uniqueness exist once rather than
 * once per entry point. `UserInviteService` is the first consumer;
 * self-registration and direct-create follow.
 *
 * `AuthModule` is imported for `JwtAuthGuard` and `PermissionsGuard`
 * (re-declared as local providers so `@UseGuards(...)` resolves them in
 * this module's own DI scope, with `JwtModule` coming along through
 * AuthModule's exports) and for `AuthAuditService`. `MailModule` supplies
 * the transport for the temporary-password and invitation messages.
 */
@Module({
  imports: [AuthModule, MailModule],
  controllers: [UsersController, AdminUsersController, UserInvitesController],
  providers: [
    AccountLifecycleService,
    TenantUserDirectoryService,
    UserQuotaService,
    UserInviteService,
    JwtAuthGuard,
    PermissionsGuard,
  ],
  exports: [TenantUserDirectoryService, UserQuotaService],
})
export class UsersModule {}
