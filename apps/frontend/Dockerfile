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

RUN pnpm install --frozen-lockfile --filter @flexi/frontend...

FROM dependencies AS build

# The API base is embedded by Vite at build time. Its default (/api) is
# reverse-proxied by nginx.conf to the backend service in production compose.
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

COPY packages/shared-types ./packages/shared-types
COPY apps/frontend/index.html apps/frontend/package.json apps/frontend/postcss.config.js apps/frontend/tailwind.config.js apps/frontend/tsconfig.json apps/frontend/vite.config.ts ./apps/frontend/
COPY apps/frontend/src ./apps/frontend/src

RUN pnpm --filter @flexi/shared-types build && pnpm --filter @flexi/frontend build

FROM nginxinc/nginx-unprivileged:1.28-alpine AS production

COPY --chown=nginx:nginx apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chown=nginx:nginx --from=build /app/apps/frontend/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
