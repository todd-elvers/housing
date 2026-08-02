#!/usr/bin/env bash
# Local craigslist loop — the one source CI cannot run: craigslist 403s
# datacenter IPs like GitHub's runners, but works fine from a residential
# connection. Everything else is ingested in CI every 10 minutes, around the
# clock (the Cloudflare cron in infra/cron-worker dispatches ingest.yml, which
# runs with --skip craigslist).
#
# No blackout window is needed against those CI runs: ingest diffing and
# removal-marking are scoped per source (src/core/db.ts), so a craigslist-only
# run and a CI run touch disjoint rows.
#
# Usage:
#   ./scripts/ingest.sh                 # loop forever, every 10 minutes
#   ./scripts/ingest.sh --once          # single iteration, then exit
#   ./scripts/ingest.sh --noNotify ...  # extra args are passed through to
#                                       # `housing ingest` (see --help)
#
# Paid tier-2 sources stay excluded here as everywhere: metered API spend
# remains a deliberate, manual act (`./housing ingest --paid`).

set -euo pipefail
cd "$(dirname "$0")/.."

INTERVAL_SECS=600
ONCE=0
PASSTHRU=()
for arg in "$@"; do
  if [[ "$arg" == "--once" ]]; then ONCE=1; else PASSTHRU+=("$arg"); fi
done

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

run_iteration() {
  log "starting craigslist ingest"
  if ./housing ingest --source craigslist "${PASSTHRU[@]+"${PASSTHRU[@]}"}"; then
    log "ingest finished"
  else
    log "ingest FAILED (exit $?) — will retry next cycle"
  fi
}

trap 'log "stopping"; exit 0' INT TERM

if ((ONCE)); then
  run_iteration
  exit 0
fi

log "local craigslist loop started (every $((INTERVAL_SECS / 60)) min)"
while true; do
  cycle_start=$(date +%s)
  run_iteration
  elapsed=$(($(date +%s) - cycle_start))
  remaining=$((INTERVAL_SECS - elapsed))
  ((remaining > 0)) && sleep "$remaining" || true
done
