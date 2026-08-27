import { USER_ERROR_CODES, type UserErrorCode } from '@flexi/shared-types';
import { ApiError } from './api-client';

/**
 * Renders a Users-area failure from its error *code*.
 *
 * The server's `message` is never shown and never matched against: it is
 * English, written for an operator, and free to change without notice.
 * `USER_ERROR_CODES` is the contract both sides share, so every branch a
 * screen takes -- and every string a user reads -- keys off the code alone.
 *
 * A code with no entry here falls back to the generic message rather than
 * leaking the server's text, which is also what happens for the transport
 * failures `api-client` reports (`NETWORK_ERROR`) and for anything a future
 * backend adds before this map catches up.
 */

const USER_ERROR_KEYS: Record<UserErrorCode, string> = {
  [USER_ERROR_CODES.QUOTA_EXCEEDED]: 'users.errors.quotaExceeded',
  [USER_ERROR_CODES.DOMAIN_NOT_ALLOWED]: 'users.errors.domainNotAllowed',
  [USER_ERROR_CODES.SELF_REG_DISABLED]: 'users.errors.selfRegDisabled',
  [USER_ERROR_CODES.EMAIL_ALREADY_EXISTS]: 'users.errors.emailAlreadyExists',
  [USER_ERROR_CODES.INVITE_TOKEN_EXPIRED]: 'users.errors.inviteTokenExpired',
  [USER_ERROR_CODES.INVITE_NOT_FOUND]: 'users.errors.inviteNotFound',
  [USER_ERROR_CODES.INVITE_NOT_PENDING]: 'users.errors.inviteNotPending',
  [USER_ERROR_CODES.CANNOT_DELETE_SELF]: 'users.errors.cannotDeleteSelf',
  [USER_ERROR_CODES.INVALID_TARGET_USER]: 'users.errors.invalidTargetUser',
  [USER_ERROR_CODES.INVALID_STATUS_TRANSITION]:
    'users.errors.invalidStatusTransition',
  [USER_ERROR_CODES.CANNOT_CHANGE_OWN_ROLE]: 'users.errors.cannotChangeOwnRole',
  [USER_ERROR_CODES.CANNOT_LOCK_SELF]: 'users.errors.cannotLockSelf',
};

/**
 * Codes raised outside `USER_ERROR_CODES` that a Users screen can still
 * meet: the envelope's own validation failure, the permission refusal the
 * service raises when the caller's role lacks the required code, and the
 * not-found answer a stale id gets.
 */
const SHARED_ERROR_KEYS: Record<string, string> = {
  VALIDATION_ERROR: 'users.errors.validation',
  FORBIDDEN: 'users.errors.forbidden',
  USER_NOT_FOUND: 'users.errors.userNotFound',
  NETWORK_ERROR: 'users.errors.network',
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The i18n key for an error code, or `null` when none is mapped. */
export function userErrorMessageKey(code: string): string | null {
  return (
    USER_ERROR_KEYS[code as UserErrorCode] ?? SHARED_ERROR_KEYS[code] ?? null
  );
}

/**
 * Translated message for anything thrown by `users-api`. A non-`ApiError`
 * rejection has no code to read, so it is reported as the generic failure
 * rather than by stringifying whatever was thrown.
 */
export function describeUserError(error: unknown, t: Translate): string {
  const code = error instanceof ApiError ? error.code : null;
  const key = code === null ? null : userErrorMessageKey(code);

  return t(key ?? 'users.errors.unexpected');
}

/** The error code, when the failure carries one. Used to branch on state. */
export function userErrorCode(error: unknown): string | null {
  return error instanceof ApiError ? error.code : null;
}
