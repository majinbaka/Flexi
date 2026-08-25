# Repository Guidelines

## Project Structure & Module Organization

Flexi is a pnpm monorepo. `apps/backend/` is the NestJS REST API; source modules live in `src/modules/`, common infrastructure in `src/common/`, and Prisma schema/migrations in `prisma/`. `apps/frontend/` is the React/Vite SPA, with pages in `src/pages/`, reusable UI in `src/components/`, i18n in `src/i18n/`, and colocated Storybook stories (`*.stories.tsx`). Shared contracts belong in `packages/shared-types/src/`. Product, design, and process documentation lives in `docs/`; Storybook-rendered specs are under `apps/frontend/src/docs/`.

## Build, Test, and Development Commands

Run commands from the repository root:

```bash
pnpm install                         # install workspace dependencies
docker compose up -d                 # start local Postgres and Redis
pnpm run build:shared-types          # rebuild shared types after edits
pnpm dev:backend                     # Nest API on port 3000
pnpm dev:frontend                    # Vite app on port 5173
pnpm build                           # build shared types, backend, frontend
pnpm lint && pnpm format:check       # validate code quality and formatting
pnpm test                            # run workspace test scripts
pnpm --filter backend test:e2e       # run backend end-to-end tests
```

Copy `.env.example` to `.env` and `apps/backend/.env.example` to `apps/backend/.env` before using local services. Run `pnpm prisma:generate` after Prisma schema changes, and create migrations with `pnpm --filter backend prisma migrate dev --name <change>`.

## Coding Style & Naming Conventions

Use TypeScript and two-space indentation; `.editorconfig` requires LF endings, UTF-8, and final newlines. Prettier is the formatting authority and the root flat ESLint config handles linting. Use `PascalCase` for React components/classes, `camelCase` for functions and values, and Nest-style filenames such as `tenant-context.ts`, `tenant-context.spec.ts`, and `create-table.dto.ts`. Keep frontend API calls in `src/lib/api-client.ts`; build shared enums and DTOs in `shared-types` instead of duplicating contracts.

## Testing Guidelines

Backend unit tests use Jest and are colocated with implementation as `*.spec.ts`; e2e tests live in `apps/backend/test/`. Add focused tests for service, guard, validation, and tenancy changes. There is no configured frontend unit-test runner: add or update nearby Storybook stories for UI behavior. No coverage threshold is enforced, but changed behavior should be tested.

## Commit & Pull Request Guidelines

Follow the existing imperative, concise history: `feat(research): add ...`, `Refactor imports ...`, or `chore: remove ...`. Keep commits scoped. PRs should explain the behavior change, link the relevant issue/story, list validation commands run, and include screenshots or Storybook evidence for visual changes. Flag migrations, environment variables, and tenant-isolation implications explicitly.
