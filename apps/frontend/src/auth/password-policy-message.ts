import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  validatePasswordStrength,
  type PasswordPolicyViolation,
} from '@flexi/shared-types';

const VIOLATION_KEYS: Record<PasswordPolicyViolation, string> = {
  TOO_SHORT: 'password.policy.tooShort',
  TOO_LONG: 'password.policy.tooLong',
  MISSING_LOWERCASE: 'password.policy.missingLowercase',
  MISSING_UPPERCASE: 'password.policy.missingUppercase',
  MISSING_DIGIT: 'password.policy.missingDigit',
  MISSING_SPECIAL: 'password.policy.missingSpecial',
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * Turns policy violations into translated messages.
 *
 * The codes come either from `validatePasswordStrength` running locally or
 * from the backend's `PASSWORD_POLICY_VIOLATION` response, which carries
 * the identical list -- both sides share one definition of a strong
 * password, so the same renderer serves both and a message never has to be
 * matched against server-authored text.
 */
export function describePasswordViolations(
  violations: readonly string[],
  t: Translate,
): string[] {
  return violations
    .filter(
      (violation): violation is PasswordPolicyViolation =>
        violation in VIOLATION_KEYS,
    )
    .map((violation) =>
      t(VIOLATION_KEYS[violation], {
        min: PASSWORD_MIN_LENGTH,
        max: PASSWORD_MAX_LENGTH,
      }),
    );
}

/**
 * Every rule a password still breaks, translated. An empty array means it
 * is acceptable -- checked client-side so the form can show all remaining
 * requirements at once instead of making the user discover them one submit
 * at a time.
 */
export function describeLocalPasswordViolations(
  password: string,
  t: Translate,
): string[] {
  return describePasswordViolations(validatePasswordStrength(password), t);
}

/**
 * The backend reports policy failures as an array of violation codes, but
 * `ApiError` flattens whatever the envelope carried into a single message
 * string. Splitting it back out keeps the frontend branching on codes
 * rather than on prose.
 */
export function parsePasswordViolations(message: string): string[] {
  return message
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}
