# App TODOLIST

Items for the app development agent to implement. Priority order: top = most urgent.

See `MVP_validation_plan.md` Section 13 for full architecture details.

---

## Post-audit fixes (2026-07-01) — SHIPPED

Executed from the 2026-07-01 full-project audit (one commit per cluster):

- [x] Session unmount stale-closure fix — `endSessionIfActive()`; hardware-back now tears the session down.
- [x] Disconnect on any start failure — retry can no longer double-register event handlers (double write-back).
- [x] `end_session` 5s summary timer tracked + cancelled — no more ghost `session_complete` after manual end.
- [x] Release build recipe `scripts/build-release.sh` enforces `APP_MODE=production` (raw key can't ship in the APK bundle).
- [x] Billing: verify-before-acknowledge, purchase completion awaited (no post-purchase paywall race), `verifyPurchase` productId allow-list.
- [x] Slow answer+refill grace window — no false `no_more_cards` mid-deck.
- [x] PostHog placeholder-key guard; missing analytics events wired (see §7).
- [x] `pause()`/`resume()` restores the paused-from phase.
- [x] Dead code removed: `textUtils.ts`, `CardDisplay.tsx`, `commitUiAdvance`, `advancing` phase.
- [x] Engram rebrand: SKUs → `com.engram.app.{monthly,yearly}`, functions package → `engram-functions`. ~~NOTE: re-run seed script + redeploy functions~~ — DONE 2026-07-02 (session 20).

---

## Session-flow fixes (2026-07-02) — SHIPPED (local commits, not pushed)

From the "tutor never advances" report (release build, token path). Details: SESSION-FLOW.md BUG 9 + `.claude/context/06-status.md` session 20.

- [x] `mintLiveToken`: drop `liveConnectConstraints` — a constrained token made the server discard the client setup (tools/prompt/transcriptions) → no tool calls, no advance. Deployed + verified on-device.
- [x] BUG 9 fixed: ctrl-token wedge detection + automatic cold reconnect/resume (`clearSessionResumptionHandle`); nudge and handle-resume proven ineffective against the live API.
- [x] VAD: `prefixPaddingMs` removed — it silently made sessions deaf (no `inputTranscription`); regression test pins the config.
- [x] Session-start latency: connect + recordSession + card load run concurrently (~8 s serial → slowest-leg wall time).
- [ ] Pending on-device: one ≥3-card voice session on the 00:48 build (also confirms the latency win).
- [ ] Follow-up: error-screen copy is English-only regardless of deck language.

---

## P0 — Required for launch

### 1. Dev/Prod environment config

- [x] Create `src/config/env.ts` with `APP_MODE` detection (`dev` / `production`)
- [x] Export helpers: `isDev()`, `requiresAuth()`, `requiresPayment()`
- [x] In dev mode: skip auth, use `.env` API key directly, no paywall, log analytics to console
- [x] In production mode: require auth, use ephemeral tokens from cloud function, enforce trial/payments
- [x] Update `app.config.js` to support `APP_MODE` env variable

### 2. Firebase setup

- [x] Create Firebase project (`engram-3392a`, live)
- [x] Add Firebase to the Expo/React Native app (`@react-native-firebase/app`)
- [x] Configure Firebase Auth with Google Sign-In provider (code + plugins added)
- [x] Firestore collection `users/{uid}` (create-on-read by `checkTrialStatus`)
- [x] Token broker `mintLiveToken` implemented + deployed (`functions/src/index.ts`) — single-use Gemini Live ephemeral tokens, gated on active trial/subscription; client in `src/services/tokenService.ts` (2026-07-01, verified by curl)
- [x] Cloud functions deployed (`checkTrialStatus`, `recordSession`, `verifyPurchase`, `mintLiveToken` — us-central1, public invoker)
- [x] Real `google-services.json` in project root

### 3. Authentication (production mode)

- [x] Add `@react-native-firebase/auth` + Google Sign-In
- [x] Create sign-in screen (`src/app/(onboarding)/sign-in.tsx`)
- [x] Update onboarding flow: if `requiresAuth()`, show sign-in; otherwise skip to api-key
- [x] Add sign-out option in deck-select header

### 4. Ephemeral-token connection (Gemini Live)

- [x] `src/services/tokenService.ts` — `getLiveCredential()`: ephemeral token via `mintLiveToken` in prod (v1alpha `?access_token=`), raw dev key on payment bypass (v1beta `?key=`)
- [x] `geminiManager.openWebSocket` builds the Live URL per credential kind
- [x] `trial_expired` from the broker surfaces as the session error the paywall flow already handles

### 5. Free trial system

- [x] On app open (prod mode), call cloud function to check trial status
- [x] If trial active: show remaining days/sessions in deck-select header banner
- [x] If trial expired and no subscription: redirect to paywall, block session start
- [x] **Trial clock actually starts (2026-06-24 session 8).** `checkTrialStatus` is now create-on-read — the user doc is created with `trialStart=now` on first status check, so the 7-day clock ticks from first use.
- [x] **Session quota actually enforced (2026-06-24 session 8).** New `recordSession` Cloud Function is called by `sessionManager.startSession` Step 1b (after the WebSocket connect, before any expensive work). Atomic `FieldValue.increment(1)` on `sessionCount`; subscribed users no-op server-side. Best-effort on the client (a network blip never blocks the session; the next `checkTrialStatus` re-syncs).
- [x] **`verifyPurchase` works on a brand-new user (2026-06-24 session 8).** Switched `.update()` → `.set(..., { merge: true })` so the first purchase doesn't throw on a missing doc.
- [x] **`firestore.rules` ships (2026-06-24 session 8).** Default-deny; `users/{uid}` self-read; all client writes denied. Cloud Functions use the admin SDK and bypass. Pre-launch blocker #3 closed.
- [x] **TOCTOU window closed (2026-06-24 session 8).** If the trial expires between deck-select's pre-check and the session start, the server-authoritative `recordSession` return value aborts the session cleanly (disconnect + `code: 'trial_expired'` error). Pinned by 4 new jest tests.

### 6. Google Play Billing (subscription)

- [x] Integrate `react-native-iap` (`billingService.ts`)
- [ ] Create subscription products on Google Play Console ($4.99/mo, $39.99/yr)
- [x] Build paywall/subscription screen (`src/app/(main)/paywall.tsx`)
- [x] On subscription purchase: update `subscriptionStatus` in Firestore (via `verifyPurchase` cloud function)
- [ ] Cloud Function: proper Google Play Developer API verification (TODO in `verifyPurchase`)

### 7. Analytics

- [x] Integrate PostHog React Native SDK (`src/services/analytics.ts`)
- [x] Implement event tracking with typed helpers (`AnalyticsEvents`)
- [x] Events wired: `app_opened`, `signup_started/completed`, `deck_selected`, `session_started/completed/error/reconnected`, `paywall_shown`, `subscription_started`
- [x] Remaining events wired (2026-07-01): `onboarding_ankidroid_check`, `onboarding_permissions_granted`, `onboarding_completed`, `trial_started/expired`, `session_first_card_answered`, `settings_changed`
- [ ] `subscription_cancelled` — unwired; there is no in-app cancel UI (Play owns cancellation). Wire only if a cancel entry point ever exists.
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

- [ ] Update app name from "RealtimeApiOnMobile" to "Engram"
- [ ] Update `app.json`: slug + package name (`com.engram.app`; `name` is already "Engram")
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

## Recently shipped (2026-05-21 — write-back tests + Gradle fix)

### Gradle build fix

- [x] **Root cause found and fixed:** `android/build/generated/autolinking/autolinking.json` cached stale library paths from before the project was moved from `Projects/` to `Projects/Dev/`. RN's autolinking caches that file keyed on lockfile SHA — the recent `package-lock.json` metadata-only change didn't invalidate it. Fix: `rm -rf android/build/generated/autolinking/`. One-time; next builds re-cache with correct paths. **BUILD SUCCESSFUL** 3m 19s, 626 tasks.
- [x] Added gotcha to `DEBUGGING.md §10` explaining the stale cache symptom and fix.

### Write-back test coverage (Jest, layer 2)

- [x] `src/services/__tests__/ankiBridge.writeback.test.ts` — 15 tests for the JS bridge retry wrapper: ease mapping (pass→4, fail→1), first-success no-retry, 0-rows-triggers-retry, throw-triggers-retry, both-fail returns false (never throws), timeTakenMs=0 default, arg forwarding on retry. Uses `jest.useFakeTimers` + `resetAllMocks`/`clearAllTimers` to prevent mock queue bleed across tests.
- [x] `src/services/__tests__/sessionManager.writeback.test.ts` — 9 tests for edge cases not covered in `sessionManager.test.ts`: override with no prior evaluated card (null lastAnsweredCardId), `endSession` clears lastAnsweredCardId/Ord (stale-override regression guard), fire-and-forget ordering (sendToolResult before answerCard resolves), write-back uses card identity at eval time not after advance, override writes to same (noteId, ord) as prior evaluate.
- [x] **All jest suites green: 139/139 passing**, 2 skipped (TEST_REAL_GEMINI gated).

### Write-back verification tool (device level)

- [x] `scripts/check-writeback.sh` — fires one answer, captures both markers: Kotlin `AnkiDroidModule:D answerCard: result ... -> N row(s) updated` + JS `[ankiBridge] answerCard(...) → ok`. Exit 0 = PASS (rows>0), 1 = FAIL (0 rows), 2 = timeout, 4 = partial. Documents failure causes (stale queue, deck mismatch, stale ord).
- [x] **Write-back confirmed working** from `_debug/runs/20260521-144314.log`: 4/4 cards `→ ok` in the last logged session.

### Known unfixed (carried from 2026-05-06 session)

- [ ] `answerCard` Kotlin row-count verification missing from prior runs (logcat filter only captured `ReactNativeJS`; `check-writeback.sh` now also captures `AnkiDroidModule:D`).
- [ ] P3 instrumented test `submitCardAnswer_writesToCorrectCard` still pending (see P3 below).

---

## Recently shipped (2026-05-21 — session debug pipeline + BUG 4 fix)

### Maintenance

- [x] Stripped overbroad Android permissions from `app.json`: removed `android.permission.CAMERA` (unused; nothing in `src/` or `modules/` references it) and `android.permission.SYSTEM_ALERT_WINDOW` (no overlay features). Kept `BLUETOOTH` (legitimately used by `modules/expo-foreground-audio/.../AudioFocusManager.kt` for headphone routing). Brings the install-time permission dialog closer to "voice + audio + IAP" only.

### Debug & test infrastructure

- [x] `src/services/sessionDebugLogger.ts` — structured step logger mapping the canonical 8 SESSION-FLOW.md steps. Timestamps, phase machine, scoped events, verbose mode gated by `EXPO_PUBLIC_SESSION_DEBUG_VERBOSE`.
- [x] `sessionManager.ts`, `geminiManager.ts`, `cardLoader.ts`, `useSessionStore.ts` all routed through `sessionLog.*`; ad-hoc `console.log` noise (per-message dumps, audio chunk counters, setup payload) gated behind verbose.
- [x] Autostart sessions without manual tap: `AUTO_START_DECK="Aws Exam SA"` in `.env` → `(main)/deck-select.tsx` calls `handleSelectDeck` on mount when env matches.
- [x] `scripts/snap.sh` — adb screencap to `_debug/snaps/<ts>-<label>.png`. Used for visual cross-reference of log vs UI state.
- [x] `scripts/answer.sh "..."` — fires deep link `engram://simulate?answer=...` → handled by new `app/simulate.tsx` route → `sessionManager.simulateUserAnswer(text)`. Injects a fake user-spoken answer without a microphone; the eval pipeline downstream runs for real.
- [x] `scripts/test-flow.sh` — multi-card pipeline. Autostart → wait STEP 7 → loop (snap pre / answer.sh / wait tool_result+ai_done / snap post) → end_session → summary. Exit 0 = all OK, exit 2 = at least one TIMEOUT/PARTIAL.
- [x] Doc: `App/DEBUGGING.md` (10 sections — recipe, logger API, canonical flow, bug cheatsheet, autostart, snaps, answer.sh, pipeline, extension, gotchas, files).

### BUG 4 fix (eager card advance + recovery)

- [x] `handleEvaluateAndMoveNext` now advances `currentCardIndex` + `cardCacheIndex` synchronously right after `sendToolResult` instead of waiting for `response.done` in `giving_feedback`. The previous design locked the UI on the wrong card when Gemini ended a turn without audio (ctrl tokens + silent turnComplete, BUG 3 shape).
- [x] `startEvaluatingRecovery()` arms an 8 s timer when the session enters `evaluating` (either user transcript or sim inject). If no `response.audio.delta` arrives, force-transitions to `awaiting_answer` and logs `evaluating_recovery`. Cancelled in audio.delta handler and in session-end paths.
- [x] Reproduced E2E by `test-flow.sh` BEFORE the fix (cards 2/4 lock the session; subsequent injects rejected by phase guard). AFTER the fix: session no longer locks; uncertain answers still TIMEOUT against Gemini but the eval loop survives for confident answers later in the same session.
- [x] `pendingCardAdvance` field deleted; reset paths in `endSession`, `endSessionFromNotification`, `scriptRunner`, jest tests, and `replay.test.ts` updated to clear the new recovery timer instead.
- [x] All jest suites green: 115/115 passing, 2 skipped (TEST_REAL_GEMINI=1 gated).

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

### P1 — Implement recovery for tool-call-no-audio **[DONE 2026-05-21]**

- [x] Currently the session sticks in `evaluating` if the AI tool-calls but never speaks. Layer 2 `toolCallNoAudio` characterizes the stuck state.
- [x] Add a timeout (e.g. 8 seconds) in the `evaluating` phase: if no `response.audio.delta` arrives, force-advance the card and transition to `awaiting_answer`. (`SessionManager.startEvaluatingRecovery`, 8 s.)
- [x] Flipped: card eager-advances inside `handleEvaluateAndMoveNext` (BUG 4 fix); recovery timer handles the phase. E2E verified via `scripts/test-flow.sh`.

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
