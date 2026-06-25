#!/usr/bin/env bash
# phase-timeline.sh — Reconstruct the phase timeline from a captured log.
#
# `session-trace.sh` is the live equivalent (same filter, adb source).
# This script is the offline counterpart: hand it a saved logcat file from
# `_debug/runs/<run-id>.log` and get the phase sequence + durations in one
# summary block.
#
# Useful for: comparing two runs side-by-side, finding the canonical
# "session hung in evaluating for 30s" pattern (BUG 9), documenting a bug
# repro without re-running the session.
#
# Usage:
#   scripts/phase-timeline.sh _debug/runs/20260625-134736.log
#   scripts/phase-timeline.sh _debug/runs/*.log      # all logs
#   scripts/phase-timeline.sh --summary only        # just counts
#
# Output columns:
#   FROM_PHASE  TO_PHASE   DELTA_S   WALL_CLOCK

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -eq 0 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
fi

SUMMARY_ONLY=0
FILES=()
for arg in "$@"; do
    case "$arg" in
        --summary-only) SUMMARY_ONLY=1 ;;
        *) FILES+=("$arg") ;;
    esac
done

if [[ ${#FILES[@]} -eq 0 ]]; then
    echo "Usage: $0 [--summary-only] <log-file> [<log-file>...]" >&2
    exit 1
fi

CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

phase_table() {
    local logfile="$1"
    [[ ! -f "$logfile" ]] && { echo "  (missing: $logfile)" >&2; return; }

    awk -v file="$logfile" '
    BEGIN {
        session_start = -1
        last_ms       = -1
        n             = 0
        longest_run   = 0
    }
    function now_ms(line,    ts, h, m, s, ms) {
        # logcat -v time prefix: "MM-DD HH:MM:SS.mmm"
        if (line !~ /^[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}/) return -1
        ts = substr(line, 7, 12)  # HH:MM:SS.mmm
        h  = substr(ts, 1, 2) + 0
        m  = substr(ts, 4, 2) + 0
        s  = substr(ts, 7, 2) + 0
        ms = substr(ts, 10, 3) + 0
        return ((h * 3600 + m * 60 + s) * 1000) + ms
    }
    {
        ms = now_ms($0)
        # Match phase lines: "↳ phase  from → to  (reason)"
        if (match($0, /phase +[^ ]+ +→ +[^ ]+ +\(/) == 0) next
        if (ms < 0) next

        line = $0
        # Strip timestamp prefix (everything up to first non-MM-DD char past position 18).
        sub(/^[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3} +[0-9]+ +[0-9]+ +[A-Z] +[^:]+: */, "", line)

        from = line; sub(/.*phase +/, "", from); sub(/ *→.*/, "", from)
        to   = line; sub(/.*→ +/, "", to);      sub(/ *\(.*/, "", to)

        delta = ""
        if (last_ms >= 0) {
            d = ms - last_ms
            delta = sprintf("%.2f", d / 1000)
        } else {
            delta = "—"
        }

        wall = substr($0, 7, 12)
        if (session_start < 0) {
            session_start = ms
            rel = "T+0000ms"
        } else {
            rel_total = ms - session_start
            rel = sprintf("T+%05dms", rel_total)
        }

        printf "  %s  %-22s  %-22s  %7ss  %s\n", rel, from, to, delta, wall

        last_ms = ms
        n++
        if (d > longest_run) longest_run = d
        if (from == "evaluating" && d > 5000) {
            print "    " red "!! STALLED in evaluating for " sprintf("%.1f", d/1000) "s — check BUG 9 hypothesis" reset > "/dev/stderr"
        }
    }
    END {
        if (n == 0) print "  (no phase transitions found)"
        else if (SUMMARY_ONLY == 0) print "  (" n " transitions; longest phase dwell: " sprintf("%.2f", longest_run/1000) "s)"
    }
    ' "$logfile"
}

for f in "${FILES[@]}"; do
    echo -e "${CYAN}━━━ $f ━━━${RESET}"
    phase_table "$f"
    echo ""
done