# Agent Context — Engram App

> **For any AI agent or developer reading this codebase.**
> This file is the non-hidden entry point to the project context.
> The full context lives in `../.claude/context/` (hidden directory — read it
> if your tool exposes it; read this file if it doesn't).
> Last updated: 2026-06-25 (session 10).

---

## What this project is

**Engram** (internal slug: `RealtimeApiOnMobile`) — an Android-only Expo + React
Native app that reads AnkiDroid flashcard decks and studies them by voice with a
realtime Gemini Live AI tutor. The user speaks their answers; the AI evaluates
them and advances the deck. Anti-Duolingo positioning, targeting Anki power users
(med students, devs prepping certs, advanced language learners).

Author: Tobías (Gusti) Pardo — UTN Facultad Regional Delta.

---

## Current state (2026-06-25)

| Layer                            | Status                                                               |
| -------------------------------- | -------------------------------------------------------------------- |
| Design system                    | Complete (phases 01–05, `_design/`)                                  |
| Landing (`Web/`)                 | Deployed, bilingual ES/EN                                            |
| App core (voice session)         | Working on Pixel 9, 243/245 Jest tests passing                       |
| Auth (Firebase + Google Sign-In) | M0 dev-bypass shipped; M1 routing shipped; M2 paywall wiring pending |
| Free-quota / trial               | End-to-end shipped (7d OR 10 sessions, server-authoritative)         |
| Play Store                       | Not yet submitted; `App/PLAY-STORE.md` documents blockers            |
| Testing infrastructure           | Full E2E scenario framework shipped this session                     |

**Git:** 8 commits ahead of `origin/main`, NOT YET PUSHED.

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
npm test                        # 243/245 Jest (node env, no device needed)
npx jest --testPathPattern="useTrialStore"  # single suite

# Kotlin instrumented (AnkiDroid must be installed on device/emulator):
./gradlew :anki-droid:connectedAndroidTest
```

Jest does NOT use jest-expo. Environment is `node`. Manual mocks live in
`__mocks__/` and are registered via `moduleNameMapper` in `jest.config.js`.

---

## Debugging & testing scripts

All scripts live in `App/scripts/`. All source `_device.sh` (prefers physical
Pixel 9 when multiple devices attached; override with `ANDROID_SERIAL=`).

| Script                                | What it does                                       | Device needed     |
| ------------------------------------- | -------------------------------------------------- | ----------------- |
| `ui.sh`                               | Tap/screenshot/dump UI, toggle theme, reload       | Any               |
| `snap.sh`                             | Quick screenshot to `_debug/snaps/`                | Any               |
| `answer.sh <text>`                    | Inject a spoken answer via deep link (dev only)    | Any               |
| `test-flow.sh`                        | Multi-card E2E: launch → inject 4 answers → assert | Any               |
| `check-writeback.sh`                  | Verify AnkiDroid scheduler accepted write-back     | Any               |
| `monitor-writeback.sh --live`         | Stream live write-back events                      | Any               |
| `monitor-writeback.sh --instrumented` | Run WriteBackTest.kt                               | Any               |
| `setup-test-emulator.sh`              | Boot AVD, install AnkiDroid, import test deck      | `google_apis` AVD |
| `test-e2e-scenario.sh <scenario>`     | Full isolated E2E with assertion                   | Any               |
| `assert-session.sh --log <file>`      | Parse log, check correct/incorrect counts          | None (offline)    |

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

Generated by `scripts/create-test-apkg.py`. Fixtures at
`src/test-harness/fixtures/<profile>.apkg` + `<profile>.scenario.json`.

Five scenarios in `scripts/scenarios/`:

```bash
scripts/test-e2e-scenario.sh scripts/scenarios/aws-all-correct.sh
scripts/test-e2e-scenario.sh scripts/scenarios/aws-mixed.sh
scripts/test-e2e-scenario.sh scripts/scenarios/refold-english-mixed.sh
# etc.
```

---

## Open work (ordered by priority)

### Pre-launch blockers

1. **Token broker for `GEMINI_API_KEY`** — today the key ships inside the APK.
2. **`verifyPurchase` trusts the client** — missing Google Play Developer API call.
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
