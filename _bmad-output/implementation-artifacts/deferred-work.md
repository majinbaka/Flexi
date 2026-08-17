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
  summary: Add a Prisma seed script that bootstraps the `Permission` catalog and default roles/role-permissions
  evidence: Review noted no seed data exists for the `Permission`/`RolePermission` tables; needed before Phase 1 Auth/RBAC work can be exercised locally, but out of scope for a scaffold with no real auth logic yet.

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
