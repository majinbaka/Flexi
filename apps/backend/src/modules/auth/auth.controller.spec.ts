import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
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
});
