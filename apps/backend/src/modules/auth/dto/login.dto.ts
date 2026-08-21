import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

/**
 * Body for POST /api/auth/login. Whether this resolves to a tenant login or
 * a system login is NOT part of the body -- it's signaled by the presence
 * (tenant) or absence (system) of the `x-tenant-id` header, read separately
 * via TenantIdHeader. See spec-core-authentication.md Boundaries.
 */
export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}
