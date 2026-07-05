#!/usr/bin/env bash
# setup-test-emulator.sh — Boot a clean AVD, install AnkiDroid, import the
# test deck, and grant permissions so WriteBackTest.kt (and test-e2e-clean.sh)
# run against isolated data instead of a personal collection.
#
# Prerequisites (one-time, run manually):
#   sdkmanager "system-images;android-34;google_apis;x86_64"
#   avdmanager create avd -n Pixel_9_Test -k "system-images;android-34;google_apis;x86_64"
#
# Usage:
#   scripts/setup-test-emulator.sh [--skip-boot]   # --skip-boot if already running
#
# The "google_apis" image (NOT "google_apis_playstore") is required for adb root.
# "google_apis_playstore" — the default Pixel 9 image — cannot be rooted and
# cannot be inspected via adb shell, which blocks full SQLite verification.
# AnkiDroid imports via the intent API do NOT need root.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APKG_PATH="$APP_DIR/src/test-harness/fixtures/engram-test-deck.apkg"
ANKIDROID_APK_URL="https://github.com/ankidroid/Anki-Android/releases/download/v2.19.0/AnkiDroid-2.19.0-arm64-v8a.apk"
ANKIDROID_APK_LOCAL="$SCRIPT_DIR/../.cache/AnkiDroid-2.19.0.apk"
AVD_NAME="${TEST_AVD:-Pixel_9_Test}"
DEVICE_SERIAL="${ANDROID_SERIAL:-emulator-5554}"
SKIP_BOOT="${1:-}"

# ── helpers ──────────────────────────────────────────────────────────────────

log() { echo "[setup-test-emulator] $*"; }
die() { echo "[setup-test-emulator] ERROR: $*" >&2; exit 1; }

wait_for_boot() {
  log "Waiting for emulator to finish booting..."
  local deadline=$((SECONDS + 120))
  while [ $SECONDS -lt $deadline ]; do
    local status
    status=$(adb -s "$DEVICE_SERIAL" shell getprop sys.boot_completed 2>/dev/null || true)
    if [ "$status" = "1" ]; then
      log "Emulator is up."
      return 0
    fi
    sleep 3
  done
  die "Emulator did not boot within 120 s"
}

adb_serial() { adb -s "$DEVICE_SERIAL" "$@"; }

# ── 1. Boot ──────────────────────────────────────────────────────────────────

if [ "$SKIP_BOOT" = "--skip-boot" ]; then
  log "Skipping boot (--skip-boot passed)."
else
  log "Starting AVD '$AVD_NAME' (wipe data for clean state)..."
  emulator -avd "$AVD_NAME" -wipe-data -no-audio -no-window &
  EMULATOR_PID=$!
  wait_for_boot
fi

# ── 2. Root the emulator (google_apis image required) ────────────────────────

log "Rooting emulator..."
adb -s "$DEVICE_SERIAL" root || log "Warning: adb root failed (only works with google_apis image)."
sleep 2

# ── 3. Download + install AnkiDroid ──────────────────────────────────────────

mkdir -p "$(dirname "$ANKIDROID_APK_LOCAL")"
if [ ! -f "$ANKIDROID_APK_LOCAL" ]; then
  log "Downloading AnkiDroid APK from GitHub..."
  curl -L --fail -o "$ANKIDROID_APK_LOCAL" "$ANKIDROID_APK_URL" \
    || die "Download failed. Check the URL or drop the APK at $ANKIDROID_APK_LOCAL manually."
else
  log "Using cached AnkiDroid APK: $ANKIDROID_APK_LOCAL"
fi

log "Installing AnkiDroid..."
adb_serial install -r "$ANKIDROID_APK_LOCAL"

# ── 4. Launch AnkiDroid once to bootstrap the default collection ──────────────

log "Launching AnkiDroid to bootstrap collection..."
adb_serial shell am start -n "com.ichi2.anki/.IntentHandler"
sleep 5  # give it time to initialise the DB

# ── 5. Push the test deck and fire the import intent ─────────────────────────

log "Pushing test deck to device..."
adb_serial push "$APKG_PATH" /sdcard/Download/engram-test-deck.apkg

log "Triggering AnkiDroid import..."
adb_serial shell am start \
  -a android.intent.action.VIEW \
  -d "file:///sdcard/Download/engram-test-deck.apkg" \
  -t "application/apkg" \
  -n "com.ichi2.anki/.IntentHandler" \
  || log "Warning: import intent returned non-zero (AnkiDroid may have handled it inline)."

sleep 4  # wait for import to complete

# ── 6. Grant our app permission to read/write AnkiDroid ──────────────────────

log "Granting READ_WRITE_DATABASE to our app..."
# The permission must be granted before connectedAndroidTest runs so that
# GrantPermissionRule can override it.  This grant covers the instrumented
# test runner package.
adb_serial shell pm grant com.engram.app \
  "com.ichi2.anki.permission.READ_WRITE_DATABASE" 2>/dev/null \
  || log "Warning: pm grant failed (may be OK if app not installed yet)."

log ""
log "Done. Emulator is ready for isolated testing."
log "Next step: run './gradlew :anki-droid:connectedAndroidTest' or"
log "           'scripts/monitor-writeback.sh --instrumented'"
