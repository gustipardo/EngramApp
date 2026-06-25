# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> For the whole-project map (how `App/`, `Web/`, `_design/`, etc. relate), see `../CLAUDE.md` at the repo root.

## Autonomy Rules

You have full decision-making authority on this project. When faced with choices:

- NEVER stop to ask unless the decision is irreversible or destructive.
- When multiple options are presented, always pick one and proceed.
  Do not list options for the user to choose from.
- Decision priority order: stability > simplicity > performance > novelty.
- If two options are equivalent, pick the more documented one.
- If you're unsure, bias toward the most mainstream/conventional choice.
- If you made a wrong call, it can be fixed in the next iteration.
  A wrong decision is better than no decision.
- Treat yourself as a senior developer with full context. Act accordingly.

## Git workflow

Commit frequently and autonomously — do NOT wait to be told. This overrides the
default "commit only when the user asks" behavior.

- After each working, logical unit of change (tests green where applicable),
  `git commit` it. Don't batch a whole session into one commit.
- Keep commits focused: stage the relevant paths (`git add <paths>`), not a
  blanket `git add -A`, when the working tree holds unrelated in-progress work.
- Commit on the current working branch (this repo's history works directly on
  `main`); only branch when starting a clearly separate line of work or when the
  user asks for a PR.
- **Pushing stays confirm-first** — it's outward-facing. Commit without asking;
  ask before `git push` unless the user says otherwise for the session.
- Standard commit-message footer still applies (Co-Authored-By trailer).

## Project Overview

Android-only Expo (SDK 54) + React Native app. Voice-powered study tutor that reads AnkiDroid flashcards aloud, listens to spoken answers, evaluates them, and advances through the deck.

**Single AI backend: Gemini Live** via WebSocket (`gemini-2.5-flash-native-audio-preview-12-2025`, native audio). `realtimeManager` is a direct re-export of `geminiManager`. API key comes from `GEMINI_API_KEY` env var via `app.config.js`.

App slug (`RealtimeApiOnMobile`) is a legacy name from when the app was OpenAI-only — rename to "Anki Conversacionales" is P1 in TODOLIST.md.

## Common Commands

```bash
npm install --legacy-peer-deps   # Install deps (--legacy-peer-deps required)
npm run android                  # Build and run on Android device/emulator
npm start                        # Start Metro bundler only
npm test                         # Run Jest tests
cd android && ./gradlew clean    # Clean Android build artifacts
```

Tests use Jest with `node` environment (not jest-expo). Test files live in `__tests__/` directories adjacent to the code they test. Run a single test with:

```bash
npx jest --testPathPattern="useSessionStore"
```

## Architecture

### Routing (Expo Router, file-based — `src/app/`)

- `index.tsx` — Root redirect based on onboarding state
- `(onboarding)/` — First-run flow: `index.tsx` (intro), `sign-in.tsx` (Firebase Google Sign-In), `permissions.tsx` (AnkiDroid API permission), `api-key.tsx` (dev fallback for API key entry)
- `(main)/` — Main app: `deck-select.tsx` (deck list + settings), `session.tsx` (study UI), `paywall.tsx` (trial expiry + Play Billing)

### Service Layer (`src/services/`)

- **`sessionManager.ts`** — Central orchestrator. Starts session → loads AnkiDroid cards → configures AI prompt → registers event handlers → processes tool calls (`evaluate_and_move_next`, skip, override, end_session) → advances cards.
- **`realtimeManager.ts`** — Thin re-export of `geminiManager` (3 lines). Everything in the app that imports `realtimeManager` actually talks to Gemini Live. Kept as a seam for re-introducing a multi-provider proxy later.
- **`geminiManager.ts`** — Gemini Live backend. WebSocket (`wss://`) + native audio streaming (16 kHz input, 24 kHz output) via `expo-foreground-audio`.
- **`micSource.ts`** — Mic abstraction. Real source is backed by `expo-foreground-audio`'s `startMicCapture`; swappable to `fakeMicSource` (replays PCM fixtures) when `APP_MODE=test`.
- **`audioLevelTracker.ts`** — RMS-based VU meter. Reads PCM chunks from `micSource`, writes a normalized 0–1 level to `useAudioLevelStore` for the in-session UI.
- **`cardLoader.ts`** — Loads due cards from AnkiDroid via `src/native/ankiBridge.ts`, manages the `useCardCacheStore` cache.
- **`trialService.ts`** — Calls `checkTrialStatus` Cloud Function; returns days/sessions remaining + subscription status.
- **`authService.ts`** — Firebase Auth wrapper (Google Sign-In, sign-out, current user).
- **`billingService.ts`** — `react-native-iap` wrapper; calls `verifyPurchase` Cloud Function post-purchase (stubbed Google Play API verification per TODOLIST.md).
- **`foregroundAudioService.ts`** — Android foreground service client; keeps audio alive when backgrounded, shows notification with pause/resume/end controls. Listens for `onAudioFocusChange` and pauses the session on external focus loss — see BUG 8 for the SFX-window filter that prevents our own chimes from auto-pausing.
- **`sfxPlayer.ts`** — Plays short feedback chimes (correct/incorrect MP3s in `assets/sfx/`) via `expo-audio` when an answer is graded. Skipped answers are silent. Exposes `isPlayingRecently()` so `foregroundAudioService` can ignore the audio-focus loss its own playback triggers on Android.
- **`analytics.ts`** — PostHog wrapper with typed event helpers. Disabled in dev (console logs only).

### State Management (Zustand stores in `src/stores/`)

- **`useSessionStore`** — Session phase state machine: `idle → connecting → loading_cards → ready → studying → paused → completed/error`. Card index, stats, reconnect tracking.
- **`useConnectionStore`** — Connection state (`idle|connecting|connected|reconnecting|failed|dropped`), reconnect attempt counter.
- **`useSettingsStore`** — Persisted via AsyncStorage: `selectedDeck`, `onboardingCompleted`, `alwaysReadBack`, `darkMode`, per-deck `deckInstructions`.
- **`useCardCacheStore`** — In-memory: current card index, cached cards array, `getCurrentCard()` / `getNextCard()` / `getRemainingCardCount()` accessors.

### Types (`src/types/`)

- `ai.ts` — Tool call types, session config.
- `anki.ts` — `AnkiCard`, `DeckInfo`, `BridgeError`.
- `session.ts` — `SessionPhase` enum, evaluation types.

### Utils (`src/utils/`)

- `textUtils.ts` — string normalization helpers.

### Config (`src/config/`)

- `env.ts` — `isDev()`, `requiresAuth()`, `requiresPayment()` helpers (from `APP_MODE` env var).
- `prompts.ts` — System prompt generator (injection-safe) + tool definitions (`evaluate_and_move_next`, `skip`, `override`, `end_session`) + read-back toggle rule.

### Native (`src/native/`)

- `ankiBridge.ts` — Typed wrapper over the `anki-droid` module: `isInstalled()`, `hasApiPermission()`, `requestApiPermission()`, `getDeckNames()`, `getDeckInfo()`, `getDueCards(deckName)`.

### Components (`src/components/`)

- `CardDisplay.tsx` — Renders the current card (front/back depending on reveal state) during a session.
- `EngramWordmark.tsx` — Brand wordmark used on onboarding / deck-select headers.

### Native Modules (`modules/`)

Two local Expo modules (Android/Kotlin), linked as `file:` dependencies in `package.json`:

- **`anki-droid`** — Reads deck names + due cards from AnkiDroid via Android ContentProvider. Accessed through `src/native/ankiBridge.ts`.
- **`expo-foreground-audio`** — Android foreground service for persistent audio during study sessions. Also exposes `startMicCapture` / `initAudioPlayer` / `playAudioChunk` used by `geminiManager` for WebSocket-based audio.

### Cloud Functions (`functions/src/`)

Firebase Cloud Functions (TypeScript, Firebase Admin SDK):

- **`checkTrialStatus`** — Returns trial remaining days/sessions + subscription status.
- **`verifyPurchase`** — Called post-purchase; Google Play Developer API verification is currently **stubbed** (see TODO in `functions/src/index.ts`).

### Key Data Flow

1. User picks deck → `sessionManager.startSession()` connects via `geminiManager` and loads cards from AnkiDroid.
2. AI receives system prompt + tools via WebSocket message — see `src/config/prompts.ts`.
3. AI speaks the question; user answers into the mic.
4. AI calls `evaluate_and_move_next` tool → `sessionManager` grades the card, fetches the next one, returns the result.
5. Loop until the deck is exhausted or the user ends the session.

### Config

- `app.config.js` merges `app.json` with runtime env (`GEMINI_API_KEY` from `.env`) via `expo-constants`.
- Styling: NativeWind (TailwindCSS for React Native). Note: `_design/` system specifies Unistyles v3 as the target — migration is pending.

## Other top-level files worth knowing

- `_bmad/`, `_bmad-output/` — BMAD-Method agent builder artifacts (stories, epics, implementation planning). Not runtime code; useful for onboarding context.
- `docs/` — Auto-generated architecture docs (`architecture.md`, `component-inventory.md`, etc.). Regeneratable, not source of truth.
- `patches/` — One `patch-package` patch for `react-native-webrtc+124.0.7`.
- `TODOLIST.md` — Current P0/P1 punch list (Firebase setup, auth wiring, Play Store products, PostHog key, app rename).
- `SETUP.md` — Developer setup guide.
- `PLAY-STORE.md` — Google Play policy & compliance notes. Read before preparing a Play release or answering "is X allowed on Play?" (cross-app AnkiDroid module, mic foreground service, Data Safety, the `com.anonymous.*` package rename, Anki trademark).
- `FREE-QUOTA.md` — Free trial / quota design + implementation plan (7 days OR 10 sessions, server-tracked). Read before touching `functions/src/` trial logic or `trialService.ts`. Notes the 3 gaps that make the trial non-functional today. Status: designed, not yet built.
