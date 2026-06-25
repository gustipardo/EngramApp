#!/usr/bin/env bash
# test-flow.sh — End-to-end session pipeline.
#
# What it does:
#   1. Force-stops the app and clears logcat.
#   2. Launches the dev build pointing at host Metro.
#   3. Streams logcat to a tmp file.
#   4. Waits until autostart fires and STEP 7 (study loop active) is reached.
#   5. For each provided answer (default: 4 canned answers):
#        a. snap "pre-card-N.png"
#        b. fire ./answer.sh "<text>"
#        c. wait for tool_result → giving_feedback → ai_done markers
#        d. snap "post-card-N.png"
#   6. Sends end_session via deep link.
#   7. Prints a summary table and the path to the captured log dump.
#
# Usage:
#   ./scripts/test-flow.sh
#   ./scripts/test-flow.sh "answer 1" "answer 2" "answer 3"
#
# Exits non-zero if any required marker doesn't appear within its timeout —
# making it usable as a smoke test in CI later.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_device.sh
source "$SCRIPT_DIR/_device.sh"
APP_DIR="$(dirname "$SCRIPT_DIR")"
SNAPS_DIR="$APP_DIR/_debug/snaps"
RUNS_DIR="$APP_DIR/_debug/runs"
mkdir -p "$SNAPS_DIR" "$RUNS_DIR"

RUN_ID="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$RUNS_DIR/${RUN_ID}.log"
SUMMARY_FILE="$RUNS_DIR/${RUN_ID}.summary.txt"

PKG="com.anonymous.RealtimeApiOnMobile"
# &autostart=1 opts into deck-select autostart for this launch only —
# overrides AUTO_START_ENABLED=false in .env so daily icon-launches stay
# manual. See src/services/autostartFlag.ts and src/app/_layout.tsx.
#
# Metro host: the dev client must reach Metro (port 8081). `localhost` works
# on BOTH the Android emulator and a physical device because we open an
# `adb reverse tcp:8081 tcp:8081` tunnel before launch (device localhost →
# host Metro). The old hardcoded 10.0.2.2 only resolved on the emulator.
# Override with METRO_HOST=<host-ip> to bypass the reverse tunnel if needed.
METRO_HOST="${METRO_HOST:-localhost}"
DEV_URL="exp+realtimeapionmobile://expo-development-client/?url=http%3A%2F%2F${METRO_HOST}%3A8081&autostart=1"

# Default answers: 4 declarative attempts.  Wording matters — Gemini Live
# emits the `evaluate_and_move_next` tool reliably when the user makes a
# concrete claim, and unreliably when the user says "skip" / "I don't
# know" / "tell me the answer" (it tends to emit ctrl tokens + a silent
# turnComplete, see SESSION-FLOW.md §4.BUG 3).  We use confident attempts
# here so the pipeline runs as a smoke test; pass your own args to stress.
DEFAULT_ANSWERS=(
  "VPC Peering connects two VPCs privately, used instead of Transit Gateway for simple one-to-one connections without transitive routing."
  "KMS handles encryption of keys, while Secrets Manager hosts credentials with rotation support."
  "S3 Transfer Acceleration uses CloudFront edge locations to speed up uploads to a bucket from distant clients."
  "Route 53 alias records map a domain to AWS resources like CloudFront or ELB without needing the resource IP, unlike CNAMEs which can't be at the zone apex."
)

if [[ $# -gt 0 ]]; then
  ANSWERS=("$@")
else
  ANSWERS=("${DEFAULT_ANSWERS[@]}")
fi
N=${#ANSWERS[@]}

# --- helpers ----------------------------------------------------------------

log()  { printf '[test-flow] %s\n' "$*" >&2; }
fail() { printf '[test-flow] FAIL: %s\n' "$*" >&2; exit 1; }

require_device() {
  if ! adb get-state >/dev/null 2>&1; then
    fail "no device/emulator attached"
  fi
}

# Wait until $1 (regex) appears in $LOG_FILE. Times out after $2 seconds.
wait_for() {
  local pattern="$1" timeout="${2:-30}" elapsed=0
  while (( elapsed < timeout )); do
    if grep -qE "$pattern" "$LOG_FILE" 2>/dev/null; then
      return 0
    fi
    sleep 1
    ((elapsed++))
  done
  return 1
}

# Same as wait_for but starting at the given byte offset of LOG_FILE.
# Returns the new offset after the match (or "0" on failure).
wait_for_after() {
  local pattern="$1" offset="$2" timeout="${3:-30}" elapsed=0
  while (( elapsed < timeout )); do
    if tail -c +"$((offset+1))" "$LOG_FILE" 2>/dev/null | grep -qE "$pattern"; then
      stat -c%s "$LOG_FILE"
      return 0
    fi
    sleep 1
    ((elapsed++))
  done
  echo "0"
  return 1
}

# --- run --------------------------------------------------------------------

require_device

log "run id: $RUN_ID"
log "answers: $N"
log "log:     $LOG_FILE"

log "force-stop + logcat clear"
# pm clear wipes AsyncStorage (Expo Router nav state) so stale screens like
# the paywall aren't restored on next launch. force-stop alone only kills
# the process; app data (including persisted nav state) survives.
# Re-grant runtime permissions that pm clear revokes.
adb shell pm clear "$PKG" >/dev/null
adb shell pm grant "$PKG" com.ichi2.anki.permission.READ_WRITE_DATABASE >/dev/null 2>&1 || true
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true
adb shell pm grant "$PKG" android.permission.RECORD_AUDIO >/dev/null 2>&1 || true
adb logcat -c

log "starting logcat stream → $LOG_FILE"
adb logcat -v time ReactNativeJS:V '*:S' > "$LOG_FILE" 2>&1 &
LOGCAT_PID=$!
trap 'kill "$LOGCAT_PID" 2>/dev/null || true' EXIT

sleep 1

log "launching dev build via deep link"
# Open the reverse tunnel BEFORE launching so the dev client can reach Metro
# at localhost:8081 the instant it boots — works on emulator AND device.
adb reverse tcp:8081 tcp:8081 >/dev/null 2>&1 || true
adb shell am start -a android.intent.action.VIEW -d "$DEV_URL" "$PKG" >/dev/null 2>&1

log "waiting for autostart → STEP 7 (study loop active) — timeout 120s"
if ! wait_for "STEP 7/8" 120; then
  fail "session never reached STEP 7 — check Metro + autostart deck name"
fi
log "STEP 7 reached"

OFFSET="$(stat -c%s "$LOG_FILE")"

# Track per-card results for the summary.
declare -a RESULTS=()
declare -a SNAPS_PRE=()
declare -a SNAPS_POST=()

for ((i = 1; i <= N; i++)); do
  ANSWER="${ANSWERS[$((i-1))]}"
  log "── card $i/$N ─ answer: \"$ANSWER\""

  PRE="$SNAPS_DIR/${RUN_ID}-card${i}-pre.png"
  POST="$SNAPS_DIR/${RUN_ID}-card${i}-post.png"
  adb exec-out screencap -p > "$PRE" 2>/dev/null
  SNAPS_PRE+=("$PRE")

  # Fire the answer
  "$SCRIPT_DIR/answer.sh" "$ANSWER" >/dev/null 2>&1 || {
    log "answer.sh failed for card $i"
  }

  # Marker A: Gemini sent the tool result back (eval cycle completed JS-side)
  # 45s timeout — Gemini Live occasionally takes 30-40s to respond to a
  # text injection, especially after multiple cards in the same session.
  NEW_OFFSET="$(wait_for_after "tool_result → evaluate_and_move_next → Gemini" "$OFFSET" 45 || true)"
  if [[ "$NEW_OFFSET" == "0" ]]; then
    RESULTS+=("$i  TIMEOUT      tool_result never sent")
    adb exec-out screencap -p > "$POST" 2>/dev/null
    SNAPS_POST+=("$POST")
    continue
  fi
  OFFSET="$NEW_OFFSET"

  # Marker B: AI finished feedback turn (phase → awaiting_answer or
  # session_complete on the last card)
  NEW_OFFSET="$(wait_for_after "ai_done|session_complete|no_more_cards" "$OFFSET" 60 || true)"
  if [[ "$NEW_OFFSET" == "0" ]]; then
    RESULTS+=("$i  PARTIAL      tool_result sent but ai_done never arrived")
    adb exec-out screencap -p > "$POST" 2>/dev/null
    SNAPS_POST+=("$POST")
    continue
  fi
  OFFSET="$NEW_OFFSET"

  # Snap after the advance has happened
  sleep 1
  adb exec-out screencap -p > "$POST" 2>/dev/null
  SNAPS_POST+=("$POST")

  RESULTS+=("$i  OK           advanced (snaps captured)")
  log "card $i complete"
done

log "session loop done — sending end_session via deep link"
# end-session deep link is wired through the same simulator — we send the
# string the prompt teaches Gemini to recognise as a request to end. If the
# tool isn't triggered, we just stop logging.
"$SCRIPT_DIR/answer.sh" "Please end the session now, I'm done." >/dev/null 2>&1 || true
wait_for_after "end_session|Session ended|Session complete" "$OFFSET" 20 >/dev/null 2>&1 || true

# --- summary ----------------------------------------------------------------

{
  echo "=== test-flow.sh summary ==="
  echo "run:      $RUN_ID"
  echo "log:      $LOG_FILE"
  echo "cards:    $N"
  echo ""
  printf "%-4s %-12s %s\n" "#" "STATUS" "DETAIL"
  printf -- '---- ------------ -------------------------------------\n'
  for line in "${RESULTS[@]}"; do
    printf '%s\n' "$line"
  done
  echo ""
  echo "snaps:"
  for ((i = 0; i < N; i++)); do
    echo "  card $((i+1)):  ${SNAPS_PRE[$i]}"
    echo "             ${SNAPS_POST[$i]}"
  done
} | tee "$SUMMARY_FILE"

# Exit non-zero if any card didn't reach OK — useful for CI.
for line in "${RESULTS[@]}"; do
  if [[ "$line" != *"OK"* ]]; then
    exit 2
  fi
done
