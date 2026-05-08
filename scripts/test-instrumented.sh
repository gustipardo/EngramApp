#!/usr/bin/env bash
# Run Kotlin instrumented tests against the AnkiDroid ContentProvider.
# Boots Pixel_9_Automatic headless if no emulator is connected, waits for
# boot, then invokes Gradle. Idempotent — safe to run repeatedly.
#
# Prereqs (one-time):
#   - ANDROID_HOME points at a working SDK with `emulator` + `adb`
#   - An AVD named "Pixel_9_Automatic" exists (`avdmanager list avd`)
#   - AnkiDroid 2.24+ installed on the AVD (sideload the x86_64 APK from
#     https://github.com/ankidroid/Anki-Android/releases)
#   - AnkiDroid bootstrapped — open it once and dismiss the intro/permissions
#     screens so the default collection + "Basic" model exist
#
# These prereqs are documented in TESTING.md.

set -euo pipefail

AVD_NAME="${ENGRAM_TEST_AVD:-Pixel_9_Automatic}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -z "${ANDROID_HOME:-}" ]; then
  echo "[test-instrumented] ANDROID_HOME unset — set it to your Android SDK path." >&2
  exit 2
fi

ADB="$ANDROID_HOME/platform-tools/adb"
EMULATOR="$ANDROID_HOME/emulator/emulator"

# Boot emulator only if no device is currently attached.
if ! "$ADB" devices | awk 'NR>1 && /\<device\>/{found=1} END{exit !found}'; then
  echo "[test-instrumented] booting AVD: $AVD_NAME (headless)..."
  nohup "$EMULATOR" -avd "$AVD_NAME" \
    -no-window -no-audio -no-snapshot-save -no-boot-anim \
    > /tmp/engram-emulator.log 2>&1 &
  disown || true
fi

echo "[test-instrumented] waiting for boot complete..."
until [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
  sleep 2
done
echo "[test-instrumented] booted."

cd "$APP_DIR/android"
exec ./gradlew :anki-droid:connectedAndroidTest
