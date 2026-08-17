---
title: 'Storybook with MDX Project Documentation'
type: 'feature'
created: '2026-08-17'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: '727b960e37f7f9440289f6116bd67c82e8f066af'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `apps/frontend` has no isolated component workshop, and project process docs (`docs/figma-design-sync.md`) are plain Markdown with no live-preview tooling — there is no single, ready-to-run way to view components or documentation outside the running app.

**Approach:** Add Storybook to `apps/frontend` using its official Vite+React framework with MDX docs support, add first-example stories for the existing `Layout`/`Sidebar` components, and migrate `docs/figma-design-sync.md` into an MDX page rendered inside Storybook's Docs view. Viewing is via the Storybook dev server — no separate MDX viewer tool is needed.

## Boundaries & Constraints

**Always:** Storybook config lives under `apps/frontend/.storybook`; add it via the official `storybook init` CLI (or hand-authored equivalent) using the `@storybook/react-vite` framework so it reuses the existing Vite 5/React 18 toolchain — no second bundler. Expose it via a `storybook` script in `apps/frontend/package.json` (mirroring `dev`/`build`/`preview`), runnable as `pnpm --filter @flexi/frontend storybook`. New `.mdx`/`.stories.tsx` files must pass existing `pnpm lint` and `pnpm format:check` unmodified (Prettier handles `.mdx` natively; no eslint config changes needed since `apps/frontend/**/*.{ts,tsx}` already covers stories files). Reuse `apps/frontend/src/styles/tokens.css` and the existing i18n setup in Storybook previews — no new styling/UI dependency, per `docs/figma-design-sync.md`'s dependency-free constraint.

**Ask First:** If the CLI-resolved Storybook version conflicts with Vite 5.4/React 18.3 and requires a downgrade of either.

**Never:** Do not touch `apps/backend` or `packages/shared-types`. Do not restyle `Layout.tsx`/`Sidebar.tsx` beyond what a story needs. Do not add visual-regression/test-runner addons or a CI job for Storybook — out of scope.

</frozen-after-approval>

## Code Map

- `apps/frontend/package.json` -- add Storybook devDependencies + `storybook`/`build-storybook` scripts
- `apps/frontend/vite.config.ts` -- existing Vite/React setup Storybook's builder must match
- `apps/frontend/tsconfig.json` -- TS config Storybook should respect (strict, `jsx: react-jsx`)
- `apps/frontend/src/main.tsx` -- shows global wiring (imports `tokens.css`, inits i18n) to mirror in `.storybook/preview`
- `apps/frontend/src/components/Layout.tsx`, `Sidebar.tsx` -- existing components needing first `.stories.tsx`
- `apps/frontend/src/i18n/index.ts` -- i18n init `Sidebar`'s `useTranslation` needs in isolation
- `docs/figma-design-sync.md` -- source content to migrate verbatim into MDX
- `README.md` -- "Repository layout" / "Design workflow" sections reference `docs/` and need updating
- `eslint.config.js`, `.prettierignore` -- confirmed no changes needed (verify during implementation, don't assume)

## Tasks & Acceptance

**Execution:**
- [x] `apps/frontend/package.json` -- add `storybook`, `@storybook/react-vite`, MDX-capable docs addon as devDependencies; add `storybook` (dev) and `build-storybook` scripts -- gives the app a Storybook toolchain matching its stack
- [x] `apps/frontend/.storybook/main.ts` -- framework `@storybook/react-vite`; stories glob covering `src/**/*.stories.tsx` and `src/**/*.mdx`; docs addon enabled -- wires Storybook to find stories and MDX docs
- [x] `apps/frontend/.storybook/preview.ts` -- import `../src/styles/tokens.css`, init i18n as `main.tsx` does -- previews render with real tokens/translations
- [x] `apps/frontend/src/components/Layout.stories.tsx` -- story wrapping `Layout` with router context -- first working component example
- [x] `apps/frontend/src/components/Sidebar.stories.tsx` -- story wrapping `Sidebar` with router + i18n context -- second working component example
- [x] `apps/frontend/src/docs/introduction.mdx` (new) -- short welcome page linking to the migrated docs page -- entry point in the Docs sidebar
- [x] `apps/frontend/src/docs/figma-design-sync.mdx` (new, migrated) -- full content of `docs/figma-design-sync.md` carried over, internal links updated for the new location -- makes the process doc viewable in Storybook
- [x] `docs/figma-design-sync.md` -- delete after migration -- avoids two diverging copies of the same doc
- [x] `README.md` -- update `docs/` references to the new MDX path; document `pnpm --filter @flexi/frontend storybook` -- keeps onboarding accurate
- [x] `package.json` (root) -- add `dev:storybook` passthrough script, consistent with existing `dev:*` scripts -- matches repo convention

**Acceptance Criteria:**
- Given dependencies installed, when running `pnpm --filter @flexi/frontend storybook`, then it starts without console errors and the sidebar lists the `Layout`/`Sidebar` stories plus both MDX docs pages.
- Given `figma-design-sync.mdx` open in Storybook's Docs view, then all content from the original `.md` is present and its internal links resolve to valid repo paths.
- Given the changed tree, when running `pnpm lint` and `pnpm format:check`, then both pass with no new violations.

## Design Notes

Use the official `storybook init` (or `storybook@latest`) CLI to resolve a mutually-compatible version set for Storybook + `@storybook/react-vite` + docs addon, rather than hand-picking versions in this spec — registry state changes faster than the spec's shelf life. Latest stable at investigation time was Storybook 10.5.8, compatible with Vite 5 and React 18.

## Verification

**Commands:**
- `pnpm --filter @flexi/frontend storybook` -- expected: dev server starts, prints local URL, no errors
- `pnpm --filter @flexi/frontend build-storybook` -- expected: static build succeeds
- `pnpm lint` -- expected: no new errors
- `pnpm format:check` -- expected: passes
- `pnpm build` -- expected: existing app build still succeeds, unaffected

## Suggested Review Order

**Storybook toolchain wiring**

- Entry point: framework/stories glob that tells Storybook what to load.
  [`main.ts:4`](../../apps/frontend/.storybook/main.ts#L4)

- Reuses app's real tokens/i18n instead of a bare-component sandbox.
  [`preview.ts:2`](../../apps/frontend/.storybook/preview.ts#L2)

- New devDependencies + `storybook`/`build-storybook` scripts driving it.
  [`package.json:28`](../../apps/frontend/package.json#L28)

**Component stories**

- `MemoryRouter` + nested `Routes` decorator so `<Outlet />` has content.
  [`Layout.stories.tsx:14`](../../apps/frontend/src/components/Layout.stories.tsx#L14)

- Simpler router-only decorator; i18n comes from the global preview init.
  [`Sidebar.stories.tsx:14`](../../apps/frontend/src/components/Sidebar.stories.tsx#L14)

**MDX docs migration**

- Verbatim migration of the deleted `docs/figma-design-sync.md`.
  [`figma-design-sync.mdx:1`](../../apps/frontend/src/docs/figma-design-sync.mdx#L1)

- Entry-point doc; link to the migrated page uses Storybook's own `/docs/...` cross-link convention (auto-rewritten by addon-docs at render time — verified with a headless-browser check).
  [`introduction.mdx:15`](../../apps/frontend/src/docs/introduction.mdx#L15)

- Ledger's reference to the old doc path, fixed post-review (was a dead link after the delete).
  [`figma-sync-ledger.md:6`](figma-sync-ledger.md#L6)

**Peripherals**

- Repository layout / design-workflow prose updated to point at the new doc location and `storybook` command.
  [`README.md:46`](../../README.md#L46)

- Root passthrough script matching the existing `dev:*` convention.
  [`package.json:24`](../../package.json#L24)
</content>
