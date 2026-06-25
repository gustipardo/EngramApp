# Debugging — Engram Session Pipeline

> Read this **before** touching anything that runs during a study session
> (`sessionManager.ts`, `geminiManager.ts`, `(main)/session.tsx`, `prompts.ts`,
> or the AnkiDroid bridge). It documents how to reproduce, instrument, and
> cross-reference a session run without manual tapping.
>
> Companion to `SESSION-FLOW.md` (which is the canonical contract of how the
> session is _supposed_ to work). This doc is about how to _observe_ the real
> run against that contract.

---

## TL;DR — Recipe for a debug session

```bash
# 1. Make sure an Android device/emulator is attached
adb devices

# 2. Start Metro
cd App && npx expo start --dev-client --port 8081

# 3. (Other terminal) build + install if APK is stale
cd App/android && ./gradlew app:assembleDebug -x lint -x test -PreactNativeArchitectures=x86_64
adb install -r app/build/outputs/apk/debug/app-debug.apk

# 4. Launch the app pointing at host Metro
adb reverse tcp:8081 tcp:8081
adb shell am start -a android.intent.action.VIEW \
  -d "exp+realtimeapionmobile://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081" \
  com.anonymous.RealtimeApiOnMobile

# 5. Stream the structured logs — broaden filter to include native module
#    tags so AnkiDroidQueries and AudioTrackManager lines come through.
adb logcat -c
adb logcat -v time ReactNativeJS:V AnkiDroidModule:D AnkiDroidQueries:D AudioTrackManager:D '*:S' | \
  grep --line-buffered -E "STEP [0-9]/8|phase  |autostart|FAIL|! \[|x \[|tool_call|tool_result|user → transcript|user speech started|setupComplete|Session ended|halted|Flushed|Stopped|head:|refilled next card"

# 6. Need a visual reference? Snap the emulator at any moment:
./scripts/snap.sh some-label
```

With `AUTO_START_DECK` set in `.env`, the app starts a session by itself —
no taps needed. The terminal then shows the 8-step canonical flow live.

---

## 0. Execution modes, permissions & the headless contract (READ FIRST)

Things that are easy to infer wrong and have cost real time. Read before running any on-device harness.

### Dev mode vs test mode — `test-flow.sh`/`answer.sh` run in DEV, not test

`getAppMode()` (`src/config/env.ts`) returns `dev | test | production` from
`Constants.expoConfig.extra.appMode` (baked from the `APP_MODE` env **at Metro
start**), falling back to `__DEV__`.

- The answer-injector deep link (`exp+…://simulate?answer=`) is handled by
  `src/app/simulate.tsx`, which is **gated on `isDev()`**. So `answer.sh` (and
  therefore `test-flow.sh`) only works in **dev** mode.
- **`APP_MODE=test` is a different mode**: it swaps the mic for `fakeMicSource`
  (replays a PCM clip) via `test-harness/bootstrap.ts`. But
  `getAppMode()==='test'` makes **`isDev()` return false**, which **disables the
  `simulate` route**. ⇒ You **cannot** combine `APP_MODE=test` with `answer.sh`
  — they are mutually exclusive:
  - Answers as **text** → **dev** mode + `answer.sh` (what `test-flow.sh` does).
  - Answers as **recorded PCM** → `APP_MODE=test` + `fakeMicSource`, _no_ `answer.sh`.
- **No fake Gemini on device.** Both modes use **real Gemini Live** (real API
  cost) and **play the tutor's audio on the speaker**. The only mocked-Gemini
  path is the Jest suite (`npm test`), off-device.

### Runtime permissions (with `SKIP_ONBOARDING`)

`SKIP_ONBOARDING` jumps past `permissions.tsx`, so nothing is requested at
runtime. A fresh/over-install then has **no** permissions granted, and the app
errors or **hard-crashes**:

| Permission                                      | If missing                                                                                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `com.ichi2.anki.permission.READ_WRITE_DATABASE` | deck-select → `AnkiDroid API permission not granted` → "Failed to load decks"                                                                              |
| `android.permission.RECORD_AUDIO`               | **FATAL crash** at STEP 6 — `SecurityException: Starting FGS with type microphone … requires … RECORD_AUDIO` (`ForegroundAudioService.kt`, targetSDK ≥ 34) |
| `android.permission.POST_NOTIFICATIONS`         | FGS notification silently absent (no crash)                                                                                                                |

```bash
PKG=com.anonymous.RealtimeApiOnMobile
adb shell pm grant $PKG com.ichi2.anki.permission.READ_WRITE_DATABASE
adb shell pm grant $PKG android.permission.RECORD_AUDIO
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS
```

`test-flow.sh` already grants all three after its `pm clear` (which wipes them).
A bare `am start` does **not** — grant manually or you'll hit the mic-FGS crash.

### Metro host — emulator AND physical device

Use **`adb reverse tcp:8081 tcp:8081` + `localhost:8081`** for both. The old
hardcoded `10.0.2.2` only resolves on the emulator. `test-flow.sh` now defaults
to `localhost` (override with `METRO_HOST=<ip>`) and opens the reverse tunnel
before launch.

### Autostart can silently miss (race)

`?autostart=1` sets a **non-reactive** override (`autostartFlag.ts`) from
`_layout`'s async `getInitialURL()`. `deck-select`'s autostart effect checks
`isAutostartEnabled()` when decks load and does **not** re-run when the override
flips later. If decks load before `getInitialURL` resolves, autostart no-ops with
**no `[autostart]` log line**. Reliable alternatives: set `AUTO_START_ENABLED=true`
in `.env` (read at Metro start — no race), or just tap the deck. (Proper fix:
make the override reactive / add it to the effect deps.)

### zsh gotcha

Unquoted `*:S` in a logcat filter is glob-expanded by zsh → `no matches found`,
and the command fails. Always quote it: `adb logcat … 'ReactNativeJS:V' '*:S'`.

---

## 1. What's instrumented

Three production files emit structured events into a single stream:

| File                             | Role                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/services/sessionManager.ts` | The 8 canonical step banners, tool-call lifecycle, AnkiDroid write-backs, reconnect flow     |
| `src/services/geminiManager.ts`  | WebSocket / setup / `toolCall` / `turnComplete` / playback errors                            |
| `src/services/cardLoader.ts`     | Deck load result + errors                                                                    |
| `src/stores/useSessionStore.ts`  | Every phase transition (`idle → connecting`, etc.) — fires automatically from `transitionTo` |

All of them call into one logger:

### `src/services/sessionDebugLogger.ts`

```ts
sessionLog.banner('Starting session — deck: "X"');         // Heavy separator
sessionLog.step(n, { ... });                                // STEP 1/8…STEP 8/8 banner
sessionLog.stepDone(n, { ... });                            // OK marker for step n
sessionLog.stepFail(n, reason, { ... });                    // Loud failure marker
sessionLog.phase(from, to, reason);                         // Wired into useSessionStore
sessionLog.event(scope, name, { ... });                     // tool_call, setupComplete, etc.
sessionLog.info / warn / error(scope, msg, { ... });        // Standard severity
sessionLog.debug(scope, msg, { ... });                      // Only printed when VERBOSE
```

Every line is prefixed with a millisecond-resolution timestamp:

```
[16:51:57.172] ── STEP 1/8 ─ Connect WebSocket (Gemini Live) ──
     deck           "Aws Exam SA"
     prev_state     "disconnected"
[16:51:57.173]   ↳ phase  idle → connecting  (startSession)
[16:51:57.560]     [Gemini] WebSocket opened
[16:51:57.632]     [Gemini] audio player initialised
[16:51:57.682]     [Gemini] mic capture started
[16:51:57.686] ── STEP 2/8 ─ Initialise audio I/O + start mic capture (muted) ──
```

### Verbose mode

Off by default. Turn on with one of:

- `SESSION_DEBUG_VERBOSE=1` in `App/.env` (loaded into
  `Constants.expoConfig.extra.sessionDebugVerbose` via `app.config.js`).
- At runtime: `sessionLog.setVerbose(true)`.

Verbose enables:

- Raw Gemini message keys dump per incoming WS message.
- Setup payload (first 1000 chars).
- Mic chunk heartbeat (every 200 chunks).
- 5s-post-VAD audio-track state probe.
- Other `sessionLog.debug(...)` lines.

Use it when you suspect the WS layer or the audio path is the bug; leave
it off otherwise — the default stream is enough to identify which of the
four canonical bugs in `SESSION-FLOW.md §4` is in play.

---

## 2. The 8-step canonical flow

Mapped 1:1 to `SESSION-FLOW.md §1`. Each step prints a banner before its
work and an `OK step n` line after success (or `FAIL step n` with reason).

| Step | What                                                 | Where (file:fn)                                                     |
| ---- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| 1    | Connect WebSocket (Gemini Live)                      | `sessionManager.startSession`                                       |
| 2    | Initialise audio I/O + start mic capture (muted)     | `sessionManager.startSession`                                       |
| 3    | Load due cards from AnkiDroid                        | `cardLoader.loadDueCards`                                           |
| 4    | Send setup message to Gemini (system prompt + tools) | `sessionManager.configureAISession` → `geminiManager.updateSession` |
| 5    | Send first card as user text message                 | `sessionManager.sendFirstCard`                                      |
| 6    | Wait for AI first response to finish                 | `sessionManager.sendFirstCard`                                      |
| 7    | Enable server VAD + unmute mic (study loop active)   | `sessionManager.startSession` (post-`sendFirstCard`)                |
| 8    | Session complete (no more cards or `end_session`)    | `sessionManager.handleEvaluateAndMoveNext` / `handleEndSessionTool` |

The study loop (STEP 7) prints sub-events instead of new step banners:

```
• mic → unmuted
• mic → user speech started
• user → transcript { text: "..." }
↳ phase  awaiting_answer → evaluating  (user_answered)
• Gemini → toolCall received { name: "evaluate_and_move_next", ... }
• tool_call → evaluate_and_move_next { quality:"correct", feedback:"..." }
• AnkiDroid → write-back (fire-and-forget) { cardId, ord, pass:true }
• tool_result → evaluate_and_move_next → Gemini { next_card_front, remaining, stats }
↳ phase  evaluating → giving_feedback  (ai_speaking)
• Gemini → turnComplete → response.done
↳ phase  giving_feedback → awaiting_answer  (ai_done)
```

---

## 3. Bug-detection cheatsheet (cross-reference to `SESSION-FLOW.md §4`)

| Bug                                          | Symptom in stream                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **BUG 1** — premature `turnComplete`         | `Gemini → turnComplete → response.done` fires before any `AI → transcript` chunk in that turn                      |
| **BUG 2** — mic can't hear user              | No `mic → user speech started` and no `user → transcript` after STEP 7. Check `Silent (-XXXX dB)` on a fresh snap. |
| **BUG 3** — tutor talks but never marks card | `AI → transcript` shows "Correct" but no subsequent `Gemini → toolCall received` and no `AnkiDroid → write-back`   |
| **BUG 4** — UI freezes on previous card      | Missing `phase  evaluating → giving_feedback`, or `phase  giving_feedback → awaiting_answer` never fires           |

When unsure which is which, snap the emulator (see §5) and compare what
the user sees vs what the phase machine thinks it's doing.

---

## 4. Autostart — sessions without manual tapping

Wired in `(main)/deck-select.tsx`. On mount, after decks load, if **both**
the deck name is configured **and** the autostart gate is open, the screen
calls `handleSelectDeck(name)` automatically (once per mount).

Autostart is **opt-in** — daily icon-launches do nothing special. Two ways
to open the gate:

| Path                                         | Where                | Scope                    |
| -------------------------------------------- | -------------------- | ------------------------ |
| `AUTO_START_ENABLED=true` in `App/.env`      | sticky, every launch | dev iteration            |
| `&autostart=1` query on the launch deep link | per-launch           | scripts (`test-flow.sh`) |

### Configure the deck

`App/.env`:

```
AUTO_START_DECK=Aws Exam SA      # deck name (exact match)
AUTO_START_ENABLED=false         # gate — flip to true for sticky autostart
EXPO_PUBLIC_SESSION_DEBUG_VERBOSE=0
```

Names must be exact (case + spaces). The first run prints the available
names if the match fails:

```
[autostart] deck "AwsExamSA" not found in loaded decks
            (have: Aws Exam SA | Aws Exam Sets | Comunication skills | Mining | Refold English Phrasal Verbs)
```

### Per-launch override (no .env edit)

Append `&autostart=1` to the dev-client deep link:

```bash
adb shell am start -a android.intent.action.VIEW \
  -d "exp+realtimeapionmobile://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081&autostart=1" \
  com.anonymous.RealtimeApiOnMobile
```

`scripts/test-flow.sh` already includes `&autostart=1` so the test pipeline
keeps working regardless of the `.env` setting.

### Plumbing

- `app.config.js` reads `AUTO_START_DECK` + `AUTO_START_ENABLED` and forwards
  them under `expoConfig.extra.autoStartDeck` / `autoStartEnabled`.
- `_layout.tsx` parses `Linking.getInitialURL()` for `?autostart=1` and
  calls `setAutostartOverride(true)` (dev builds only).
- `src/services/autostartFlag.ts` exposes `isAutostartEnabled()` — true if
  either env gate is open or the runtime override is set.
- `(main)/deck-select.tsx` reads `autoStartDeck` and only fires when
  `isAutostartEnabled()` returns true.
- The autostart effect is idempotent for a mount via `autoStartFiredRef`.
- Set `AUTO_START_ENABLED=false` (default) and don't pass the deep-link
  param — deck-select behaves like production.

### When `.env` changes don't take effect

`app.config.js` is evaluated when Metro starts. Editing `.env` and hot-reloading
JS does _not_ re-read it. Restart Metro:

```bash
# Kill the running expo start, then
cd App && npx expo start --dev-client --port 8081
```

---

## 5. Screenshots — `scripts/snap.sh`

On-demand emulator screenshots, for cross-referencing visual state against
logged state. Outputs PNG to `App/_debug/snaps/<YYYYMMDD-HHMMSS>[-label].png`.

```bash
./scripts/snap.sh                     # _debug/snaps/<ts>.png
./scripts/snap.sh deck-select         # _debug/snaps/<ts>-deck-select.png
./scripts/snap.sh step3 -o /tmp/x.png # explicit output path

# Chain — capture and grab the path in a variable
IMG=$(./scripts/snap.sh phase-eval)
```

Guarantees:

- Fails fast if no device attached (`adb get-state` check).
- Verifies PNG magic header on the resulting file.
- Path goes to stdout; status note goes to stderr.

The shot can be read back into the conversation with the `Read` tool — Claude
ingests it as an image and can compare it against the logged phase state.

Typical use during a debugging session:

```
[log shows STEP 7 reached, no user transcript after 20s]
→ ./scripts/snap.sh stuck-at-step7
→ Read /…/_debug/snaps/…-stuck-at-step7.png
→ See "Silent (-6457 dB)" → confirm it's an emulator-mic issue, not a
  pipeline bug.
```

---

## 6. Simulating a user answer — `scripts/answer.sh`

End-to-end driver: inject what would otherwise be a spoken answer, without
a microphone. The eval pipeline downstream (Gemini's `evaluate_and_move_next`
tool call → AnkiDroid write-back → UI advance to next card) runs for real.

```bash
./scripts/answer.sh "VPC Peering connects two VPCs privately"
./scripts/answer.sh "no idea, skip this one"
```

What it does:

1. URL-encodes the answer.
2. Fires `adb shell am start -a android.intent.action.VIEW -d
"exp+realtimeapionmobile://simulate?answer=…"`.
3. `_layout.tsx`'s `Linking` listener parses the URL and calls
   `sessionManager.simulateUserAnswer(text)`.
4. The simulator: mutes the mic → logs `[SIM] injecting user answer` →
   transitions phase to `evaluating` → sends a user-role `clientContent`
   turn to Gemini via `webrtcManager.sendTextMessage` → unmutes mic
   after 300 ms.
5. Gemini treats the text as the user's answer and fires its normal
   `evaluate_and_move_next` tool call. The session advances.

### Constraints

- The deep-link listener is **dev-only** (gated on `isDev()`).
- The simulator only accepts injection in `awaiting_answer`,
  `giving_feedback`, or `ready` phases. Calling it during setup is
  rejected with a `[SIM]` warning — protects against corrupting the
  conversation state.
- Expo Router catches the same URL and tries to navigate to `/simulate`
  (a route that doesn't exist → "Unmatched Route" 404). `_layout.tsx`
  calls `router.back()` 50ms after handling to dismiss the 404 and
  restore the session screen.

### Typical debug loop

```bash
# 1. wait for STEP 7 in the log stream
# 2. snap to confirm visual state (Your Turn / mic open)
./scripts/snap.sh pre-inject
# 3. fire the answer
./scripts/answer.sh "the answer text"
# 4. wait for tool_call → tool_result → ai_done in the log stream
# 5. snap to confirm card advanced
./scripts/snap.sh post-inject
```

The full bug cheatsheet (§3) maps naturally to which step of this loop
the run gets stuck on.

---

## 7. End-to-end multi-card pipeline — `scripts/test-flow.sh`

The full chain wrapped into one command: launches the app, waits for the
study loop, drives 3-4 simulated answers through Gemini, snaps the UI
before and after each card, dumps logcat, and prints a status summary.

```bash
# Default: 4 canned answers (mix of confident + uncertain)
./scripts/test-flow.sh

# Or pass your own answers — N positional args = N cards tested
./scripts/test-flow.sh "the answer is X" "no idea" "I think it's Y"
```

### Outputs (per run)

Each run gets a `YYYYMMDD-HHMMSS` ID and produces:

```
App/_debug/
├── runs/
│   ├── <run-id>.log            ← full logcat capture for the run
│   └── <run-id>.summary.txt    ← table of per-card status + snap paths
└── snaps/
    ├── <run-id>-card1-pre.png
    ├── <run-id>-card1-post.png
    ├── <run-id>-card2-pre.png
    ├── …
```

The summary prints to stdout too:

```
=== test-flow.sh summary ===
run:      20260521-1530
log:      /…/_debug/runs/20260521-1530.log
cards:    4

#    STATUS       DETAIL
---- ------------ -------------------------------------
1    OK           advanced (snaps captured)
2    OK           advanced (snaps captured)
3    PARTIAL      tool_result sent but ai_done never arrived
4    OK           advanced (snaps captured)
```

### What each status means

| Status      | Marker that fired                                                                                    | Marker that didn't                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OK**      | `tool_result → evaluate_and_move_next → Gemini` **and** `ai_done`/`session_complete`/`no_more_cards` | (none — full happy path)                                                                                                                            |
| **PARTIAL** | `tool_result …`                                                                                      | the AI-done turn marker — Gemini cancelled the tool, the UI never advanced, or response.done lost in `evaluating` phase (cf. SESSION-FLOW.md BUG 4) |
| **TIMEOUT** | (nothing within 30s of inject)                                                                       | `tool_result …` — likely Gemini didn't call the tool, suggests prompt-discipline regression (BUG 3)                                                 |

### Exit code

- `0` — every card reached `OK`. Useful as a smoke test in CI: a green
  exit means the eval pipeline is intact end-to-end.
- `2` — at least one card non-`OK`. Inspect the run log + summary.

### Common failure shapes

- **Every card TIMEOUT** → autostart didn't reach STEP 7 (deck name
  mismatch, AnkiDroid empty) or Gemini API key broken.
- **First N cards OK, last cards PARTIAL** → likely server-side rate
  limiting on Gemini Live.
- **PARTIAL on the same card index across runs** → the deck's card at
  that position has a deterministic bug (cf. BUG 4 — possibly a
  toolCallCancellation race specific to that card content).

---

## 8. Verifying AnkiDroid write-back — `scripts/check-writeback.sh`

Confirms that a card answer is actually persisted to AnkiDroid, not just logged
by JS. Checks two independent log markers:

- **Kotlin** (`AnkiDroidModule`): `answerCard: result deck='…' note=… ord=… -> N row(s) updated` — proves the ContentProvider `update()` call returned N rows.
- **JS** (`ankiBridge`): `[ankiBridge] answerCard(…) → ok` — proves the JS wrapper received `updatedCards > 0`.

### Usage

Requires an active session at STEP 7 (use `test-flow.sh` to get there, or
autostart with `AUTO_START_DECK`). Then:

```bash
# Default answer (AWS SA topic — concretely gradeable by Gemini)
./scripts/check-writeback.sh

# Custom answer
./scripts/check-writeback.sh "S3 Transfer Acceleration uses CloudFront edge nodes."
```

### Exit codes

| Code | Meaning                                                            |
| ---- | ------------------------------------------------------------------ |
| `0`  | PASS — Kotlin confirmed N>0 rows updated + JS confirmed ok         |
| `1`  | FAIL — ContentProvider update returned 0 rows (scheduler mismatch) |
| `2`  | ERROR — timeout, no markers in logcat within 45s                   |
| `4`  | PARTIAL — one marker found but not the other                       |

### Failure diagnosis (exit 1 — 0 rows)

Most common causes (documented in `AnkiDroidModule.kt` `answerCard` comments):

- **Stale queue** — the schedule queue wasn't primed for this (note_id, ord). Priming happens inside `answerCard` itself; if the selected deck drifted, priming queries the wrong deck.
- **Deck selection mismatch** — AnkiDroid's scheduler is scoped to the globally selected deck. `answerCard` re-sets it before update, but if `getDeckId` fails to resolve the name, the reset is skipped.
- **Stale cardOrd** — ord was captured after the cache advanced (would indicate a BUG 4 regression — should not happen after 2026-05-21 fix).

### Known status (2026-05-21)

Write-back confirmed working: `_debug/runs/20260521-144314.log` shows 4/4 cards
`→ ok` (JS marker). Kotlin row-count line wasn't captured in those runs because
logcat filter only had `ReactNativeJS`. `check-writeback.sh` now captures
`AnkiDroidModule:D` as well, so future runs will show the row count too.

---

## 9. Common control commands

```bash
# List attached devices
adb devices

# Foreground activity (what's actually on screen)
adb shell dumpsys activity activities | grep topResumedActivity

# Granted Anki permission?
adb shell dumpsys package com.anonymous.RealtimeApiOnMobile | grep -i anki

# Force-stop and restart the app (clean state)
adb shell am force-stop com.anonymous.RealtimeApiOnMobile
adb shell am start -a android.intent.action.VIEW \
  -d "exp+realtimeapionmobile://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081" \
  com.anonymous.RealtimeApiOnMobile

# Tail logcat with the structured filter
adb logcat -v time ReactNativeJS:V '*:S' | \
  grep --line-buffered -E "STEP [0-9]/8|phase  |tool_call|tool_result|! \[|x \[|user → transcript|Session ended"

# One-shot dump of recent logs
adb logcat -d ReactNativeJS:V '*:S' > /tmp/session.log
```

---

## 10. Extending the instrumentation

When you add new behaviour to the session and want it visible in the stream,
prefer the existing logger over `console.log`. Patterns:

```ts
import { sessionLog } from "./sessionDebugLogger";

// New top-level milestone? Don't add a 9th step — the canon is 8.
// Use an event with a clear scope:
sessionLog.event("SessionManager", "recovery timer fired", {
  phase,
  waited_ms,
});

// Phase transitions: don't log them manually. transitionTo() already does
// it from useSessionStore. Just call:
useSessionStore.getState().transitionTo("giving_feedback", "audio_arrived");

// Sub-event from a service:
sessionLog.event("AnkiDroid", "sync triggered");

// Non-fatal failure:
sessionLog.warn("Gemini", "tool result for cancelled call", { call_id });

// Genuinely fatal:
sessionLog.error("SessionManager", "reconnect failed — to error", { attempts });

// Raw dump that's noisy but useful when chasing a bug — gate with debug:
sessionLog.debug("Gemini", "raw incoming msg", {
  body: JSON.stringify(msg).slice(0, 500),
});
```

Avoid:

- `console.log` directly in production paths. The logger is the contract;
  bypassing it means the line won't show up in the filtered stream.
- Logging audio chunk payloads or any base64 blob outside `sessionLog.debug`.
  They flood logcat and the rate limiter drops events.
- Adding new "step banners" — the 8 are the canon from `SESSION-FLOW.md`.
  New milestones should be `event(...)` calls inside an existing step.

---

## 10b. Phone vs emulator: device selection

All four scripts (`snap.sh`, `answer.sh`, `test-flow.sh`, `check-writeback.sh`)
use bare `adb` commands — when more than one device is attached (e.g. Pixel 9 +
AVD), bare `adb` fails with `more than one device/emulator`. A shared helper
solves this transparently.

### `scripts/_device.sh`

Sourced by every script as the first thing after `set -euo pipefail`. Picks
an `ANDROID_SERIAL` via this order:

1. `ANDROID_SERIAL` already exported → honor it.
2. Exactly one device attached → use it.
3. Multiple attached, at least one physical → use the first non-`emulator-*`.
4. Multiple, all emulators → first one.
5. Zero attached → leave unset and let the next `adb` call fail loudly.

So with both a Pixel 9 (`45151FDAQ001HS`) and an AVD running, the scripts
default to the phone. Override per-invocation:

```bash
ANDROID_SERIAL=emulator-5554 ./scripts/test-flow.sh
```

Adopted 2026-05-24 because emulator runs were slow and added friction during
mid-session debugging on the phone. The selection prints to stderr on
multi-device runs so it's visible in script output:

```
[_device.sh] multiple devices attached — using ANDROID_SERIAL=45151FDAQ001HS (override by exporting ANDROID_SERIAL)
```

### Launching the app on the phone

```bash
source scripts/_device.sh
adb reverse tcp:8081 tcp:8081
adb shell monkey -p com.anonymous.RealtimeApiOnMobile -c android.intent.category.LAUNCHER 1
```

Both phone and emulator can use `localhost:8081` via `adb reverse` (the
portable path `test-flow.sh` now uses); `10.0.2.2` is an emulator-only fallback.

---

## 11. Known gotchas

- **Emulator mic is dead.** The AVD's default mic sits at ~−65 dB and never
  trips Gemini's VAD, so `user → transcript` won't fire from real speech on
  the emulator (STEP 7 is still reached). To exercise the eval loop without a
  mic, use **`answer.sh` text injection** (dev mode) — it works on the emulator
  and is exactly what `test-flow.sh` does. Note: `APP_MODE=test` +
  `fakeMicSource` is **not** a way to make `answer.sh` work — it flips
  `isDev()` off and disables the `simulate` route (see §0). A real device is
  still best for validating the live mic → VAD → transcript path.
- **`expo run:android` (`npm run android`) works** as of 2026-06-25 — it
  builds, installs, and starts Metro fine on the Pixel 9. (Historically it
  failed on Gradle 8.14 with `configure-on-demand` → "No variants exist" for
  every autolinked module. If that resurfaces, build via
  `./gradlew app:assembleDebug` directly and `adb install -r` instead.)
- **Stale autolinking cache after moving the project folder.** Symptom: Gradle
  reports "No matching variant / No variants exist" for ALL autolinked libs
  (react-native-screens, reanimated, firebase, etc.) simultaneously. Root cause:
  `android/build/generated/autolinking/autolinking.json` caches absolute library
  paths keyed on a lockfile SHA. If the project folder moves (e.g. `Projects/` →
  `Projects/Dev/`), the cached paths are stale but the SHA still matches, so the
  file is never regenerated. Fix: `rm -rf android/build/generated/autolinking/`.
  The next build re-runs `npx @react-native-community/cli config` and caches
  correct paths.
- **`adb reverse` is required after device reboot.** Without it the dev
  client cannot reach `localhost:8081`. Use `http://10.0.2.2:8081` in the
  deep link as a belt-and-suspenders fallback.
- **Metro stale env.** `.env` is read by `app.config.js` at Metro start —
  restart Metro after editing the env file.
- **Dev launcher splash class warning.** `DevLauncherController:
ClassNotFoundException expo.modules.splashscreen.SplashScreenManager` is
  cosmetic. Ignore it.

---

## 12. Files this debugging system touches

```
App/
├── DEBUGGING.md                                 ← this file
├── SESSION-FLOW.md                              ← canonical session contract
├── .env                                         ← AUTO_START_DECK, SESSION_DEBUG_VERBOSE
├── app.config.js                                ← exposes env to runtime via extra
├── scripts/
│   ├── _device.sh                               ← shared ANDROID_SERIAL helper (phone-first when multiple devices)
│   ├── snap.sh                                  ← screenshot helper
│   ├── answer.sh                                ← simulated-user-answer injector
│   ├── test-flow.sh                             ← multi-card E2E pipeline (autostart via &autostart=1)
│   └── check-writeback.sh                       ← write-back verification (exit 0=ok, 1=0rows, 2=timeout)
├── _debug/
│   ├── snaps/                                   ← captured PNGs (gitignored-friendly)
│   └── runs/                                    ← per-run log + summary files
└── src/
    ├── services/
    │   ├── sessionDebugLogger.ts                ← the logger itself
    │   ├── sessionManager.ts                    ← step banners + tool lifecycle
    │   ├── geminiManager.ts                     ← WS / setup / toolCall events / playback halt flag
    │   ├── cardLoader.ts                        ← deck load + fetchAndAppendNextCard (BUG 5 v3b refill)
    │   └── autostartFlag.ts                    ← env+deep-link gate for the deck-select autostart
    ├── stores/
    │   └── useSessionStore.ts                   ← phase transition logging
    └── app/
        ├── _layout.tsx                          ← engram://simulate deep-link listener
        └── (main)/
            └── deck-select.tsx                  ← autostart effect
```
