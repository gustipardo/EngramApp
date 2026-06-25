#!/usr/bin/env bash
# snap.sh — Capture a screenshot of the connected Android device/emulator.
#
# Usage:
#   ./scripts/snap.sh                  # auto-named: _debug/snaps/<ts>.png
#   ./scripts/snap.sh deck-select      # labelled: _debug/snaps/<ts>-deck-select.png
#   ./scripts/snap.sh step3 -o /tmp/x.png   # explicit path with -o
#
# Prints the resulting absolute path to stdout (and a friendly note to stderr)
# so you can chain it: `IMG=$(./scripts/snap.sh phase-eval)`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_device.sh
source "$SCRIPT_DIR/_device.sh"

LABEL="${1:-}"
OUT=""

# Optional -o <path>
if [[ "${2:-}" == "-o" && -n "${3:-}" ]]; then
  OUT="$3"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
SNAPS_DIR="$APP_DIR/_debug/snaps"
mkdir -p "$SNAPS_DIR"

if [[ -z "$OUT" ]]; then
  TS="$(date +%Y%m%d-%H%M%S)"
  if [[ -n "$LABEL" ]]; then
    OUT="$SNAPS_DIR/${TS}-${LABEL}.png"
  else
    OUT="$SNAPS_DIR/${TS}.png"
  fi
fi

# Verify a device is attached before invoking screencap
if ! adb get-state >/dev/null 2>&1; then
  echo "snap.sh: no device/emulator attached (adb get-state failed)" >&2
  exit 1
fi

adb exec-out screencap -p > "$OUT"

# Sanity-check: PNG magic header should be present
if ! head -c 8 "$OUT" | grep -q 'PNG'; then
  echo "snap.sh: capture failed — output is not a PNG ($OUT)" >&2
  exit 2
fi

SIZE="$(stat -c%s "$OUT")"
echo "snap.sh: saved $OUT (${SIZE} bytes)" >&2
echo "$OUT"
