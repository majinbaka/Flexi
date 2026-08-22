- source_spec: none
  summary: Build Authentication & Authorization module (login/logout, refresh token, forgot password, RBAC role/permission management, tenant-aware middleware)
  evidence: Independently shippable module split out from the initial "scaffold Flexi platform" intent per multi-goal check in step-01.

- source_spec: none
  summary: Build Dynamic Database / Table Builder module (table/field creation UI+API, validation, relations, migration engine)
  evidence: Independently shippable module split out from the initial "scaffold Flexi platform" intent per multi-goal check in step-01.

- source_spec: none
  summary: Build Workflow Builder module (drag-drop node-graph editor, triggers, conditions, actions)
  evidence: Independently shippable module split out from the initial "scaffold Flexi platform" intent per multi-goal check in step-01.

- source_spec: none
  summary: Build Page Builder & Page Routing module (drag-drop component builder, data binding, dynamic routing with role-based access)
  evidence: Independently shippable module split out from the initial "scaffold Flexi platform" intent per multi-goal check in step-01.

- source_spec: none
  summary: Build Cron Job module (cron expression UI, binding to workflows/scripts/actions, run history log)
  evidence: Independently shippable module split out from the initial "scaffold Flexi platform" intent per multi-goal check in step-01.

- source_spec: none
  summary: Build Mail & Template module (SMTP config, template editor with variable binding, template list management)
  evidence: Independently shippable module split out from the initial "scaffold Flexi platform" intent per multi-goal check in step-01.

- source_spec: none
  summary: Build Wiki / internal documentation module (article CRUD, folder hierarchy, search, markdown editor)
  evidence: Independently shippable module split out from the initial "scaffold Flexi platform" intent per multi-goal check in step-01.

- source_spec: none
  summary: Implement full multi-tenant data/config/role isolation and subdomain/tenant-code resolution beyond the core schema
  evidence: Independently shippable module split out from the initial "scaffold Flexi platform" intent per multi-goal check in step-01.

- source_spec: none
  summary: Implement i18n for dynamic user-created content (field labels, page names, wiki content translation tables) beyond base system UI i18n scaffolding
  evidence: Independently shippable module split out from the initial "scaffold Flexi platform" intent per multi-goal check in step-01.

- source_spec: none
  summary: Build Settings module (system-wide theme/logo/org config UI+API, per-tenant settings)
  evidence: Independently shippable module split out from the initial "scaffold Flexi platform" intent per multi-goal check in step-01.

- source_spec: none
  summary: Build realtime Logging module (WebSocket live log viewer, filter by module/level/tenant, queryable log storage)
  evidence: Independently shippable module split out from the initial "scaffold Flexi platform" intent per multi-goal check in step-01.

- source_spec: `_bmad-output/implementation-artifacts/spec-flexi-core-scaffold.md`
  summary: Set up lint/format tooling (ESLint+Prettier config for backend/frontend/shared-types) and a CI workflow that runs install/build/lint/test on PRs
  evidence: Review found `pnpm lint` is currently a silent no-op (no lint script or config anywhere in the repo) and there is no CI workflow, despite the roadmap implying ongoing multi-phase, multi-contributor work. Choosing lint rules/CI platform is a real decision, not a trivial patch to the scaffold.

- source_spec: `_bmad-output/implementation-artifacts/spec-flexi-core-scaffold.md`
  summary: Decide and implement a `WikiPage` parent-deletion strategy (cascade, restrict-with-friendly-error, or re-parent-on-delete) instead of the current raw `onDelete: NoAction` FK behavior
  evidence: Review flagged that deleting a wiki page with children currently fails with a raw Postgres FK-violation error; no delete endpoint exists yet in the wiki stub module, so the actual UX/strategy belongs to that module's own story.

- source_spec: `_bmad-output/implementation-artifacts/spec-flexi-core-scaffold.md`
  summary: Add i18n language persistence (localStorage) and/or browser-language detection to the frontend, instead of hardcoding `lng: 'en'`
  evidence: Review noted the EN/VI sidebar toggle currently resets to English on every reload since i18next has no persistence/detection plugin configured; a UX nicety, not required by the scaffold's stub-only i18n acceptance criteria.

- source_spec: `_bmad-output/implementation-artifacts/spec-flexi-core-scaffold.md`
  summary: Replace the frontend's inline hardcoded styles with a real design system/theme once the Page Builder module lands
  evidence: Review noted `Sidebar.tsx`/`Layout.tsx` use ad hoc inline `style={{}}` objects with hardcoded hex colors and no shared tokens; acceptable for a bare placeholder shell but should be superseded when Page Builder (deferred module) defines real UI components/theming.

- source_spec: `_bmad-output/implementation-artifacts/spec-flexi-core-scaffold.md`
  summary: Enforce `DynamicField.dataType` and `LogEntry.level` against their `FieldDataType`/`LogLevel` enum value sets at the application layer (DTO validation) once real create/update endpoints exist
  evidence: Review noted both columns are currently unconstrained `TEXT` with no validation anywhere (by design, per the schema's comment that the enum lives once in `@flexi/shared-types`), but nothing enforces it yet since no real endpoints accept these fields in the scaffold. Belongs to the Dynamic Table Builder / Logging module stories.

- source_spec: `_bmad-output/implementation-artifacts/spec-lint-ci-tooling.md`
  summary: Wire backend's existing e2e suite (`apps/backend/test/app.e2e-spec.ts`, run via `test:e2e`) into `.github/workflows/ci.yml` with a real Postgres service container and a migration/deploy step
  evidence: Review found the CI workflow's `pnpm test` step only runs the root `test` pass-through, which for backend is plain `jest` (rootDir `src`, unit specs only) — `test:e2e` is never invoked anywhere in CI, so the existing e2e suite (health check, tenant envelope, not-implemented envelope coverage) never runs on PRs. Confirmed no current unit spec touches `PrismaService`/`$connect()`, so this is not a live CI failure today, but it's a real coverage gap that needs a deliberate service-container + migration decision, out of scope for a lint/format chore.

- source_spec: `_bmad-output/implementation-artifacts/spec-lint-ci-tooling.md`
  summary: Add frontend test tooling (e.g. Vitest) with at least smoke-level coverage
  evidence: Review found `apps/frontend` has no test script or test framework at all, so the new root `pnpm test` (and the CI `Test` step) silently no-ops for it with zero signal. Spec's frozen boundaries explicitly excluded adding a new test framework for frontend/shared-types from this chore's scope.

- source_spec: `_bmad-output/implementation-artifacts/spec-lint-ci-tooling.md`
  summary: Add a root `.editorconfig` to reinforce indentation/charset/final-newline conventions for editors that don't invoke Prettier automatically
  evidence: Review flagged the repo relies entirely on Prettier for formatting consistency; an `.editorconfig` is a small, independent belt-and-suspenders addition (covers editors/tools that never run Prettier) not required by this chore's acceptance criteria.

- source_spec: `_bmad-output/implementation-artifacts/spec-figma-design-sync.md`
  summary: Expand design-token categories beyond color/typography/spacing/radii (shadows/elevation, z-index scale, breakpoints, motion/transition durations) once a Figma frame actually needs one of them
  evidence: Review noted the current token categories are a deliberate, frozen-intent v1 scope; broadening them now would be scope creep beyond what was approved, but the gap should be filled in when a real frame requires it rather than forgotten.

- source_spec: `_bmad-output/implementation-artifacts/spec-figma-design-sync.md`
  summary: Add lint/CI enforcement (e.g. stylelint rule) preventing hardcoded design values in component styles once components begin consuming `tokens.css`
  evidence: Review flagged that "don't hardcode design values" is currently only a documented convention with no tooling to enforce it; adding a linter is out of this chore's zero-new-dependency scope but worth revisiting once real components adopt tokens.

- source_spec: `_bmad-output/implementation-artifacts/spec-figma-design-sync.md`
  summary: Define a theming/multi-mode strategy (light/dark, or multiple Figma variants for the same frame) before the flat `:root` token structure becomes hard to retrofit
  evidence: Review noted the Figma file may define mode variants that don't map cleanly onto a single flat `:root` token set; deciding this now would be premature since no screen is implemented yet, but it's a costly gap to leave unaddressed once tokens accumulate.

- source_spec: none
  summary: Build forgot/reset password flow (request-reset endpoint, time-limited reset token, reset-confirm endpoint)
  evidence: Independently shippable goal split out from the "Build Authentication & Authorization module" intent per multi-goal check in step-01 -- it has a hard dependency on the Mail & Template module actually sending email, which is still a stub, so it cannot be completed as part of Core Auth.

- source_spec: none
  summary: Build RBAC admin management API (CRUD for roles, assigning permissions to roles, assigning roles to users)
  evidence: Independently shippable goal split out from the "Build Authentication & Authorization module" intent per multi-goal check in step-01 -- distinct from Core Auth's guard-based permission *enforcement*, which only needs roles/permissions to already exist (via seed data).

- source_spec: `_bmad-output/implementation-artifacts/spec-core-authentication.md`
  summary: Build a guest-to-real-account upgrade/claim flow (attach a real email/password to a system-generated guest `AuthAccount`)
  evidence: Guest login provisions a system-generated email/password with no forgot-password path (that flow is itself deferred, blocked on the stub Mail module); a claim flow is the only way a guest account becomes recoverable long-term, but it's out of scope for the guest-login MVP.

- source_spec: `_bmad-output/implementation-artifacts/spec-core-authentication.md`
  summary: Add rate limiting / abuse throttling on `POST /api/auth/guest`
  evidence: The guest endpoint requires no credentials and creates a new `AuthAccount`+`TenantUser` per call, so unauthenticated account creation is otherwise unbounded; deferred out of the guest-login MVP scope.

- source_spec: `_bmad-output/implementation-artifacts/spec-core-authentication.md`
  summary: Implement the "permission ceiling" rule (an actor assigning a role/permission to another can never grant more than it itself holds) once an RBAC admin management API exists
  evidence: Surfaced in a brainstorm on 3-tier RBAC (`_bmad-output/brainstorming/brainstorm-core-auth-3-tier-rbac-review-2026-08-17/`) as the mechanism that prevents both an Admin over-granting a User and a tenant Role receiving a `SYSTEM`-scope `Permission`. Has no live enforcement point in Core Auth today since there is no runtime role/permission-assignment endpoint (only the seed script assigns roles) -- belongs to the RBAC admin API's own spec.

- source_spec: `_bmad-output/implementation-artifacts/spec-core-authentication.md`
  summary: Extend `LogEntry` (or a dedicated audit log) with `actorType`/`actorId` fields, once the Logging module is built
  evidence: Surfaced in the 3-tier RBAC brainstorm as a "Should": once `SystemUser` and `TenantUser` coexist, a flat `createdBy`-style field can't tell the two apart. `LogEntry` currently has no actor fields at all and Core Auth writes none, so there's no live attachment point yet -- belongs to the deferred realtime Logging module.

- source_spec: `_bmad-output/implementation-artifacts/spec-core-authentication.md`
  summary: Build impersonation (`SystemUser` acting "as" a `TenantUser`) for support/ops use cases
  evidence: Surfaced in the 3-tier RBAC brainstorm as a real support need with no current use case backing it for Flexi specifically. The JWT claim name `impersonatedBy` is reserved (left undefined in the payload shape) in Core Auth's spec so this can be added later without a payload migration.

- source_spec: `_bmad-output/implementation-artifacts/spec-core-authentication.md`
  summary: Add a guest-login endpoint (`POST /api/auth/guest`) letting an unauthenticated caller obtain a system-provisioned, tenant-scoped `TenantUser` (generated email/password returned once) usable via normal `POST /api/auth/login` afterward
  evidence: Split out per the step-02 token-budget gate -- the spec exceeded the 900-1600 token target (~3800-5500 tokens estimated) covering both the 3-tier core-auth actor model (`AuthAccount`/`SystemUser`/`TenantUser`, JWT login/refresh/logout/me, RBAC guards) and guest-login. Guest-login is independently shippable once core auth exists: it only adds one endpoint + a seeded `Guest` role on top of the already-built `AuthAccount`+`TenantUser` creation path. User chose to split rather than keep both in one spec.

- source_spec: `_bmad-output/implementation-artifacts/spec-core-authentication.md`
  summary: On refresh-token reuse where the presented token is specifically *revoked* (not merely unknown/expired), revoke every other live refresh token for that `AuthAccount`, not just 401 the single replayed attempt
  evidence: Surfaced by step-04 blind-hunter review. Reuse of a revoked token is a standard signal of refresh-token theft; the current implementation (`auth.service.ts` `refresh()`) collapses it to the same 401 `INVALID_REFRESH_TOKEN` as an unknown/expired token with no session-family kill-switch, matching the frozen spec's literal I/O Matrix but not full theft-response best practice.

- source_spec: `_bmad-output/implementation-artifacts/spec-core-authentication.md`
  summary: Normalize `AuthAccount.email` (case-folding at write and lookup time) once a real account-creation/registration path exists
  evidence: Surfaced by step-04 blind-hunter review. `email` is matched as-is with no DB-unique constraint by design; without normalization, `User@x.com` and `user@x.com` could back independent accounts. Currently only the seed script creates accounts (two fixed, author-controlled addresses), so there is no live path where this bites yet.

- source_spec: `_bmad-output/implementation-artifacts/spec-core-authentication.md`
  summary: Build an account-creation/registration API for `TenantUser`/`SystemUser`, including the service-layer email-uniqueness ("no two `TenantUser`s in a tenant share an email", "no two `SystemUser`s share an email") and one-actor-per-`AuthAccount` invariants the schema comments describe
  evidence: Surfaced by step-04 blind-hunter review. This spec's frozen Boundaries document these as service-layer-enforced invariants, but the only current account-creator is `prisma/seed.ts` (fixed dev bootstrap data, not user input) -- there is no live endpoint where the invariants could be violated or need enforcing yet.

- source_spec: `_bmad-output/implementation-artifacts/spec-core-authentication.md`
  summary: Enforce `Role.tenantId` scope compatibility at role-assignment time (a tenant role only assignable to a `TenantUser` of that same tenant; a system role only to a `SystemUser`) once an RBAC admin API / role-assignment endpoint exists
  evidence: Surfaced by step-04 edge-case-hunter review. `TenantUser.roles`/`SystemUser.roles` are plain many-to-many relations with no constraint or service check preventing a mismatched assignment; only `prisma/seed.ts` assigns roles today and happens to comply by construction. Belongs with the already-deferred RBAC admin management API.

- source_spec: `_bmad-output/implementation-artifacts/spec-core-authentication.md`
  summary: Add rate limiting / brute-force protection on `POST /api/auth/login` and `POST /api/auth/refresh`
  evidence: Surfaced by step-04 blind-hunter review. Neither endpoint has any attempt-throttling (no `@nestjs/throttler` guard or equivalent); repeated password/refresh-token guessing is currently unbounded. Distinct from the already-deferred guest-endpoint rate-limiting entry, which no longer applies now that guest-login is out of this spec entirely.

- source_spec: `_bmad-output/implementation-artifacts/spec-core-authentication.md`
  summary: Add a cleanup/retention job for revoked and expired `RefreshToken` rows
  evidence: Surfaced by step-04 blind-hunter review. Rows are never purged after `revokedAt` is set or `expiresAt` passes, so the table grows unboundedly in a long-lived deployment; needs a scheduling mechanism this spec doesn't build.

- source_spec: `_bmad-output/implementation-artifacts/spec-core-authentication.md`
  summary: Exercise `PermissionsGuard`/`@RequirePermissions()` end-to-end on a real route, or extend the guard to support an actor-conditional permission set
  evidence: Surfaced by step-04 blind-hunter review. `GET /api/auth/me` -- the one endpoint built to prove the guard pair out -- needed an actor-conditional permission check (`auth.me.read` for `TenantUser`, `system.me.read` for `SystemUser`) that the guard's current static-list `@RequirePermissions()` design can't express, so `AuthService.me()` re-implements the check by hand instead. The guard pair is currently exercised only by its own unit tests, never by a live route.

- source_spec: none
  summary: Build tenant provisioning (new-tenant onboarding): background job that creates a tenant's PostgreSQL schema and runs its initial migrations via `withUserParams()`
  evidence: Independently shippable deliverable split out of the schema-per-tenant implementation guide (`_bmad-output/planning-artifacts/schema-per-tenant-implementation-guide.md`, §5) per multi-goal check in step-01. Depends on the tenant context & schema-routing core landing first.

- source_spec: none
  summary: Build cross-tenant migration tooling: the `withUserParams()`/`.withSchema()` per-migration-file pattern plus a `migrateAllTenants()` runner that replays migrations across all existing tenant schemas without aborting on one tenant's failure
  evidence: Independently shippable deliverable split out of the schema-per-tenant implementation guide (`_bmad-output/planning-artifacts/schema-per-tenant-implementation-guide.md`, §6) per multi-goal check in step-01. Depends on the tenant context & schema-routing core landing first; note `migrate.latest({ schemaName })` only relocates the tracking table and does not scope DDL -- every migration file must read `knex.userParams.schema` and call `.withSchema()` itself.

- source_spec: none
  summary: Enforce Dynamic-Table-Builder guardrails under schema-per-tenant: per-tenant max-tables-per-schema cap (alongside the existing per-table column cap) and a fleet-wide catalog-object-budget metric/alert
  evidence: Independently shippable deliverable split out of the schema-per-tenant implementation guide (`_bmad-output/planning-artifacts/schema-per-tenant-implementation-guide.md`, §7) per multi-goal check in step-01. The guide stresses this is load-bearing, not optional polish -- no external source validates safe ceilings for schema-per-tenant combined with uncapped tenant-created dynamic tables, so the caps are Flexi's own starting risk mitigation pending real usage data.

- source_spec: `_bmad-output/implementation-artifacts/spec-schema-per-tenant-core.md`
  summary: Size/validate the total Postgres connection budget across Prisma's pool and `TenantKnexService`'s new Knex `pg` pool (both `min:2/max:50` today) against real `max_connections`, and move the pool bounds (and an explicit `acquireTimeoutMillis`) from hardcoded values into `ConfigService`/`env.validation.ts` like this codebase's other tunables
  evidence: Surfaced by step-04 blind-hunter and edge-case-hunter review. Two independent pools against one database multiplies connection usage per instance as the app scales horizontally; today's hardcoded `min:2/max:50` with no timeout is a reasonable default but not production-sized, and needs real traffic data (or at least a documented sizing rationale) before it matters.

- source_spec: `_bmad-output/implementation-artifacts/spec-schema-per-tenant-core.md`
  summary: Rename either the new `TenantContext` injectable class (`apps/backend/src/tenancy/tenant-context.ts`) or the pre-existing `TenantContext` param decorator (`apps/backend/src/common/tenant-context.decorator.ts`) so two semantically different "current tenant" concepts (JWT/CLS-derived vs. unauthenticated `x-tenant-id`-header-derived) don't share an identical exported symbol name
  evidence: Surfaced by step-04 verification-gap review. Confirmed as a literal name collision (`export class TenantContext` vs `export const TenantContext = createParamDecorator(...)`) across two files; doesn't break compilation today since import paths differ, but is a real future mis-import/confusion risk. Left as-is for this story since fixing it would mean touching the pre-existing decorator and its only call site (`auth.controller.ts`), outside this story's scope.

- source_spec: `_bmad-output/implementation-artifacts/spec-schema-per-tenant-core.md`
  summary: `TenantKnexService` eagerly opens a live `pg` connection pool on every app boot (including e2e test runs) even though nothing calls `forCurrentTenant()` yet -- revisit once the Dynamic Table Builder module actually consumes it
  evidence: Surfaced by step-04 verification-gap review (confirmed via repo-wide grep: no caller of `TenantKnexService`/`forCurrentTenant` exists outside its own spec file). Inert infrastructure reserving real DB connections on every boot; acceptable for now since this story's own scope is deliberately "infra before consumer," but worth revisiting for lazy initialization once a real caller lands.

- source_spec: `_bmad-output/implementation-artifacts/spec-schema-per-tenant-core.md`
  summary: No integration/e2e test exercises the full request pipeline (CLS middleware opening the store -> `JwtAuthGuard` populating tenant/schema -> `TenantKnexService.forCurrentTenant()` compiling a query) inside a real bootstrapped Nest app -- all current coverage is unit-level with hand-constructed `ClsService`/`AsyncLocalStorage` instances
  evidence: Surfaced by step-04 blind-hunter review. Mirrors the same category of gap already deferred for `PermissionsGuard` in `spec-core-authentication.md` (exercised only by unit tests, never a live route) -- there's no live dynamic-table route yet for an e2e test to exercise this against, so deferring alongside it rather than manufacturing a test with no real consumer.

- source_spec: `_bmad-output/implementation-artifacts/spec-core-authentication-fe.md`
  summary: Add a System Admin login page (`/admin/login`) that authenticates via `POST /auth/login` without the `x-tenant-id` header
  evidence: Split from the FE core-auth spec's token budget (step-02 token check, ~1925 tokens over the 1600 target). The Tenant User login page exercises the full AuthContext/ProtectedRoute/API-client session machinery end-to-end; System Admin login reuses that same infrastructure and the shared `LoginForm`, so it can ship as a small follow-on once this spec lands.

- source_spec: `_bmad-output/implementation-artifacts/spec-core-authentication-fe.md`
  summary: Add automated test coverage for the auth flow's concurrency/security-sensitive logic once frontend test tooling lands (single-flight refresh dedup in `api-client.ts`'s `refreshAccessToken()`, the `NO_REFRESH_PATHS` retry skip-list, and `AuthContext`'s boot-time silent refresh)
  evidence: Surfaced by step-04 verification-gap review, confirmed via repo-wide search: `apps/frontend` has no test files and no `test` script at all. This mirrors the pre-existing "no frontend test tooling" gap already tracked from the lint/CI chore, but calls out these specific auth-critical paths as the highest-value first candidates -- a regression in the single-flight guard or the retry skip-list would ship as an intermittent forced-logout or a silent unrelated-session token rotation, and nothing in `pnpm build:frontend`/`pnpm lint` would catch it.

- source_spec: `_bmad-output/implementation-artifacts/spec-core-authentication-fe.md`
  summary: No cross-tab session sync -- the refresh token lives in `localStorage` (shared across browser tabs) but nothing listens for the `storage` event or uses a `BroadcastChannel`, so logging out in one tab leaves other open tabs holding a live in-memory access token until it happens to expire
  evidence: Surfaced by step-04 blind-hunter review. Not addressed by the frozen spec (single-tab session model only); a legitimate scope expansion, not a defect in the shipped behavior.

- source_spec: `_bmad-output/implementation-artifacts/spec-core-authentication-fe.md`
  summary: Fix the repo's documented frontend env-var setup -- root `.env.example`/README ("Configure environment variables") both claim root `.env` "contains the `VITE_*` variables for the frontend", but `apps/frontend/vite.config.ts` has no `envDir` override, so Vite actually reads `apps/frontend/.env` (project-root-relative to the Vite config, not the repo root) and never sees the root file at all
  evidence: Pre-existing since the scaffold spec (`spec-flexi-core-scaffold.md`); dormant until this story became the first to actually call `import.meta.env.VITE_API_BASE_URL` at runtime. Worked around locally with a new gitignored `apps/frontend/.env`, but a fresh clone following the documented `cp .env.example .env` (root only) still leaves `VITE_API_BASE_URL` unresolved. Fix is either `envDir: '../../'` in `vite.config.ts`, or updating the README/root `.env.example` comment and adding `apps/frontend/.env.example`.

- source_spec: `_bmad-output/implementation-artifacts/spec-admin-login.md`
  summary: No actor-type-aware post-login experience -- both `/login` (TenantUser) and `/admin/login` (SystemUser) route through the identical `ProtectedRoute` -> `Layout` -> `HomePage`/`MODULE_NAV_ITEMS` tree, with nothing branching on `currentUser.actorType`, and a signed-in session of either type can freely navigate to the other's login page and silently re-authenticate as the other actor
  evidence: Surfaced by blind-hunter review. Consistent with the frozen fe-auth spec's own boundary ("no per-route RBAC gating... authenticated-vs-not only"); a distinct admin shell/nav and actor-aware guarding is a real scope expansion belonging to whichever spec first builds System-Admin-only screens.
- source_spec: `_bmad-output/implementation-artifacts/spec-admin-login.md`
  summary: No UI cross-link between `/login` and `/admin/login` -- `/admin/login` is reachable only by typing the URL directly, with no nav/footer affordance pointing to it from `/login` or vice versa
  evidence: Surfaced by blind-hunter review. Deliberately minimal for this slice (mirrors the tenant LoginPage's existing scope); worth revisiting once there's a real discovery flow for System Admin operators.
- source_spec: `_bmad-output/implementation-artifacts/spec-admin-login.md`
  summary: `LoginPage`'s "Tenant ID" field accepts whitespace-only input (`required` doesn't reject it), sending `x-tenant-id: "   "` to the backend
  evidence: Surfaced by blind-hunter review while reviewing the new AdminLoginPage against the existing LoginPage. Pre-existing in the frozen, already-`done` `spec-core-authentication-fe.md` -- not introduced by this change, so not patched here.
- source_spec: `_bmad-output/implementation-artifacts/spec-admin-login.md`
  summary: `LoginPage` and `AdminLoginPage` are near-duplicate components (~100 lines each, differing only in the Tenant ID field, icon, and title/subtitle copy) with no shared base extracted, so future changes to shared form chrome (validation, submit handling, error rendering) must be made twice
  evidence: Surfaced by blind-hunter review. Deliberate for this slice to keep the change small and reviewable; worth extracting a shared `LoginForm` if a third login variant or further divergence appears.
- source_spec: `_bmad-output/implementation-artifacts/spec-admin-login.md`
  summary: No automated test coverage proving `AdminLoginPage` calls `login(email, password)` without a third `tenantId` argument -- the entire behavioral difference from `LoginPage` is unverified by anything but manual/Storybook checks
  evidence: Surfaced by blind-hunter review. Mirrors the already-deferred "no frontend test tooling" gap from `spec-core-authentication-fe.md` -- `apps/frontend` still has no test runner configured.

- source_spec: `_bmad-output/implementation-artifacts/spec-refresh-token-reuse-detection.md`
  summary: Audit-log or emit a metric/event for session-family kill-switch firings (which account, how many sessions killed, when) so a theft incident is investigable and alertable after the fact
  evidence: Surfaced by blind-hunter review. `AuthService.refresh()`'s new kill-switch branch discards the `updateMany` result count and writes nothing anywhere -- there is no logging module/sink in this repo yet (tracked separately as the deferred realtime Logging module), so there is no live attachment point for this today.

- source_spec: `_bmad-output/implementation-artifacts/spec-refresh-token-reuse-detection.md`
  summary: Add a dedicated abuse-throttling / backoff path for repeated refresh-token-reuse triggers, distinct from the existing login/refresh rate limiting, since a flood of replayed-revoked-token requests against one account is a self-inflicted mass-logout DoS vector against that specific user
  evidence: Surfaced by blind-hunter review. The existing `ThrottlerGuard` on `POST /api/auth/refresh` (`spec-auth-rate-limiting.md`) limits raw request volume but does not distinguish "many distinct reuse-trigger events for the same account" as a special case worth a tighter, targeted limit.

- source_spec: `_bmad-output/implementation-artifacts/spec-refresh-token-reuse-detection.md`
  summary: Notify the affected user (e.g. email) when the session-family kill-switch revokes their other live sessions, so a legitimate user isn't silently logged out of other devices with no explanation
  evidence: Surfaced by blind-hunter review. Requires the Mail & Template module, which is still a stub (already tracked as its own deferred module) -- no live sending path exists yet for this to attach to.

- source_spec: `_bmad-output/implementation-artifacts/spec-refresh-token-reuse-detection.md`
  summary: Add a composite DB index on `RefreshToken(authAccountId, revokedAt)` if the kill-switch's `updateMany({ where: { authAccountId, revokedAt: null } })` scan shows up as a hot path under real production load
  evidence: Surfaced by blind-hunter review. Today's schema only has `@@index([authAccountId])`; `revokedAt` isn't part of a composite index, so the kill-switch query scans every row for an account rather than only its live ones. Not a correctness issue and premature to add without real traffic data, per this repo's existing pattern of only sizing indexes/pools against observed load (see the already-deferred Prisma/Knex connection-pool-sizing entry).

- source_spec: `_bmad-output/implementation-artifacts/spec-editorconfig-drift-check.md`
  summary: Wire `pnpm editorconfig:check` (and `format:check`/`lint`) into a local pre-commit hook, not just CI, once the repo adopts a pre-commit tool (e.g. husky + lint-staged)
  evidence: Surfaced by blind-hunter review. There is no local git-hook infrastructure in this repo today; adding one is a real tooling decision (which tool, staged-files-only vs. full-repo scope) out of scope for wiring a single CI check.

- source_spec: `_bmad-output/implementation-artifacts/spec-editorconfig-drift-check.md`
  summary: Replace the three hand-duplicated ignore lists (`.prettierignore`, `eslint.config.js` `ignores`, `.editorconfig-checker.json` `Exclude`) with a single shared source of truth, or add a check that keeps them in sync
  evidence: Surfaced by blind-hunter review. Each list uses a different syntax (plain paths, glob, regex) for the same underlying exclusion set (vendored BMad/Claude tooling, generated files); a future addition to one is likely to be missed in the others with no CI signal to catch the drift.

- source_spec: `_bmad-output/implementation-artifacts/spec-deferred-fixes-batch.md`
  summary: Add `.env.example` file(s) (root and/or `apps/backend`) documenting every backend-consumed env var, including the new `TRUST_PROXY_HOPS`
  evidence: Surfaced by blind-hunter review. No `.env.example` exists anywhere in this repo today despite the README instructing `cp .env.example .env`; pre-existing gap (also covers already-undocumented `AUTH_THROTTLE_TTL`/`AUTH_THROTTLE_LIMIT`), not introduced by this change, but an operator turning on a real reverse proxy has nothing to copy `TRUST_PROXY_HOPS` from.

- source_spec: `_bmad-output/implementation-artifacts/spec-deferred-fixes-batch.md`
  summary: Add unit test coverage for `TRUST_PROXY_HOPS` in `env.validation.spec.ts` (valid non-negative integer accepted, negative/non-integer rejected) and for the new 429-handling branch in `apps/frontend/src/lib/api-client.ts`'s `request()` (asserts `RATE_LIMITED_ERROR_CODE` thrown for `/auth/login`/`/auth/refresh`, not for other paths)
  evidence: Surfaced by blind-hunter review. `env.validation.spec.ts` has thorough coverage for sibling vars (`JWT_ACCESS_SECRET`, `JWT_ACCESS_EXPIRES_IN`) but wasn't extended for the new var; the frontend assertion is blocked on the still-missing frontend test framework (already tracked separately), but is worth calling out as the first concrete case once that framework lands.

- source_spec: `_bmad-output/implementation-artifacts/spec-deferred-fixes-batch.md`
  summary: Surface the backend's `Retry-After` value (if `@nestjs/throttler` sends one) in the frontend's rate-limited login error message, instead of a static "please wait a moment" string
  evidence: Surfaced by blind-hunter review. The new 429 handling in `api-client.ts` discards `envelope.error.message` entirely in favor of a fixed translated string; a precise wait time would be more actionable, but reading throttler response headers/body was out of scope for this pass and needs verifying what `@nestjs/throttler` actually returns.

- source_spec: `_bmad-output/implementation-artifacts/spec-deferred-fixes-batch.md`
  summary: Decide on and configure `reviewers`/`assignees`/`labels` for the new `.github/dependabot.yml` PRs, and verify in a live Dependabot run that the `eslint-plugin-react-hooks` devDependency is actually matched by the `lint-and-format` group's `eslint*` glob (not left ungrouped)
  evidence: Surfaced by blind-hunter review. PR routing is a team-process decision this pass shouldn't assume; the glob-match claim should be confirmed against Dependabot's actual first run rather than assumed from the pattern syntax alone.

- source_spec: `_bmad-output/implementation-artifacts/spec-deferred-fixes-batch-2.md`
  summary: Add a unit test for `apps/frontend/src/i18n/index.ts`'s `resolveInitialLanguage` (stored-language, `navigator.languages` preference-order, unsupported-language fallback, and storage-unavailable branches)
  evidence: Surfaced by blind-hunter review. Blocked on the still-missing frontend test framework (already tracked as its own deferred item from the lint/CI chore) -- there is nothing to run a `.spec.ts` file with yet in `apps/frontend`.

- source_spec: `_bmad-output/specs/spec-dynamic-table-builder/stories/2-table-and-field-crud-through-the-async-ddl-queue.md`
  summary: Reject a user-supplied field named `id`, `created_at`, or `updated_at` synchronously at create-table/field-add time, since `ddl-worker.ts` unconditionally injects these same column names via `increments('id')`/`timestamps(true, true)`
  evidence: Confirmed by blind-hunter review (`ddl-worker.ts:141,150`). Currently the collision only surfaces asynchronously as a raw Postgres "column already exists" DDL error once the worker processes the job, rather than a clean synchronous `400` at request time -- contained (fails safely, no data corruption) but confusing to debug.

- source_spec: `_bmad-output/specs/spec-dynamic-table-builder/stories/2-table-and-field-crud-through-the-async-ddl-queue.md`
  summary: Reject duplicate field names within a single `CreateTableDto.fields` array synchronously, before enqueue
  evidence: Confirmed by blind-hunter review. `enqueueCreateTable` sanitizes each field name independently with no uniqueness check; two fields with the same (or case-variant) name both pass validation and only fail asynchronously via the worker's `CREATE TABLE` DDL.

- source_spec: `_bmad-output/specs/spec-dynamic-table-builder/stories/2-table-and-field-crud-through-the-async-ddl-queue.md`
  summary: Add upper-bound `.max(...)` validation to `DDL_JOB_RETRY_COUNT`/`DDL_LOCK_TIMEOUT_MS`/`DDL_STATEMENT_TIMEOUT_MS` in `env.validation.ts`
  evidence: Confirmed by blind-hunter review. All three are currently `Joi.number().integer().positive().default(...)` with no ceiling, so an operator typo (e.g. a statement timeout in the billions of ms) would pass validation and only misbehave at runtime against production Postgres.

- source_spec: `_bmad-output/specs/spec-dynamic-table-builder/stories/2-table-and-field-crud-through-the-async-ddl-queue.md`
  summary: Add `@ArrayUnique`/a max-size cap to `CreateTableDto.fields` and `UpdateFieldDto.edits`
  evidence: Confirmed by blind-hunter review. Only `@ArrayMinSize(1)` bounds the low end today; nothing stops a pathologically large `fields`/`edits` array from being accepted and enqueued as one oversized DDL job.

- source_spec: `_bmad-output/specs/spec-dynamic-table-builder/stories/2-table-and-field-crud-through-the-async-ddl-queue.md`
  summary: Seed this story's new `dynamic-tables.tables.create`/`dynamic-tables.fields.update`/`dynamic-tables.jobs.read` permission codes into `prisma/seed.ts` (or wherever tenant-admin roles are provisioned) before this module reaches a real deployment
  evidence: Confirmed by blind-hunter review. Today only the new e2e test manually upserts these permission rows via raw Prisma calls; without seeding, `PermissionsGuard` would deny every request to `TablesController`'s three routes in a real environment. Exact code names were a judgment call (spec's own "Ask First" item, never confirmed with a human) and may need to change to match however the tenant-management/RBAC UI ends up naming things -- worth resolving both together.

- source_spec: `_bmad-output/specs/spec-dynamic-table-builder/stories/2-table-and-field-crud-through-the-async-ddl-queue.md`
  summary: Cover the "drop succeeds, rename fails within one attempt" sub-case of the `cutover-column` field-edit step (`ddl-worker.ts`'s `dropColumn` + `renameColumn` as two separate `alterTable` calls inside one step transaction)
  evidence: Confirmed by blind-hunter review. Both statements run inside the same `TenantKnexService.transaction()`, so a mid-step Postgres-level failure should roll both back together, but no test exercises the case where the first `alterTable` call succeeds and the second throws within a single attempt -- only the already-tested "process crashes between committed steps" (retry-safety) scenario is covered.

- source_spec: `_bmad-output/specs/spec-dynamic-table-builder/stories/3-row-readwrite-api-with-generated-validation.md`
  summary: Seed this story's new `dynamic-tables.rows.create`/`dynamic-tables.rows.read`/`dynamic-tables.rows.update`/`dynamic-tables.rows.delete` permission codes into `prisma/seed.ts`, same as the already-deferred Story 2 tables/fields codes
  evidence: Confirmed by blind-hunter and verification-gap review. `RowsController` guards every route with `RequirePermissions('dynamic-tables.rows.<action>')` but `prisma/seed.ts` has no `dynamic-tables.*` codes at all yet (not even Story 2's) -- without seeding, `PermissionsGuard` denies every row route in a real environment. Should be resolved together with the already-deferred Story 2 seeding item.

- source_spec: `_bmad-output/specs/spec-dynamic-table-builder/stories/3-row-readwrite-api-with-generated-validation.md`
  summary: Add an e2e test (real Nest DI/module boot, real guard execution) exercising at least one `RowsController` route end-to-end, analogous to `dynamic-tables.e2e-spec.ts`'s existing create-table/field-edit coverage
  evidence: Confirmed by verification-gap review. `rows.controller.spec.ts` constructs `RowsController` via plain `new RowsController(service)`, never through Nest's module system, so it cannot catch a route-registration, path-collision, or guard-binding regression -- the exact class of bug `dynamic-tables.module.ts`'s own doc comment says was previously discovered and worked around for `TablesController`'s guard resolution. No existing e2e test touches any `/rows` path.

- source_spec: `_bmad-output/specs/spec-dynamic-table-builder/stories/3-row-readwrite-api-with-generated-validation.md`
  summary: Decide whether `createRow`/`updateRow`/`deleteRow` should re-check row existence atomically (via the mutation's own returned-row check) instead of a separate `findRowOrThrow()` round trip beforehand
  evidence: Confirmed by blind-hunter review. `updateRow`/`deleteRow` call `findRowOrThrow()` then issue a second `where({id}).update()/.delete()` -- a row deleted concurrently between the two calls makes the second call a silent no-op (empty `update()` result destructured as `undefined`, or a no-op `delete()`) rather than a fresh 404, which is a narrow, low-severity race, not data corruption.

- source_spec: `_bmad-output/specs/spec-dynamic-table-builder/stories/3-row-readwrite-api-with-generated-validation.md`
  summary: Consider surfacing (logging/metric) when a field-edit's synchronous cache invalidation runs but the underlying DDL job hasn't completed yet, so a DML request in that narrow window fails with a raw Postgres "column does not exist" error instead of a clearer message
  evidence: Confirmed by edge-case-hunter review. `enqueueFieldEdit()` invalidates the validation-schema cache synchronously (so the next DML validates against the *intended* post-edit shape), but the physical `ALTER TABLE` only completes asynchronously via the DDL queue -- a request landing in that gap validates successfully against fields the physical table doesn't have yet, and fails with an unmapped DB-level error rather than the module's structured envelope. Narrow window, self-resolves once the job completes, not a correctness/data-safety issue.

- source_spec: `_bmad-output/specs/spec-dynamic-table-builder/stories/3-row-readwrite-api-with-generated-validation.md`
  summary: Decide whether an empty `_meta_fields.config.enum: []` (as opposed to an absent `enum` key) should be treated as "no constraint" rather than "reject every value"
  evidence: Confirmed by edge-case-hunter review. `checkFieldConstraints()`'s enum check only skips when `rule.enum === undefined`; a tenant admin who saves `config: { enum: [] }` (e.g. via a future UI that submits an empty array rather than omitting the key) would make that field permanently unwritable. Self-inflicted via the table's own field config, not attacker-reachable, but a confusing foot-gun once Story 6's frontend exists.

- source_spec: `_bmad-output/specs/spec-dynamic-table-builder/stories/4-many-to-one-linked-record-fields.md`
  summary: A `modify` field-edit naming a field slug that doesn't exist on the table falls through into the destructive expand/contract path with no existence check, building DDL steps against a nonexistent source column
  evidence: Confirmed by edge-case-hunter review; pre-existing gap from Story 2, not introduced by Story 4 -- the new modify-away-from-RELATION guard added in this story's review loop reads `currentField?.data_type`, which is safely `undefined` (not `RELATION`) for a nonexistent field, so it doesn't mask a NEW error but also doesn't fix this older one. Surfaces as a confusing async job failure inside the DDL worker rather than a synchronous 404/400.

- source_spec: `_bmad-output/specs/spec-dynamic-table-builder/stories/4-many-to-one-linked-record-fields.md`
  summary: `listRows`/`getRow`'s relation-resolving `leftJoin` + `json_agg` query composition has no test covering a table with two or more RELATION fields at once
  evidence: Confirmed by two independent review passes. Every existing test exercises exactly one relation field per table; the join-building loop in `buildRowQuery()` should compose correctly per-iteration (unique join alias per field slug), but the multi-join + single shared `groupBy` path is entirely unverified.

- source_spec: `_bmad-output/specs/spec-dynamic-table-builder/stories/4-many-to-one-linked-record-fields.md`
  summary: A RELATION field's DML value passes validation if it's any integer (`Number.isInteger`), including values outside Postgres's 32-bit `integer` column range; such a value causes an unreshaped raw error (SQLSTATE `22003`, not `23503`) instead of the module's standard field-error envelope
  evidence: Confirmed by blind-hunter review. `checkFieldType`'s RELATION branch and `reshapeForeignKeyViolation` both only handle the FK-violation code path; an out-of-range integer fails at the DB with a different, uncaught error class.

- source_spec: `_bmad-output/specs/spec-dynamic-table-builder/stories/4-many-to-one-linked-record-fields.md`
  summary: `reshapeForeignKeyViolation`'s error message is a fixed generic string ("one or more relation fields reference a row that does not exist") that never names the specific field/relation that violated the constraint, unlike every other field-error in this module
  evidence: Confirmed by blind-hunter review. Postgres's own error object typically carries `error.constraint`/`error.detail`, which could be parsed to name the offending column, consistent with how `checkFieldType`/`checkFieldConstraints` already name the specific field slug in their messages.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-permission-gated-onboarding-entry-and-form-shell.md`
  summary: Resolve the planning-doc conflict where UX copy mentions possible manual cleanup while Phase 1 forbids Retry, Cleanup, and manual state-transition controls.
  evidence: Surfaced by Step 4 blind-hunter review against the full dirty-worktree diff. `_bmad-output/planning-artifacts/ux-designs/ux-Flexi-2026-08-21/EXPERIENCE.md` appears to allow a manual cleanup action, while the PRD/epic requirements say failed attempts are view-only in Phase 1. This predates Story 1.1 implementation and belongs in planning-contract cleanup.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-permission-gated-onboarding-entry-and-form-shell.md`
  summary: Choose one canonical setup secret handoff contract: setup link versus raw setup token response.
  evidence: Surfaced by Step 4 blind-hunter review. `_bmad-output/specs/spec-super-admin-tenant-onboarding/SPEC.md` describes raw `setupToken` response fields while PRD/UX requirements emphasize Setup Link handoff. Story 1.1 does not implement setup handoff, so this should be resolved before Epic 2/3 setup-link stories.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-permission-gated-onboarding-entry-and-form-shell.md`
  summary: Specify the onboarding idempotency key source, payload comparison behavior, conflict status, retry response shape, and retention window.
  evidence: Surfaced by Step 4 blind-hunter review. The planning artifacts require idempotent onboarding but do not fully define the request identity contract. Story 1.1 intentionally has no submit API; this should be resolved before Story 1.4.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-permission-gated-onboarding-entry-and-form-shell.md`
  summary: Add a non-demo permission catalog or migration path for `system.tenants.onboard` so non-seeded environments receive the permission.
  evidence: Surfaced by Step 4 review. Story 1.1 seeds the demo PlatformAdmin role so the local allowed path works, but the repository still lacks a real permission-management or catalog migration story for production-like environments.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-permission-gated-onboarding-entry-and-form-shell.md`
  summary: Add a frontend assertion runner and committed route/component tests for permission-gated onboarding entry.
  evidence: Surfaced by Step 4 verification-gap review. The repo has Storybook variants and this run used a temporary headless Storybook probe for matrix audit, but `apps/frontend` still has no committed test runner for assertions such as permitted SystemUser sees the CTA, unpermitted users do not, and denied direct route renders no form.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-4-idempotent-submission-handling.md`
  summary: Add slug-level onboarding attempt reservation so different idempotency keys cannot create multiple accepted attempts for the same tenant slug before provisioning creates a Tenant row.
  evidence: Story 1.4 prevents duplicate same-key submissions, but review found the broader intake flow can still accept repeated same-slug attempts when operators use different idempotency keys before downstream provisioning consumes the slug.

- source_spec: `_bmad-output/implementation-artifacts/spec-2-2-tenant-schema-provisioning-and-bootstrap-migration.md`
  summary: Add a terminal/dead-letter path for tenant onboarding attempts whose schema or bootstrap-migration step fails permanently (BullMQ retries exhausted), since today the tenant is left stuck at `PROVISIONING` forever with no alert.
  evidence: Blind-hunter review of Story 2.2 found `provisionTenantSchema()` always re-throws and relies on BullMQ retrying, but once retries are exhausted nothing marks the attempt/tenant as terminally failed or notifies an operator. The spec's own Boundaries reserve "permanent failure recording" for Story 2.6, so this is explicitly out of Story 2.2's scope.

- source_spec: `_bmad-output/implementation-artifacts/spec-2-2-tenant-schema-provisioning-and-bootstrap-migration.md`
  summary: Apply a DDL statement/lock timeout (mirroring `DdlWorker`'s `setDdlTimeouts()`) to the `CREATE SCHEMA IF NOT EXISTS` call in `createTenantSchema()`, which currently runs unbounded and can hang a worker slot under lock contention.
  evidence: Blind-hunter review of Story 2.2 found this is inconsistent with the rest of the codebase's DDL discipline. Adjusting timeout budgets is explicitly "Ask First" in Story 2.2's Boundaries, so it was left out of this story.

- source_spec: `_bmad-output/implementation-artifacts/spec-2-2-tenant-schema-provisioning-and-bootstrap-migration.md`
  summary: Guard `provisionTenantSchema()` (or its callers) against re-running `CREATE SCHEMA`/`ensureMetaTables()` against a tenant whose status has already moved past `PROVISIONING` (e.g. a stale retried job reprocessed long after activation).
  evidence: Blind-hunter review of Story 2.2 found no check that the linked tenant is still `PROVISIONING` before re-provisioning on a retry. Touching tenant activation/lifecycle-status branching is out of Story 2.2's scope per its Boundaries (`Never ... Set Tenant.status = ACTIVE in this story`).
