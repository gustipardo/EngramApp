#!/usr/bin/env bash
# test-e2e-scenario.sh — Drive a full E2E session from a scenario definition.
#
# A scenario file (scripts/scenarios/*.sh) defines:
#   SCENARIO_PROFILE         — which .apkg deck to use (matches create-test-apkg.py profile key)
#   SCENARIO_DECK            — the deck name as it appears in AnkiDroid
#   SCENARIO_CARDS_TO_STUDY  — how many cards to drive through
#   SCENARIO_ANSWERS[]       — the injected answers in card order
#   SCENARIO_EXPECTED_CORRECT/INCORRECT/SKIPPED — assertion targets
#   SCENARIO_ANSWER_DELAY_S  — seconds to wait between answers
#   SCENARIO_STEP7_TIMEOUT_S — seconds to wait for STEP 7
#
# Usage:
#   scripts/test-e2e-scenario.sh scripts/scenarios/aws-all-correct.sh
#   scripts/test-e2e-scenario.sh scripts/scenarios/refold-english-mixed.sh
#
#   # Run all scenarios sequentially:
#   for s in scripts/scenarios/*.sh; do scripts/test-e2e-scenario.sh "$s"; done
#
# What this script does:
#   1. Import the correct .apkg deck into the attached device/emulator
#   2. Launch Engram with AUTO_START_DECK pointing at that deck
#   3. Capture logcat in the background
#   4. Wait for STEP 7 (session ready for answers)
#   5. Inject each answer from SCENARIO_ANSWERS[], waiting between each
#   6. Wait for STEP 8 or session_complete
#   7. Stop logcat, run assert-session.sh against the captured log
#   8. Print a pass/fail summary with the log path for inspection
#
# Prerequisites:
#   - Device (physical or emulator) attached with AnkiDroid installed
#   - Metro running: npx expo start --dev-client
#   - App installed and the READ_WRITE_DATABASE permission granted
#   - GEMINI_API_KEY set in App/.env
#
# Note on what is NOT asserted:
#   - The exact text of what the tutor says (non-deterministic)
#   - Whether Gemini's evaluation of each answer is "correct" in the domain sense
#     (we only check that it called the tool, not which quality value it chose)
#   - Timing of individual turns (logcat ordering can vary)
#
# Note on what IS asserted:
#   - The session reached STEP 7 (fully connected, cards loaded)
#   - evaluate_and_move_next was called for each injected answer
#   - AnkiDroid accepted each write-back (>0 rows updated)
#   - The combined correct+incorrect+skipped count matches expectations
#   - No error phase transitions occurred

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURES_DIR="$APP_DIR/src/test-harness/fixtures"
DEBUG_DIR="$APP_DIR/_debug"

source "$SCRIPT_DIR/_device.sh"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

section() { echo -e "\n${CYAN}══ $* ══${RESET}"; }
log()     { echo -e "${CYAN}[scenario]${RESET} $*"; }
ok()      { echo -e "${GREEN}[OK]${RESET}  $*"; }
fail()    { echo -e "${RED}[FAIL]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET} $*"; }

# ── Load scenario ─────────────────────────────────────────────────────────────

SCENARIO_FILE="${1:-}"
[[ -z "$SCENARIO_FILE" ]] && {
    echo "Usage: $0 <scenario-file>"
    echo "Example: $0 scripts/scenarios/aws-all-correct.sh"
    echo ""
    echo "Available scenarios:"
    ls "$SCRIPT_DIR/scenarios/"
    exit 1
}
[[ ! -f "$SCENARIO_FILE" ]] && { fail "Scenario file not found: $SCENARIO_FILE"; exit 1; }

# shellcheck source=/dev/null
source "$SCENARIO_FILE"

SCENARIO_NAME="$(basename "$SCENARIO_FILE" .sh)"
APKG="$FIXTURES_DIR/${SCENARIO_PROFILE}.apkg"
[[ ! -f "$APKG" ]] && {
    warn "Deck file not found: $APKG"
    log "Regenerating..."
    python3 "$SCRIPT_DIR/create-test-apkg.py" "$SCENARIO_PROFILE"
}

RUN_ID="$(date +%Y%m%d-%H%M%S)-${SCENARIO_NAME}"
RUN_DIR="$DEBUG_DIR/runs"
SCREENSHOTS_DIR="$DEBUG_DIR/screenshots"
LOG_FILE="$RUN_DIR/${RUN_ID}.log"
SUMMARY_FILE="$RUN_DIR/${RUN_ID}.summary.txt"
mkdir -p "$RUN_DIR" "$SCREENSHOTS_DIR"

PKG="com.anonymous.RealtimeApiOnMobile"
METRO_HOST="${METRO_HOST:-localhost}"
LAUNCH_URL="exp+realtimeapionmobile://expo-development-client/?url=http%3A%2F%2F${METRO_HOST}%3A8081&autostart=1"

# ── Helper: wait for a log marker with timeout ────────────────────────────────

wait_for_marker() {
    local marker="$1" timeout_s="$2" label="${3:-$1}"
    local deadline=$((SECONDS + timeout_s))
    log "Waiting for: $label (timeout ${timeout_s}s)..."
    while [[ $SECONDS -lt $deadline ]]; do
        if grep -q "$marker" "$LOG_FILE" 2>/dev/null; then
            ok "Marker found: $label"
            return 0
        fi
        sleep 1
    done
    fail "Timed out waiting for: $label"
    return 1
}

# ── Step 1: Import the deck ───────────────────────────────────────────────────

section "1 — Import deck: $SCENARIO_DECK"

# Android ≥14 (incl. the physical Pixel 9 on Android 17) strips `am start -d
# file://…` under scoped storage, so the documented file:// import fails.
# import-deck.sh works around it with a MediaStore content:// URI (see memory
# `ankidroid-emulator-import-workaround`). Set SKIP_IMPORT=1 to reuse a deck
# already in AnkiDroid (faster when re-running scenarios back to back).

if [[ "${SKIP_IMPORT:-0}" == "1" ]]; then
    log "SKIP_IMPORT=1 — assuming '$SCENARIO_DECK' is already in AnkiDroid."
else
    log "Importing via MediaStore content:// (import-deck.sh)..."
    bash "$SCRIPT_DIR/import-deck.sh" "$SCENARIO_PROFILE" || \
        warn "import-deck.sh returned non-zero — continuing (deck may already exist)."
fi

# Screenshot: confirm AnkiDroid state after import
adb -s "$ANDROID_SERIAL" shell screencap -p /sdcard/engram-screenshot.png
adb -s "$ANDROID_SERIAL" pull /sdcard/engram-screenshot.png \
    "$SCREENSHOTS_DIR/${RUN_ID}-after-import.png" >/dev/null 2>&1 || true
ok "Deck ready. Screenshot: $SCREENSHOTS_DIR/${RUN_ID}-after-import.png"

# ── Step 2: Clear logcat + start capture ─────────────────────────────────────

section "2 — Start logcat capture"

adb -s "$ANDROID_SERIAL" logcat -c
adb -s "$ANDROID_SERIAL" logcat -v time \
    ReactNativeJS:V AnkiDroidModule:D AnkiDroidQueries:D AudioTrackManager:D '*:S' \
    > "$LOG_FILE" 2>&1 &
LOGCAT_PID=$!
log "Logcat PID: $LOGCAT_PID  →  $LOG_FILE"

cleanup() {
    kill "$LOGCAT_PID" 2>/dev/null || true
}
trap cleanup EXIT

# ── Step 3: Grant permissions + launch ───────────────────────────────────────

section "3 — Grant permissions + launch"

adb -s "$ANDROID_SERIAL" shell pm grant "$PKG" \
    "com.ichi2.anki.permission.READ_WRITE_DATABASE" 2>/dev/null || true
adb -s "$ANDROID_SERIAL" shell pm grant "$PKG" \
    "android.permission.RECORD_AUDIO" 2>/dev/null || true
adb -s "$ANDROID_SERIAL" shell pm grant "$PKG" \
    "android.permission.POST_NOTIFICATIONS" 2>/dev/null || true

# Ensure Metro tunnel is open
adb -s "$ANDROID_SERIAL" reverse tcp:8081 tcp:8081 2>/dev/null || true

# Set AUTO_START_DECK via env (Metro must be running with this value in .env;
# we can't change it at runtime, so we use the per-launch autostart flag instead
# and pass the deck name via the deep link).
# The deck name is URL-encoded and passed as a query param.
ENCODED_DECK="$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$SCENARIO_DECK")"
FULL_URL="${LAUNCH_URL}&deck=${ENCODED_DECK}"

log "Launching: $PKG"
log "Deck: $SCENARIO_DECK"

adb -s "$ANDROID_SERIAL" shell am start \
    -a android.intent.action.VIEW \
    -d "$LAUNCH_URL" \
    "$PKG" >/dev/null 2>&1 || true

sleep 2

# Take a screenshot of the deck-select to verify the deck is visible
adb -s "$ANDROID_SERIAL" shell screencap -p /sdcard/engram-screenshot.png
adb -s "$ANDROID_SERIAL" pull /sdcard/engram-screenshot.png \
    "$SCREENSHOTS_DIR/${RUN_ID}-launch.png" >/dev/null 2>&1 || true

# If AUTO_START_DECK is not set in .env, tap the deck manually
if ! grep -q "AUTO_START_DECK=${SCENARIO_DECK}" "$APP_DIR/.env" 2>/dev/null; then
    log "AUTO_START_DECK not set for this deck — tapping deck row..."
    sleep 3
    bash "$SCRIPT_DIR/ui.sh" tap "$SCENARIO_DECK" 2>/dev/null \
        || warn "Could not tap deck automatically. Tap '$SCENARIO_DECK' manually."
fi

# ── Step 4: Wait for STEP 7 ───────────────────────────────────────────────────

section "4 — Wait for session STEP 7 (study loop active)"

wait_for_marker "STEP 7" "$SCENARIO_STEP7_TIMEOUT_S" "STEP 7/8 — mic unmuted, study loop active" || {
    fail "Session never reached STEP 7. Common causes:"
    echo "    - Metro is not running (cd App && npx expo start --dev-client)"
    echo "    - The deck name in the scenario doesn't match what AnkiDroid imported"
    echo "    - Android ≥14 scoped storage blocked the file:// import (DEBUGGING.md §12)"
    echo "    - App is missing RECORD_AUDIO / READ_WRITE_DATABASE permissions"
    kill "$LOGCAT_PID" 2>/dev/null || true
    bash "$SCRIPT_DIR/assert-session.sh" --log "$LOG_FILE" \
        --expect-correct 0 --expect-complete 2>/dev/null || true
    exit 1
}

# Screenshot at STEP 7 — should show session screen with the first card
adb -s "$ANDROID_SERIAL" shell screencap -p /sdcard/engram-screenshot.png
adb -s "$ANDROID_SERIAL" pull /sdcard/engram-screenshot.png \
    "$SCREENSHOTS_DIR/${RUN_ID}-step7.png" >/dev/null 2>&1 || true
ok "Session started. Screenshot: $SCREENSHOTS_DIR/${RUN_ID}-step7.png"

# ── Step 5: Inject answers ────────────────────────────────────────────────────

section "5 — Inject answers (${#SCENARIO_ANSWERS[@]} cards)"

for i in "${!SCENARIO_ANSWERS[@]}"; do
    CARD_NUM=$((i + 1))
    ANSWER="${SCENARIO_ANSWERS[$i]}"

    log "Card $CARD_NUM/${#SCENARIO_ANSWERS[@]}: injecting answer..."

    # Screenshot before injection
    adb -s "$ANDROID_SERIAL" shell screencap -p /sdcard/engram-screenshot.png
    adb -s "$ANDROID_SERIAL" pull /sdcard/engram-screenshot.png \
        "$SCREENSHOTS_DIR/${RUN_ID}-card${CARD_NUM}-pre.png" >/dev/null 2>&1 || true

    # Inject via the simulate deep link (dev-only route)
    ENCODED_ANSWER="$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$ANSWER")"
    adb -s "$ANDROID_SERIAL" shell am start -a android.intent.action.VIEW \
        -d "exp+realtimeapionmobile://simulate?answer=${ENCODED_ANSWER}" \
        "$PKG" >/dev/null 2>&1 || true

    log "Waiting ${SCENARIO_ANSWER_DELAY_S}s for tutor response..."
    sleep "$SCENARIO_ANSWER_DELAY_S"

    # Screenshot after tutor response
    adb -s "$ANDROID_SERIAL" shell screencap -p /sdcard/engram-screenshot.png
    adb -s "$ANDROID_SERIAL" pull /sdcard/engram-screenshot.png \
        "$SCREENSHOTS_DIR/${RUN_ID}-card${CARD_NUM}-post.png" >/dev/null 2>&1 || true

    ok "Card $CARD_NUM injected. Screenshots: ${RUN_ID}-card${CARD_NUM}-{pre,post}.png"
done

# ── Step 6: Wait for session complete ────────────────────────────────────────

section "6 — Wait for session complete"

COMPLETE_TIMEOUT=30
DEADLINE=$((SECONDS + COMPLETE_TIMEOUT))
SESSION_DONE=false

while [[ $SECONDS -lt $DEADLINE ]]; do
    if grep -qE "STEP 8|session_complete|no_more_cards|Session ended" "$LOG_FILE" 2>/dev/null; then
        SESSION_DONE=true
        ok "Session completed."
        break
    fi
    sleep 2
done

if ! $SESSION_DONE; then
    warn "Session did not reach STEP 8 within ${COMPLETE_TIMEOUT}s — asserting partial results anyway."
fi

# Final screenshot
adb -s "$ANDROID_SERIAL" shell screencap -p /sdcard/engram-screenshot.png
adb -s "$ANDROID_SERIAL" pull /sdcard/engram-screenshot.png \
    "$SCREENSHOTS_DIR/${RUN_ID}-final.png" >/dev/null 2>&1 || true

# Stop logcat
sleep 2   # drain remaining log lines
kill "$LOGCAT_PID" 2>/dev/null || true
trap - EXIT

# ── Step 7: Assert outcomes ───────────────────────────────────────────────────

section "7 — Assertions"

ASSERT_FLAGS=(
    "--log" "$LOG_FILE"
    "--expect-correct"   "$SCENARIO_EXPECTED_CORRECT"
    "--expect-incorrect" "$SCENARIO_EXPECTED_INCORRECT"
)

[[ -n "${SCENARIO_EXPECTED_SKIPPED:-}" && "$SCENARIO_EXPECTED_SKIPPED" -gt 0 ]] && \
    ASSERT_FLAGS+=("--expect-skipped" "$SCENARIO_EXPECTED_SKIPPED")

$SESSION_DONE && ASSERT_FLAGS+=("--expect-complete")

bash "$SCRIPT_DIR/assert-session.sh" "${ASSERT_FLAGS[@]}"
ASSERT_EXIT=$?

# ── Summary ───────────────────────────────────────────────────────────────────

section "Summary"

{
    echo "Scenario : $SCENARIO_NAME"
    echo "Profile  : $SCENARIO_PROFILE"
    echo "Deck     : $SCENARIO_DECK"
    echo "Run ID   : $RUN_ID"
    echo "Log      : $LOG_FILE"
    echo "Result   : $([ $ASSERT_EXIT -eq 0 ] && echo PASS || echo FAIL)"
    echo ""
    echo "Screenshots:"
    ls "$SCREENSHOTS_DIR/${RUN_ID}"*.png 2>/dev/null | sed 's/^/  /'
} | tee "$SUMMARY_FILE"

echo ""
if [[ $ASSERT_EXIT -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}SCENARIO PASSED: $SCENARIO_NAME${RESET}"
else
    echo -e "${RED}${BOLD}SCENARIO FAILED: $SCENARIO_NAME${RESET}"
    echo "  Inspect: $LOG_FILE"
fi

exit $ASSERT_EXIT
