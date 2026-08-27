import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

/**
 * Public payload for `POST /api/auth/register`. Which tenant is being
 * registered into is not part of the body -- it is the `x-tenant-id`
 * header, exactly as it is for login.
 *
 * As with invite redemption, only the shape is asserted here: the password
 * policy and the password/confirmation match are checked in the service,
 * so the endpoint answers with the platform's own
 * `PASSWORD_POLICY_VIOLATION` contract rather than a class-validator
 * message list.
 */
export class SelfRegisterDto {
  @IsEmail()
  email!: string;

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
