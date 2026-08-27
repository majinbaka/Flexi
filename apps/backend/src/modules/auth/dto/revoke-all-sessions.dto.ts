import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Body for POST /api/auth/sessions/revoke-all. `keepCurrent` spares the
 * refresh token of the session making the request, so a holder can sign
 * every other device out without signing themselves out too.
 */
export class RevokeAllSessionsDto {
  @IsOptional()
  @IsBoolean()
  keepCurrent?: boolean;
}
