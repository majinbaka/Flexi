import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Body for POST /api/admin/users/:userId/force-reset-password.
 *
 * `sendEmail` defaults to true. With it false the account's password is
 * still scrambled and `mustChangePassword` still raised -- the point of the
 * operation is to invalidate the credential the holder currently has -- but
 * nothing is mailed, so they recover through the ordinary
 * forgot-password flow rather than with a temporary password.
 */
export class ForceResetPasswordDto {
  @IsOptional()
  @IsBoolean()
  sendEmail?: boolean;
}
