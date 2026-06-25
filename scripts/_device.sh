#!/usr/bin/env bash
# Shared device-selector for adb-based scripts.
#
# Goal: when both an emulator and a physical device are attached, the scripts
# should target the physical device by default — emulators are slower and add
# friction. Allow opt-in to a specific device via the standard ANDROID_SERIAL
# env var.
#
# Resolution order:
#   1. $ANDROID_SERIAL already exported  → honor it (no-op).
#   2. Exactly one device attached       → export its serial.
#   3. >1 attached, at least one physical (serial not starting with `emulator-`)
#                                        → export the first physical one.
#   4. >1 attached, all emulators        → export the first.
#   5. 0 attached                        → leave unset and let adb fail loudly.
#
# Source this file from a script BEFORE any adb call:
#
#     SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#     source "$SCRIPT_DIR/_device.sh"
#
# After sourcing, every plain `adb …` in the script targets the chosen device
# because adb honors ANDROID_SERIAL natively. To override per-invocation:
#
#     ANDROID_SERIAL=emulator-5554 ./scripts/test-flow.sh

_engram_select_device() {
  if [[ -n "${ANDROID_SERIAL:-}" ]]; then
    return 0
  fi

  local devices
  devices="$(adb devices 2>/dev/null | awk 'NR>1 && $2=="device" {print $1}')"
  if [[ -z "$devices" ]]; then
    return 0  # nothing attached — let downstream adb call surface the error
  fi

  local count
  count="$(printf '%s\n' "$devices" | wc -l)"
  if (( count == 1 )); then
    export ANDROID_SERIAL="$devices"
    return 0
  fi

  local physical
  physical="$(printf '%s\n' "$devices" | grep -v '^emulator-' | head -1 || true)"
  if [[ -n "$physical" ]]; then
    export ANDROID_SERIAL="$physical"
  else
    export ANDROID_SERIAL="$(printf '%s\n' "$devices" | head -1)"
  fi

  printf '[_device.sh] multiple devices attached — using ANDROID_SERIAL=%s (override by exporting ANDROID_SERIAL)\n' \
    "$ANDROID_SERIAL" >&2
}

_engram_select_device
unset -f _engram_select_device
