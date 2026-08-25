---
name: storybook-frontend-ui
description: Use whenever creating or editing a Storybook story or any `.mdx` file in `apps/frontend/src`, including documentation-only changes; render tables and UI examples with existing frontend primitives.
---

# Storybook frontend UI

Use this skill for Storybook stories and `.mdx` documentation in the Flexi
frontend. The result should render the product UI, rather than relying on
Markdown constructs to imitate it.

## Activation

Select this skill for every change to a `.mdx` file under `apps/frontend/src`,
even when the request only says "documentation", "specification", or
"Storybook docs". MDX documentation can introduce tables and interface
examples just as stories can, so it must follow the same UI-primitive rules.

## Rendering rules

- For tabular information, use the frontend `Table` component from
  `src/components/ui` (directly or through a small docs-specific adapter).
  Do not add GitHub-flavoured Markdown tables to Storybook MDX.
- For interface examples, states, controls, badges, cards, inputs, and icons,
  compose the matching component exported by `src/components/ui`; do not
  recreate its visual appearance with Markdown, raw HTML, or ad-hoc styles.
- Import UI primitives through `src/components/ui`'s barrel export. Use the
  design-token Tailwind utilities when small layout wrappers are necessary.
- Markdown remains appropriate for document structure and non-UI content:
  headings, paragraphs, short lists, links, inline code, and fenced commands.

## Working in MDX

1. Inspect nearby stories and the UI primitive's props before authoring an
   example. Keep the example valid with the component's public API.
2. If several docs pages need the same presentation, add a focused React
   helper next to the docs and make it delegate to the frontend primitive.
   Keep product data in the MDX page rather than duplicating UI behaviour.
3. After editing, search the Storybook MDX files for Markdown-table delimiter
   rows (`| ---`) and replace any findings with the frontend table.
4. Validate with `pnpm --filter @flexi/frontend build-storybook` when the
   environment permits. At a minimum, run the frontend TypeScript build.

Do not alter the UI primitive merely to accommodate static documentation
unless the component itself has a genuine product requirement.
