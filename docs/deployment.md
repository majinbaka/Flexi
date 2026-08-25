# Production deployment

`docker-compose.prod.yml` deploys the browser-facing frontend, Nest backend,
and PostgreSQL. The frontend proxies same-origin `/api` requests to the backend;
PostgreSQL has no published host port and exists only on the internal `data`
network. The deployment intentionally does not run a demo seed.

## Prerequisites and environment contract

Install Docker Engine with the Compose plugin on the deployment host. Put TLS
termination and the public reverse proxy in front of `127.0.0.1:$FRONTEND_PORT`;
do not expose the unencrypted container port directly to the internet.

Provide these values through the deployment system's secret store or a
host-protected environment file that is never committed. Compose fails before
creating services when any value marked required is absent.

| Variable                                                                | Required | Notes                                                                                                       |
| ----------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`                     | Yes      | Unique database credentials; do not use the development defaults.                                           |
| `DATABASE_URL`                                                          | Yes      | PostgreSQL URL for that same database, including `?schema=public`; URL-encode reserved password characters. |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`                               | Yes      | Separate random secrets, at least 64 characters; rotate through a planned auth-session invalidation.        |
| `CORS_ORIGIN`                                                           | Yes      | Comma-separated public HTTPS frontend origins only, with no path.                                           |
| `SETUP_ACCOUNT_URL_BASE`                                                | Yes      | Public HTTPS frontend origin, also present in `CORS_ORIGIN`.                                                |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM` | Yes      | Production invitation delivery configuration.                                                               |
| `FRONTEND_PORT`                                                         | Yes      | Host loopback port used by the external reverse proxy.                                                      |
| `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN`                       | No       | Defaults: `15m` and `7d`.                                                                                   |
| `TRUST_PROXY_HOPS`                                                      | No       | Defaults to `1` for the bundled nginx proxy; adjust only when the actual proxy chain changes.               |
| `SMTP_SECURE`, `SMTP_TIMEOUT_MS`                                        | No       | Defaults: `false`, `10000`. Set `SMTP_SECURE=true` for implicit-TLS SMTP.                                   |

The backend validates production values on startup: CORS and setup origins must
match, setup links must use HTTPS, SMTP is mandatory, and JWT secrets must be
distinct and strong. Keep the environment file mode `0600`, and use a secret
manager where the platform supports one.

## Deploy and verify

From the repository root, make the required environment available, then build
and start the stack:

```bash
docker compose --env-file /secure/flexi-production.env -f docker-compose.prod.yml up -d --build
docker compose --env-file /secure/flexi-production.env -f docker-compose.prod.yml ps
```

The `migrations` service is a one-shot gate. It runs `prisma migrate deploy`
only after PostgreSQL is healthy; the backend starts only when that service
exits successfully, and the frontend starts only after backend liveness is
healthy. Check a failed gate before retrying:

```bash
docker compose --env-file /secure/flexi-production.env -f docker-compose.prod.yml logs migrations
curl --fail http://127.0.0.1:$FRONTEND_PORT/api/health
curl --fail http://127.0.0.1:$FRONTEND_PORT/api/health/ready
```

`/api/health` is a process liveness check. `/api/health/ready` additionally
checks PostgreSQL and the PostgreSQL-backed queue; use readiness for rollout
verification. After a successful deploy, verify the public TLS endpoint,
login, and a first-admin invitation delivery using a controlled account.

For a routine image update, retain the same database volume and run the same
`up -d --build` command. `prisma migrate deploy` records applied migrations and
is safe to re-run; never substitute `prisma migrate dev` or a seed command in
production.

## Backup and restore

Take a logical backup before every release that includes a migration, and test
restore procedures in a non-production environment. This command writes a
custom-format dump into a protected backup directory on the host:

```bash
docker compose --env-file /secure/flexi-production.env -f docker-compose.prod.yml exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > /secure/backups/flexi-$(date +%F-%H%M%S).dump
```

Also retain an off-host, encrypted copy according to the organization's
recovery policy. Confirm that a backup is readable before treating it as a
rollback checkpoint:

```bash
pg_restore --list /secure/backups/flexi-YYYY-MM-DD-HHMMSS.dump > /dev/null
```

Restoration overwrites database contents. First stop all application writers,
take one final backup, and record the exact image and dump names. Restore into a
fresh PostgreSQL volume (preferred) or a maintenance window, then start the
matching application image and verify the readiness endpoint before allowing
traffic. Do not run restore commands against an active production database.

## Rollback after a migration

Prisma production deployment applies forward-only migrations; this repository
does not provide automatic down migrations. A rollback is therefore a planned
operation, not `docker compose down -v`.

1. Put the public proxy into maintenance mode and stop frontend/backend writers.
2. Preserve the failed-release logs and take a final backup/checkpoint.
3. If the migration is backward compatible, deploy the previous application image and verify it against the migrated schema.
4. If schema reversal is needed, restore the pre-release backup into a fresh volume, deploy the previous image, and validate `/api/health/ready` plus critical flows before reopening traffic.
5. Keep the failed volume and backup until the incident review approves their removal.

Never delete `flexi_postgres_data` as a rollback shortcut. Volume removal and
database restoration are destructive and require a verified backup, an explicit
maintenance window, and a recovery owner.
