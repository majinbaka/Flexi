---
title: 'Figma Design Sync Workflow'
type: 'chore'
created: '2026-08-17'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: '5db47b15ea06bed3e1057842ad84db2d64d5bac1'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Figma file "Untitled" (`zhLrZDSvhw2cHAUWR0cnOU`) is now reachable via a connected `figma` MCP server, but the project has no established process for turning that design into frontend code — no design tokens exist (all styling is scattered inline `CSSProperties` in components like `Layout.tsx`/`Sidebar.tsx`), and there is no record of which Figma frames map to which parts of the app.

**Approach:** Stand up a lightweight, zero-new-dependency foundation — a central CSS token file plus a documented workflow and a mapping ledger — so that whenever a future feature spec touches UI, the implementer pulls the matching Figma frame through the `figma` MCP server, lands any new values into the shared tokens file, and records the mapping in the ledger. No specific screen is implemented now; the whole file is synced gradually, one feature at a time.

## Boundaries & Constraints

**Always:** Design values (color, typography, spacing, radii) sourced from Figma go into one central token file (`apps/frontend/src/styles/tokens.css`) as CSS custom properties, reused instead of re-hardcoded. Every future feature spec whose scope includes UI must consult `docs/figma-design-sync.md` and update `figma-sync-ledger.md` with the Figma node it implemented.

**Ask First:** Introducing any new frontend styling dependency (Tailwind, CSS-in-JS, component library) — this spec deliberately stays dependency-free given the project's current scaffold phase; escalate before adding one.

**Never:** Do not implement or restyle any specific page/component in this spec — that happens incrementally in later feature work. Do not write the Figma personal access token into any git-tracked file (it is already stored via `claude mcp add -s local`, outside version control).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh clone | Developer opens repo, no prior Figma sync done | `docs/figma-design-sync.md` explains file key, MCP server name, and step-by-step process | N/A |
| First feature touches UI | Dev follows workflow for a given Figma frame | New tokens land in `tokens.css`; ledger gets one new row for that frame | If the `figma` MCP tools aren't visible, doc notes a Claude Code session reload is required |

</frozen-after-approval>

## Code Map

- `apps/frontend/src/main.tsx` -- entry point; add one import so tokens load app-wide from boot.
- `apps/frontend/src/components/Layout.tsx`, `apps/frontend/src/components/Sidebar.tsx` -- current inline-style pattern; future migration targets, not touched by this spec.
- `apps/frontend/src/styles/` -- does not exist yet; new home for `tokens.css`.
- `README.md` -- add a short pointer section linking to the new workflow doc; existing "Repository layout" section (lines 16-25) is the natural anchor.
- `_bmad-output/implementation-artifacts/` -- location for the new ledger file, consistent with other implementation artifacts.
- MCP server `figma` already registered (`claude mcp add figma -s local -e FIGMA_API_KEY=... -- npx -y figma-developer-mcp --stdio`), local scope, not in any tracked file. Tools require a Claude Code session reload to appear.

## Tasks & Acceptance

**Execution:**
- [x] `apps/frontend/src/styles/tokens.css` -- create with an empty `:root { }` block and category comments (colors, typography, spacing, radii) -- single landing place for all future Figma-sourced values.
- [x] `apps/frontend/src/main.tsx` -- add `import './styles/tokens.css';` -- tokens are available globally from app boot.
- [x] `docs/figma-design-sync.md` -- new file documenting: Figma file key `zhLrZDSvhw2cHAUWR0cnOU`, MCP server name `figma`, the reload-required note, and the per-feature workflow (fetch frame → extract tokens into `tokens.css`, reusing existing ones first → implement the component against tokens → update the ledger) -- durable reference for every future UI-touching spec.
- [x] `_bmad-output/implementation-artifacts/figma-sync-ledger.md` -- new file with a table header (`Figma node | node-id | Frontend path | Status | Last synced | Notes`) and zero data rows -- tracks gradual whole-file sync progress.
- [x] `README.md` -- add a "Design workflow" subsection near "Repository layout" linking to `docs/figma-design-sync.md` -- makes the process discoverable without duplicating it.

**Acceptance Criteria:**
- Given a fresh clone, when a developer opens `docs/figma-design-sync.md`, then they find the Figma file key, MCP server name, and the exact per-feature steps including the ledger update.
- Given `apps/frontend/src/main.tsx`, when the app boots, then `tokens.css` custom properties are present under `:root` in devtools.
- Given the ledger file, when this spec is done, then it contains only the header row — no design has been applied yet.

## Spec Change Log

## Design Notes

CSS custom properties (not Tailwind or a CSS-in-JS library) were chosen to keep this zero-dependency, matching the project's current "scaffold, no business logic yet" posture (see `ROADMAP.md`). If a later feature's design complexity outgrows plain variables, that's an "Ask First" trigger for the implementer, not a default to swap in now.

Example ledger row once a feature applies a frame:

```
| Login screen | 12:34 | apps/frontend/src/pages/LoginPage.tsx | done | 2026-08-20 | colors + spacing only |
```

## Verification

**Commands:**
- `pnpm --filter frontend build` -- expected: succeeds (`tsc --noEmit && vite build`), confirming the new CSS import doesn't break the build.

**Manual checks (if no CLI):**
- `pnpm --filter frontend dev`, open devtools, confirm `:root` shows the custom properties defined in `tokens.css`.
- `claude mcp list` shows `figma ... ✔ Connected` (already verified during Step 1).

## Suggested Review Order

**Workflow document (the core deliverable)**

- Read this first — explains why the whole change exists and how future features are meant to use it.
  [`figma-design-sync.md:1`](../../docs/figma-design-sync.md#L1)

- Reference block: Figma file key, MCP server name, and how to get/register a personal access token.
  [`figma-design-sync.md:8`](../../docs/figma-design-sync.md#L8)

- The 4-step per-feature workflow — fetch frame, land tokens (reusing existing ones first), implement, update ledger.
  [`figma-design-sync.md:55`](../../docs/figma-design-sync.md#L55)

- Re-sync guidance for when a Figma frame's design changes after it was already implemented.
  [`figma-design-sync.md:103`](../../docs/figma-design-sync.md#L103)

**Token foundation**

- Central CSS custom-property file that will hold every future Figma-sourced value; empty by design until the first feature lands one.
  [`tokens.css:1`](../../apps/frontend/src/styles/tokens.css#L1)

- Wires the token file into the app so it loads from boot, ahead of everything else.
  [`main.tsx:4`](../../apps/frontend/src/main.tsx#L4)

**Sync tracking**

- Empty ledger table plus Status legend — the single source of truth for what's been synced so far.
  [`figma-sync-ledger.md:9`](figma-sync-ledger.md#L9)

**Discoverability**

- Design-workflow pointer added where a first-time reader would naturally look.
  [`README.md:28`](../../README.md#L28)

- One-line pointer from the existing roadmap so the workflow doc isn't orphaned.
  [`ROADMAP.md:25`](../../ROADMAP.md#L25)

**Peripherals**

- Three new deferred-work entries (extra token categories, lint enforcement, theming) captured so they aren't lost.
  [`deferred-work.md:85`](deferred-work.md#L85)
