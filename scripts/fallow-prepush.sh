#!/usr/bin/env sh

# --- Fallow codebase health pre-push check ---
# Runs fallow on the branch delta before push.
# Graceful degradation: skips with a warning if fallow is not installed.

if ! command -v fallow >/dev/null 2>&1 && ! npx --no-install fallow --version >/dev/null 2>&1; then
  echo "warning: fallow not found — skipping codebase health check"
  echo "  Install with: pnpm add -D fallow"
  exit 0
fi

echo "Running fallow dead-code check on branch changes..."
npx --no-install fallow dead-code --changed-since main --format json --quiet

status=$?
if [ $status -ne 0 ]; then
  echo ""
  echo "error: Fallow found codebase health issues in your branch."
  echo "  Run 'pnpm run health' for full details."
  echo "  Run 'pnpm run health:fix' to preview auto-fixes."
  echo ""
  echo "  Bypass (rare): git push --no-verify"
  exit 1
fi
