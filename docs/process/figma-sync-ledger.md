# Figma Design Sync Ledger

Tracks progress of the gradual, whole-file sync from the Figma file
`zhLrZDSvhw2cHAUWR0cnOU` ("Untitled") into the frontend. One row per
Figma frame that has been implemented against `tokens.css`. See
[`figma-design-sync.mdx`](../../apps/frontend/src/docs/figma-design-sync.mdx)
(rendered in Storybook's Docs view) for the workflow this ledger is
part of.

**Status legend:** `in-progress` (sync started, not yet matching
Figma) · `done` (matches Figma as of "Last synced") · `stale` (Figma
frame changed since "Last synced", needs a re-sync pass).

| Figma node | node-id | Frontend path | Status | Last synced | Notes |
|------------|---------|----------------|--------|--------------|-------|

No rows yet -- the sync hasn't started. An empty table here is the
expected starting state, not a broken or incomplete file; rows are
added one at a time as feature specs implement each Figma frame.
