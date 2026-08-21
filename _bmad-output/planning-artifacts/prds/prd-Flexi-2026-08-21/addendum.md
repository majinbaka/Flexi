# Addendum: Tenant Provisioning Technical Context

This addendum preserves technical depth and source rationale gathered during PRD discovery. The PRD should express product requirements and constraints; implementation mechanics here should feed architecture and build work.

## User-Provided Technical Context

- Flexi uses a schema-per-tenant architecture. Provisioning a tenant means creating a new PostgreSQL schema, applying the latest tenant bootstrap migrations, seeding defaults, creating the first Tenant Admin identity, mapping that admin to the new tenant, and activating only after the flow completes.
- The current process depends on engineers manually running SQL scripts and migrations, creating risk from mistyped schema/subdomain values, missing grants, partial migrations, and undocumented manual cleanup.
- The target flow should run as a background job rather than inside the synchronous request/response path, because schema creation and migration replay are heavy and failure-prone.
- Ops needs progress visibility at the step level so they can see whether provisioning is validating input, creating the tenant, creating the schema, running migrations, seeding defaults, creating the first admin, assigning role, generating setup link, activating, or failing.
- The first customer admin receives a one-time setup link or an automated setup email after successful provisioning.

## Phase 1 Decisions Captured After Draft

- Bootstrap before activation includes the First Admin in `pending_setup`, Default RBAC Roles (Admin/Tenant Admin, Manager, Member) with permission matrices, System Settings (locale, timezone, base currency, configuration flags), and Core Lookup Data (default status workflows, categories, initial system notification templates).
- Bootstrap RBAC matrix: Admin/Tenant Admin has full user/role management, workspace settings/modules, core business objects including hard delete/export, and audit-log read/export; Manager has directory/settings read-only, core business create/read/update/soft-delete, and no audit access; Member has directory read-only, own-record core business create/read/update, and no workspace/audit access.
- Production default seed objects: workflow statuses `Draft` -> `In Review` -> `Active` -> `Archived`; categories `General`, `Operations`, `Administrative`; notification templates `WELCOME_SETUP_INVITE`, `PASSWORD_RESET_REQUEST`, and `WORKSPACE_LIMIT_WARNING`.
- Setup Link expiration defaults to 24 hours. If expired, Ops can regenerate the link from the Super Admin Dashboard.
- Setup Link regeneration uses `system.tenants.onboard` for MVP because the same Ops users handling tenant creation also handle initial setup support. A narrower credential-support permission is deferred until Flexi introduces a distinct support team that should not have provisioning rights.
- Email delivery failure is warning-only across all customer plans because the Setup Link is displayed directly to Ops for copy/manual handoff. The UI should show `Email Delivery Failed (Copy Link Manually)` when SMTP fails after successful link generation.
- MVP history filters are status, subdomain/keyword search over tenant name or slug, and created-at date range. Actor is displayed but actor filtering is deferred.
- Migration replay remains the default provisioning strategy until p95 provisioning latency exceeds 30 seconds or tenant schema migration files exceed 50. That threshold creates a safety buffer before the 1-minute hard SLA and triggers architecture evaluation of PostgreSQL template schema cloning.

## Source Inputs

- `/home/anhnv/Code/flexi/_bmad-output/planning-artifacts/schema-per-tenant-implementation-guide.md`
- `/home/anhnv/Code/flexi/_bmad-output/planning-artifacts/architecture/architecture-flexi-2026-08-20/ARCHITECTURE-SPINE.md`
- `/home/anhnv/Code/flexi/_bmad-output/specs/spec-super-admin-tenant-onboarding/SPEC.md`
- `/home/anhnv/Code/flexi/_bmad-output/specs/spec-super-admin-tenant-onboarding/failure-modes.md`
- `/home/anhnv/Code/flexi/_bmad-output/planning-artifacts/research/technical-schema-per-tenant-implementation-2026-08-18/research.md`
- `/home/anhnv/Code/flexi/_bmad-output/planning-artifacts/research/technical-dynamic-table-builder-schema-2026-08-17/research.md`
