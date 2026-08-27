import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import {
  THROTTLER_LIMIT,
  THROTTLER_TTL,
} from '@nestjs/throttler/dist/throttler.constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

/**
 * Covers spec-auth-rate-limiting.md's route-scoping edge case: `@UseGuards
 * (ThrottlerGuard)` must be applied to `login`/`refresh` only, leaving
 * `logout`/`me` on their existing `JwtAuthGuard` and untouched by
 * throttling. Asserted via the same `__guards__` reflect-metadata Nest
 * itself reads when building the enhancers chain.
 *
 * NOTE (per spec's Spec Change Log, loop 1): this metadata check proves the
 * decorator is present, NOT that throttling actually fires -- a miswired
 * or no-op guard (e.g. options resolving to Infinity) would still pass
 * every assertion here. The real 429-firing behavior is proven end-to-end
 * in apps/backend/test/app.e2e-spec.ts, which is the required coverage;
 * this file is retained as narrow, correctly-scoped route-assignment
 * coverage only, not a substitute for it.
 */
describe('AuthController guard metadata', () => {
  function guardsFor(methodName: keyof AuthController): unknown[] {
    return (
      Reflect.getMetadata(
        GUARDS_METADATA,
        AuthController.prototype[methodName],
      ) ?? []
    );
  }

  it('applies ThrottlerGuard to login', () => {
    expect(guardsFor('login')).toContain(ThrottlerGuard);
  });

  it('applies ThrottlerGuard to refresh', () => {
    expect(guardsFor('refresh')).toContain(ThrottlerGuard);
  });

  it('does not apply ThrottlerGuard to logout', () => {
    expect(guardsFor('logout')).not.toContain(ThrottlerGuard);
  });

  it('does not apply ThrottlerGuard to me', () => {
    expect(guardsFor('me')).not.toContain(ThrottlerGuard);
  });

  it('keeps JwtAuthGuard on logout', () => {
    expect(guardsFor('logout')).toContain(JwtAuthGuard);
  });

  it('keeps JwtAuthGuard on me', () => {
    expect(guardsFor('me')).toContain(JwtAuthGuard);
  });

  /**
   * The two password-recovery routes are the only endpoints an attacker can
   * drive with no credential at all -- one sends mail to an address they
   * choose, the other guesses a six-digit code -- so they carry their own,
   * much stricter budget instead of the module-wide login/refresh default.
   */
  it.each(['forgotPassword', 'resetPassword'] as const)(
    'applies ThrottlerGuard to %s',
    (method) => {
      expect(guardsFor(method)).toContain(ThrottlerGuard);
    },
  );

  it('leaves the password-recovery routes unauthenticated', () => {
    expect(guardsFor('forgotPassword')).not.toContain(JwtAuthGuard);
    expect(guardsFor('resetPassword')).not.toContain(JwtAuthGuard);
  });

  it.each([
    ['forgotPassword', 3],
    ['resetPassword', 5],
  ] as const)('overrides the throttle budget on %s', (method, limit) => {
    const target = AuthController.prototype[method];

    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, target)).toBe(
      limit,
    );
    expect(Reflect.getMetadata(`${THROTTLER_TTL}default`, target)).toBe(
      15 * 60 * 1000,
    );
  });
});
