#!/usr/bin/env bash
# Self-healing logcat tail. Respawns whenever adb drops the connection
# (this Pixel + cable combo loses USB every 30–60 s under sustained logcat
# load). The output stream is one continuous file across all reconnects,
# so a single `grep` over the result captures full sessions without gaps
# beyond the brief reconnect windows.
#
# Used as the durable capture layer for BUG 9 reproduction (see
# SESSION-FLOW.md §4.BUG 9): the freeze is intermittent, so we want every
# session logged just in case "this one happens to be it."
#
# Usage:   ./scripts/resilient-logcat.sh
# Stops on Ctrl-C. The file path is recorded in
# `_debug/runs/.live-log-path` so other helpers (snap.sh, test-flow.sh)
# pick up the active capture automatically.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_device.sh
. "$SCRIPT_DIR/_device.sh"

LOG_DIR="$SCRIPT_DIR/../_debug/runs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/live-resilient-$(date +%Y%m%d-%H%M%S).log"
echo "$LOG" > "$LOG_DIR/.live-log-path"
echo "[resilient-logcat] writing to: $LOG"
echo "[resilient-logcat] device:     ${ANDROID_SERIAL:-default}"
echo "[resilient-logcat] press Ctrl-C to stop"

# Tags we care about. *:S silences everything else.
TAGS=(
  'ReactNativeJS:V'
  'AudioTrackManager:D'
  'AnkiDroidQueries:D'
  'AnkiDroidModule:D'
  'AudioFocusManager:D'
  '*:S'
)

trap 'echo "[resilient-logcat] stop"; exit 0' INT TERM

attempt=0
while true; do
  attempt=$((attempt + 1))
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  echo "[resilient-logcat] ==== attempt #$attempt at $ts ====" >> "$LOG"

  # Wait for the device to come back if it's offline / unplugged.
  adb wait-for-device 2>/dev/null

  # Clear logcat buffer on first connect only — on reconnects we DON'T
  # clear so we capture any logs the device buffered while disconnected.
  if [ "$attempt" -eq 1 ]; then
    adb logcat -c 2>/dev/null || true
  fi

  # Stream. When the connection dies, logcat exits non-zero and we loop.
  adb logcat -v time "${TAGS[@]}" >> "$LOG" 2>&1

  # Brief backoff so we don't burn CPU if the device is gone for a while.
  sleep 1
done
