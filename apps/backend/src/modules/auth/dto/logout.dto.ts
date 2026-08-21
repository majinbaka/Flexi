import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body for POST /api/auth/logout. Requires a valid access token (via
 * JwtAuthGuard) PLUS the refresh token to revoke, which must be owned by
 * the authenticated caller's AuthAccount.
 */
export class LogoutDto {
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}
