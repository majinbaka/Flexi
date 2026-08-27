import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body for POST /api/auth/change-password. Both fields are only
 * shape-checked here; the strength policy on `newPassword` is enforced in
 * the service, which reports `PASSWORD_POLICY_VIOLATION` with the full list
 * of unmet rules.
 */
export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  currentPassword!: string;

  @IsString()
  @IsNotEmpty()
  newPassword!: string;
}
