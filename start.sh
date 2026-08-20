#!/usr/bin/env bash
#
# start.sh -- khởi động toàn bộ hệ thống Flexi ở chế độ development.
#
#   1. Hạ tầng  : Postgres + Redis qua docker compose (chờ healthcheck)
#   2. Database : prisma generate + migrate deploy (+ seed nếu có)
#   3. Backend  : NestJS      http://localhost:3000/api
#   4. Frontend : Vite/React  http://localhost:5173
#   5. Storybook: tài liệu MDX + component workshop  http://localhost:6006
#   6. Prisma Studio (tuỳ chọn, --studio)            http://localhost:5555
#
# Log của từng service ghi vào .logs/<service>.log. Ctrl-C dừng tất cả.
#
# Cách dùng:
#   ./start.sh                    # chạy full stack
#   ./start.sh --no-storybook     # bỏ Storybook
#   ./start.sh --studio           # bật thêm Prisma Studio
#   ./start.sh --only backend,frontend
#   ./start.sh --infra-only       # chỉ Postgres/Redis + migrate
#   ./start.sh --seed             # chạy prisma seed
#   ./start.sh --fresh            # xoá volume DB rồi migrate lại từ đầu
#   ./start.sh --skip-install     # bỏ qua pnpm install
#   ./start.sh --skip-migrate     # bỏ qua prisma generate/migrate
#   ./start.sh --no-backend --no-frontend --no-storybook
#   ./start.sh --help

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

LOG_DIR="$ROOT_DIR/.logs"
PIDS=()
PID_NAMES=()

# ---------------------------------------------------------------- options ---
RUN_BACKEND=1
RUN_FRONTEND=1
RUN_STORYBOOK=1
RUN_STUDIO=0
INFRA_ONLY=0
DO_SEED=0
DO_FRESH=0
SKIP_INSTALL=0
SKIP_MIGRATE=0
ONLY_SET=""

usage() { sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-backend)   RUN_BACKEND=0 ;;
    --no-frontend)  RUN_FRONTEND=0 ;;
    --no-storybook) RUN_STORYBOOK=0 ;;
    --studio)       RUN_STUDIO=1 ;;
    --infra-only)   INFRA_ONLY=1 ;;
    --seed)         DO_SEED=1 ;;
    --fresh)        DO_FRESH=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --skip-migrate) SKIP_MIGRATE=1 ;;
    --only)
      ONLY_SET="${2:-}"
      [[ -z "$ONLY_SET" ]] && { echo "--only cần danh sách, ví dụ: --only backend,frontend" >&2; exit 1; }
      shift ;;
    --only=*)       ONLY_SET="${1#*=}" ;;
    -h|--help)      usage ;;
    *) echo "Tham số không hợp lệ: $1 (dùng --help)" >&2; exit 1 ;;
  esac
  shift
done

if [[ -n "$ONLY_SET" ]]; then
  RUN_BACKEND=0; RUN_FRONTEND=0; RUN_STORYBOOK=0; RUN_STUDIO=0
  IFS=',' read -ra _only <<< "$ONLY_SET"
  for svc in "${_only[@]}"; do
    case "${svc// /}" in
      backend|be)      RUN_BACKEND=1 ;;
      frontend|fe|web) RUN_FRONTEND=1 ;;
      storybook|docs)  RUN_STORYBOOK=1 ;;
      studio|db-ui)    RUN_STUDIO=1 ;;
      *) echo "Service không rõ trong --only: $svc" >&2; exit 1 ;;
    esac
  done
fi

if [[ $INFRA_ONLY -eq 1 ]]; then
  RUN_BACKEND=0; RUN_FRONTEND=0; RUN_STORYBOOK=0; RUN_STUDIO=0
fi

# ------------------------------------------------------------------- log ----
c_reset=$'\033[0m'; c_dim=$'\033[2m'; c_red=$'\033[31m'
c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_blue=$'\033[36m'
if [[ ! -t 1 ]]; then c_reset=; c_dim=; c_red=; c_green=; c_yellow=; c_blue=; fi

info() { printf '%s==>%s %s\n' "$c_blue" "$c_reset" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$c_green" "$c_reset" "$*"; }
warn() { printf '%swarn%s %s\n' "$c_yellow" "$c_reset" "$*" >&2; }
die()  { printf '%serr %s %s\n' "$c_red" "$c_reset" "$*" >&2; exit 1; }

# --------------------------------------------------------------- cleanup ----
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  if [[ ${#PIDS[@]} -gt 0 ]]; then
    echo
    info "Đang dừng các service..."
    for i in "${!PIDS[@]}"; do
      local pid="${PIDS[$i]}"
      kill -0 "$pid" 2>/dev/null || continue
      # Nest/Vite/Storybook chạy dưới process group riêng -> kill cả group.
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    done
    local waited=0
    while [[ $waited -lt 10 ]]; do
      local alive=0
      for pid in "${PIDS[@]}"; do kill -0 "$pid" 2>/dev/null && alive=1; done
      [[ $alive -eq 0 ]] && break
      sleep 1; waited=$((waited + 1))
    done
    for pid in "${PIDS[@]}"; do
      kill -0 "$pid" 2>/dev/null && { kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; }
    done
    ok "Đã dừng. Hạ tầng docker vẫn chạy -- dừng bằng: docker compose down"
  fi
  exit $code
}
trap cleanup EXIT INT TERM

# ------------------------------------------------------------ preflight -----
need() { command -v "$1" >/dev/null 2>&1 || die "Thiếu '$1' trong PATH. $2"; }

need node   "Cần Node >= 20 (https://nodejs.org)."
need pnpm   "Cài bằng: corepack enable && corepack prepare pnpm@10.18.0 --activate"
need docker "Cần Docker để chạy Postgres/Redis."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || die "Cần Node >= 20, hiện tại $(node -v)."

if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  die "Không tìm thấy 'docker compose' hoặc 'docker-compose'."
fi
docker info >/dev/null 2>&1 || die "Docker daemon chưa chạy. Khởi động Docker rồi thử lại."

mkdir -p "$LOG_DIR"

port_busy() {
  if command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null | grep -Eq "[:.]$1[[:space:]]"
  elif command -v lsof >/dev/null 2>&1; then lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else return 1; fi
}

# ------------------------------------------------------------- env files ----
info "Kiểm tra file .env"
for pair in ".env:.env.example" "apps/backend/.env:apps/backend/.env.example"; do
  target="${pair%%:*}"; example="${pair##*:}"
  if [[ ! -f "$target" && -f "$example" ]]; then
    cp "$example" "$target"; ok "tạo $target từ $example"
  fi
done
if [[ ! -f apps/frontend/.env ]]; then
  printf 'VITE_API_BASE_URL="http://localhost:3000/api"\n' > apps/frontend/.env
  ok "tạo apps/frontend/.env"
fi

# Đọc .env gốc để lấy PORT/POSTGRES_PORT... (bỏ qua comment & dòng trống).
set -a
# shellcheck disable=SC1091
[[ -f .env ]] && source <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env)
[[ -f apps/backend/.env ]] && source <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' apps/backend/.env)
set +a

BACKEND_PORT="${PORT:-3000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
STORYBOOK_PORT="${STORYBOOK_PORT:-6006}"
STUDIO_PORT="${STUDIO_PORT:-5555}"
PG_PORT="${POSTGRES_PORT:-5432}"
PG_USER="${POSTGRES_USER:-flexi}"
PG_DB="${POSTGRES_DB:-flexi}"

# ------------------------------------------------------------- install ------
if [[ $SKIP_INSTALL -eq 0 ]]; then
  info "pnpm install"
  pnpm install --frozen-lockfile 2>&1 | tail -n 5 || {
    warn "--frozen-lockfile thất bại, thử lại không frozen"
    pnpm install 2>&1 | tail -n 5
  }
  ok "dependencies sẵn sàng"
else
  warn "bỏ qua pnpm install (--skip-install)"
fi

# --------------------------------------------------------------- docker -----
if [[ $DO_FRESH -eq 1 ]]; then
  warn "--fresh: xoá container + volume dữ liệu Postgres/Redis"
  "${DC[@]}" down -v --remove-orphans || true
fi

info "Khởi động hạ tầng (postgres, redis)"
"${DC[@]}" up -d postgres redis

wait_healthy() {
  local name="$1" cid deadline=$((SECONDS + 120)) status
  cid="$("${DC[@]}" ps -q "$name")"
  [[ -n "$cid" ]] || die "Không tìm thấy container cho service '$name'."
  while [[ $SECONDS -lt $deadline ]]; do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo unknown)"
    case "$status" in
      healthy|running) ok "$name: $status"; return 0 ;;
      exited|dead) die "$name dừng bất thường. Xem: ${DC[*]} logs $name" ;;
    esac
    sleep 2
  done
  die "$name không healthy sau 120s. Xem: ${DC[*]} logs $name"
}
wait_healthy postgres
wait_healthy redis

# ------------------------------------------------------------- database -----
if [[ $SKIP_MIGRATE -eq 0 ]]; then
  info "Prisma: generate client"
  pnpm --filter @flexi/backend exec prisma generate >"$LOG_DIR/prisma.log" 2>&1 \
    || { tail -n 30 "$LOG_DIR/prisma.log"; die "prisma generate thất bại (xem $LOG_DIR/prisma.log)"; }
  ok "prisma client đã generate"

  info "Prisma: áp dụng migrations"
  if ! pnpm --filter @flexi/backend exec prisma migrate deploy >>"$LOG_DIR/prisma.log" 2>&1; then
    tail -n 30 "$LOG_DIR/prisma.log"
    die "prisma migrate deploy thất bại (xem $LOG_DIR/prisma.log)"
  fi
  ok "migrations đã áp dụng ($PG_USER@localhost:$PG_PORT/$PG_DB)"

  if [[ $DO_SEED -eq 1 ]]; then
    info "Prisma: seed dữ liệu"
    if pnpm --filter @flexi/backend run prisma:seed >>"$LOG_DIR/prisma.log" 2>&1; then
      ok "seed xong"
    else
      tail -n 30 "$LOG_DIR/prisma.log"; die "seed thất bại (xem $LOG_DIR/prisma.log)"
    fi
  fi
else
  warn "bỏ qua prisma generate/migrate (--skip-migrate)"
fi

if [[ $INFRA_ONLY -eq 1 ]]; then
  ok "Hạ tầng + database đã sẵn sàng (--infra-only). Không khởi động app."
  trap - EXIT INT TERM
  exit 0
fi

# ------------------------------------------------------------- services -----
start_service() {
  local name="$1" port="$2"; shift 2
  local log="$LOG_DIR/$name.log"

  if [[ -n "$port" ]] && port_busy "$port"; then
    warn "$name: cổng $port đang bận -- bỏ qua (service khác có thể đã chạy)"
    return 0
  fi

  : > "$log"
  # setsid -> mỗi service một process group, cleanup kill được cả cây con.
  setsid "$@" >>"$log" 2>&1 &
  local pid=$!
  PIDS+=("$pid"); PID_NAMES+=("$name")
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    tail -n 30 "$log"; die "$name không khởi động được (xem $log)"
  fi
  ok "$name đã khởi động (pid $pid, log $log)"
}

wait_http() {
  local name="$1" url="$2" deadline=$((SECONDS + 180))
  command -v curl >/dev/null 2>&1 || { sleep 3; return 0; }
  while [[ $SECONDS -lt $deadline ]]; do
    if curl -fsS -o /dev/null --max-time 3 "$url" 2>/dev/null; then ok "$name sẵn sàng: $url"; return 0; fi
    sleep 2
  done
  warn "$name chưa phản hồi sau 180s: $url (xem $LOG_DIR/$name.log)"
}

[[ $RUN_BACKEND -eq 1 ]] && \
  start_service backend "$BACKEND_PORT" pnpm --filter @flexi/backend run start:dev
[[ $RUN_FRONTEND -eq 1 ]] && \
  start_service frontend "$FRONTEND_PORT" pnpm --filter @flexi/frontend run dev --port "$FRONTEND_PORT" --strictPort
[[ $RUN_STORYBOOK -eq 1 ]] && \
  start_service storybook "$STORYBOOK_PORT" pnpm --filter @flexi/frontend exec storybook dev -p "$STORYBOOK_PORT" --no-open
[[ $RUN_STUDIO -eq 1 ]] && \
  start_service studio "$STUDIO_PORT" pnpm --filter @flexi/backend exec prisma studio --port "$STUDIO_PORT" --browser none

[[ ${#PIDS[@]} -eq 0 ]] && { ok "Không có service nào cần chạy."; trap - EXIT INT TERM; exit 0; }

[[ $RUN_BACKEND -eq 1 ]]  && wait_http backend  "http://localhost:$BACKEND_PORT/api/health"
[[ $RUN_FRONTEND -eq 1 ]] && wait_http frontend "http://localhost:$FRONTEND_PORT"

# --------------------------------------------------------------- summary ----
echo
printf '%s──────────────── Flexi đang chạy ────────────────%s\n' "$c_green" "$c_reset"
printf '  Postgres   localhost:%s  (db=%s user=%s)\n' "$PG_PORT" "$PG_DB" "$PG_USER"
printf '  Redis      localhost:%s\n' "${REDIS_PORT:-6379}"
[[ $RUN_BACKEND   -eq 1 ]] && printf '  Backend    http://localhost:%s/api\n' "$BACKEND_PORT"
[[ $RUN_FRONTEND  -eq 1 ]] && printf '  Frontend   http://localhost:%s\n' "$FRONTEND_PORT"
[[ $RUN_STORYBOOK -eq 1 ]] && printf '  Tài liệu   http://localhost:%s  (Storybook + MDX docs)\n' "$STORYBOOK_PORT"
[[ $RUN_STUDIO    -eq 1 ]] && printf '  DB Studio  http://localhost:%s\n' "$STUDIO_PORT"
printf '%s  Log: %s/*.log   |   Ctrl-C để dừng tất cả%s\n' "$c_dim" "${LOG_DIR#$ROOT_DIR/}" "$c_reset"
printf '%s─────────────────────────────────────────────────%s\n\n' "$c_green" "$c_reset"

# Chạy tới khi có service chết hoặc người dùng Ctrl-C.
while true; do
  for i in "${!PIDS[@]}"; do
    if ! kill -0 "${PIDS[$i]}" 2>/dev/null; then
      warn "Service '${PID_NAMES[$i]}' đã thoát -- dừng toàn bộ."
      tail -n 20 "$LOG_DIR/${PID_NAMES[$i]}.log" 2>/dev/null || true
      exit 1
    fi
  done
  sleep 2
done
