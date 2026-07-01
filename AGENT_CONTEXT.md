# Agent Context — Engram App

> **For any AI agent or developer reading this codebase.**
> This file is the non-hidden entry point to the project context.
> The full context lives in `../.claude/context/` (hidden directory — read it
> if your tool exposes it; read this file if it doesn't).
> Last updated: 2026-06-29 (Account & Settings surface built + exhaustively
> QA'd: new `(main)/settings.tsx`, plan-state/billing/theme plumbing, paywall
> Play-compliance parity. 3 bugs fixed incl. a blocker — `purchaseSubscription`
> was missing `type:"subs"`. Jest 475 pass / 6 skip; tsc clean; Maestro
> `account-settings.yaml` green on device. RTL test written but blocked by a
> jest-expo 54 winter-runtime bug (BUG-ENV-1). See
> `SESSION_LOG_2026-06-29_account-settings.md`, `_debug/account-settings-test-plan.md`,
> `_debug/account-settings-bugs.md`. Prior: `SESSION_LOG_2026-06-25_session12.md`.)

---

## What this project is

**Engram** (internal slug: `RealtimeApiOnMobile`) — an Android-only Expo + React
Native app that reads AnkiDroid flashcard decks and studies them by voice with a
realtime Gemini Live AI tutor. The user speaks their answers; the AI evaluates
them and advances the deck. Anti-Duolingo positioning, targeting Anki power users
(med students, devs prepping certs, advanced language learners).

Author: Tobías (Gusti) Pardo — UTN Facultad Regional Delta.

---

## Current state (2026-06-25, end of session 11)

| Layer                            | Status                                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Design system                    | Complete (phases 01–05, `_design/`)                                                                                           |
| Landing (`Web/`)                 | Deployed, bilingual ES/EN                                                                                                     |
| App core (voice session)         | Working on Pixel 9 + emulator, **428/434 Jest passing** (6 L3 gated)                                                          |
| Auth (Firebase + Google Sign-In) | M0 dev-bypass shipped; M1 routing shipped; M2 paywall wiring pending                                                          |
| Free-quota / trial               | End-to-end shipped (7d OR 10 sessions, server-authoritative)                                                                  |
| Play Store                       | Not yet submitted; `App/PLAY-STORE.md` documents blockers                                                                     |
| Testing infrastructure           | L1 unit + L2 replay (51 tests, 4 personas) + L3 real-Gemini (gated) + L4 on-device scenarios **now runnable on the emulator** |

**Git:** 19 commits ahead of `origin/main`, NOT YET PUSHED.

**Detailed change logs (most recent first):**
`SESSION_LOG_2026-06-25_session12.md` (on-device persona E2E + BUG 10 skip-path
fix + assert-harness honesty fixes + the MediaStore emulator-import workaround —
read this first) then `SESSION_LOG_2026-06-25.md` (session 11 — testing pyramid,
4 personas). Read before doing further work.

---

## Architecture in one page

```
src/app/
  index.tsx              → auth gate → onboarding or deck-select
  (onboarding)/          → sign-in, permissions, api-key
  (main)/deck-select.tsx → deck list, trial gate, autostart
  (main)/session.tsx     → voice study UI
  (main)/paywall.tsx     → subscription screen

src/services/
  sessionManager.ts      → 8-step orchestrator (THE central file)
  geminiManager.ts       → Gemini Live WebSocket (native audio, 16kHz in/24kHz out)
  realtimeManager.ts     → 3-line re-export of geminiManager (seam for future providers)
  cardLoader.ts          → AnkiDroid card fetching + cache management
  authService.ts         → Firebase Auth wrapper
  trialService.ts        → Cloud Function: checkTrialStatus / recordSession
  billingService.ts      → react-native-iap wrapper (verifyPurchase stub)
  sfxPlayer.ts           → correct/incorrect chimes via expo-audio
  foregroundAudioService.ts → Android FGS client, audio focus, notification
  sessionDebugLogger.ts  → structured debug logger (all session events)

src/stores/
  useSessionStore.ts     → phase state machine (idle→connecting→…→completed/error)
  useAuthStore.ts        → Firebase auth state (Zustand, reactive)
  useTrialStore.ts       → global trial status (Zustand, refresh after purchase)
  useCardCacheStore.ts   → in-memory card cache + UI index
  useSettingsStore.ts    → persisted: selected deck, per-deck language + instructions

src/config/
  env.ts                 → isDev() / requiresAuth() / requiresPayment()
                           Hard __DEV__ guard — bypass impossible in release binary
  prompts.ts             → Gemini system prompt + tool definitions

modules/
  anki-droid/            → Kotlin: reads AnkiDroid via ContentProvider
  expo-foreground-audio/ → Kotlin: microphone FGS + AudioTrack playback

functions/src/
  index.ts               → Cloud Functions: checkTrialStatus, recordSession, verifyPurchase
```

---

## The session flow (8 canonical steps)

Defined in `App/SESSION-FLOW.md`. Summary:

1. Connect WebSocket to Gemini Live
2. Init audio I/O + start mic (muted)
3. Load due cards from AnkiDroid
4. Send setup message (system prompt + tools) to Gemini
5. Send first card as user text turn
6. Wait for AI first response
7. Unmute mic — study loop active (user answers, AI evaluates, cards advance)
8. Session complete (no more cards or `end_session` tool call)

The AI calls `evaluate_and_move_next` after each answer → `sessionManager`
writes back to AnkiDroid via `ankiBridge.answerCard` → fetches the next card
from AnkiDroid's scheduler → sends it to Gemini as `tool_result`.

---

## Key invariants (never break these)

- **`realtimeManager.ts` = geminiManager.ts.** Everything in the app imports
  `realtimeManager`; internally it's Gemini Live. Adding a second provider means
  turning `realtimeManager` into a real proxy (see `03-ai-providers.md`).
- **Tokens from `_design/03-tokens/`.** Don't hardcode colors or sizes.
  Change `tokens.json` → regenerate `tokens.css` → hand-update `colors.ts` +
  `tailwind.config.js` (see `04-tokens-pipeline.md`).
- **Never use "Anki" in commercial naming.** OK in technical docs; never in
  product title, app store listing, or marketing.
- **Dev bypass is compile-time.** `authBypassed()` / `paymentBypassed()` are
  gated on `__DEV__`. A release binary cannot bypass auth regardless of `.env`.
- **`sessionManager.startSession` Step 1b calls `recordSession()`** before
  expensive work. If the server says trial expired, the session bails cleanly.

---

## Dev bypass (how to run without Firebase / billing)

```bash
# App/.env defaults (bypass both):
AUTH_REQUIRED=false
PAYMENT_REQUIRED=false
# Or explicitly enable real flows:
AUTH_REQUIRED=true
PAYMENT_REQUIRED=true
APP_MODE=production
```

With bypass: `useAuthStore` starts authenticated as `FAKE_DEV_USER` synchronously.
`useTrialStore` returns `{ isActive: true, subscriptionActive: true }` without
calling the Cloud Function.

---

## Testing

```bash
npm test                        # 426/432 Jest (node env, no device needed; 6 L3 gated)
npx jest --testPathPattern="useTrialStore"  # single suite
npx jest --testPathPatterns="replay"        # Layer 2: full mock-user pipeline
npx tsc --noEmit                # TypeScript strict — must be clean

# Layer 3 (real Gemini API, costs money per run):
TEST_REAL_GEMINI=1 GEMINI_API_KEY=... npx jest --testPathPatterns="realGemini"
# See "Layer 3 setup issue" note below before running.

# Kotlin instrumented (AnkiDroid must be installed on device/emulator):
./gradlew :anki-droid:connectedAndroidTest
```

Jest does NOT use jest-expo. Environment is `node`. Manual mocks live in
`__mocks__/` and are registered via `moduleNameMapper` in `jest.config.js`.

### Test pyramid (4 layers, deterministic first)

| Layer         | Suite(s)                                                                  | What it tests                                                                           | Cost       |
| ------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------- |
| 1 — unit      | `src/services/__tests__/sessionManager.test.ts` + 5 others                | Tool-call routing, write-back contract, override flip, retry                            | $0         |
| 2 — replay    | `src/test-harness/__tests__/replay.test.ts` (**51 tests, 4 personas**)    | Full pipeline: user transcript → AI tool call → write-back → phase → foreground service | $0         |
| 3 — real API  | `src/test-harness/__tests__/realGemini.text.test.ts` (gated, **6 tests**) | Prompt regressions, tool arg shape, AI grading drift                                    | ~$0.05/run |
| 4 — on-device | `scripts/test-e2e-scenario.sh` (5 scenarios)                              | Real Android + real AnkiDroid + real Gemini                                             | ~$0.20/run |

The 4 personas covered in L2 are: AWS Solutions Architect (English), Anatomy
med-student (English), Refold English learner (vocab), Spanish phrases learner
(es-ES, exercises BUG 16's language directive).

### Layer 3 setup issue — READ BEFORE RUNNING

`realGemini.text.test.ts` defaults to the production model
`gemini-2.5-flash-native-audio-preview-12-2025`, which only accepts AUDIO
modality and times out on `setupComplete` when given `responseModalities: TEXT`.
Workaround: set `GEMINI_L3_MODEL=gemini-live-2.5-flash-preview` (a text-capable
Live API model). Verified to receive `setupComplete` but the network/API
setup may need re-validation; if L3 starts failing again, check
`src/test-harness/realGeminiTextRunner.ts:130-160`.

---

## Debugging & testing scripts

All scripts live in `App/scripts/`. All source `_device.sh` (prefers physical
Pixel 9 when multiple devices attached; override with `ANDROID_SERIAL=`).

| Script                                | What it does                                           | Device needed     |
| ------------------------------------- | ------------------------------------------------------ | ----------------- |
| `ui.sh`                               | Tap/screenshot/dump UI, toggle theme, reload           | Any               |
| `snap.sh`                             | Quick screenshot to `_debug/snaps/`                    | Any               |
| `answer.sh <text>`                    | Inject a spoken answer via deep link (dev only)        | Any               |
| `test-flow.sh`                        | Multi-card E2E: launch → inject 4 answers → assert     | Any               |
| `check-writeback.sh`                  | Verify AnkiDroid scheduler accepted write-back         | Any               |
| `monitor-writeback.sh --live`         | Stream live write-back events                          | Any               |
| `monitor-writeback.sh --instrumented` | Run WriteBackTest.kt                                   | Any               |
| `setup-test-emulator.sh`              | Boot AVD, install AnkiDroid, import test deck          | `google_apis` AVD |
| `test-e2e-scenario.sh <scenario>`     | Full isolated E2E with assertion                       | Any               |
| `assert-session.sh --log <file>`      | Parse log, check correct/incorrect counts              | None (offline)    |
| `session-trace.sh`                    | **NEW** Live logcat → colored phase tracer with Δs     | Any (or stdin)    |
| `phase-timeline.sh <logfile>`         | **NEW** Offline phase timeline from saved log          | None              |
| `dump-decks.sh [--json]`              | **NEW** AnkiDroid deck list via uiautomator (no perms) | Any               |

**Interactive debugging:** `scrcpy --turn-screen-on` mirrors + mouse-controls the
device screen from your laptop.

**`ui.sh` quick reference:**

```bash
scripts/ui.sh dump                  # print live UI tree
scripts/ui.sh tap "Dark"            # tap element by text
scripts/ui.sh select-deck "AWS"     # tap deck row
scripts/ui.sh screenshot label      # save PNG
scripts/ui.sh reload                # Expo dev menu → Reload
scripts/ui.sh theme                 # toggle dark/light
```

---

## E2E test personas & decks

Four isolated test decks (completely independent of developer's personal AnkiDroid):

| Profile           | Deck name                     | Cards | Use case              |
| ----------------- | ----------------------------- | ----- | --------------------- |
| `aws-sa`          | Engram Test — AWS SA          | 8     | AWS SA exam student   |
| `refold-english`  | Engram Test — Refold English  | 10    | English vocab learner |
| `spanish-phrases` | Engram Test — Spanish Phrases | 7     | Conversation learner  |
| `anatomy-med`     | Engram Test — Anatomy         | 6     | Med student           |

Generated by `scripts/create-test-apkg.py`. Three artifact kinds per persona:

- `src/test-harness/fixtures/<profile>.apkg` — installable deck (used by on-device tests)
- `src/test-harness/fixtures/<profile>.scenario.json` — scenario definition (used by `create-test-apkg.py` to regenerate the .apkg)
- `src/test-harness/fixtures/<profile>.ts` — typed `AnkiCard[]` array (used by L2 Jest tests)

Five on-device scenarios in `scripts/scenarios/` (only run if `setup-test-emulator.sh`
succeeds — see "Android ≥14 file:// limitation" below):

```bash
scripts/test-e2e-scenario.sh scripts/scenarios/aws-all-correct.sh
scripts/test-e2e-scenario.sh scripts/scenarios/aws-mixed.sh
scripts/test-e2e-scenario.sh scripts/scenarios/refold-english-mixed.sh
# etc.
```

### Android ≥14 file:// limitation — READ BEFORE RUNNING ON-DEVICE E2E

On Android 14+ with the `google_apis_playstore` system image (the only one
installed on the dev machine as of 2026-06-25), `am start … -d file://…` strips
the URI under scoped storage. AnkiDroid's `IntentHandler` logs
`Intent: ... Data: none` + `File import failed`, the deck row never appears
in Engram's deck-select, and STEP 7 times out after 45s. Verified with
AnkiDroid 2.24.0 on Android 16 (`google_apis_playstore;android-36;x86_64`).

**Workaround:** install the rootable image and use that AVD instead:

```bash
sdkmanager "system-images;android-34;google_apis;x86_64"
avdmanager create avd -n Pixel_9_Test \
  -k "system-images;android-34;google_apis;x86_64" \
  --device "pixel_9"
```

Root is required because the production AnkiDroid `CardContentProvider.query`
rejects shell queries even with `READ_WRITE_DATABASE` granted. Documented in
`DEBUGGING.md §12`. A `content://`-based fix would need a FileProvider
helper in the Engram app — TODO, not implemented.

---

## Known production bugs (status as of 2026-06-25)

- **BUG 9** — intermittent: after a silent eval turn, recovery timer bounces
  evaluating → awaiting_answer but the user's next utterance doesn't unstick.
  No fix yet; need persistent log capture (see BUG 13 in SESSION-FLOW.md).
- **BUG 10 variant C (skip-path)** — **FIXED 2026-06-25** (`aecd301`). A skip
  never refilled (the write-back+refill block was guarded by
  `quality !== "skipped"`), so the session falsely ended on the first skip. A
  skip now writes back as "Again" (ease=1) to advance the head-only scheduler;
  excluded from stats. Trade-off + future native-bury alternative in
  SESSION-FLOW.md §BUG 10.
- **BUG 10 variant B** — still open, intermittent: tutor says "last card"
  because the Promise.race 500ms cap leaves `fetchAndAppendNextCard` unresolved
  → `peekNextCard()` returns undefined. Fix proposed: re-query `getDeckInfo()`
  before transitioning to `session_complete`. (Variant C's fix does NOT close
  this — B is a race timeout, not the skip omission.)
- **BUG 13** — first SFX chime is silent (expo-audio isLoaded race). Partially
  worked around; root fix requires porting SFX to native SoundPool.
- **BUG 15** — Gemini WebSocket close 1011; resume-failure UX is terminal.
  Session-resumption added in session 7 but the user-facing recovery flow
  is still open.
- **Reconnect-failure transition** — `attemptReconnectAndResume` async chain
  doesn't always propagate to `error: reconnect_failed` in tests (the L2
  runner drains the chain deterministically via microtasks + reconnect
  succeeds; failure path was added but flaky). The runner pins the
  _intermediate_ state ("reconnecting" phase was entered, reconnectCount
  incremented) rather than the final error phase.

All five are tracked in `App/SESSION-FLOW.md §4`. None are blockers — the
app works for the happy path.

---

## Open work (ordered by priority)

### Pre-launch blockers

1. ~~Token broker for `GEMINI_API_KEY`~~ — **CLOSED** (2026-07-01, `mintLiveToken` deployed; raw key nulled in production config, release recipe `scripts/build-release.sh` enforces `APP_MODE=production`).
2. **`verifyPurchase` trusts the client** — productId now allow-listed (2026-07-01), but the Google Play Developer API token check is still missing.
3. ~~No `firestore.rules`~~ — **CLOSED** (session 8, default-deny shipped).
4. **Release APK uses debug keystore** — need real keystore + R8 before Play Store.
5. **Over-broad permissions** — `BLUETOOTH`, `READ/WRITE_EXTERNAL_STORAGE` may be injected by plugins; audit before submission.

### M2 (next milestone — payment wiring)

- Wire `billingService.purchaseSubscription` post-purchase hook to refresh trial store
- Handle "Maybe later" / `router.back()` from paywall without stranding the user
- Add dev bypass badge/indicator in deck-select (M3)

### Other P1

- Rename app slug from `RealtimeApiOnMobile` → Engram (~25 files + Firebase re-registration)
- Google Sign-In branding on `sign-in.tsx` screen
- Download `google_apis` (rootable) AVD image for full emulator E2E isolation
  (`sdkmanager "system-images;android-34;google_apis;x86_64"`)

---

## Key files to read before touching things

| Task                 | Read first                                                  |
| -------------------- | ----------------------------------------------------------- |
| Debug a session      | `App/SESSION-FLOW.md` + `App/DEBUGGING.md`                  |
| Add an AI provider   | `.claude/context/03-ai-providers.md`                        |
| Change a color/token | `.claude/context/04-tokens-pipeline.md`                     |
| Modify auth/payment  | `App/src/config/env.ts` + `App/FREE-QUOTA.md`               |
| Play Store question  | `App/PLAY-STORE.md`                                         |
| Product positioning  | `docs/product-idea.md`                                      |
| Design system        | `_design/README.md`                                         |
| Write marketing copy | `_design/01-identidad.md` §10 (voice) + §15 (anti-patterns) |

---

## Commit convention

Commits are frequent and autonomous (per `App/.claude/CLAUDE.md`).
**Push is confirm-first** — always ask the user before `git push`.
The repo has a single `main` branch; no feature branches unless explicitly
requested. Standard footer: `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`.
