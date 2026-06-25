#!/usr/bin/env bash
# dump-decks.sh — List AnkiDroid decks with due counts, without launching Engram.
#
# Strategy: open AnkiDroid, dump the live UI hierarchy via uiautomator, parse
# the deck rows + their "N due" counts. Works on every device/emulator that
# AnkiDroid runs on, no permissions required.
#
# Faster than launching Engram for a quick "is the deck I expect actually
# there?" check. For deeper due-count breakdowns (learn vs review vs new),
# the AnkiDroid ContentProvider query would be richer — but that requires
# READ_WRITE_DATABASE to be granted to the shell user, which the production
# provider blocks.
#
# Usage:
#   scripts/dump-decks.sh                # current device
#   scripts/dump-decks.sh --json         # machine-readable
#
# Output (text):
#   Aws Exam SA                              248 due
#   Refold English Phrasal Verbs             217 due
#   ...
#
# Output (json):
#   [{"name":"Aws Exam SA","due":248}, ...]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_device.sh"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

JSON=0
for arg in "$@"; do
    case "$arg" in
        --json) JSON=1 ;;
        -h|--help)
            sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
    esac
done

[[ -z "$(adb -s "$ANDROID_SERIAL" get-state 2>/dev/null || true)" ]] && {
    echo "[dump-decks] No device attached (ANDROID_SERIAL=$ANDROID_SERIAL)" >&2
    exit 1
}

# 1. Make sure AnkiDroid is running and we're on DeckPicker.
# DeckPicker isn't an exported activity, so we launch via the main
# launcher intent. Then we wait long enough for the collection to load
# (the "study less, remember more" onboarding screen can also show on
# first launch — the script handles that by looking for ANY deck row).
echo -e "${DIM}[dump-decks]${RESET} launching AnkiDroid..." >&2
adb -s "$ANDROID_SERIAL" shell am force-stop com.ichi2.anki
adb -s "$ANDROID_SERIAL" shell monkey -p com.ichi2.anki -c android.intent.category.LAUNCHER 1 \
    >/dev/null 2>&1
sleep 4

# 2. Pull the live UI hierarchy.
TMP_UI="$(mktemp)"
trap 'rm -f "$TMP_UI"' EXIT

adb -s "$ANDROID_SERIAL" shell uiautomator dump /sdcard/engram-deckdump.xml >/dev/null 2>&1
adb -s "$ANDROID_SERIAL" pull /sdcard/engram-deckdump.xml "$TMP_UI" >/dev/null 2>&1

if [[ ! -s "$TMP_UI" ]]; then
    echo "[dump-decks] uiautomator dump returned empty — is the device responsive?" >&2
    exit 1
fi

# 3. Parse with Python stdlib (no extra deps).
python3 - "$TMP_UI" "$JSON" <<'PYEOF'
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

xml_path = Path(sys.argv[1])
json_mode = sys.argv[2] == "1"

try:
    tree = ET.parse(xml_path)
except ET.ParseError as e:
    print(f"[dump-decks] XML parse error: {e}", file=sys.stderr)
    sys.exit(1)

root = tree.getroot()

# AnkiDroid DeckPicker: each deck row carries a deck name and a stats line
# like "248 due" or "12 new" or "3 learning / 12 review".
# Strategy: find every text node whose content matches a due-count pattern,
# then look at the nearest preceding sibling with a deck-name-like value.

# Heuristic: deck names are typically the longest text on a row (3+ words
# usually); due lines are short and contain "due" / "new" / "learning" /
# "review" tokens.

decks = []
seen_rows = set()

for node in root.iter("node"):
    text = node.get("text", "") or ""
    desc = node.get("content-desc", "") or ""
    candidate = text or desc
    if not candidate:
        continue
    # Match a deck-name line: not a count, not a button label.
    if any(tok in candidate.lower() for tok in ("due", "new", "learning", "review")):
        continue
    if candidate in ("Decks", "Study", "Add", "Browse", "Sync", "More", "Menu",
                       "AnkiDroid", "Study less", "Remember more"):
        continue
    # Filter very short or numeric-only strings.
    if len(candidate) < 3 or candidate.replace(" ", "").isdigit():
        continue
    # Skip duplicates that often appear (deck name rendered twice on a row).
    if candidate in seen_rows:
        continue
    seen_rows.add(candidate)

    # Find the nearest count line after this deck name within ~500px y-coord.
    target_y = node.get("bounds", "")
    try:
        # bounds="[x1,y1][x2,y2]"
        parts = target_y.replace("][", ",").strip("[]").split(",")
        if len(parts) == 4:
            my_y = (int(parts[1]) + int(parts[3])) // 2
        else:
            my_y = -1
    except Exception:
        my_y = -1

    due = None
    best = None
    for sib in root.iter("node"):
        sib_text = sib.get("text", "") or ""
        if not sib_text:
            continue
        if "due" not in sib_text.lower() and "new" not in sib_text.lower():
            continue
        sib_bounds = sib.get("bounds", "")
        try:
            sp = sib_bounds.replace("][", ",").strip("[]").split(",")
            if len(sp) == 4:
                sib_y = (int(sp[1]) + int(sp[3])) // 2
            else:
                continue
        except Exception:
            continue
        # Match if sib is on the same row (within 100px) AND on the right half
        # of the screen (count column).
        dx = abs(my_y - sib_y)
        if dx < 100 and (best is None or dx < best[0]):
            best = (dx, sib_text)
    if best:
        # Pull the leading number out of the count line.
        import re
        m = re.match(r"\s*(\d+)", best[1])
        if m:
            due = int(m.group(1))

    if due is not None or my_y > 0:
        decks.append((candidate, due))

# Filter out non-deck items (UI chrome).
# A real deck row almost always has a numeric due count. Drop entries
# without one — they're header text / onboarding copy that slipped through.
real_decks = [(n, d) for (n, d) in decks if d is not None]

if json_mode:
    import json as _json
    payload = [{"name": n, "due": d} for (n, d) in real_decks]
    print(_json.dumps(payload, indent=2, ensure_ascii=False))
else:
    if not real_decks:
        print("[dump-decks] no decks found — is AnkiDroid set up?", file=sys.stderr)
        sys.exit(1)
    name_w = max(len(n) for (n, _) in real_decks)
    for n, d in real_decks:
        print(f"  {n.ljust(name_w)}  {d} due")
    print(f"\n[total: {len(real_decks)} deck(s)]", file=sys.stderr)
PYEOF