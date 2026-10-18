#!/usr/bin/env bash
# Update the running service on the Mac: pull, install, rebuild native only when Swift changed, restart, health check.
#   ./scripts/updater.sh                 # on the Mac
#   ssh mac-m4 '~/Github/vision-mac/scripts/updater.sh'
# Env: PORT (default 8090), FORCE_NATIVE=1 to rebuild the dylib anyway.
set -euo pipefail

# everything sits in main() so bash has parsed the whole script before `git pull` can rewrite this file
main() {
  cd "$(dirname "$0")/.."
  export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"
  local label="app.dvgamerr.vision-mac" port="${PORT:-8090}"

  # the Mac's bun rewrites bun.lock on install; drop that so the pull never conflicts on it
  git checkout -- bun.lock 2>/dev/null || true
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "local changes in $(pwd), not updating:" >&2
    git status --short --untracked-files=no >&2
    exit 1
  fi

  local before after
  before=$(git rev-parse HEAD)
  git pull --ff-only --quiet
  after=$(git rev-parse HEAD)
  if [ "$before" = "$after" ]; then echo "already at $(git log --oneline -1)"; else git log --oneline "$before..$after"; fi

  bun install
  git checkout -- bun.lock 2>/dev/null || true

  if [ "${FORCE_NATIVE:-}" = 1 ] || [ ! -f native/libvision.dylib ] || [ ! -f native/vision-tts ] ||
     ! git diff --quiet "$before" "$after" -- native scripts/build-native.ts; then
    bun run build:native
  fi

  launchctl kickstart -k "gui/$(id -u)/$label"
  for _ in $(seq 1 30); do
    if curl -fs --max-time 1 "http://127.0.0.1:$port/health" >/dev/null; then
      echo "up on :$port at $(git log --oneline -1)"
      return
    fi
    sleep 1
  done
  echo "no answer on :$port after 30 s, last log lines:" >&2
  tail -20 /tmp/vision-mac.log >&2
  exit 1
}

main "$@"
