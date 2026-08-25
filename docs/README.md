# Documentation

Non-spec output from Flexi's BMad planning/build process, consolidated
here from `_bmad-output/` and organized by kind. Design specs and the
architecture spine live in Storybook instead (`apps/frontend/src/docs/specs/`,
`pnpm --filter @flexi/frontend storybook` -- see the "Specs" section of the
Docs sidebar) so they're browsable next to the components/backend they
describe.

## Layout

- [`product/`](./product) -- PRD (`prd.md` + `prd-addendum.md`) and the
  epics breakdown (`epics.md`).
- [`design/`](./design) -- UX design and experience docs
  (`ux-design.md`, `ux-experience.md`).
- [`research/`](./research) -- technical research behind the dynamic table
  builder and schema-per-tenant pivot, including the raw digest sources
  and the resulting implementation guide.
- [`brainstorming/`](./brainstorming) -- rendered brainstorm session output
  (the underlying intent doc that seeded the Super Admin Tenant Onboarding
  spec lives in Storybook as its companion, not duplicated here).
- [`process/`](./process) -- living process docs, including
  `deferred-work.md` (what's planned vs. deferred and why).
- [`reports/`](./reports) -- code-and-documentation audit reports. The latest
  Storybook/code inventory is also rendered in Storybook through its
  **Docs → Current Product State** entry point.

`_bmad-output/` still holds BMad's own working state (`.memlog.md` session
logs, `sprint-status.yaml` sprint tracking, raw research digests/imports)
that isn't curated documentation and isn't duplicated here.
