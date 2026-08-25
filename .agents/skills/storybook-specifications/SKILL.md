---
name: storybook-specifications
description: "Create concise, code-traceable functional and technical specifications in Storybook for implemented product features. Use when documenting an existing codebase; do not use to invent requirements or write generic project documentation."
---

# Storybook Specifications

Create a living specification that lets developers, QA, BA, reviewers, and future maintainers understand an implemented feature without reverse-engineering the whole codebase.

## Evidence first

Treat the current implementation as the source of truth. Trace the relevant path as it exists:

`UI → event/action → validation → request/DTO → controller/handler → business logic → data access/query → database or external service → response → UI state`

- Do not infer requirements, architecture layers, API behavior, authorization, states, or database details that code does not establish.
- When evidence is missing, say `Not confirmed from current implementation` at the relevant point.
- When behavior appears anomalous, distinguish `Current implementation: ...` from `Potential issue: ...`; do not silently recast it as an intended requirement or change the code unless requested.
- Cite the relevant files and, where valuable, public methods/classes. Do not list incidental private helpers.

## Work feature by feature

Start by inspecting the project structure and its existing Storybook configuration/documentation conventions. Select one module, feature, screen, or meaningful end-to-end flow. Trace it completely before moving to the next; do not document an entire large project superficially.

For each feature:

1. Identify the entry point, users if evidenced, screens, actions, visible states, and navigation.
2. Trace validation at UI, request/DTO, business, and database levels.
3. Trace requests, responses, transformations, business decisions, persistence, and meaningful errors.
4. Derive the user flow, user-facing acceptance criteria, and technical flow from that trace.
5. Write or update the Storybook MDX/stories following the project’s established patterns. Use component previews only when they make the screen behavior easier to understand.
6. Cross-check every material statement, table row, and diagram against the implementation.

## Organize for navigation, not ceremony

Create a `Specifications` section with a short overview and feature pages grouped by module/feature. Combine sections when the feature is small; split pages only when doing so improves navigation or keeps a page scannable.

Use the outline in [specification-format.md](references/specification-format.md) as a menu of sections. Include only sections that add evidence-backed value. Put each fact in one primary location and reference it elsewhere instead of repeating it.

## Writing and diagram rules

- Favor short paragraphs, clear headings, useful tables, and Mermaid for real decisions, branches, or interactions.
- Make UI-field tables describe only meaningful attributes: type, required/editable/default values, validation, and purpose.
- Separate UI validation, API/DTO validation, business validation, and database constraints. If one rule exists in multiple layers, show the layers without duplicating the explanation.
- Document APIs, DTOs, tables, columns, and external services only when they are used by the feature.
- Keep flowcharts at the decision/process/result level. Sequence diagrams must reflect actual participants—never assume a service, repository, or database layer that the code does not use.
- Explain what the code does and why the behavior matters. Do not transcribe source code, SQL, entire schemas, or boilerplate.

## Completion check

Before calling a feature documented, ensure a reader can determine its purpose, entry point, key UI behavior, validations, success/error paths, relevant request/response contracts, ordered business logic, data access, and implementation locations. Include user stories only for real user goals and write their acceptance criteria from observed behavior.

Optimize in this order: **correctness, sufficient coverage, readability, brevity**. Remove anything that does not help a developer, tester, or BA understand or test the implemented behavior.
