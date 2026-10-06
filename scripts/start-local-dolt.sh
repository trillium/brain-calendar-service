#!/usr/bin/env bash
# Start a DISPOSABLE Dolt SQL server for this project's own store.
#
# This is NOT the fleet-shared server. It exists so S1's exit condition - a real
# Dolt server, not a mock - can be met honestly without an autonomous worker
# creating databases on 127.0.0.1:3307, which every other lane shares. Same
# dolt binary, same SQL, same history and diff semantics; only the blast radius
# is different.
#
# Usage: scripts/start-local-dolt.sh [start|stop|status]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${ROOT}/.local-dolt"
PORT="${CALENDAR_DB_PORT:-3399}"
PID_FILE="${DATA_DIR}/server.pid"

case "${1:-start}" in
  start)
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "Disposable Dolt already running (pid $(cat "$PID_FILE")) on port ${PORT}"
      exit 0
    fi
    mkdir -p "$DATA_DIR"
    if [[ ! -d "${DATA_DIR}/.dolt" ]]; then
      # `dolt init` resolves against the CURRENT directory, not only against
      # DOLT_DATA_DIR, and refuses with "This directory has already been
      # initialized" when the cwd holds a .dolt - which this repo's root does.
      # Without the subshell a fresh clone can never start its own server, and
      # the failure looks like a corrupt data directory rather than a cwd bug.
      (cd "$DATA_DIR" && DOLT_DATA_DIR="$DATA_DIR" dolt init --name brain-calendar-service \
        --email brain-calendar-service@localhost >/dev/null)
    fi
    nohup dolt sql-server -H 127.0.0.1 -P "$PORT" --data-dir "$DATA_DIR" \
      >"${DATA_DIR}/server.log" 2>&1 &
    echo $! > "$PID_FILE"
    for _ in $(seq 1 40); do
      if (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
        echo "Disposable Dolt listening on 127.0.0.1:${PORT} (pid $(cat "$PID_FILE"))"
        exec 3>&- 2>/dev/null || true
        exit 0
      fi
      sleep 0.25
    done
    echo "Dolt did not start; see ${DATA_DIR}/server.log" >&2
    exit 1
    ;;
  stop)
    if [[ -f "$PID_FILE" ]]; then
      kill "$(cat "$PID_FILE")" 2>/dev/null || true
      rm -f "$PID_FILE"
      echo "Disposable Dolt stopped"
    fi
    ;;
  status)
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "running (pid $(cat "$PID_FILE")) on port ${PORT}"
    else
      echo "not running"
      exit 1
    fi
    ;;
  *)
    echo "Usage: $0 [start|stop|status]" >&2
    exit 1
    ;;
esac