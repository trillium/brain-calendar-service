#!/usr/bin/env bash
set -euo pipefail

# next-migration.sh — Atomic migration number allocator for parallel agents
#
# Usage:
#   scripts/next-migration.sh                        # Print next available number
#   scripts/next-migration.sh --reserve "description" # Reserve number + create placeholder .sql
#
# Designed for parallel worktrees: computes max from current worktree,
# main worktree, and shared reservations file.

# ADAPTED from Canon (modules/migration-allocator/scripts/next-migration.sh),
# per conflict C4: the directory moves from supabase/migrations to migrations/,
# because this project's schema lives in Dolt and has no Supabase. The module's
# own Conflicts section sanctions exactly this ("adjust the migration directory
# path in the script; the number allocation logic still applies"), so the
# flock-based reservation discipline that makes parallel agents safe is kept
# byte-for-byte. Only the one line below differs.

MIGRATION_DIR="migrations"
DESCRIPTION=""
RESERVE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reserve)
      RESERVE=true
      DESCRIPTION="${2:?--reserve requires a description}"
      shift 2
      ;;
    *)
      echo "Usage: $0 [--reserve \"description\"]" >&2
      exit 1
      ;;
  esac
done

# --- Resolve git directories ---

GIT_COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null)" || {
  echo "Error: not inside a git repository" >&2
  exit 1
}

MAIN_WORKTREE="$(git rev-parse --show-toplevel 2>/dev/null)"
LOCK_FILE="${GIT_COMMON_DIR}/migration-reservations.lock"
RESERVATIONS_FILE="${GIT_COMMON_DIR}/migration-reservations"

# --- Cross-platform lock helpers ---

acquire_lock() {
  if command -v flock &>/dev/null; then
    exec 9>"${LOCK_FILE}"
    flock -w 10 9
  else
    # macOS fallback: mkdir is atomic
    local attempts=0
    while ! mkdir "${LOCK_FILE}.d" 2>/dev/null; do
      attempts=$((attempts + 1))
      if [[ $attempts -ge 100 ]]; then
        echo "Error: could not acquire lock after 10s" >&2
        exit 1
      fi
      sleep 0.1
    done
    trap 'rmdir "${LOCK_FILE}.d" 2>/dev/null' EXIT
  fi
}

release_lock() {
  if command -v flock &>/dev/null; then
    exec 9>&-
  else
    rmdir "${LOCK_FILE}.d" 2>/dev/null || true
  fi
}

# --- Compute max migration number ---

max_from_dir() {
  local dir="$1"
  if [[ -d "$dir" ]]; then
    ls "$dir" 2>/dev/null \
      | grep -oE '^[0-9]+' \
      | sort -n \
      | tail -1
  fi
}

max_from_reservations() {
  if [[ -f "$RESERVATIONS_FILE" ]]; then
    grep -oE '^[0-9]+' "$RESERVATIONS_FILE" 2>/dev/null \
      | sort -n \
      | tail -1
  fi
}

compute_next() {
  local max_current max_main max_reserved max_all

  # Check current worktree
  max_current="$(max_from_dir "${MIGRATION_DIR}")"

  # Check main worktree (if we're in a linked worktree)
  max_main=""
  if [[ -n "$MAIN_WORKTREE" ]]; then
    max_main="$(max_from_dir "${MAIN_WORKTREE}/${MIGRATION_DIR}")"
  fi

  # Also check main branch files via git
  max_main_branch="$(git ls-tree -r --name-only origin/main -- "${MIGRATION_DIR}/" 2>/dev/null \
    | grep -oE '[0-9]+' \
    | sort -n \
    | tail -1)" || true

  # Check reservations
  max_reserved="$(max_from_reservations)"

  # Find the overall max
  max_all=0
  for val in "$max_current" "$max_main" "$max_main_branch" "$max_reserved"; do
    if [[ -n "$val" ]] && [[ "$val" -gt "$max_all" ]]; then
      max_all="$val"
    fi
  done

  echo $((max_all + 1))
}

# --- Main ---

acquire_lock

NEXT="$(compute_next)"

if [[ "$RESERVE" == true ]]; then
  AGENT_ID="${CANON_AGENT_ID:-${USER:-unknown}}"
  TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Log reservation
  echo "${NEXT}  ${AGENT_ID}  ${TIMESTAMP}  ${DESCRIPTION}" >> "$RESERVATIONS_FILE"

  # Create placeholder migration file
  mkdir -p "$MIGRATION_DIR"
  FILENAME="${NEXT}_${DESCRIPTION// /_}.sql"
  cat > "${MIGRATION_DIR}/${FILENAME}" <<SQL
-- Migration ${NEXT}: ${DESCRIPTION}
-- Reserved by ${AGENT_ID} at ${TIMESTAMP}
-- TODO: replace this placeholder with actual migration SQL

SQL

  echo "${NEXT}"
  echo "Reserved: ${MIGRATION_DIR}/${FILENAME}" >&2
else
  echo "${NEXT}"
fi

release_lock
