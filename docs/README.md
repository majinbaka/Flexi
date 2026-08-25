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
- [`brainstorming/`](./brainstorming) -- intentionally empty after removing an
  unreferenced, rendered session export. Its curated intent record is in
  Storybook.
- [`process/`](./process) -- living process docs, including
  `deferred-work.md` (the current, verified backlog).
- [`reports/`](./reports) -- code-and-documentation audit reports. The latest
  Storybook/code inventory is also rendered in Storybook through its
  **Docs → Current Product State** entry point.

Raw HTML exports are not retained when a curated Markdown/MDX source already
captures their relevant decisions. Historical specs are marked in place;
current code, tests and **Docs → Current Product State** take precedence for
release status.

No BMad working-state directory is retained in this repository. Only curated
documentation and the audit reports above are kept.
