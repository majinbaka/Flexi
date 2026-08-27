import { randomInt } from 'crypto';
import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_SPECIAL_CHARACTERS,
  validatePasswordStrength,
} from '@flexi/shared-types';

/**
 * Length of a generated temporary password. Well above
 * `PASSWORD_MIN_LENGTH`, because this one is never chosen by a human and
 * has to survive being mailed: the only thing making it safe is that
 * guessing it is hopeless.
 */
export const TEMPORARY_PASSWORD_LENGTH = 20;

const TEMPORARY_PASSWORD_ALPHABET =
  'abcdefghijklmnopqrstuvwxyz' +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
  '0123456789' +
  PASSWORD_SPECIAL_CHARACTERS;

/**
 * A password the platform generates for somebody else: an admin-forced
 * reset, or the initial credential of a directly created account. It is
 * always paired with `mustChangePassword`, leaves the server only through
 * the mail transport, and is never logged, persisted in the clear or put
 * in a response.
 *
 * Draws uniformly from the full alphabet with `randomInt`, which Node
 * rejection-samples, then re-draws if the result happens to miss a
 * required character class. At twenty characters a miss is vanishingly
 * unlikely, so the loop is a correctness guarantee rather than a hot path
 * -- the password must satisfy the same policy the holder will be held to
 * when they replace it.
 */
export function generateTemporaryPassword(): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let password = '';
    for (let index = 0; index < TEMPORARY_PASSWORD_LENGTH; index += 1) {
      password += TEMPORARY_PASSWORD_ALPHABET.charAt(
        randomInt(0, TEMPORARY_PASSWORD_ALPHABET.length),
      );
    }

    if (validatePasswordStrength(password).length === 0) {
      return password;
    }
  }

  // Unreachable for any sane alphabet and length; throwing beats returning
  // a password that does not meet the policy the account will be validated
  // against.
  throw new Error(
    `Could not generate a temporary password of ${TEMPORARY_PASSWORD_LENGTH} characters meeting the ${PASSWORD_MIN_LENGTH}-character policy.`,
  );
}
