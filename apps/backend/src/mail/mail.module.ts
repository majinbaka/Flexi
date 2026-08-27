import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EmailDeliveryService } from './email-delivery.service';

/**
 * Owns the single SMTP transporter for the process.
 *
 * `EmailDeliveryService` started inside `TenantsModule`, which was fine
 * while provisioning was its only caller. Auth needs it too (password-reset
 * codes and, later, temporary passwords), and `TenantsModule` already
 * imports `AuthModule` for the shared guards -- so having `AuthModule`
 * import `TenantsModule` back would be a circular dependency. Hoisting the
 * transport into its own module that depends on nothing but `ConfigModule`
 * lets both sides import it without one owning the other.
 */
@Module({
  imports: [ConfigModule],
  providers: [EmailDeliveryService],
  exports: [EmailDeliveryService],
})
export class MailModule {}
