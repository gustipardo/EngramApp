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

## Project Overview

Android-only Expo (SDK 54) + React Native app. Voice-powered study tutor that reads AnkiDroid flashcards aloud, listens to spoken answers, evaluates them, and advances through the deck.

**Two AI backends, selectable at runtime:**
- **OpenAI Realtime** via WebRTC (data channel for server events, ephemeral token from Cloud Function).
- **Gemini Live** via WebSocket (`gemini-2.5-flash-native-audio-preview-12-2025`, native audio).

Neither is dead code. The user toggles between them in the deck-select screen; the selection persists via `useSettingsStore.aiProvider`. All session code is written against a single `realtimeManager` Proxy that forwards to whichever backend is active.

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
- `(main)/` — Main app: `deck-select.tsx` (deck list + OpenAI/Gemini toggle), `session.tsx` (study UI), `paywall.tsx` (trial expiry + Play Billing)

### Service Layer (`src/services/`)
- **`sessionManager.ts`** — Central orchestrator. Starts session → loads AnkiDroid cards → configures AI prompt → registers event handlers → processes tool calls (`evaluate_and_move_next`, skip, override, end_session) → advances cards.
- **`realtimeManager.ts`** — **Proxy/facade.** Forwards every call to `webrtcManager` or `geminiManager` based on `useSettingsStore.aiProvider`. `syncActiveProvider()` is called before each session start. Everything else in the app talks to this, not to the backend managers directly.
- **`webrtcManager.ts`** — OpenAI Realtime backend. WebRTC peer connection, SDP negotiation, data channel for server events, mic muting, reconnect logic (3 attempts, 1s base delay). Uses GA endpoint `/v1/realtime/calls` in prod, Beta `/v1/realtime` in dev.
- **`geminiManager.ts`** — Gemini Live backend. WebSocket (`wss://`) + native audio streaming (16 kHz input, 24 kHz output) via `expo-foreground-audio`. Mirrors the `webrtcManager` interface so the proxy can swap freely.
- **`cardLoader.ts`** — Loads due cards from AnkiDroid via `src/native/ankiBridge.ts`, manages the `useCardCacheStore` cache.
- **`tokenService.ts`** — Fetches ephemeral OpenAI token from `getSessionToken` Cloud Function (prod), falls back to `.env` API key (dev). Exposes `isTokenError()` helper.
- **`trialService.ts`** — Calls `checkTrialStatus` Cloud Function; returns days/sessions remaining + subscription status.
- **`authService.ts`** — Firebase Auth wrapper (Google Sign-In, sign-out, current user).
- **`billingService.ts`** — `react-native-iap` wrapper; calls `verifyPurchase` Cloud Function post-purchase (stubbed Google Play API verification per TODOLIST.md).
- **`foregroundAudioService.ts`** — Android foreground service client; keeps audio alive when backgrounded, shows notification with pause/resume/end controls.
- **`analytics.ts`** — PostHog wrapper with typed event helpers. Disabled in dev (console logs only).

### State Management (Zustand stores in `src/stores/`)
- **`useSessionStore`** — Session phase state machine: `idle → connecting → loading_cards → ready → studying → paused → completed/error`. Card index, stats, reconnect tracking.
- **`useConnectionStore`** — Connection state (`idle|connecting|connected|reconnecting|failed|dropped`), reconnect attempt counter.
- **`useSettingsStore`** — Persisted via AsyncStorage: `selectedDeck`, `onboardingCompleted`, `apiKeyStored`, `alwaysReadBack`, `darkMode`, **`aiProvider` (`'openai' | 'gemini'`)**, per-deck `deckInstructions`.
- **`useCardCacheStore`** — In-memory: current card index, cached cards array, `getCurrentCard()` / `getNextCard()` / `getRemainingCardCount()` accessors.

### Types (`src/types/`)
- `ai.ts` — `AIProvider`, tool call types, session config.
- `anki.ts` — `AnkiCard`, `DeckInfo`, `BridgeError`.
- `session.ts` — `SessionPhase` enum, evaluation types.

### Utils (`src/utils/`)
- `secureStorage.ts` — `expo-secure-store` wrapper.
- `textUtils.ts` — string normalization helpers.

### Config (`src/config/`)
- `env.ts` — `isDev()`, `requiresAuth()`, `requiresPayment()` helpers (from `APP_MODE` env var).
- `prompts.ts` — System prompt generator (injection-safe) + tool definitions (`evaluate_and_move_next`, `skip`, `override`, `end_session`) + read-back toggle rule.

### Native (`src/native/`)
- `ankiBridge.ts` — Typed wrapper over the `anki-droid` module: `isInstalled()`, `hasApiPermission()`, `requestApiPermission()`, `getDeckNames()`, `getDeckInfo()`, `getDueCards(deckName)`.

### Components (`src/components/`)
- `CardDisplay.tsx` — The only component so far. Renders the current card (front/back depending on reveal state) during a session.

### Native Modules (`modules/`)
Two local Expo modules (Android/Kotlin), linked as `file:` dependencies in `package.json`:
- **`anki-droid`** — Reads deck names + due cards from AnkiDroid via Android ContentProvider. Accessed through `src/native/ankiBridge.ts`.
- **`expo-foreground-audio`** — Android foreground service for persistent audio during study sessions. Also exposes `startMicCapture` / `initAudioPlayer` / `playAudioChunk` used by `geminiManager` for WebSocket-based audio.

### Cloud Functions (`functions/src/`)
Firebase Cloud Functions (TypeScript, Firebase Admin SDK):
- **`getSessionToken`** — Authenticates user, checks trial (7 days / 10 sessions max) or subscription status, requests ephemeral token from OpenAI `/v1/realtime/client_secrets`, increments session count.
- **`checkTrialStatus`** — Returns trial remaining days/sessions + subscription status.
- **`verifyPurchase`** — Called post-purchase; Google Play Developer API verification is currently **stubbed** (see TODO in `functions/src/index.ts`).

### Key Data Flow
1. User picks deck + provider → `sessionManager.startSession()` calls `realtimeManager.syncActiveProvider()`, then connects via the active backend and loads cards from AnkiDroid.
2. AI receives system prompt + tools via data channel (OpenAI) or WebSocket message (Gemini) — see `src/config/prompts.ts`.
3. AI speaks the question; user answers into the mic.
4. AI calls `evaluate_and_move_next` tool → `sessionManager` grades the card, fetches the next one, returns the result.
5. Loop until the deck is exhausted or the user ends the session.

### Config
- `app.config.js` merges `app.json` with runtime env (`OPENAI_API_KEY`, `GEMINI_API_KEY` from `.env`) via `expo-constants`.
- API keys stored in `expo-secure-store` at runtime; `.env` is for dev convenience only.
- Styling: NativeWind (TailwindCSS for React Native). Note: `_design/` system specifies Unistyles v3 as the target — migration is pending.

## Other top-level files worth knowing

- `_bmad/`, `_bmad-output/` — BMAD-Method agent builder artifacts (stories, epics, implementation planning). Not runtime code; useful for onboarding context.
- `docs/` — Auto-generated architecture docs (`architecture.md`, `component-inventory.md`, etc.). Regeneratable, not source of truth.
- `patches/` — One `patch-package` patch for `react-native-webrtc+124.0.7`.
- `TODOLIST.md` — Current P0/P1 punch list (Firebase setup, auth wiring, Play Store products, PostHog key, app rename).
- `SETUP.md` — Developer setup guide.
