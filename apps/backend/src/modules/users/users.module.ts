import { Module } from '@nestjs/common';
import { MailModule } from '../../mail/mail.module';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AccountLifecycleService } from './account-lifecycle.service';
import { AdminUsersController } from './admin-users.controller';
import { TenantUserDirectoryService } from './tenant-user-directory.service';
import { UserQuotaService } from './user-quota.service';
import { UsersController } from './users.controller';

/**
 * Account activation, deactivation and admin-forced password resets, plus
 * the rules every user-creation path shares.
 *
 * `UserQuotaService` and `TenantUserDirectoryService` carry no routes of
 * their own yet -- they are exported for the invite, self-registration and
 * direct-create stories, so seat accounting and per-tenant email
 * uniqueness exist once rather than once per entry point.
 *
 * `AuthModule` is imported for `JwtAuthGuard` (re-declared as a local
 * provider so `@UseGuards(JwtAuthGuard)` resolves it in this module's own
 * DI scope, with `JwtModule` coming along through AuthModule's exports) and
 * for `AuthAuditService`. `MailModule` supplies the transport for the
 * temporary-password message.
 */
@Module({
  imports: [AuthModule, MailModule],
  controllers: [UsersController, AdminUsersController],
  providers: [
    AccountLifecycleService,
    TenantUserDirectoryService,
    UserQuotaService,
    JwtAuthGuard,
  ],
  exports: [TenantUserDirectoryService, UserQuotaService],
})
export class UsersModule {}
