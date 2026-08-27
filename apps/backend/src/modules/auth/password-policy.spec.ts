import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_SPECIAL_CHARACTERS,
  validatePasswordStrength,
} from '@flexi/shared-types';

/**
 * `validatePasswordStrength` lives in `packages/shared-types` so the backend
 * DTO validators and the frontend forms enforce one definition of a strong
 * password. It is exercised here, next to the module that enforces it on the
 * server, because the shared package has no test runner of its own.
 */
describe('validatePasswordStrength', () => {
  const strong = 'Str0ng!Passphrase';

  it('accepts a password meeting every rule', () => {
    expect(validatePasswordStrength(strong)).toEqual([]);
  });

  it('accepts every documented special character', () => {
    for (const special of PASSWORD_SPECIAL_CHARACTERS) {
      const password = `Abcdefgh1jklm${special}`;

      expect(validatePasswordStrength(password)).toEqual([]);
    }
  });

  it('reports a password shorter than the minimum length', () => {
    const password = 'Ab1!' + 'x'.repeat(PASSWORD_MIN_LENGTH - 5);

    expect(password).toHaveLength(PASSWORD_MIN_LENGTH - 1);
    expect(validatePasswordStrength(password)).toEqual(['TOO_SHORT']);
  });

  it('accepts a password of exactly the minimum length', () => {
    const password = 'Ab1!' + 'x'.repeat(PASSWORD_MIN_LENGTH - 4);

    expect(password).toHaveLength(PASSWORD_MIN_LENGTH);
    expect(validatePasswordStrength(password)).toEqual([]);
  });

  it('reports a password longer than the maximum length', () => {
    const password = 'Ab1!' + 'x'.repeat(PASSWORD_MAX_LENGTH - 3);

    expect(password).toHaveLength(PASSWORD_MAX_LENGTH + 1);
    expect(validatePasswordStrength(password)).toEqual(['TOO_LONG']);
  });

  it.each([
    ['MISSING_LOWERCASE', 'STR0NG!PASSPHRASE'],
    ['MISSING_UPPERCASE', 'str0ng!passphrase'],
    ['MISSING_DIGIT', 'Strong!Passphrase'],
    ['MISSING_SPECIAL', 'Str0ngPassphrase1'],
  ])('reports %s', (violation, password) => {
    expect(validatePasswordStrength(password)).toEqual([violation]);
  });

  /**
   * Every broken rule is returned at once, in a stable order, so a form can
   * show all outstanding requirements instead of revealing them one submit
   * at a time.
   */
  it('reports every violated rule together, in a stable order', () => {
    expect(validatePasswordStrength('short')).toEqual([
      'TOO_SHORT',
      'MISSING_UPPERCASE',
      'MISSING_DIGIT',
      'MISSING_SPECIAL',
    ]);
  });

  it('treats an empty password as breaking every rule but TOO_LONG', () => {
    expect(validatePasswordStrength('')).toEqual([
      'TOO_SHORT',
      'MISSING_LOWERCASE',
      'MISSING_UPPERCASE',
      'MISSING_DIGIT',
      'MISSING_SPECIAL',
    ]);
  });
});
