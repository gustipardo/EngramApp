# App TODOLIST

Items for the app development agent to implement. Priority order: top = most urgent.

See `MVP_validation_plan.md` Section 13 for full architecture details.

---

## P0 — Required for launch

### 1. Dev/Prod environment config
- [x] Create `src/config/env.ts` with `APP_MODE` detection (`dev` / `production`)
- [x] Export helpers: `isDev()`, `requiresAuth()`, `requiresPayment()`
- [x] In dev mode: skip auth, use `.env` API key directly, no paywall, log analytics to console
- [x] In production mode: require auth, use ephemeral tokens from cloud function, enforce trial/payments
- [x] Update `app.config.js` to support `APP_MODE` env variable

### 2. Firebase setup
- [ ] Create Firebase project (manual: Firebase Console)
- [x] Add Firebase to the Expo/React Native app (`@react-native-firebase/app`)
- [x] Configure Firebase Auth with Google Sign-In provider (code + plugins added)
- [ ] Create Firestore collection `users/{uid}` (auto-created by cloud function on first user)
- [x] Cloud Function `getSessionToken` implemented (`functions/src/index.ts`)
- [ ] Deploy cloud functions (`cd functions && npm install && firebase deploy --only functions`)
- [ ] Add `google-services.json` to project root (download from Firebase Console)

**Cloud Function `getSessionToken`:**
```
Input: Firebase auth token (verified automatically by callable function)
Logic:
  1. Get user doc from Firestore
  2. If new user → create doc, set trialStart = now, sessionCount = 0
  3. Check: is trial active (< 7 days AND < 10 sessions) OR subscription active?
  4. If no → return { error: "trial_expired" }
  5. If yes → POST https://api.openai.com/v1/realtime/client_secrets   ← GA endpoint
              Authorization: Bearer {SERVER_OPENAI_KEY}
              Body: { session: { type: "realtime", model: "gpt-4o-realtime-preview-2024-12-17" } }
  6. Increment sessionCount in Firestore
  7. Return { token: response.value }   ← token starts with "ek_"
```

**NOTE — API endpoint evolution:**
The app currently uses Beta endpoints. Update to GA:
| Purpose | Beta (current app) | GA (use this) |
|---------|-------------------|---------------|
| Ephemeral token | `POST /v1/realtime/sessions` | `POST /v1/realtime/client_secrets` |
| SDP exchange | `POST /v1/realtime?model={model}` | `POST /v1/realtime/calls` |

### 3. Authentication (production mode)
- [x] Add `@react-native-firebase/auth` + Google Sign-In
- [x] Create sign-in screen (`src/app/(onboarding)/sign-in.tsx`)
- [x] Update onboarding flow: if `requiresAuth()`, show sign-in; otherwise skip to api-key
- [x] Add sign-out option in deck-select header

### 4. Update WebRTC connection for ephemeral tokens
- [x] Create `src/services/tokenService.ts`
- [x] Modify `webrtcManager.ts`: uses tokenService, GA endpoint in prod, Beta in dev
- [x] Handle `trial_expired` response → redirect to paywall screen

### 5. Free trial system
- [x] On app open (prod mode), call cloud function to check trial status
- [x] If trial active: show remaining days/sessions in deck-select header banner
- [x] If trial expired and no subscription: redirect to paywall, block session start

### 6. Google Play Billing (subscription)
- [x] Integrate `react-native-iap` (`billingService.ts`)
- [ ] Create subscription products on Google Play Console ($4.99/mo, $39.99/yr)
- [x] Build paywall/subscription screen (`src/app/(main)/paywall.tsx`)
- [x] On subscription purchase: update `subscriptionStatus` in Firestore (via `verifyPurchase` cloud function)
- [ ] Cloud Function: proper Google Play Developer API verification (TODO in `verifyPurchase`)

### 7. Analytics
- [x] Integrate PostHog React Native SDK (`src/services/analytics.ts`)
- [x] Implement event tracking with typed helpers (`AnalyticsEvents`)
- [x] Events wired: `app_opened`, `signup_started/completed`, `deck_selected`, `session_started/completed/error/reconnected`, `paywall_shown`, `subscription_started/cancelled`
- [ ] Wire remaining events: `onboarding_ankidroid_check`, `onboarding_permissions_granted`, `onboarding_completed`, `trial_started/expired`, `session_first_card_answered`, `settings_changed`
- [x] In dev mode: log events to console only (no network calls)
- [x] In production mode: send events to PostHog
- [ ] Replace `YOUR_POSTHOG_API_KEY` and `YOUR_POSTHOG_HOST` in `_layout.tsx` with actual values

---

## P1 — Important but not blocking launch

### In-app feedback
- [ ] After the 3rd completed session, show a simple feedback prompt
- [ ] "How was your study session?" — 1-5 stars + optional text field
- [ ] Show once per week max, non-intrusive
- [ ] Send feedback to PostHog as event

### Play Store listing preparation
- [ ] Update app name from "RealtimeApiOnMobile" to "Anki Conversacionales"
- [ ] Update `app.json`: name, slug, package name (`com.ankiconversacionales.app`)
- [ ] Create Play Store screenshots
- [ ] Write Play Store description (bilingual EN/ES)
- [ ] Create app icon and feature graphic

---

## P2 — Post-launch improvements

### Session history
- [ ] Store session results locally (date, deck, cards reviewed, accuracy)
- [ ] Show session history screen with trends

### Study reminders
- [ ] Push notification reminders for daily study (Firebase Cloud Messaging)
- [ ] Configurable time in settings

---

## Recently shipped (2026-05-08 — test-suite expansion + deck-mixing fix)

### Production fixes (commits)
- [x] `36fa52b fix(anki)` — repair deck mixing in `getDueCards`. Switched padding from notes URI (`?deckID=` ignored on AnkiDroid 2.23+) to cards URI (`?query=did:<id>` respected) + defense-in-depth `did != deckId` row filter. Also fixed `parseDeckCountsSeparate` field order (was `[new, learn, review]`, AnkiDroid actually returns `[learn, review, new]`). **Pending: rebuild + reinstall APK on phone (`npm run android`) to verify.**
- [x] `386c061 fix(session)` — fire-and-forget AnkiDroid write-back (was awaited; AnkiDroid hangs caused Gemini `toolCallCancellation` race). Tightened `response.done` to act only on `phase=='giving_feedback'` (matches real Gemini's two-turn-per-evaluation shape). Added Gemini VAD config (HIGH end-of-speech sensitivity, 800ms silence) — fixes the multi-minute turn-commit stalls.
- [x] `798854f feat(prompts)` — system prompt forbids AI verbalising verdict before tool call. Prevents the "tutor says correct but no popup" bug class at the AI behavior level.
- [x] `c36827b feat(theme)` — slate/info color tokens.

### Testing infrastructure
- [x] `7bcef89 test(layer-2)` — 13 new Layer 2 tests. `silentGrade*` family (AI verbalises but doesn't tool-call: no write, no popup, no advance, phase recovers). `toolCallNoAudio` (characterizes UI stuck after tool fires but before audio.delta). Phase + advance invariants. Total 102 → 115 tests.
- [x] `1d10089 test(layer-5)` — Kotlin instrumented suite for `getDueCards` deck isolation. 5 tests on real AnkiDroid emulator. The only layer that catches the deck-mixing bug class. Run with `npm run test:instrumented`.
- [x] `8ee5f4d test(layer-6)` — Maestro scaffold for full-app deck isolation. Selectors not yet validated. Run with `npm run test:maestro` (requires Engram APK installed on emulator).
- [x] Refactor: `AnkiDroidQueries.kt` extracted from `AnkiDroidModule.kt` so instrumented tests can call production logic directly without the Expo `Module()` runtime.
- [x] `scripts/test-instrumented.sh` — boots `Pixel_9_Automatic` headless if no device attached. Idempotent.
- [x] `npm run test`, `test:instrumented`, `test:maestro`, `test:all`. `TESTING.md` rewritten as 6-layer doc with bug-class catchment table.

### Bugs the user reported in this session
1. **Deck mixing in a session** — cards from other decks (Refold "Go on") leaking into AwsExamSA. **PRODUCTION FIX SHIPPED**, regression caught by Layer 5. Requires phone rebuild to verify on hardware.
2. **Tutor advances but UI freezes on previous card** — store advances but `session.tsx` doesn't redraw. **NOT FIXED**. Needs UI rendering tests (`@testing-library/react-native` — see Pending).
3. **Tutor says correct/incorrect but no popup, card not marked** — AI verbalises without firing `evaluate_and_move_next`. **PARTIALLY FIXED**: prompt commit (`798854f`) makes AI less likely to do it; Layer 2 `silentGrade` tests pin the no-op JS-state behavior. Recovery (detect + retry) NOT implemented.

---

## Pending — testing gaps (priority order)

### P0 — verify the production fix
- [ ] Rebuild + reinstall APK on the phone: `npm run android`. Run a session against AwsExamSA + at least one other deck (Refold or Phrasal Verbs). Confirm no foreign-deck cards appear during the session.

### P1 — UI rendering tests (catches bug 2 from this session)
- [ ] Add `@testing-library/react-native` + jsdom env config in `jest.config.js`.
- [ ] Snapshot-test `src/app/(main)/session.tsx` against each `SessionPhase` (`idle | connecting | loading_cards | ready | awaiting_answer | evaluating | giving_feedback | session_complete | error`).
- [ ] Assert the popup component is bound to `useSessionStore.lastEvaluation` and re-renders when the store updates.
- [ ] Assert "Card N of M" text actually changes when `currentCardIndex` advances. **This is the gap that lets bug 2 slip past Layer 2.**
- [ ] Estimated 2-3h.

### P1 — Layer 3 expansion (catches AI behavior regressions)
- [ ] Run all 8 replay fixtures (happyPath, mixedResults, override*, silentGrade*, toolCallNoAudio) through `realGeminiTextRunner`. Currently only 1 fixture goes through real Gemini.
- [ ] Validates the prompt-discipline change in `798854f` against actual Gemini behavior.
- [ ] Run with `TEST_REAL_GEMINI=1 GEMINI_API_KEY=... npx jest realGemini.text`.
- [ ] Estimated 1h, ~$0.10 in Gemini API costs.

### P1 — Implement recovery for tool-call-no-audio
- [ ] Currently the session sticks in `evaluating` if the AI tool-calls but never speaks. Layer 2 `toolCallNoAudio` characterizes the stuck state.
- [ ] Add a timeout (e.g. 8 seconds) in the `evaluating` phase: if no `response.audio.delta` arrives, force-advance the card and transition to `awaiting_answer`.
- [ ] Flip the `toolCallNoAudio` test assertion from "phase stuck in evaluating" to "phase recovers to awaiting_answer".

### P2 — Layer 2 fixture coverage gaps
- [ ] `reconnectMidSession` — adds `__simulateConnectionDropped()` to `mockGeminiManager`; verifies reconnect → resume message → write-back continuity. Covers `installConnectionDropHandler` + `attemptReconnectAndResume` (~120 LOC currently untested).
- [ ] `endOfDeck` — last card answered → `session_complete` + `onSessionComplete` flow (sync triggered, foreground stopped).
- [ ] `endSessionToolMidDeck` — user invokes `end_session` on card 2 of 4 (the 5-second setTimeout completion path).
- [ ] `notificationLifecycle` — un-mock `foregroundAudioService`, spy on calls, assert ordering: start before `sendFirstCard`, update on each card advance, stop on completion.
- [ ] Estimated 3-4h total.

### P2 — Maestro execution
- [ ] Build Engram APK with `APP_MODE=test` so `installTestHarness()` swaps `fakeMicSource` + auth bypass kicks in. Verify Firebase / Gemini test bypass paths actually skip those screens.
- [ ] Adjust selectors in `.maestro/session-deck-isolation.yaml` and subflows to match real UI text.
- [ ] Run `npm run test:maestro`.

### P3 — Layer 5 coverage for write-back
- [ ] Finish the AnkiDroidQueries.kt extraction for `answerCard`. Currently only `getDueCards` is extracted; `answerCard` still has its own inline copy of helpers.
- [ ] Add `submitCardAnswer_writesToCorrectCard` instrumented test.

---

## Recently shipped (2026-05-06 evening session)

### Multi-card sessions (was: every session was 1 card long)
- [x] Hybrid `getDueCards` in `AnkiDroidModule.kt`: schedule URI for the head card (correct `ord` for write-back) + `notes/?deckID=` URI for padding, deduped by noteId, capped at deck due-count.
- [x] `getDeckDueCount(deckName)` helper.
- [x] Test file `App/src/services/__tests__/sessionManager.start.test.ts`.
- [x] VERIFIED on emulator (Aws Exam SA, 168 cards loaded).

### Phone-call-style in-session notification
- [x] Added POST_NOTIFICATIONS to runtime permission flow (`App/src/app/(onboarding)/permissions.tsx`).
- [x] New notification channel `voice_session_v2` at `IMPORTANCE_HIGH` with `CATEGORY_CALL`, gold accent (`#E4A13F`).
- [x] `▶` (`ic_media_play`) icon as the running indicator (rejected CallStyle's forced timer).
- [x] Single-notification peek/revert mechanism: JS `AppState` listener triggers Kotlin `ACTION_HEADS_UP` → cancel + notify with "Tap to return…" body → `Handler.postDelayed` reverts to "Card N of M" after 3s.
- [x] `startForegroundService` moved BEFORE `sendFirstCard` in `startSession` (was previously gated on AI's first reply, never ran when WebSocket dropped). Defensive fallback added to `resumeAfterReconnect`.
- [ ] User visual sign-off on the final design + verification that heads-up re-fires on second/third minimize per session.

### Known unfixed (out of scope for this session)
- [ ] `App/src/native/__tests__/ankiBridge.test.ts` and `App/src/test-harness/__tests__/replay.test.ts` use the old 2-arg `answerCard(noteId, pass)` signature; need updating to the current 5-arg signature (8 failing tests).
- [ ] `answerCard` write-back from earlier in this session day (column-name fix: `ord`/`answer_ease`) still UNVERIFIED end-to-end — sessions kept dropping the WebSocket before user could grade a card on the emulator.
