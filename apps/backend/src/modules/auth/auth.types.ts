import { ActorType } from '@flexi/shared-types';

/**
 * Shape of the decoded JWT access token payload. `sub` (authAccountId) and
 * `actorType` are always present; `tenantId`/`tenantUserId` are present only
 * for a tenant token, `systemUserId` only for a system token. Both actor
 * types carry the flattened permission codes granted through the actor's
 * role(s) at issuance time (see Design Notes: permissions are embedded to
 * avoid a DB round trip on every guarded request).
 *
 * `impersonatedBy` is deliberately reserved (never set) so impersonation
 * support can be added later without a payload shape change -- see
 * apps/frontend/src/docs/specifications/authentication.mdx.
 */
export interface AccessTokenPayload {
  sub: string;
  actorType: ActorType;
  tenantId?: string;
  tenantUserId?: string;
  systemUserId?: string;
  email: string;
  name: string | null;
  roles: string[];
  permissions: string[];
  /**
   * `RefreshToken.id` of the session this access token was issued
   * alongside. Optional so a token minted before session management landed
   * stays decodable for the rest of its (<= 15 minute) life; the session
   * routes treat its absence as "no current session to protect".
   */
  sessionId?: string;
  /**
   * Mirrors `AuthAccount.mustChangePassword` as it stood when the token was
   * issued. Advisory only -- it tells the frontend to route the holder into
   * the change-password flow; the authoritative value is re-read from the
   * database by `changePassword` itself.
   */
  mustChangePassword?: boolean;
  impersonatedBy?: string;
}

/**
 * Payload signed into a rotating refresh token. `jti` is never read back
 * (lookup is always by tokenHash) -- its purpose is entropy: without it,
 * two tokens issued for the same account in the same second would sign to
 * the identical JWT string (same payload + secret + `iat` truncated to
 * seconds), which would collide against `RefreshToken.tokenHash`'s unique
 * constraint.
 */
export interface RefreshTokenPayload {
  sub: string;
  jti: string;
}
