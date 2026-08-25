# syntax=docker/dockerfile:1

FROM node:22-alpine AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@10.18.0 --activate

WORKDIR /app

FROM base AS dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/frontend/package.json ./apps/frontend/package.json
COPY packages/shared-types/package.json ./packages/shared-types/package.json

RUN pnpm install --frozen-lockfile --filter @flexi/backend...

FROM dependencies AS build

COPY packages/shared-types ./packages/shared-types
COPY apps/backend/nest-cli.json apps/backend/prisma.config.ts apps/backend/tsconfig.build.json apps/backend/tsconfig.json ./apps/backend/
COPY apps/backend/prisma ./apps/backend/prisma
COPY apps/backend/src ./apps/backend/src

# Client generation is deterministic and does not connect to this placeholder
# database. Runtime credentials are supplied only when the container starts.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build \
    pnpm --filter @flexi/shared-types build && \
    pnpm --filter @flexi/backend prisma:generate && \
    pnpm --filter @flexi/backend build && \
    pnpm --filter @flexi/backend --prod deploy --legacy /app/production && \
    source_prisma_dir="$(dirname "$(dirname "$(find node_modules/.pnpm -path '*/node_modules/.prisma/client/default.js' -type f -print -quit)")")" && \
    target_node_modules_dir="$(dirname "$(dirname "$(dirname "$(find production/node_modules/.pnpm -path '*/node_modules/@prisma/client/default.js' -type f -print -quit)")")")" && \
    cp -R "$source_prisma_dir" "$target_node_modules_dir/.prisma"

# This target intentionally retains Prisma CLI and source files so the
# production compose migration job can run `pnpm ... prisma:deploy` once.
FROM build AS migrations

CMD ["pnpm", "--filter", "@flexi/backend", "prisma:deploy"]

FROM node:22-alpine AS production

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

COPY --chown=node:node --from=build /app/production/node_modules ./node_modules
COPY --chown=node:node --from=build /app/apps/backend/dist ./dist

USER node

EXPOSE 3000

# Liveness deliberately checks the process-only endpoint. Database and queue
# readiness are exposed separately at /api/health/ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/src/main.js"]
