import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * Body for `POST /api/users/direct-create`.
 *
 * No password field, on purpose: the server generates a temporary one,
 * mails it and raises `mustChangePassword`, the same contract an admin
 * force-reset already uses. An administrator creating an account for
 * somebody else therefore never chooses -- or gets to read -- that
 * person's credential.
 *
 * `roleId` is optional, matching invites: a tenant that grants roles in a
 * second step can create the seat first.
 */
export class DirectCreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @IsNotEmpty()
  fullName!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  roleId?: string;
}
