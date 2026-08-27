import { Module } from '@nestjs/common';
import { MailModule } from '../../mail/mail.module';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AccountLifecycleService } from './account-lifecycle.service';
import { AdminUsersController } from './admin-users.controller';
import { SelfRegistrationController } from './self-registration.controller';
import { SelfRegistrationService } from './self-registration.service';
import { TenantSettingsController } from './tenant-settings.controller';
import { TenantSettingsService } from './tenant-settings.service';
import { TenantUserDirectoryService } from './tenant-user-directory.service';
import { UserInvitesController } from './user-invites.controller';
import { UserInviteService } from './user-invite.service';
import { UserQuotaService } from './user-quota.service';
import { UsersAdminService } from './users-admin.service';
import { UsersController } from './users.controller';
import { UserDeletionService } from './user-deletion.service';

/**
 * Account activation, deactivation, admin-forced password resets, the
 * invite lifecycle, the tenant's self-registration policy and public
 * sign-up itself, plus the rules every user-creation path shares.
 *
 * `UserQuotaService` and `TenantUserDirectoryService` carry no routes of
 * their own -- they are shared by every path that can create a seat, so
 * seat accounting and per-tenant email uniqueness exist once rather than
 * once per entry point. `UserInviteService` and `SelfRegistrationService`
 * are their consumers today; direct-create follows.
 *
 * `SelfRegistrationController` is declared here rather than in
 * `AuthModule` even though it serves `POST /api/auth/register`: sign-up
 * needs this module's quota, directory and settings services, and hosting
 * it in `AuthModule` would turn the one-way `UsersModule -> AuthModule`
 * dependency into a cycle. See the note on the controller itself.
 *
 * `AuthModule` is imported for `JwtAuthGuard` and `PermissionsGuard`
 * (re-declared as local providers so `@UseGuards(...)` resolves them in
 * this module's own DI scope, with `JwtModule` coming along through
 * AuthModule's exports) and for `AuthAuditService`. `MailModule` supplies
 * the transport for the temporary-password, invitation, welcome and
 * pending-approval messages.
 */
@Module({
  imports: [AuthModule, MailModule],
  // Order matters, and only here: Nest maps routes in the order
  // controllers are declared, and Express answers with the first match. So
  // `UserInvitesController` (`users/invites`) must be registered before
  // `UsersController`, whose `GET users/:userId` would otherwise swallow
  // `GET users/invites` and answer it with `404 USER_NOT_FOUND` for a user
  // called "invites". The e2e suite pins this by asking for both.
  controllers: [
    UserInvitesController,
    UsersController,
    AdminUsersController,
    TenantSettingsController,
    SelfRegistrationController,
  ],
  providers: [
    AccountLifecycleService,
    UsersAdminService,
    UserDeletionService,
    TenantUserDirectoryService,
    UserQuotaService,
    UserInviteService,
    TenantSettingsService,
    SelfRegistrationService,
    JwtAuthGuard,
    PermissionsGuard,
  ],
  exports: [
    TenantUserDirectoryService,
    UserQuotaService,
    TenantSettingsService,
  ],
})
export class UsersModule {}
