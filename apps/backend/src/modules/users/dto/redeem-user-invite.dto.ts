import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Public payload for claiming an invited account.
 *
 * Only shape is asserted here; the password policy and the
 * password/confirmation match are checked in the service, so the public
 * endpoint answers with the platform's own `PASSWORD_POLICY_VIOLATION`
 * contract rather than a class-validator message list.
 */
export class RedeemUserInviteDto {
  @IsString()
  @IsNotEmpty()
  token!: string;

  @IsString()
  @IsNotEmpty()
  fullName!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;

  @IsString()
  @IsNotEmpty()
  confirmPassword!: string;
}
