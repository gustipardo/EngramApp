#!/usr/bin/env bash
# check-writeback.sh — Verify AnkiDroid write-back for a single card answer.
#
# What it does:
#   1. Clears logcat so there is no noise from prior runs.
#   2. Fires one answer via ./answer.sh (or the text you provide as $1).
#   3. Waits for TWO independent markers:
#        a. Native (Kotlin): "AnkiDroidModule: answerCard: result ... -> N row(s) updated"
#           logged by AnkiDroidModule.kt with Log.d — proves the ContentProvider
#           update was issued and returned N rows.
#        b. JS bridge:      "[ankiBridge] answerCard(...) → ok" or "→ no rows"
#           logged by ankiBridge.ts — proves the JS wrapper processed the result.
#   4. Extracts the row count from the Kotlin line and reports PASS/FAIL.
#
# Prerequisites:
#   - adb device attached and Metro running.
#   - App already at STEP 7 (study loop active). Use test-flow.sh to reach that
#     state, or set AUTO_START_DECK in .env and wait for autostart.
#
# Usage:
#   ./scripts/check-writeback.sh
#   ./scripts/check-writeback.sh "S3 Transfer Acceleration uses CloudFront edge locations."
#
# Exit codes:
#   0  — PASS: Kotlin confirmed N>0 rows updated + JS bridge confirmed "ok"
#   1  — FAIL: Kotlin confirmed 0 rows updated (stale queue, wrong deck, etc.)
#   2  — ERROR: timeout — write-back markers never appeared in logcat
#   3  — ERROR: no device attached
#   4  — PARTIAL: JS-ok but Kotlin row-count line not found (or vice versa)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_device.sh
source "$SCRIPT_DIR/_device.sh"
RUNS_DIR="$(dirname "$SCRIPT_DIR")/_debug/runs"
mkdir -p "$RUNS_DIR"

RUN_ID="$(date +%Y%m%d-%H%M%S)-writeback"
LOG_FILE="$RUNS_DIR/${RUN_ID}.log"

# Default answer — AWS SA associate topic so the AI evaluates it concretely.
DEFAULT_ANSWER="S3 Transfer Acceleration uses CloudFront edge locations to speed up uploads from distant clients to a bucket."
ANSWER="${1:-$DEFAULT_ANSWER}"

TIMEOUT_WRITEBACK=45  # seconds to wait for the write-back log lines

# ─── helpers ─────────────────────────────────────────────────────────────────

log()  { printf '[check-writeback] %s\n' "$*" >&2; }
pass() { printf '\n✓  PASS: %s\n' "$*"; }
fail() { printf '\n✗  FAIL: %s\n' "$*" >&2; }
err()  { printf '\n!  ERROR: %s\n' "$*" >&2; }

wait_for_pattern() {
  local pattern="$1" timeout="$2" elapsed=0
  while (( elapsed < timeout )); do
    if grep -qP "$pattern" "$LOG_FILE" 2>/dev/null; then
      return 0
    fi
    sleep 1
    ((elapsed++))
  done
  return 1
}

extract_row_count() {
  # Extract N from "answerCard: result ... -> N row(s) updated"
  grep -oP 'answerCard: result.*?-> \K\d+(?= row)' "$LOG_FILE" | tail -1
}

# ─── preflight ───────────────────────────────────────────────────────────────

if ! adb get-state >/dev/null 2>&1; then
  err "no device/emulator attached — run 'adb devices'"
  exit 3
fi

log "run id:  $RUN_ID"
log "log:     $LOG_FILE"
log "answer:  \"$ANSWER\""

# ─── clear logcat and start streaming ────────────────────────────────────────

log "clearing logcat"
adb logcat -c

log "starting logcat stream → $LOG_FILE"
# Capture:
#   ReactNativeJS — JS-layer logs (ankiBridge, sessionManager)
#   AnkiDroidModule — Kotlin native module logs
adb logcat -v time ReactNativeJS:V AnkiDroidModule:D '*:S' > "$LOG_FILE" 2>&1 &
LOGCAT_PID=$!
trap 'kill "$LOGCAT_PID" 2>/dev/null || true' EXIT

sleep 1  # let adb settle

# ─── fire the answer ─────────────────────────────────────────────────────────

log "firing answer via answer.sh"
if ! "$SCRIPT_DIR/answer.sh" "$ANSWER" >/dev/null 2>&1; then
  err "answer.sh failed — is the dev server running? Is the app at STEP 7?"
  exit 2
fi

# ─── wait for write-back markers ─────────────────────────────────────────────

log "waiting up to ${TIMEOUT_WRITEBACK}s for write-back markers …"

# Marker A: JS bridge — fire-and-forget dispatched
JS_PATTERN='\[ankiBridge\] answerCard\(.*\) →'
# Marker B: Kotlin — ContentProvider update result
KT_PATTERN='answerCard: result .* -> \d+ row'

JS_OK=false
KT_OK=false

elapsed=0
while (( elapsed < TIMEOUT_WRITEBACK )); do
  if [[ "$JS_OK" == false ]] && grep -qP "$JS_PATTERN" "$LOG_FILE" 2>/dev/null; then
    JS_OK=true
    log "JS bridge marker found"
  fi
  if [[ "$KT_OK" == false ]] && grep -qP "$KT_PATTERN" "$LOG_FILE" 2>/dev/null; then
    KT_OK=true
    log "Kotlin marker found"
  fi
  if [[ "$JS_OK" == true && "$KT_OK" == true ]]; then
    break
  fi
  sleep 1
  ((elapsed++))
done

# ─── evaluate ────────────────────────────────────────────────────────────────

echo ""
echo "─── write-back check ──────────────────────────────────────────"
echo "  answer:  \"$ANSWER\""
echo "  log:     $LOG_FILE"
echo ""

if [[ "$KT_OK" == false && "$JS_OK" == false ]]; then
  err "timeout — no write-back markers in logcat after ${TIMEOUT_WRITEBACK}s"
  echo ""
  echo "  Possible causes:"
  echo "    • App was not at STEP 7 when answer.sh fired"
  echo "    • answer.sh deep link was rejected (check Metro is running)"
  echo "    • Tool call loop stalled — check SESSION-FLOW.md §4"
  echo ""
  exit 2
fi

if [[ "$JS_OK" == false ]]; then
  err "JS bridge marker missing — JS never dispatched answerCard"
  echo "  Kotlin found: $KT_OK"
  exit 4
fi

ROW_COUNT="$(extract_row_count)"

# Show both raw log lines for auditability.
echo "  JS line:     $(grep -oP '\[ankiBridge\] answerCard\([^)]+\) → \w+' "$LOG_FILE" | tail -1)"
if [[ -n "$ROW_COUNT" ]]; then
  echo "  Kotlin line: $(grep -oP 'answerCard: result[^\n]*' "$LOG_FILE" | tail -1)"
else
  echo "  Kotlin line: (not found)"
fi
echo ""

if [[ -z "$ROW_COUNT" ]]; then
  err "Kotlin marker not found — ContentProvider update may have been skipped"
  echo "  JS said: $(grep -oP '\[ankiBridge\] answerCard\([^)]+\) → \w+' "$LOG_FILE" | tail -1)"
  echo ""
  echo "  Possible causes:"
  echo "    • answerCard returned 0 rows both attempts — schedule queue not primed"
  echo "    • AnkiDroid permission was revoked"
  echo "    • Deck selection drifted (wrong deck was selected when update fired)"
  exit 4
fi

if (( ROW_COUNT > 0 )); then
  pass "${ROW_COUNT} row(s) updated in AnkiDroid — write-back confirmed"
  echo ""
  echo "  To re-check with a different answer:"
  echo "    ./scripts/check-writeback.sh \"your answer here\""
  echo ""
  exit 0
else
  fail "ContentProvider update returned 0 rows"
  echo ""
  echo "  The Kotlin update call completed but no rows were modified."
  echo "  Most common causes (see AnkiDroidModule.kt answerCard comments):"
  echo "    • Schedule queue not primed — card (note_id, ord) not in review queue"
  echo "    • Deck selection mismatch — selected_deck differs from the reviewed deck"
  echo "    • Stale cardOrd — ord captured after cache advanced (BUG 4 regression?)"
  echo ""
  exit 1
fi
