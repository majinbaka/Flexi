import { describe, expect, it } from 'vitest';
import { USER_ERROR_CODES } from '@flexi/shared-types';
import { ApiError } from './api-client';
import {
  describeUserError,
  userErrorCode,
  userErrorMessageKey,
} from './user-error-message';

/** Stands in for i18next: returns the key, so a test asserts on mapping. */
const echoKey = (key: string) => key;

describe('userErrorMessageKey', () => {
  it('maps every code in USER_ERROR_CODES to a key', () => {
    const unmapped = Object.values(USER_ERROR_CODES).filter(
      (code) => userErrorMessageKey(code) === null,
    );

    expect(unmapped).toEqual([]);
  });

  it('maps the shared envelope codes a Users screen can also meet', () => {
    expect(userErrorMessageKey('VALIDATION_ERROR')).toBe(
      'users.errors.validation',
    );
    expect(userErrorMessageKey('FORBIDDEN')).toBe('users.errors.forbidden');
    expect(userErrorMessageKey('USER_NOT_FOUND')).toBe(
      'users.errors.userNotFound',
    );
    expect(userErrorMessageKey('NETWORK_ERROR')).toBe('users.errors.network');
  });

  it('returns null for a code it does not know', () => {
    expect(userErrorMessageKey('SOME_FUTURE_CODE')).toBeNull();
  });
});

describe('describeUserError', () => {
  it('renders a known code through its own key', () => {
    const error = new ApiError('QUOTA_EXCEEDED', 'tenant is at 25/25 seats');

    expect(describeUserError(error, echoKey)).toBe(
      'users.errors.quotaExceeded',
    );
  });

  it('never falls back to the server message for an unknown code', () => {
    const error = new ApiError('SOME_FUTURE_CODE', 'raw backend prose');

    expect(describeUserError(error, echoKey)).toBe('users.errors.unexpected');
  });

  it('reports a non-ApiError rejection generically', () => {
    expect(describeUserError(new Error('boom'), echoKey)).toBe(
      'users.errors.unexpected',
    );
    expect(describeUserError('boom', echoKey)).toBe('users.errors.unexpected');
  });
});

describe('userErrorCode', () => {
  it('reads the code off an ApiError and nothing else', () => {
    expect(userErrorCode(new ApiError('CANNOT_LOCK_SELF', 'no'))).toBe(
      'CANNOT_LOCK_SELF',
    );
    expect(userErrorCode(new Error('boom'))).toBeNull();
    expect(userErrorCode(undefined)).toBeNull();
  });
});
