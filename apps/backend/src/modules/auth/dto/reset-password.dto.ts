import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

/**
 * Body for POST /api/auth/reset-password.
 *
 * `otp` is validated only as a non-empty string here; its length and
 * digits-only shape are checked by the service alongside the code itself,
 * so a malformed code produces the same opaque `INVALID_OTP` as a wrong one
 * rather than a distinguishable validation error.
 *
 * `newPassword` is likewise only shape-checked here -- the strength policy
 * is enforced in the service, which reports `PASSWORD_POLICY_VIOLATION`
 * with the full list of unmet rules so a form can show them all at once.
 */
export class ResetPasswordDto {
  @IsEmail()
  email!: string;

  @IsString()
  @IsNotEmpty()
  otp!: string;

  @IsString()
  @IsNotEmpty()
  newPassword!: string;
}
