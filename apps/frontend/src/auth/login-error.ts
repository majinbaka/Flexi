import { ApiError, RATE_LIMITED_ERROR_CODE } from '../lib/api-client';

/**
 * Shared error-to-message mapping for LoginPage/AdminLoginPage's submit
 * handlers -- both forms hit the same login() call and need identical
 * handling of the rate-limited case (a translated, stable message instead
 * of the raw backend text) and the generic ApiError/unknown-error split.
 */
export function getLoginErrorMessage(
  err: unknown,
  t: (key: string) => string,
): string {
  if (err instanceof ApiError && err.code === RATE_LIMITED_ERROR_CODE) {
    return t('auth.tooManyRequests');
  }
  return err instanceof ApiError ? err.message : t('auth.unknownError');
}
