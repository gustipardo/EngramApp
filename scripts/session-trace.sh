#!/usr/bin/env bash
# session-trace.sh — Live phase-transition tracer for a running Engram session.
#
# Wraps `adb logcat` with a filter that emits ONLY the structured session
# markers — STEP banners, phase transitions, tool_call / tool_result
# events. Adds two things the raw stream doesn't:
#
#   1. Relative timestamps (T+ms from session start)
#   2. Wall-clock deltas between consecutive phase transitions
#      (e.g. "evaluating → giving_feedback  (Δ 1.34s)")
#
# This is what you reach for when the session hangs in `evaluating`
# and you want to see exactly where it stopped.
#
# Usage:
#   scripts/session-trace.sh                     # live, current device
#   scripts/session-trace.sh --since "13:30:00"  # only lines after wall-clock
#   scripts/session-trace.sh | tee trace.txt     # save while watching
#
# Requires: Metro not required (works on any running Engram session).
#
# Notes:
#   - Unlike scripts/test-flow.sh, this does NOT inject anything. It's a
#     passive observer. Pair with scripts/answer.sh to drive the session.
#   - The phase deltas are computed in real time, so if you `tail -f` the
#     output you see the gap widen as a phase stalls.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_device.sh"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

# Parse args.
SINCE=""
SOURCE="adb"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --since) SINCE="$2"; shift 2 ;;
        --source) SOURCE="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

# --source stdin: read from stdin (useful for unit-testing the filter).
# --source adb (default): live tail logcat.
if [[ "$SOURCE" != "stdin" && "$SOURCE" != "adb" ]]; then
    echo "[session-trace] --source must be 'adb' or 'stdin'" >&2
    exit 1
fi

if [[ "$SOURCE" == "adb" ]]; then
    [[ -z "$(adb -s "$ANDROID_SERIAL" get-state 2>/dev/null || true)" ]] && {
        echo "[session-trace] No device attached (ANDROID_SERIAL=$ANDROID_SERIAL)" >&2
        echo "[session-trace] Hint: pass --source stdin to test the filter with a file" >&2
        exit 1
    }
fi

# Clear logcat so the session start anchors cleanly. (Skip if --since given —
# caller might want to keep historical context.)
if [[ "$SOURCE" == "adb" && -z "$SINCE" ]]; then
    adb -s "$ANDROID_SERIAL" logcat -c >/dev/null 2>&1 || true
fi

LOG_CMD=(adb -s "$ANDROID_SERIAL" logcat -v time
    ReactNativeJS:V AnkiDroidModule:D AnkiDroidQueries:D AudioTrackManager:D '*:S')

echo -e "${CYAN}[session-trace]${RESET} ${DIM}source: $SOURCE $([[ -n "$SINCE" ]] && echo "(since $SINCE)")${RESET}"
echo -e "${CYAN}[session-trace]${RESET} ${DIM}ctrl-c to stop${RESET}"
echo ""

# We tail the raw logcat stream and enrich each line. We track:
#   - The first STEP 1 line seen → marks T=0
#   - The last phase transition timestamp → for Δ computations
LAST_PHASE_TS=""
LAST_PHASE_NAME=""
SESSION_START_TS=""

# awk script that:
#   - strips the bracket timestamp from logcat -v time
#   - detects STEP/phase/tool_call/tool_result markers and prints them with
#     relative ms since session start + delta from previous phase transition.
#   - everything else is dimmed and passed through.
filter() {
    awk -v cyan="$CYAN" -v yellow="$YELLOW" -v green="$GREEN" \
        -v dim="$DIM" -v bold="$BOLD" -v reset="$RESET" '
    function now_ms() {
        # adb -v time prints "MM-DD HH:MM:SS.mmm PID TID LVL TAG: msg".
        # We capture the wall clock (HH:MM:SS.mmm — $2) BEFORE clearing fields.
        ts = $2
        if (ts !~ /^[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}$/) return -1
        h = substr(ts, 1, 2) + 0
        m = substr(ts, 4, 2) + 0
        s = substr(ts, 7, 2) + 0
        ms = substr(ts, 10, 3) + 0
        return ((h * 3600 + m * 60 + s) * 1000) + ms
    }
    {
        # Capture timestamp FIRST — clearing $1/$2 below would blank it.
        ms = now_ms()
        $1 = $2 = ""
        line = substr($0, 3)  # drop the two cleared fields + leading space

        if (ms < 0) {
            # Couldn'\''t parse a timestamp — pass through dimmed.
            print dim line reset
            next
        }

        # Heuristics — grep -E equivalent for log content.
        is_step    = (line ~ /STEP ([0-9]\/[0-9]|1b)/)
        is_phase   = (line ~ /phase .*→/)
        is_tool    = (line ~ /tool_call|tool_result/)
        is_session = (line ~ /Session ended|session_complete|STEP 8/)

        if (is_step && session_start == "") {
            session_start = ms
            print bold cyan "T+0000ms " reset line
            next
        }
        if (session_start == "") {
            # Pre-session noise — pass through dimmed.
            print dim "  (pre) " line reset
            next
        }

        rel = ms - session_start
        rel_total = sprintf("%d", rel)

        if (is_phase) {
            # Extract "from → to" names for the delta annotation.
            t = line
            sub(/.*phase +/, "", t)
            from = t; sub(/ *→.*/, "", from)
            to   = t; sub(/.*→ */, "", to); sub(/ *\(.*/, "", to)

            delta = ""
            if (last_phase_ts != "") {
                d = ms - last_phase_ts
                delta = sprintf(" %s(Δ %d.%02ds)%s", yellow, d / 1000, (d % 1000) / 10, reset)
            }
            print bold cyan "T+" rel_total "ms " reset line delta
            last_phase_ts = ms
            next
        }
        if (is_step) {
            print bold cyan "T+" rel_total "ms " reset line
            next
        }
        if (is_tool) {
            print green "T+" rel_total "ms " line reset
            next
        }
        if (is_session) {
            print bold yellow "T+" rel_total "ms " line reset
            next
        }

        # Default: dim, indent, pass through.
        print dim "  T+" rel_total "ms " line reset
    }
'
}

# Run the filtered log stream.
if [[ "$SOURCE" == "stdin" ]]; then
    # Test mode: just run the filter on whatever is piped in.
    filter
elif [[ -n "$SINCE" ]]; then
    "${LOG_CMD[@]}" | sed -n "/$SINCE/,\$p" | filter
else
    "${LOG_CMD[@]}" | filter
fi