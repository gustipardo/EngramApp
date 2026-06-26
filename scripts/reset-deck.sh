#!/usr/bin/env bash
# reset-deck.sh — Delete a deck from AnkiDroid by name, then re-import it fresh
# from its test .apkg so every scenario run starts with a full, unstudied queue.
#
# Why: scenarios answer cards (write-back advances them out of the "new" queue),
# and re-importing the same .apkg merges by note GUID WITHOUT resetting the
# schedule. Deleting first guarantees the re-import lands cards as new/due again.
#
# Usage:
#   scripts/reset-deck.sh <profile> "<deck name as shown in AnkiDroid>"
#   scripts/reset-deck.sh aws-sa "Engram Test — AWS SA"
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_device.sh"

PROFILE="${1:?Usage: reset-deck.sh <profile> <deck-name>}"
DECK_NAME="${2:?Usage: reset-deck.sh <profile> <deck-name>}"
SER="$ANDROID_SERIAL"

dump()  { adb -s "$SER" shell uiautomator dump /sdcard/u.xml >/dev/null 2>&1; }
xml()   { adb -s "$SER" shell cat /sdcard/u.xml 2>/dev/null; }

# bounds_of <exact-text> → "x1 y1 x2 y2" (empty if not found)
bounds_of() {
    xml | tr '>' '\n' | grep "text=\"$1\"" \
        | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' \
        | head -1 | grep -oE '[0-9]+' | tr '\n' ' '
}
tap_exact() {
    dump; local b; b="$(bounds_of "$1")"
    [[ -z "$b" ]] && return 1
    read -r x1 y1 x2 y2 <<< "$b"
    adb -s "$SER" shell input tap $(( (x1+x2)/2 )) $(( (y1+y2)/2 ))
}

# Make sure we're on the DeckPicker
adb -s "$SER" shell am force-stop com.ichi2.anki
adb -s "$SER" shell monkey -p com.ichi2.anki -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
sleep 4

# 1. Delete the deck if present (long-press row → Delete deck → confirm)
dump
B="$(bounds_of "$DECK_NAME")"
if [[ -n "$B" ]]; then
    read -r x1 y1 x2 y2 <<< "$B"
    cx=$(( (x1+x2)/2 )); cy=$(( (y1+y2)/2 ))
    adb -s "$SER" shell input swipe "$cx" "$cy" "$cx" "$cy" 800   # long-press
    sleep 2
    tap_exact "Delete deck" && echo "[reset] Delete deck tapped" || echo "[reset] no Delete deck item"
    sleep 2
    tap_exact "Delete" || tap_exact "DELETE" || tap_exact "OK" || true
    sleep 2
    echo "[reset] deleted: $DECK_NAME"
else
    echo "[reset] deck not present (nothing to delete): $DECK_NAME"
fi

# 2. Re-import fresh
bash "$SCRIPT_DIR/import-deck.sh" "$PROFILE"
# back to deck picker
adb -s "$SER" shell input keyevent KEYCODE_BACK; sleep 1
adb -s "$SER" shell input keyevent KEYCODE_BACK; sleep 1
echo "[reset] done: $DECK_NAME"
