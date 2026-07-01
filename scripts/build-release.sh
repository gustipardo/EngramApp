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
#   scripts/build-release.sh              # build + install on connected device
#   ANDROID_SERIAL=<serial> scripts/build-release.sh
#
# Output APK: android/app/build/outputs/apk/release/app-release.apk
#
# NOTE: release is still signed with the debug keystore and unminified —
# fine for personal sideload testing, a blocker for Play (see ROADMAP.md).

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

echo "Building release with APP_MODE=production (raw Gemini key nulled in extra)..."
npx expo run:android --variant release
