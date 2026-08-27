import { Module } from '@nestjs/common';
import { MailModule } from '../../mail/mail.module';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AccountLifecycleService } from './account-lifecycle.service';
import { AdminUsersController } from './admin-users.controller';
import { UsersController } from './users.controller';

/**
 * Account activation, deactivation and admin-forced password resets.
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
  providers: [AccountLifecycleService, JwtAuthGuard],
})
export class UsersModule {}
