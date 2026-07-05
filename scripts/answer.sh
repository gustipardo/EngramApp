#!/usr/bin/env bash
# answer.sh — Simulate a user's spoken answer during a running session by
# sending a deep link the app translates into sessionManager.simulateUserAnswer.
#
# Requires:
#   - Engram dev build installed on the connected device/emulator.
#   - A session already active (i.e. logs have reached STEP 7).
#   - The app to be in dev mode (the deep link listener is gated on __DEV__).
#
# Usage:
#   ./scripts/answer.sh "VPC Peering connects two VPCs privately"
#   ./scripts/answer.sh "no idea"
#
# It URL-encodes the answer, fires the intent via `adb shell am start`, and
# prints what got sent so you can correlate with the [SIM] line in logcat.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_device.sh
source "$SCRIPT_DIR/_device.sh"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <answer text>" >&2
  exit 1
fi

ANSWER="$*"

if ! adb get-state >/dev/null 2>&1; then
  echo "answer.sh: no device/emulator attached (adb get-state failed)" >&2
  exit 1
fi

# URL-encode using python (universal on Linux dev boxes); jq fallback if not.
if command -v python3 >/dev/null 2>&1; then
  ENCODED="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$ANSWER")"
elif command -v jq >/dev/null 2>&1; then
  ENCODED="$(printf '%s' "$ANSWER" | jq -sRr @uri)"
else
  echo "answer.sh: need python3 or jq for url-encoding" >&2
  exit 2
fi

URL="engram://simulate?answer=${ENCODED}"
PKG="com.engram.app"

echo "answer.sh: sending → $URL" >&2

adb shell am start \
  -a android.intent.action.VIEW \
  -d "$URL" \
  "$PKG" 2>&1 | tail -2
