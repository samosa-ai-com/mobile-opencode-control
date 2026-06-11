#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
LOG_DIR="$RUNTIME_DIR/logs"

OPENCODE_PID_FILE="$RUNTIME_DIR/opencode.pid"
OPENCODE_PORT_FILE="$RUNTIME_DIR/opencode.port"
OPENCODE_URL_FILE="$RUNTIME_DIR/opencode.url"
BACKEND_PID_FILE="$RUNTIME_DIR/backend.pid"
BACKEND_PORT_FILE="$RUNTIME_DIR/backend.port"
BACKEND_URL_FILE="$RUNTIME_DIR/backend.url"
FRONTEND_PID_FILE="$RUNTIME_DIR/frontend.pid"
FRONTEND_PORT_FILE="$RUNTIME_DIR/frontend.port"
FRONTEND_URL_FILE="$RUNTIME_DIR/frontend.url"

mkdir -p "$LOG_DIR"

is_running() {
  local pid_file="$1"
  if [[ ! -f "$pid_file" ]]; then
    return 1
  fi
  local pid
  pid="$(cat "$pid_file")"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" >/dev/null 2>&1
}

systemd_active() {
  local unit="$1"
  systemctl is-active --quiet "$unit" 2>/dev/null
}

require_dep() {
  local dep="$1" hint="$2"
  if ! command -v "$dep" >/dev/null 2>&1; then
    echo "Missing dependency: $dep"
    echo "$hint"
    exit 1
  fi
}

require_dep "opencode" "Install OpenCode CLI first, then re-run this script."
require_dep "npm" "Install Node.js + npm first, then re-run this script."
require_dep "curl" "Install curl first, then re-run this script."

if [[ ! -x "$ROOT_DIR/.venv/bin/python" ]]; then
  echo "Python virtual environment not found at: $ROOT_DIR/.venv"
  echo "Run: python3 -m venv .venv && source .venv/bin/activate && pip install -r backend/requirements.txt"
  exit 1
fi

if [[ ! -d "$ROOT_DIR/frontend/node_modules" ]]; then
  echo "Installing frontend dependencies..."
  npm --prefix "$ROOT_DIR/frontend" install
fi

BACKEND_SYSTEMD_UNIT="mobile-opencode-control-backend.service"
FRONTEND_SYSTEMD_UNIT="mobile-opencode-control-frontend.service"
OPENCODE_SYSTEMD_UNIT="mobile-opencode-control-opencode.service"

BACKEND_USE_SYSTEMD=false
FRONTEND_USE_SYSTEMD=false
OPENCODE_USE_SYSTEMD=false

systemd_active "$BACKEND_SYSTEMD_UNIT" && BACKEND_USE_SYSTEMD=true
systemd_active "$FRONTEND_SYSTEMD_UNIT" && FRONTEND_USE_SYSTEMD=true
systemd_active "$OPENCODE_SYSTEMD_UNIT" && OPENCODE_USE_SYSTEMD=true

if is_running "$BACKEND_PID_FILE" || is_running "$FRONTEND_PID_FILE" || is_running "$OPENCODE_PID_FILE"; then
  echo "One or more services are already running (manual scripts)."
  echo "Use scripts/stop-app.sh first, or check systemd services."
  exit 1
fi

# ─── port picking helper ───
pick_port() {
  local base_port="$1" attempts="${2:-60}" sleep_seconds="${3:-0.5}"
  "$ROOT_DIR/.venv/bin/python" - "$base_port" "$attempts" "$sleep_seconds" <<'PY'
import socket, time, sys
base_port = int(sys.argv[1])
attempts = int(sys.argv[2])
sleep_seconds = float(sys.argv[3])
for attempt in range(attempts):
    for offset in range(3):
        candidate = base_port + offset
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", candidate))
        except OSError:
            pass
        else:
            print(candidate)
            sock.close()
            sys.exit(0)
        finally:
            try: sock.close()
            except Exception: pass
    if attempt < attempts - 1:
        time.sleep(sleep_seconds)
print(f"No free port in range {base_port}-{base_port + 2}", file=sys.stderr)
sys.exit(1)
PY
}

wait_for_opencode() {
  local port="$1"
  local url="http://127.0.0.1:${port}/global/health"
  local max_tries=40 attempt=1
  while (( attempt <= max_tries )); do
    curl -fsS "$url" >/dev/null 2>&1 && return 0
    sleep 0.25
    (( attempt += 1 ))
  done
  return 1
}

# ─── 1. Resolve frontend port first (needed by OpenCode CORS and backend) ───
if $FRONTEND_USE_SYSTEMD; then
  FRONTEND_PORT="$(cat "$FRONTEND_PORT_FILE" 2>/dev/null || echo "${FRONTEND_APP_PORT:-5173}")"
else
  FRONTEND_PORT="$(pick_port "${FRONTEND_APP_PORT:-5173}")"
fi
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi
FRONTEND_ALLOWED_HOSTS="${FRONTEND_ALLOWED_HOSTS:-localhost,127.0.0.1}"
FRONTEND_ORIGINS="${FRONTEND_ORIGINS:-http://localhost:${FRONTEND_PORT}}"
FRONTEND_BASE_URL="http://localhost:${FRONTEND_PORT}"
OPENCODE_CORS_ORIGINS="${OPENCODE_CORS_ORIGINS:-$FRONTEND_ORIGINS}"

# ─── 2. OpenCode ───
if $OPENCODE_USE_SYSTEMD; then
  echo "OpenCode is managed by systemd ($OPENCODE_SYSTEMD_UNIT)."
  OPENCODE_PORT="$(cat "$OPENCODE_PORT_FILE" 2>/dev/null || echo "${OPENCODE_APP_PORT:-40961}")"
else
  OPENCODE_PORT="$(pick_port "${OPENCODE_APP_PORT:-40961}")"
  echo "Starting OpenCode server..."
  opencode serve \
    --hostname 127.0.0.1 \
    --port "$OPENCODE_PORT" \
    --cors "$OPENCODE_CORS_ORIGINS" \
    >"$LOG_DIR/opencode.log" 2>&1 &
  echo $! >"$OPENCODE_PID_FILE"
  echo "$OPENCODE_PORT" >"$OPENCODE_PORT_FILE"
  echo "http://127.0.0.1:${OPENCODE_PORT}" >"$OPENCODE_URL_FILE"

  if ! wait_for_opencode "$OPENCODE_PORT"; then
    echo "OpenCode failed to start on port ${OPENCODE_PORT}. Check: $LOG_DIR/opencode.log"
    exit 1
  fi
fi
OPENCODE_BASE_URL="http://127.0.0.1:${OPENCODE_PORT}"

# ─── 3. Backend ───
if $BACKEND_USE_SYSTEMD; then
  echo "Backend is managed by systemd ($BACKEND_SYSTEMD_UNIT)."
  BACKEND_PORT="$(cat "$BACKEND_PORT_FILE" 2>/dev/null || echo "${BACKEND_APP_PORT:-38473}")"
else
  BACKEND_PORT="$(pick_port "${BACKEND_APP_PORT:-38473}")"
  echo "Starting backend..."
  OPENCODE_BASE_URL="$OPENCODE_BASE_URL" \
    FRONTEND_ORIGINS="$FRONTEND_ORIGINS" \
    FRONTEND_ORIGIN="${FRONTEND_ORIGIN:-$(printf '%s' "$FRONTEND_ORIGINS" | cut -d',' -f1)}" \
    BACKEND_PORT="$BACKEND_PORT" \
    "$ROOT_DIR/.venv/bin/python" "$ROOT_DIR/backend/run.py" \
    >"$LOG_DIR/backend.log" 2>&1 &
  echo $! >"$BACKEND_PID_FILE"
  echo "$BACKEND_PORT" >"$BACKEND_PORT_FILE"
fi
BACKEND_BASE_URL="http://127.0.0.1:${BACKEND_PORT}"

# ─── 4. Frontend ───
if $FRONTEND_USE_SYSTEMD; then
  echo "Frontend is managed by systemd ($FRONTEND_SYSTEMD_UNIT)."
else
  echo "Starting frontend dev server..."
  BACKEND_PORT="$BACKEND_PORT" \
    FRONTEND_ALLOWED_HOSTS="$FRONTEND_ALLOWED_HOSTS" \
    npm --prefix "$ROOT_DIR/frontend" run dev -- --host 0.0.0.0 --port "$FRONTEND_PORT" \
    >"$LOG_DIR/frontend.log" 2>&1 &
  echo $! >"$FRONTEND_PID_FILE"
  echo "$FRONTEND_PORT" >"$FRONTEND_PORT_FILE"
fi

sleep 2

echo ""
echo "App started."
echo "- Frontend: ${FRONTEND_BASE_URL}"
echo "- Backend:  ${BACKEND_BASE_URL}/api/health"
echo "- OpenCode: ${OPENCODE_BASE_URL}/global/health"
echo ""
echo "Logs:"
echo "- $LOG_DIR/frontend.log"
echo "- $LOG_DIR/backend.log"
echo "- $LOG_DIR/opencode.log"
