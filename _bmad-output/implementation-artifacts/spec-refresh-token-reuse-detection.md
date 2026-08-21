---
title: 'Refresh Token Reuse Detection (Session-Family Kill-Switch)'
type: 'feature'
created: '2026-08-20'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'd482d84dbbf742f984259f96417d2399f1e4c1a9'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `AuthService.refresh()` collapses reuse of an already-*revoked* refresh token into the same generic 401 as an unknown/expired token. Revoked-token reuse is a standard signal of refresh-token theft (an attacker replaying a token the legitimate client already rotated away from), but today nothing responds to that signal — the thief's session and every other live session for that account stay valid.

**Approach:** In `AuthService.refresh()`, distinguish "token found but already revoked" from "token not found / expired" *before* the existing collapsed-401 throw. On the revoked-reuse case specifically, first revoke every other currently-unrevoked `RefreshToken` row for that `authAccountId` (session-family kill-switch), then throw the same `INVALID_REFRESH_TOKEN` 401 as before — the response body/status the client sees does not change, only the server-side side effect.

## Boundaries & Constraints

**Always:**
- The HTTP response for revoked-token reuse stays byte-identical to today (401, `INVALID_REFRESH_TOKEN`) — no account enumeration signal is added.
- The kill-switch fires only when the presented token is found in storage AND `revokedAt !== null`. It must NOT fire for unknown-hash or expired-but-never-revoked tokens (those stay ambiguous, per existing collapsed-401 design).
- The mass-revoke is scoped by `authAccountId` (matches the stored row's owner, not the JWT payload's `sub` blindly) and only touches rows where `revokedAt IS NULL` (idempotent, no-op if nothing else is live).
- Preserve the existing concurrent-rotation-race behavior (the `updateMany` with `revokedAt: null` in the WHERE clause for the *valid* rotation path) untouched.

**Ask First:** None — this is an additive, isolated behavior change to one existing method.

**Never:**
- Do not add a new response field, header, or error code exposing that a reuse/theft event was detected — client-visible behavior is unchanged.
- Do not touch `login`, `logout`, or `me` — out of scope.
- Do not build audit logging/alerting for the theft event — no logging module/sink exists yet (tracked separately in deferred-work.md).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Revoked-token reuse, other live sessions exist | Presented token's stored row has `revokedAt !== null`; account has 2 other rows with `revokedAt: null` | Both other rows updated to `revokedAt: now`; request still throws 401 `INVALID_REFRESH_TOKEN` | N/A |
| Revoked-token reuse, no other live sessions | Presented token's stored row has `revokedAt !== null`; no other unrevoked rows for the account | `updateMany` runs (matches 0 rows, no-op); request throws 401 `INVALID_REFRESH_TOKEN` | N/A |
| Unknown token (no stored row) | `findUnique` returns null | No mass-revoke triggered; throws 401 `INVALID_REFRESH_TOKEN` as before | N/A |
| Expired but never revoked | Stored row `revokedAt === null`, `expiresAt` in the past | No mass-revoke triggered (not a reuse signal); throws 401 `INVALID_REFRESH_TOKEN` as before | N/A |
| Valid rotation (unchanged path) | Stored row unrevoked, unexpired | Existing single-row conditional revoke + new token pair issued; no mass-revoke | N/A |

</frozen-after-approval>

## Code Map

- `apps/backend/src/modules/auth/auth.service.ts:126-169` -- `refresh()` method; the branch to change is the existing `if (!stored || stored.revokedAt !== null || ...)` block at lines 142-149, which must split into a revoked-specific branch (trigger kill-switch) vs. the remaining not-found/expired/mismatched-account conditions (unchanged).
- `apps/backend/src/modules/auth/auth.service.ts:399-401` -- `hashToken()` private helper, reused as-is, no change needed.
- `apps/backend/prisma/schema.prisma:180-192` -- `RefreshToken` model; already has `@@index([authAccountId])`, so the mass `updateMany` scoped by `authAccountId` is index-backed with no migration needed.
- `apps/backend/src/modules/auth/auth.service.spec.ts:351-368` -- existing `'rejects a revoked token with 401 INVALID_REFRESH_TOKEN (refresh reuse)'` test; must be extended/replaced to also assert the mass-revoke side effect (`prisma.refreshToken.updateMany` called with the account-scoped, `revokedAt: null` filter).
- `apps/backend/src/modules/auth/auth.service.spec.ts:396-421` -- existing concurrent-rotation-race test using `updateMany`; confirm this still passes unmodified (it exercises the *valid, unrevoked* path, not the new revoked-reuse branch) since both branches now call `updateMany` on the same mocked method — mock call assertions must stay scenario-specific (`toHaveBeenCalledWith`, not just `toHaveBeenCalled`).

## Tasks & Acceptance

**Execution:**
- [x] `apps/backend/src/modules/auth/auth.service.ts` -- In `refresh()`, split the current combined guard clause (lines 142-149) into: (1) a check for `stored && stored.revokedAt !== null` that first calls `this.prisma.refreshToken.updateMany({ where: { authAccountId: stored.authAccountId, revokedAt: null }, data: { revokedAt: new Date() } })`, then throws `this.invalidRefreshToken()`; (2) the remaining not-found/expired/account-mismatch conditions, unchanged, throwing the same error -- Implements the kill-switch without changing any client-visible response.
- [x] `apps/backend/src/modules/auth/auth.service.spec.ts` -- Extend the existing revoked-token-reuse test to assert `prisma.refreshToken.updateMany` was called once with `{ where: { authAccountId: <account>, revokedAt: null }, data: { revokedAt: expect.any(Date) } }`, and add a case where no other live rows exist (mock still returns e.g. `{ count: 0 }`) to confirm no throw/crash on a no-op mass-revoke -- Covers both edge cases from the I/O Matrix.
- [x] `apps/backend/src/modules/auth/auth.service.spec.ts` -- Add/confirm an unknown-token and an expired-but-unrevoked test explicitly assert `prisma.refreshToken.updateMany` was NOT called for the account-scoped kill-switch shape (distinguish from the valid-rotation path's own `updateMany` call) -- Guards against the kill-switch over-firing.
- [x] `apps/backend/src/modules/auth/auth.service.spec.ts` -- Add a revoked-and-expired combined case asserting the kill-switch still fires -- Closes the implicit-branch gap found by edge-case-hunter review.
- [x] `apps/backend/test/app.e2e-spec.ts` -- Add an e2e case logging in twice for the same account, rotating one session, replaying its now-revoked original token, and asserting the second untouched session's refresh token is also rejected -- Closes the verification-gap review finding that unit tests only assert the mock-call shape, not the real cross-session effect.

**Acceptance Criteria:**
- Given an `AuthAccount` with two other live (unrevoked, unexpired) `RefreshToken` rows, when a client presents a token whose stored row is already `revokedAt !== null`, then both other rows are updated to `revokedAt` set and the request still receives 401 `INVALID_REFRESH_TOKEN`.
- Given an `AuthAccount` with no other live `RefreshToken` rows, when a client presents an already-revoked token, then the mass-revoke call is a no-op (matches zero rows) and the request still receives 401 `INVALID_REFRESH_TOKEN` without error.
- Given a token with no matching stored row (unknown) or an expired-but-never-revoked row, when presented to `refresh()`, then no mass-revoke call occurs and behavior is byte-identical to before this change.
- Given a valid, unrevoked, unexpired token, when presented to `refresh()`, then the existing single-row conditional-revoke rotation path executes exactly as before (unaffected by this change).

## Spec Change Log

## Verification

**Commands:**
- `pnpm --filter backend test -- auth.service.spec` -- expected: all existing and new `AuthService` unit tests pass, including the extended refresh-reuse cases.
- `pnpm --filter backend build` -- expected: TypeScript compiles with no errors.

## Suggested Review Order

**Kill-switch logic**

- Entry point: the new branch that detects revoked-token reuse and mass-revokes every other live session for the account before falling through to the same collapsed 401.
  [`auth.service.ts:153`](../../apps/backend/src/modules/auth/auth.service.ts#L153)

**Test coverage — unit (mocked)**

- Core new-behavior test: asserts the mass-revoke `updateMany` call shape when other live sessions exist.
  [`auth.service.spec.ts:351`](../../apps/backend/src/modules/auth/auth.service.spec.ts#L351)

- Edge case surfaced by edge-case-hunter review: revoked-and-expired token still triggers the kill-switch.
  [`auth.service.spec.ts:375`](../../apps/backend/src/modules/auth/auth.service.spec.ts#L375)

- No-op case: kill-switch still fires safely when no other live sessions exist.
  [`auth.service.spec.ts:399`](../../apps/backend/src/modules/auth/auth.service.spec.ts#L399)

**Test coverage — e2e (real DB, real effect)**

- Closes the verification-gap finding that unit tests only proved the mock-call shape, not the real cross-session effect: two live sessions, one reused-revoked, both die.
  [`app.e2e-spec.ts:238`](../../apps/backend/test/app.e2e-spec.ts#L238)

**Supporting fix — pre-existing test-env bug surfaced during verification**

- `AppModule` is now `require()`d lazily inside this file instead of statically imported, since a static import is hoisted ahead of the `process.env.AUTH_THROTTLE_LIMIT` override just above it -- previously silently pinning every e2e run to the default throttle limit (5) instead of the intended override.
  [`app.e2e-spec.ts:22`](../../apps/backend/test/app.e2e-spec.ts#L22)
  [`app.e2e-spec.ts:26`](../../apps/backend/test/app.e2e-spec.ts#L26)
