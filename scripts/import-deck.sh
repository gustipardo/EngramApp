#!/usr/bin/env bash
# import-deck.sh — Import a test .apkg into AnkiDroid on Android 14+ devices
# where the documented `am start -d file://…` path is stripped by scoped storage.
#
# Works by handing AnkiDroid a MediaStore `content://` URI instead of a raw
# file path. Verified on the Pixel 9 (Android 17) and the Pixel_9 playstore AVD.
# Background: memory `ankidroid-emulator-import-workaround`.
#
# Usage:
#   scripts/import-deck.sh <profile>        # e.g. aws-sa, refold-english, anatomy-med
#   scripts/import-deck.sh path/to/file.apkg
#
# Steps:
#   1. push the .apkg to /sdcard/Download (FUSE indexes it into MediaStore)
#   2. resolve its MediaStore _id by display name
#   3. fire the VIEW intent at com.ichi2.anki/.IntentHandler with the content:// URI
#   4. tap the "Add" confirm dialog + the "Import" options button via ui.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURES_DIR="$APP_DIR/src/test-harness/fixtures"
source "$SCRIPT_DIR/_device.sh"

PROFILE_OR_PATH="${1:?Usage: import-deck.sh <profile|path-to-apkg>}"

if [[ -f "$PROFILE_OR_PATH" ]]; then
    APKG="$PROFILE_OR_PATH"
else
    APKG="$FIXTURES_DIR/${PROFILE_OR_PATH}.apkg"
fi
[[ ! -f "$APKG" ]] && { echo "[import] apkg not found: $APKG" >&2; exit 1; }

BASENAME="$(basename "$APKG")"
SER="$ANDROID_SERIAL"

echo "[import] device=$SER  file=$BASENAME"

# 1. push (overwrite); FUSE indexes Download into MediaStore
adb -s "$SER" push "$APKG" "/sdcard/Download/$BASENAME" >/dev/null
echo "[import] pushed → /sdcard/Download/$BASENAME"

# 2. resolve MediaStore id
ID="$(adb -s "$SER" shell content query \
    --uri content://media/external/file \
    --projection _id \
    --where "_display_name=\\'$BASENAME\\'" 2>/dev/null \
    | grep -oE '_id=[0-9]+' | head -1 | cut -d= -f2 || true)"

if [[ -z "$ID" ]]; then
    echo "[import] not in MediaStore yet — forcing a scan..."
    adb -s "$SER" shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE \
        -d "file:///sdcard/Download/$BASENAME" >/dev/null 2>&1 || true
    sleep 2
    ID="$(adb -s "$SER" shell content query \
        --uri content://media/external/file \
        --projection _id \
        --where "_display_name=\\'$BASENAME\\'" 2>/dev/null \
        | grep -oE '_id=[0-9]+' | head -1 | cut -d= -f2 || true)"
fi
[[ -z "$ID" ]] && { echo "[import] FAILED to resolve MediaStore id for $BASENAME" >&2; exit 2; }
echo "[import] MediaStore _id=$ID"

# 3. fire the import intent
adb -s "$SER" shell am start \
    -a android.intent.action.VIEW \
    -d "content://media/external/file/$ID" \
    -t application/apkg \
    --grant-read-uri-permission \
    -n com.ichi2.anki/.IntentHandler >/dev/null 2>&1 || true
echo "[import] VIEW intent sent — waiting for AnkiDroid dialog..."
sleep 3

# 4. Two-stage AnkiDroid 2.24+ flow:
#    (a) "Add '<file>' to collection?" confirm dialog → Add
#    (b) "Import options" screen → blue Import button (top-right toolbar)

# tap_exact <text>: tap a node whose text is EXACTLY <text> (not a substring).
# Needed because the confirm dialog's message body also begins with "Add …",
# so a contains-match would hit the paragraph instead of the button.
tap_exact() {
    local want="$1"
    adb -s "$SER" shell uiautomator dump /sdcard/u.xml >/dev/null 2>&1 || return 1
    local bounds
    bounds="$(adb -s "$SER" shell cat /sdcard/u.xml 2>/dev/null \
        | tr '>' '\n' \
        | grep "text=\"$want\"" \
        | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' \
        | head -1)"
    [[ -z "$bounds" ]] && return 1
    local nums; nums="$(echo "$bounds" | grep -oE '[0-9]+')"
    local x1 y1 x2 y2; read -r x1 y1 x2 y2 <<< "$(echo "$nums" | tr '\n' ' ')"
    adb -s "$SER" shell input tap $(( (x1 + x2) / 2 )) $(( (y1 + y2) / 2 ))
    return 0
}

# (a) poll for the Add confirm button (exact match), tap it
for _ in 1 2 3 4 5 6; do
    if tap_exact "Add"; then
        echo "[import] tapped Add"
        break
    fi
    sleep 1
done

# (b) wait for the Import options screen, then tap the top-right Import button.
# Two "Import" texts exist (toolbar title + the blue action button); a text tap
# is ambiguous, so hit the action button by proportional coords (≈95% w, ≈16% h).
sleep 2
SIZE="$(adb -s "$SER" shell wm size | grep -oE '[0-9]+x[0-9]+' | head -1)"
W="${SIZE%x*}"; H="${SIZE#*x}"
IMPORT_X=$(( W * 90 / 100 ))
IMPORT_Y=$(( H * 165 / 1000 ))
for _ in 1 2 3 4 5; do
    if adb -s "$SER" shell uiautomator dump /sdcard/u.xml >/dev/null 2>&1 \
        && adb -s "$SER" shell cat /sdcard/u.xml 2>/dev/null | grep -q "Import options"; then
        adb -s "$SER" shell input tap "$IMPORT_X" "$IMPORT_Y"
        echo "[import] tapped Import button at ($IMPORT_X,$IMPORT_Y)"
        break
    fi
    sleep 1
done
sleep 4

echo "[import] done: $BASENAME"
