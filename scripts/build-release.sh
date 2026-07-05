#!/usr/bin/env bash
# build-release.sh — THE way to build a release APK.
#
# Exists to make the one dangerous mistake impossible: building a release
# without APP_MODE=production. app.config.js only nulls `geminiApiKey` in
# `extra` when APP_MODE=production; a bare `npx expo run:android --variant
# release` bakes the raw Gemini key into the APK bundle (extractable with
# `strings`), even though the release runtime never uses it (token broker
# path is forced when !__DEV__). This script pins the flag and sanity-checks
# the environment so the config is deterministic.
#
# Usage:
#   scripts/build-release.sh              # build + install APK on connected device
#   scripts/build-release.sh --aab        # build the Play Store bundle (.aab), no install
#   ANDROID_SERIAL=<serial> scripts/build-release.sh
#
# Output: android/app/build/outputs/apk/release/app-release.apk
#     or: android/app/build/outputs/bundle/release/app-release.aab (--aab)
#
# Signing: release builds are signed with the real keystore at
# ../keystore/engram-release.jks (injected by plugins/withReleaseSigning.js,
# which also enables R8 + resource shrinking). If keystore.properties is
# missing it falls back to the debug keystore — the cert check below will
# flag that. BACK UP the keystore folder; losing it means losing the Play
# upload key.

set -euo pipefail
cd "$(dirname "$0")/.."

# Sanity check: .env must be loadable (expo-cli reads it for the rest of the
# config — GOOGLE_WEB_CLIENT_ID etc.). A shell where GEMINI_API_KEY is
# neither exported nor present in .env means the env didn't load at all and
# the resulting config would silently fall back to defaults.
if [ -z "${GEMINI_API_KEY:-}" ] && ! grep -q "^GEMINI_API_KEY=" .env 2>/dev/null; then
  echo "ERROR: GEMINI_API_KEY not found in the environment or .env." >&2
  echo "The build environment did not load — refusing to build blind." >&2
  exit 1
fi

export APP_MODE=production

verify_cert() { # $1 = artifact path
  local subject
  subject=$(keytool -printcert -jarfile "$1" 2>/dev/null | grep -m1 "Owner:" || true)
  echo "Signing cert: ${subject:-<none found>}"
  case "$subject" in
    *CN=Engram*) echo "OK: signed with the Engram release keystore." ;;
    *) echo "WARNING: NOT signed with the Engram release key (debug fallback?)." >&2 ;;
  esac
}

if [ "${1:-}" = "--aab" ]; then
  echo "Building Play Store bundle with APP_MODE=production..."
  # prebuild keeps android/ in sync with app.json + plugins before gradle runs
  npx expo prebuild --platform android --no-install
  (cd android && ./gradlew bundleRelease)
  AAB=android/app/build/outputs/bundle/release/app-release.aab
  ls -lh "$AAB"
  verify_cert "$AAB"
else
  echo "Building release APK with APP_MODE=production (raw Gemini key nulled in extra)..."
  npx expo run:android --variant release
  verify_cert android/app/build/outputs/apk/release/app-release.apk
fi
