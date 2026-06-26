# Session Flow — Engram

> Source of truth for how the study session is supposed to work, what breaks, why, and how to fix + test each failure. Read this before touching `sessionManager.ts`, `geminiManager.ts`, or `prompts.ts`.

---

## 1. The Correct Flow (canonical)

```
[User taps Start]
       │
       ▼
sessionManager.startSession()
  → connects WebSocket (geminiManager)
  → loads due cards from AnkiDroid (cardLoader)
  → sends setup message to Gemini (system prompt + tools)
  → sends first card as text message
  → waits for Gemini to finish first response (waitForNextResponseDone)
  → enables mic (server VAD on)
       │
       ▼
TUTOR: "Good morning! Let's study [deck]. You have [N] cards."
TUTOR: reads/rephrases first card question aloud
UI:    shows first card (front)
       │
       ▼
USER:  speaks answer
       │
       ▼
Gemini VAD detects end of speech → commits user turn
       │
       ▼
TUTOR: (silently) calls evaluate_and_move_next(quality, feedback)
  → client receives toolCall message
  → records answer in AnkiDroid (fire-and-forget)
  → advances card index in UI
  → returns { next_card: {front, back} | null } to Gemini
       │
       ▼
TUTOR: says "Correct!" or "Incorrect. The answer was [back]."
TUTOR: reads next card question aloud
UI:    shows next card (front)
       │
       ▼
[repeat until next_card === null]
       │
       ▼
TUTOR: "Great work! You reviewed [N] cards. [X] correct, [Y] incorrect."
UI:    transitions to session_complete screen
```

**Key invariants:**

- The tool call is always SILENT — no audio comes before the tool result returns.
- The UI advances the card THE MOMENT the tool result is sent (not when AI finishes speaking).
- If `next_card` is `null`, the tutor wraps up and calls `end_session`. No card loop.
- The mic is muted during setup and the first AI response. It unmutes only after.

---

## 2. Tool: `evaluate_and_move_next`

This is the ONLY mechanism that records grades and advances the session. There is no other path.

**Current name in code:** `evaluate_and_move_next`  
**Proposed rename:** `mark_and_go_next` (clearer intent — marks the card AND gets the next one atomically)

### Parameters (sent by AI)

```json
{
  "user_response_quality": "correct" | "incorrect" | "skipped",
  "feedback_text": "Brief explanation."
}
```

### Response (returned by client)

```json
{
  "status": "success" | "session_complete",
  "answered_card_back": "the correct answer string",
  "next_card": { "front": "...", "back": "..." } | null,
  "remaining_cards": 3,
  "session_stats": { "correct": 2, "incorrect": 1 }
}
```

**When `next_card` is `null`:** session is over. The AI MUST say the summary and call `end_session`. It must NOT loop or ask for more cards.

---

## 3. Phase State Machine

```
idle
 → connecting       (startSession called)
 → loading_cards    (connected, loading AnkiDroid)
 → ready            (cards loaded, configuring AI)
 → awaiting_answer  (AI asked the question, mic is live)
 → evaluating       (user transcript received)
 → giving_feedback  (AI audio starts after tool result)
 → awaiting_answer  (AI finishes speaking → next card)
 → session_complete (no more cards or end_session called)
 → error            (any fatal failure)
```

Phase transitions in code:

- `ready` → `awaiting_answer`: after `sendFirstCard` + `waitForNextResponseDone` completes
- `awaiting_answer` → `evaluating`: on `conversation.item.input_audio_transcription.completed`
- `evaluating` → `giving_feedback`: on `response.audio.delta` (first audio chunk after tool result)
- `giving_feedback` → `awaiting_answer`: on `response.done` (AI finishes speaking)

---

## 3a. Tutor Utterance Contract

Design rules for what the tutor says and when. Pinned here because the LLM drifts and previous regressions (BUG 10, BUG 11, the deck-dependent variance observed 2026-05-25) all involved the tutor saying the wrong count at the wrong time. Changes to `prompts.ts` MUST preserve these rules.

### Card count announcement

- **The card count is spoken EXACTLY TWICE per session:**
  1. The opening greeting: _"Good {morning|afternoon}! Let's study {deck}. You have {N} cards to review."_ — `N` = `totalDueAtStart` (the AnkiDroid `dueCount` snapshot taken at `startSession`, NOT `cards.length` which is always 1 under the BUG 5 v3b cache).
  2. The closing summary: _"Great work! You reviewed {total} cards. {correct} correct, {incorrect} incorrect. Keep up the good practice!"_
- **Between greeting and summary the tutor MUST NOT verbalize any card count.** No "almost done," no "X cards to go," no "this is the last card," no echoing `remaining_cards`. The `remaining_cards` field in tool responses exists so the AI knows when the deck is exhausted (`remaining_cards === 0` + `next_card === null` ⇒ end-of-deck), not for narration.
- **Count source MUST come from `totalDueAtStart`, not `cards.length`.** Anywhere the prompt template, foreground service notification, or UI receives a "total cards" number, the source is `useSessionStore.totalDueAtStart`. The in-memory cache holds 1–2 cards at any moment under refill-from-scheduler; using `cards.length` produces the "1 card to review" regression that landed twice (once in the system prompt, once in `remaining_cards`).

### Feedback turn structure

The tutor's per-card spoken output, in order:

1. Evaluation word: _"Correct!"_ or _"Incorrect!"_ (after `evaluate_and_move_next` returns).
2. If incorrect (or always-read-back enabled): one sentence reading the correct answer aloud from `answered_card_back`.
3. Optional one-sentence feedback explaining why.
4. Brief pause.
5. The next question, rephrased from `next_card.front`.

The tutor MUST NOT add: card counts, encouragement counters ("3 in a row!"), progress remarks ("we're almost done"), unsolicited hints, or any content derived from the previous card's `back` other than the literal read-back in step 2.

### Forbidden references

- Card `back` content in question rephrasings (BUG: information leakage, see §10 ANSWER SECRECY in prompt).
- The `cards.length` cache size (always misleading under v3b).
- Any reference to "the system," "the database," "the tool" — the tutor is a study coach, not a sysadmin narrating IPC.

---

## 4. Known Bugs — Root Causes + Fixes

---

### BUG 1 — Tutor greets but never reads the first card

**Symptom:** AI says "Good morning! Let's study X." and then goes silent. Never asks the first question.

**Root cause (most likely):** `waitForNextResponseDone()` resolves on a premature `turnComplete`.  
Gemini can emit an empty `serverContent { turnComplete: true }` right after setup acknowledgement (before the AI actually speaks). This `turnComplete` maps to `response.done`, which resolves `waitForNextResponseDone` early. VAD gets enabled before the AI has spoken the first card. The mic comes live, the AI gets confused by ambient input, and never completes the greeting+question turn.

**Secondary cause:** `getInitialMessage()` asks the AI to "greet AND ask the first question" in one turn. If the AI's greeting turn completes (turnComplete fires) before it has said the question, `waitForNextResponseDone` resolves and VAD is enabled during the question. The mic captures the AI's own voice or ambient noise.

**Fix:**

1. In `geminiManager.handleMessage`: ignore `turnComplete` events that arrive without any preceding audio chunks in that turn. Only emit `response.done` when the turn contained at least one audio part.
2. In `getInitialMessage()`: separate greeting from first question. Tell the AI: "After greeting, immediately ask: [first card question]". Make it unambiguous that both happen in one turn.
3. Add a guard in `waitForNextResponseDone`: wait for a turn that actually had audio (`response.audio.delta` fired at least once in that turn) before resolving.

**Test to add:** `BUG1 — premature turnComplete does not resolve waitForNextResponseDone`

- Mock: emit `response.done` immediately after setup (no `response.audio.delta` preceding it)
- Assert: `waitForNextResponseDone` does NOT resolve on this event
- Mock: emit `response.audio.delta` then `response.done`
- Assert: now it resolves

---

### BUG 2 — Tutor can't listen to the user (mic never active / VAD not triggering)

**Symptom:** Tutor reads the card, user speaks, nothing happens. Or: transcript never appears in logs.

**Root cause A — premature resolve of waitForNextResponseDone (same as Bug 1):** VAD is enabled before the AI finishes its first turn. The mic picks up the AI's own audio output (echo) and Gemini's VAD triggers on it, consuming the "user turn" before the user speaks.

**Root cause B — `updateSession` no-op for Gemini:** The second `updateSession` call in `sendFirstCard` (which attempts to enable `server_vad`) is a **no-op** for Gemini because `isSetupDone = true` on subsequent calls. The VAD is always whatever was configured in the initial setup's `realtimeInputConfig.automaticActivityDetection`. This is fine IF the initial config is correct — but the sessionManager's `turn_detection: null` intent (disable VAD during setup) has no effect either. The initial setup always has VAD active via `realtimeInputConfig`.

**Root cause C — `isMuted` vs `isSetupDone` check:** Audio chunks are only sent when `!isMuted && ws.readyState === OPEN && isSetupDone`. If `isSetupDone` is ever false when the mic should be live, chunks are silently dropped.

**Fix:**

1. After `waitForNextResponseDone` resolves (guarded as per Bug 1 fix), add a 200ms delay before unmuting to let the AI's last audio chunk finish playing through the speaker. This prevents the mic capturing AI audio echo.
2. Log a warning when `isMuted=false` but `isSetupDone=false` — makes the silent-drop visible.
3. Document clearly that the `turn_detection` field in `updateSession` is a no-op for Gemini; VAD config lives in the initial setup only.

**Test to add:** `BUG2 — audio chunks not sent when isSetupDone=false`

- Assert that `ws.send` is not called when `isSetupDone = false` even if `isMuted = false`

---

### BUG 3 — Tutor says "Correct/Incorrect" but card is not marked in AnkiDroid

**Symptom:** Session continues verbally but AnkiDroid card status never changes. Or: in logs, `evaluate_and_move_next` is never called.

**Root cause A — AI speaks before calling the tool:** Gemini may verbalize "Correct!" and emit audio BEFORE or WITHOUT emitting a `toolCall` message. The system prompt forbids this, but Gemini doesn't always obey. When this happens: no `toolCall` message → no `response.function_call_arguments.done` event → `handleEvaluateAndMoveNext` is never called → AnkiDroid never gets the write-back → stats don't update → UI doesn't advance.

**Root cause B — `toolCallCancellation` race:** If the client takes too long to respond to the tool call (Gemini's timeout is ~1s), Gemini sends `toolCallCancellation`. The tool result arrives at a cancelled call ID and is silently ignored. The fix (fire-and-forget write-back) was already applied — but the tool result itself must still be sent fast.

**Root cause C — `toolCall` message arrives but `toolCallNames` map miss:** In `geminiManager`, `toolCallNames` is populated in the `toolCall` branch of `handleMessage`. In `sessionManager`, the handler for `response.output_item.added` also tracks names. If the order of emission races (edge case), `toolCallNames.get(call_id)` returns `undefined` → tool falls into the `default: unknown tool` branch → silently ignored.

**Fix:**

1. In the system prompt: add explicit rule "Every evaluation MUST end with a tool call. Saying 'Correct' or 'Incorrect' is not an evaluation — only the tool call is."
2. Add a timeout in `evaluating` phase: if 8 seconds pass without a `response.function_call_arguments.done` event, log an error and force-advance with `skipped` quality (so the session doesn't freeze).
3. In `geminiManager.handleMessage`: when a `toolCall` arrives, also log the call IDs received. Add assertion in tests that `toolCallNames` map is populated before `response.function_call_arguments.done` fires.

**Test to add:** `BUG3 — evaluating phase timeout forces skip after 8s`

- Mock: trigger `evaluating` phase transition (user transcript event)
- Assert: after 8000ms (fake timers), tool call fires with `skipped`
- Assert: session is not stuck in `evaluating` phase

---

### BUG 4 — Tutor reads next card but UI still shows previous card **[FIXED 2026-05-21]**

**Status:** Fix shipped in `sessionManager.ts` `handleEvaluateAndMoveNext` —
card advance is now eager (synchronous after `sendToolResult`), and a
recovery timer (`startEvaluatingRecovery`, 8 s) forces phase exit if no
audio arrives. Reproduced E2E by `scripts/test-flow.sh` on 2026-05-21 —
cards 2/4 of the canned run regressed before the fix, all 4 should pass
after.

**Symptom:** AI voice says "Next question: [card N+1]" but the screen still displays card N.

**Root cause — card advance is gated on `giving_feedback` phase, but phase never reaches it:**

The advance logic is:

```ts
// response.audio.delta handler:
if (phase === 'evaluating') → transition to 'giving_feedback'

// response.done handler:
if (phase === 'giving_feedback') → advanceCard() + advanceCacheIndex()
```

If Gemini emits `turnComplete` WITHOUT preceding audio deltas (e.g. the tool-call turn itself, which is silent), `response.done` fires in `evaluating` phase. The condition `phase === 'giving_feedback'` is false → `pendingCardAdvance` is never processed → UI stays on old card forever.

The system prompt comment in `sessionManager.ts` (lines 218-228) acknowledges this: "Gemini Live emits turnComplete at the end of every model turn, including the turn that ends with a toolCall." The intended fix was to only advance when `giving_feedback` was reached. But if the feedback turn ALSO has no audio (bug), it breaks.

**Fix:**  
Advance the card index when the tool result is sent — not on `response.done`. This is the fundamental design change:

1. In `handleEvaluateAndMoveNext`: call `advanceCard()` and `advanceCacheIndex()` immediately after `sendToolResult(callId, result)`, before returning.
2. Remove `pendingCardAdvance` flag entirely.
3. Remove the `response.done` → advance logic.
4. Keep `giving_feedback` → `awaiting_answer` transition on `response.done` (just for phase management).

Trade-off: the UI will show the next card's front while the AI is still giving feedback about the previous card. This is acceptable — the user's ears track the AI; the screen is secondary. Freezing the UI on the wrong card forever is not acceptable.

**Test to add:** `BUG4 — advanceCard called immediately after sendToolResult`

- Mock `peekNextCard` returning a card
- Call `handleEvaluateAndMoveNext`
- Assert `mockAdvanceCacheIndex` was called synchronously (not deferred to response.done)
- Assert `useSessionStore.getState().cardIndex` has incremented

---

### BUG 5 — Second card of every session is always the deck's first note (not a due card) **[FIXED 2026-05-24]**

**Status:** Shipped. v3b — refill from scheduler per answer.

**Original symptom:** First card was a genuine due card. Card #2 was always the same hard-coded-looking card (e.g. for `Aws Exam SA`: "Which service is used for encryption of keys and which for hosting of credentials?"), regardless of what cards were actually due. Verified on Pixel 9. The "always-card" was the deck's oldest-added note (lowest `nid`).

**Root cause:** `AnkiDroidQueries.queryDueCards` had a hybrid loader — scheduler URI for the head card (1 result; AnkiDroid 2.23+ ignores `?limit=N` on the schedule URI) plus a pad via the cards URI `?query=did:N is:due` / `is:new` / `is:learn`. The pad returned results in `nid` (insertion) order and AnkiDroid's cards URI does **not** expose the `due` column on its default cursor (confirmed: columns are `_id, note_id, ord, card_name, deck_id, question, answer`). With the scheduler head deduped out of the pad results, slot[1] was always the deck's oldest-`nid` due card.

**Attempts (all failed):**

| Attempt           | Approach                                                                                                                                                         | Why it failed                                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1                | Add `due` field to `DueRef`, sort in-memory `sortedBy { it.due }`. Fallback `due=Long.MAX_VALUE` when column missing.                                            | AnkiDroid cards URI doesn't expose `due` — all pad cards tied at MAX_VALUE → stable-sort preserved `nid` order. No-op.                                                                                     |
| v2                | Explicit cursor projection `arrayOf("_id","nid","ord","did","due","queue","type")` to force `due` into the result.                                               | AnkiDroid's SQL builder rejected: `"Queue 'nid' is unknown"`. Pad query returned 0 cards. Session loaded just the scheduler head → user answers 1 card → session ends (this is **BUG 7**, the regression). |
| v2-sort           | Pass `sortOrder = "due ASC"` to `contentResolver.query` to let AnkiDroid sort SQL-side.                                                                          | AnkiDroid silently ignores the hint. slot[1] still wrong.                                                                                                                                                  |
| **v3b (shipped)** | Drop the pad entirely. `queryDueCards` returns only the scheduler head card (size 0 or 1). After each answer, JS re-queries the scheduler to fetch the new head. | Always-correct order, no dependency on `due`.                                                                                                                                                              |

**Shipped implementation (v3b):**

1. `AnkiDroidQueries.kt` `queryDueCards`: pad code path removed. Returns scheduler head only.
2. `useCardCacheStore.pushCard(card)`: new method, appends with **no dedup** (a user-failed card legitimately re-appears at the scheduler head).
3. `cardLoader.fetchAndAppendNextCard(deckName)`: new helper. Calls `ankiBridge.getDueCards(deckName)` → takes `cards[0]` → pushes to cache → returns it (or `null` if scheduler returned empty).
4. `sessionManager.handleEvaluateAndMoveNext`: was fire-and-forget `answerCard`. Now `await answerCard` → `await fetchAndAppendNextCard(deck)` → then sends tool_result. Wrapped in `Promise.race` against a 500 ms timeout so a slow AnkiDroid cannot exceed Gemini's ~1 s tool-call timeout (which would trigger `toolCallCancellation` and corrupt the session).

**Contract change:** `answerCard` is no longer fire-and-forget. The old defensive test `sends tool result before answerCard resolves (non-blocking)` was removed and replaced with:

- `calls answerCard then fetchAndAppendNextCard before sending tool result` (ordering)
- `does not throw when answerCard rejects (refill still proceeds)` (resilience)
- `caps the answer+refill chain at 500 ms so slow AnkiDroid does not trip Gemini cancellation` (timeout)

**Verification:** logged `CardLoader → refilled next card from scheduler { cardId, ord }` per answer. User confirmed card 2 is now a different real due card across sessions.

**Files touched:** `AnkiDroidQueries.kt`, `useCardCacheStore.ts`, `cardLoader.ts`, `sessionManager.ts`, `sessionManager.writeback.test.ts`, `sessionManager.test.ts`, `replay.test.ts`.

---

### BUG 6 — `end_session` and `pause` don't interrupt in-flight TTS **[FIXED 2026-05-24]**

**Status:** Shipped. v2 — synchronous native halt flag.

**Symptom:** During a TTS turn (question, feedback, or summary), user tapped End Session or Pause. UI responded immediately, but the tutor's voice kept playing for **3–8 seconds** of trailing buffered TTS. User expectation: hard cut. Does not surface in logcat — JS handlers completed cleanly; the leak was downstream in the audio pipeline.

**Root cause (after two iterations):** Initially thought the AudioTrack buffer wasn't flushed. But native `flush()` was called and the logs showed the flush running **8 seconds late**:

```
13:26:43.975 — Audio → playback halted (JS event)
13:26:43.976 — phase awaiting_answer → idle (session_ended)
[... 8.3 SECONDS LATER ...]
13:26:52.144 — AudioTrackManager: Flushed
13:26:52.265 — AudioTrackManager: Stopped
```

The real cause: Expo `AsyncFunction` handlers are **serialized** on a single dispatcher. While the tutor was speaking, dozens of `playAudioChunk` calls had queued up. Each one blocks on `AudioTrack.write()` (which itself blocks when the AudioTrack buffer is full — backpressure). When `flushAudioPlayer()` was finally invoked, it had to wait its turn behind the entire backlog, so by the time `pause()`+`flush()` ran, the user had already heard the queue play out.

**Attempts:**

| Attempt          | Approach                                                                                                                                                                                                                                                                      | Why it failed                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1a              | JS-side `playbackHalted` flag in `geminiManager`. `stopCurrentAudio()` sets it; `response.audio.delta` handler `continue`s when set.                                                                                                                                          | Correct in principle, but only stops _new_ chunk submissions. The pending chunks already in the AsyncFunction queue (and the AudioTrack hardware buffer) still played out. |
| v1b              | Reorder `sessionManager.endSession()` to call `webrtcManager.disconnect()` immediately after `stopCurrentAudio()`, before other cleanup.                                                                                                                                      | Helped marginally but didn't address the queued-AsyncFunction backlog.                                                                                                     |
| **v2 (shipped)** | Native `@Volatile halted` flag on `AudioTrackManager`. Synchronous Expo `Function` (not AsyncFunction) flips it from JS instantly. `writeChunk` checks the flag and early-returns — pending queued chunks become microseconds each instead of blocking on `AudioTrack.write`. | Drained the backlog within ~10 ms. User hears nothing after the tap.                                                                                                       |

**Shipped implementation (v2):**

1. `AudioTrackManager.kt`: added `@Volatile private var halted: Boolean = false`. `writeChunk` early-returns when set. `flush()` and `stop()` both set it. `init(sampleRate)` resets to `false` for the next session.
2. `AudioTrackManager.setHalted(value: Boolean)`: synchronous setter.
3. `ExpoForegroundAudioModule.kt`: added `Function("haltAudioPlayer") { halted: Boolean -> audioTrackManager.setHalted(halted) }`. **`Function`, not `AsyncFunction`** — must be sync so it runs on the JS thread immediately, bypassing the dispatcher queue.
4. `expo-foreground-audio/index.ts`: exposed `haltAudioPlayer(halted: boolean): void` (sync return).
5. `geminiManager.ts` `stopCurrentAudio()`: calls `ExpoForegroundAudioModule.haltAudioPlayer(true)` first (sync, sub-ms), then `flushAudioPlayer()` (async, drains whenever). Also keeps the JS `playbackHalted` flag as belt-and-suspenders.
6. `sessionManager.endSession()` and `endSessionFromNotification()`: reordered to call `webrtcManager.disconnect()` immediately after `stopCurrentAudio()` (was 10+ statements later). Also `endSessionFromNotification` previously didn't call disconnect at all — now it does.

**Verification:** user confirmed audio cuts within ~100 ms when tapping End during tutor speech. Log shows the new diagnostic line `halted=true (sync)` from the native side.

**Files touched:** `AudioTrackManager.kt`, `ExpoForegroundAudioModule.kt`, `expo-foreground-audio/index.ts`, `geminiManager.ts`, `sessionManager.ts`.

---

### BUG 7 — Session auto-completes after answering one card **[FIXED 2026-05-24]**

**Status:** Shipped. Regression patched immediately; superseded by BUG 5 v3b architecture.

**Origin:** Introduced as a regression while attempting to fix BUG 5. The "BUG 5 v2" attempt added an explicit cursor projection to `AnkiDroidQueries.queryDueCards` pad query (`arrayOf("_id","nid","ord","did","due","queue","type")`). AnkiDroid's cards URI rejects that projection with the error:

```
W/AnkiDroidQueries: queryDueCards: cards URI query 'did:N is:due' failed: Queue "nid" is unknown
W/AnkiDroidQueries: queryDueCards: cards URI query 'did:N is:new'  failed: Queue "nid" is unknown
W/AnkiDroidQueries: queryDueCards: cards URI query 'did:N is:learn' failed: Queue "nid" is unknown
D/AnkiDroidQueries: queryDueCards: returning 1 due cards for '<deck>' (head: <nid>@0)
```

Pad adds 0 cards. Session loads exactly the scheduler head (1 card). User answers it. `peekNextCard()` returns `undefined`. `handleEvaluateAndMoveNext` returns `next_card: null` + `remaining: 0`. SessionManager transitions to `session_complete` with reason `no_more_cards`.

**Visible symptom:** "Great job, you finished all your cards!" after one answer, even if AnkiDroid shows 245+ due.

**Why the projection broke it:** the cards URI's `?query=did:N is:due` route runs through `Collection.findCards()`. Its result schema is fixed by AnkiDroid; passing a projection array makes AnkiDroid try to SQL-SELECT those columns and `"nid"` isn't a column name it recognizes in that context (it expects e.g. `Notes.id`). The error message "Queue 'nid' is unknown" is AnkiDroid's parser misinterpreting the projection as a SQL fragment.

**Immediate fix (BUG 7 patch):** reverted to `null` projection. Pad came back populated (in wrong order — BUG 5 reappeared). User confirmed session loaded all 247 cards again.

**Real fix (BUG 5 v3b, shipped same day):** dropped the pad approach entirely (see BUG 5 above). With v3b the cards URI is no longer queried — `queryDueCards` calls only the scheduler URI which returns the head card — so the BUG 7 codepath is unreachable.

---

### BUG 8 — SFX feedback chime auto-pauses the session **[FIXED 2026-05-24]**

**Status:** Shipped. SFX-window filter on the audio-focus listener.

**Symptom:** When the evaluation feedback chime (correct/incorrect SFX, added 2026-05-24) plays, the session immediately transitions from `evaluating → paused` with reason `audio_focus_loss`. The chime is audible, the on-screen banner appears, then the session freezes and the tutor never delivers spoken feedback. The user has to manually resume to continue. Repeats on every graded card.

**Visible log signature:**

```
14:28:15.655 — tool_call → evaluate_and_move_next
14:28:15.704 — phase  evaluating → paused  (audio_focus_loss)
14:28:15.766 — tool_result → evaluate_and_move_next → Gemini
[session stuck until user_resumed]
```

**Root cause:** The SFX uses `expo-audio`'s `createAudioPlayer` + `play()`. On Android, `expo-audio` internally requests `AUDIOFOCUS_GAIN` when playback starts. Android's focus arbiter notifies the previous holder — our own `expo-foreground-audio` foreground service — that it has lost focus, even though both holders are the same process. `foregroundAudioService.ts:164-171` handles the `'loss'` event by pausing the session (the design assumes any focus loss is an external interruption like a phone call).

`expo-audio`'s `setAudioModeAsync` only exposes `'doNotMix' | 'duckOthers'` on Android (not `'mixWithOthers'`), so there is no JS-side knob to make the SFX a non-focus-stealing stream. A native fix would require routing SFX through `expo-foreground-audio` with `USAGE_ASSISTANCE_SONIFICATION` AudioAttributes (no focus request) — outside the scope of v1.

**Shipped implementation (software-only filter):**

1. `sfxPlayer.ts`: added `lastPlayAt` timestamp set inside `play()`, plus a public `isPlayingRecently()` returning `true` for `FOCUS_LOSS_IGNORE_WINDOW_MS = 2000` ms after each play.
2. `foregroundAudioService.ts` `onAudioFocusChange`: at the top of the handler, if the event is any `'loss' | 'loss_transient' | 'loss_transient_can_duck'` AND `sfxPlayer.isPlayingRecently()`, return early without pausing. Logs `[foregroundAudio] ignoring focus '<state>' — within SFX window` so the swallow is visible in logcat.
3. Trade-off: a real phone-call interruption that arrives within 2 s of an SFX play will be silently ignored. The next focus event (or the user tapping pause) recovers. Acceptable for v1 — the SFX is brief, real interruptions persist past the window.

**Verification:** user confirmed correct/incorrect chimes now play without pausing, tutor delivers feedback normally, and logcat shows:

```
14:33:14.765 — tool_call → evaluate_and_move_next
14:33:14.838 — [foregroundAudio] ignoring focus 'loss' — within SFX window
14:33:14.901 — tool_result → evaluate_and_move_next → Gemini
```

**Files touched:** `App/src/services/sfxPlayer.ts`, `App/src/services/foregroundAudioService.ts`. Tests: 4 new cases in `sfxPlayer.test.ts` covering the window timing. 161/163 passing.

**Future cleanup (deferred):** if SFX gain more importance, port them to a native SoundPool inside `expo-foreground-audio` with `USAGE_ASSISTANCE_SONIFICATION` so no focus request happens at all. The 2 s heuristic is a workaround, not a structural fix.

---

### BUG 9 — Session locks in "Your Turn" loop after silent eval turn **[OPEN, intermittent]**

**Status:** Open. Intermittent — does not reproduce on every session. Reporter: user, sesión 4 (2026-05-24). Logs not yet captured for a confirmed occurrence; needs persistent session-log capture before root cause can be confirmed.

**Symptom (verbatim from user):**

```
UI says "Your Turn" → user speaks → UI says "Evaluating" → silence →
UI says "Your Turn" again → user re-speaks → nothing happens, ever.
The session is stuck. The only fix is to end the session and start a new one.
```

The session does not pause, does not error, does not advance. The mic level meter still moves while the user speaks. The tutor never delivers feedback, never asks the next question. UI is responsive but the phase machine is frozen on `awaiting_answer` and no further transcripts seem to land.

**Likely root cause (hypothesis, to be confirmed via log capture):**

This looks like a continuation of [BUG 3](#bug-3--tutor-says-correctincorrect-but-card-is-not-marked-in-ankidroid). The trace is probably:

1. User answers card N. `awaiting_answer → evaluating` fires on `user_done_debounced`.
2. Gemini's eval turn produces **no audio + no tool call** — only `turnComplete`. ("BUG 3 shape": Gemini hallucinated the eval verbally inside its hidden reasoning but never emitted a `toolCall` or `response.audio.delta`.)
3. The 8 s `evaluatingRecoveryTimer` (`sessionManager.ts:679-685`) fires and force-transitions `evaluating → awaiting_answer` with reason `evaluating_recovery`. This is the "Your Turn" UI bounce the user sees.
4. User re-speaks. `inputTranscription.text` events stream in. The debounce in `sessionManager.ts:284-295` should fire `awaiting_answer → evaluating` again — but apparently doesn't, or fires and immediately hits the same BUG 3 shape, or Gemini's session-side state is stuck and ignores subsequent input entirely.

Step 4 is where the trace dies. Three sub-hypotheses to discriminate via logs:

| Hypothesis                                                                                                                  | Log signature when the session locks                                                  |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 9A. User's second utterance never produces `inputTranscription.text` events (Gemini stopped processing input)               | No `• user → transcript` lines after the recovery; mic meter active but Gemini silent |
| 9B. Transcripts come but the debounce timer is somehow stuck                                                                | `• user → transcript` lines appear, no `↳ phase awaiting_answer → evaluating` follows |
| 9C. Transcripts come, debounce fires, but Gemini's eval turn ALSO produces no tool call → recovery timer fires again → loop | `↳ phase` transitions ping-pong between `evaluating` and `awaiting_answer` every 8s   |

**Mitigation that DIDN'T fully work:** the 8 s `evaluatingRecoveryTimer` was added for BUG 3 to prevent permanent freeze in `evaluating`. It correctly bounces the phase back to `awaiting_answer`, but if the session is in hypothesis 9A's "Gemini stopped processing input" state, the bounce is cosmetic — the underlying Gemini session is dead from the user's perspective and only `endSession` + restart truly recovers.

**Data needed before fix:**

- Persistent logcat capture across multiple sessions (currently logs only land in `_debug/runs/live-*.log` when an external `adb logcat` tail is running; that tail dies on USB drops). User to tell us "it happened in this session" so we can grep the matching log file.
- Grep targets when capture lands:
  ```bash
  grep -E "evaluating_recovery|user → transcript|→ awaiting_answer|→ evaluating|toolCallCancellation" <log>
  ```
- If hypothesis 9A: capture also raw WebSocket-level events from `geminiManager.handleMessage` to see whether Gemini is acknowledging incoming audio.

**Tentative fixes to consider once root cause confirmed:**

- 9A → after `N` recovery bounces without progress, force a Gemini session resume (the same `resumeAfterReconnect` flow already exists for network drops). The user's "end + restart" workaround works because resume rebuilds the WebSocket + re-sends the current card; doing it automatically would un-stuck the session without user action.
- 9B → audit the `userDoneSpeakingTimer` lifecycle around the recovery-triggered phase change. A timer leak could be eating the second utterance's debounce.
- 9C → add a circuit breaker: after 2 consecutive recovery-timer bounces on the same card, force-skip the card (call `evaluate_and_move_next` with `skipped`) so the session moves on.

**Files probably involved:** `App/src/services/sessionManager.ts:284-312` (debounce + recovery), `App/src/services/geminiManager.ts` (WebSocket message handling — `handleMessage` for `inputTranscription.text` and `toolCall`), system prompt in `App/src/config/prompts.ts` (BUG 3 mitigation language).

---

### BUG 10 — Tutor falsely declares session complete / "this is the last card" every turn **[variant A FIXED 2026-05-25; variant C (skip-path) FIXED 2026-06-25; variant B still open]**

**Status:** Variant A (deterministic "last card every turn") root cause confirmed in sesión 5 from `_debug/runs/live-resilient-20260525-150637.log` and FIXED. **Variant C (skip-path, deterministic) FIXED 2026-06-25** — see below. Variant B (intermittent false session-end after a refill timeout) still open as originally described.

**Variant C — skip never advanced the scheduler (deterministic), FIXED 2026-06-25:**

Reproduced on-device with the persona E2E harness (`refold-english-mixed`): the session ended on the card-3 skip with `next_card: null` while `remaining: 8`. Root cause: in `handleEvaluateAndMoveNext` the entire write-back + `fetchAndAppendNextCard` block was guarded by `user_response_quality !== "skipped"`, so a skip never refilled. Under the BUG 5 v3b head-only cache, `peekNextCard()` then returned `undefined` → `next_card: null` → `no_more_cards` → false `session_complete`. Distinct from variant B (this never even _attempts_ the refill; it is not a race-timeout).

Fix: a skip now runs the same write-back + refill path as a graded answer. Because the AnkiDroid scheduler head only moves once a card is answered (there is no bury API in the `anki-droid` module) and `queryDueCards` returns only the head, the skip is written back as **"Again" (ease=1, pass=false)** purely to advance the scheduler — it is excluded from the correct/incorrect stats and plays no chime. Trade-off: a skipped card is rescheduled exactly like an incorrect one (rather than left untouched). A future `bury` native function would let a skip advance without touching scheduling; tracked as follow-up. Tests: `sessionManager.test.ts` (skip writes pass=false + triggers refill + does not end the session) and the L2 replay fixtures/invariants updated to expect the skip→Again write. Verified on-device: `refold-english-mixed` now grades all 6 cards (4 correct / 1 incorrect / 1 skip) instead of dying after the skip.

**Reporters:** user, sesión 4 (2026-05-24) [variant B] + sesión 5 (2026-05-25) [variant A].

**Symptoms (verbatim):**

- Variant A (sesión 5, Refold English Phrasal Verbs deck): _"The tutor, I don't know why, always says that the next card is the last one of the session even if there are 200 due cards left."_
- Variant B (sesión 4): _"The tutor says 'You reviewed 2 cards, 1 correct, 1 incorrect, Good Practice!' like if we finished the session because there are no more due cards (when that's not true)."_

Both originate from the same source-of-truth bug: the `remaining_cards` value the tool sends to Gemini comes from the in-memory cache, not the real AnkiDroid due pile.

**Root cause (variant A — deterministic):**

`handleEvaluateAndMoveNext` populated `remaining_cards` from `peekRemainingAfterAdvance()` (`cardLoader.ts:70-73`), which returns `cache.length − (currentIndex + 1)`. Under the BUG 5 v3b refill-from-scheduler architecture the cache only ever holds the current card + a 1-card lookahead. So **the value sent to the AI was 1 after every grading**, regardless of how many cards the deck actually has due. Confirmed in `live-resilient-20260525-150637.log`:

```
15:09:37.671  next_card_front  get through to
15:09:37.671  remaining        1
...
15:09:57.925  next_card_front  get down
15:09:57.925  remaining        1
...
15:10:23.709  next_card_front  move up
15:10:23.709  remaining        1
```

The Refold deck had ~200 cards due, but every tool response said `remaining: 1` → the tutor reliably read that as "one more after this" → narrated each card as the last.

**Fix (shipped 2026-05-25 — TWO independent edits):**

1. **Tool-result `remaining_cards`** now comes from `useSessionStore.totalDueAtStart − (stats.correct + stats.incorrect)`, clamped at 0. `totalDueAtStart` is snapshotted at `startSession` from `ankiBridge.getDeckInfo()` (the BUG 11 fix). Tests added in `sessionManager.test.ts` (`reports remaining_cards from the AnkiDroid due snapshot, not the cache` and a clamp test).
2. **System-prompt `cardCount`** also previously came from the cache: `configureAISession(selectedDeck, cards.length)`. The prompt's opening line _"You have {cardCount} cards to review"_ therefore baked "1" into the greeting, and the tutor faithfully announced "you have 1 card to review" at the start of every session — independent of the tool-result fix above. Patched: `configureAISession(selectedDeck, dueAtStart)` and the foreground-service notification _"Card 1 of N"_ now uses `dueAtStart` too.

Both numbers — the one in the opening greeting and the `remaining_cards` field — now share `totalDueAtStart` as their single source of truth. Reinforced by the new §3a Tutor Utterance Contract.

**Files touched:** `App/src/services/sessionManager.ts` (the snapshot block, the `configureAISession` call site, the foreground-service notification, the tool-result construction block), `App/src/config/prompts.ts` (count-utterance rule added to §1 START).

---

**Variant B — still open (intermittent false session-end):**

Below is the prior analysis, untouched. The variant-A fix does NOT close this: variant B is about `next_card: null`, not `remaining_cards: 0`. Even with `remaining_cards: 199`, if `next_card` is `null` the tutor still hits the end-of-deck branch.

**Symptom (verbatim):**

> The tutor says "You reviewed 2 cards, 1 correct, 1 incorrect, Good Practice!" like if we finished the session because there are no more due cards (when that's not true).

The tutor delivers the session-end summary monologue mid-session. The deck-select screen, before starting the session, showed many more due cards.

**Likely root cause (high confidence given BUG 11):**

Direct consequence of the BUG 5 v3b refill-from-scheduler architecture combined with the 500 ms cap in `handleEvaluateAndMoveNext`. Specifically:

1. `cardLoader.loadDueCards` calls `AnkiDroidQueries.queryDueCards`, which under v3b returns only the **scheduler head** — exactly 1 card.
2. The cache starts with 1 card. After answering, `handleEvaluateAndMoveNext` runs `answerCard + fetchAndAppendNextCard` inside a `Promise.race` with a 500 ms timeout (`sessionManager.ts:595-606`).
3. If `fetchAndAppendNextCard` does not resolve within 500 ms — either because AnkiDroid is slow on this device, the deck is large, or the scheduler returned `null` for "no more cards right now" without actually being exhausted — the race times out and the cache has not grown.
4. `peekNextCard()` returns `undefined` (`cards[currentIndex + 1]` doesn't exist).
5. `formatToolResult` builds a tool result with `next_card: null, remaining_cards: 0`. The AI receives this and behaves exactly as it would on a real end-of-deck: speaks the summary.
6. Simultaneously, `sessionManager.ts:658-666` triggers `transitionTo('session_complete', 'no_more_cards')`.

So the "false complete" is a faithful execution of the contract — the bug is in step 3, where a _transient_ refill failure is indistinguishable from a _real_ deck exhaustion.

**Distinguishing signals in logs:**

- Real exhaustion (legitimate end): `cardLoader.fetchAndAppendNextCard` logs an explicit "scheduler returned no more cards" event and is _not_ race-bounded — the refill completes.
- Transient failure (this bug): the `Promise.race` log shows the timeout branch winning, the answer/refill chain not completing before `sendToolResult` fires. No `• card → appended` event in the trace despite a known-populous deck.

**Proposed fixes (ordered by effort):**

1. **Verify-before-quit guard.** Before transitioning to `session_complete` on `nextCard == null`, call `ankiBridge.getDeckInfo()` (or a lighter "dueCount for this deck" call) and confirm `dueCount === 0`. If the deck still reports due cards, log a warning, do NOT send `next_card: null` to the AI — instead retry the refill once with a longer timeout (e.g. 1500 ms, accepting one slow `toolCallCancellation` rather than a wrong session end), and only declare complete if the second attempt also yields nothing.
2. **Defer the AI's session-end signal.** Today the tool result + `transitionTo('session_complete')` happen in the same tick. Splitting them — emit the tool result with `next_card: null` only after a confirmation step — at least prevents the tutor from delivering the summary on a false reading.
3. **Long-term: pre-fetch a small buffer.** Restore a 2- or 3-card lookahead cache (smaller than the pre-v3b pad approach so the BUG 5 ordering issue doesn't return at scale). The first slot stays from the scheduler head; the next 1–2 slots are pre-fetched in parallel after every answer. Transient refill latency is hidden behind the buffer.

**Files involved:** `App/src/services/sessionManager.ts:546-666`, `App/src/services/cardLoader.ts` (especially `fetchAndAppendNextCard`).

---

### BUG 11 — Top-bar counter shows "0 / 1" instead of the deck's actual due count **[FIXED 2026-05-24]**

**Status:** Open. Deterministic — happens at the start of every session under the current v3b architecture. Reporter: user, sesión 4 (2026-05-24). Likely the visible symptom that pre-loads the BUG 10 illusion.

**Symptom (verbatim):**

> In the deck menu I can see I have 234 cards due, but when I start a session in that deck it says at the top bar `0 / 1 cards` — as if the session is only 1 card long.

**Root cause:**

The session screen's top bar reads `cards.length` from the in-memory cache (`useCardCacheStore`):

```ts
// App/src/app/(main)/session.tsx:548-549
totalCards={cards.length}
// SessionHeader.tsx renders:  {currentIndex} / {totalCards} cards
```

After BUG 5 v3b, `cards.length` starts at **1** (only the scheduler head) and grows by 1 every time `fetchAndAppendNextCard` appends a refill. So at session start, `cards.length === 1` and the bar displays `0 / 1`.

In contrast, the deck-select screen reads `dueCount` from `ankiBridge.getDeckInfo()` (`App/src/app/(main)/deck-select.tsx:131-133`), which queries AnkiDroid for the **true** due-cards count for each deck. That's why the numbers disagree: two different sources of truth.

**Why this matters beyond cosmetics:**

The counter is the user's primary signal for session length. Showing `0 / 1` actively misleads them into expecting a one-card session — which then makes BUG 10's false-complete summary appear "consistent" with the displayed counter, masking the real underlying refill failure.

**Proposed fix:**

The top bar should display the deck's _true_ due count, not the cache size. Two implementation options:

- **Lightweight:** at `startSession` step 3, after `loadDueCards`, call `ankiBridge.getDeckInfo()` once and stash the deck's `dueCount` into `useSessionStore` (new field, e.g. `deckDueCountAtStart`). The session header reads from there instead of `cards.length`. Snapshot — doesn't drift as cards are answered, which is what we want for a stable progress bar.
- **More involved:** maintain a live "remaining due" count by decrementing on each successful `answerCard` write-back. More accurate but more code and more failure modes (e.g. write-back retry → desync).

Lightweight option is sufficient. The denominator stays fixed at "due at session start"; numerator is `stats.correct + stats.incorrect`. Same convention as e.g. AnkiDroid's own session counter.

**Files to touch:** `App/src/stores/useSessionStore.ts` (new field), `App/src/services/sessionManager.ts` `startSession` (populate it), `App/src/app/(main)/session.tsx:548-549` (read from session store instead of cache).

**Caveat:** the AnkiDroid `dueCount` from `getDeckInfo` includes cards that are due _today_. If new cards become due mid-session (e.g. the user is studying right at the day-boundary), the snapshot will be slightly off. Acceptable for v1.

---

### BUG 12 — UI flips to next card while tutor is still giving feedback on previous **[OPEN, UX]**

**Status:** Open. Deterministic — happens on every graded card. Reporter: user, sesión 4 (2026-05-24). Classified as UX, not functional — nothing is broken, but the visual order doesn't match the auditory order, which is disorienting.

**Symptom (paraphrased from user):**

> The tutor marks the flashcard, the correct/incorrect label appears, then the UI immediately shows the next flashcard — but then the tutor goes on to give feedback about the previous one. The next card is already on screen while the tutor is still talking about the previous one. Desired order: mark → label → feedback (previous card visible) → next card appears at the moment the tutor starts pronouncing it.

**Root cause (intentional trade-off from BUG 4):**

`sessionManager.handleEvaluateAndMoveNext` advances the card eagerly, immediately after `sendToolResult` (`sessionManager.ts:644-657`). This was the BUG 4 fix: the previous design gated advance on `response.done` in the `giving_feedback` phase, but Gemini sometimes emits a silent turn (audio.delta never fires → phase stays in `evaluating` → advance never happens → session freezes). The eager advance trades visual ordering for liveness.

**The fundamental obstacle the user identified:**

> The tutor pronounces the feedback AND the next question in the same sentence — there is no audible gap between them.

This is correct. `formatToolResult` packs `answered_card_back + next_card` into one tool result; Gemini generates one continuous TTS turn that flows directly from feedback to next question. There is no `response.done` between them, no reliable audio-amplitude pause, no separate WS event.

**What real-time signals we DO have during the feedback turn:**

- `response.audio.delta` — fires per audio chunk. Frequent, no semantic info.
- `outputTranscription` deltas — Gemini Live streams partial transcripts incrementally as the AI speaks. `geminiManager.ts:334-338` already emits these as `response.audio_transcript.done` events (the name is misleading — these are deltas, not "done"). Transcript text grows as the AI speaks.
- `response.done` — fires once the entire turn is over. Too late for "advance UI mid-turn."

**Options considered (all implementable today):**

| Option                               | Mechanism                                                                                                                                                                                                      | Pros                                                                                                     | Cons                                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. Leave as-is.**                  | No code change.                                                                                                                                                                                                | Zero risk. BUG 4 trade-off already documented.                                                           | UX stays imperfect.                                                                                                                                    |
| **B. Fixed-delay UI advance.**       | After `sendToolResult` keep `advanceCacheIndex` eager (data layer stays live for BUG 4); split a new `pendingUIAdvance` that fires after N ms or `response.done` (whichever first).                            | Trivial, ~15 lines.                                                                                      | Brittle — feedback length varies from ~0.5 s ("Correct!") to ~6 s (long explanation). Always wrong by a few seconds.                                   |
| **C. Transcript-driven UI advance.** | Subscribe to `outputTranscription` deltas; track the running transcript. When it first contains the leading 2–3 words of `nextCard.front`, advance the UI. Hard timeout (e.g. 6 s) + `response.done` fallback. | Aligns with the auditory transition exactly _when_ the AI doesn't paraphrase.                            | Fragile when the AI paraphrases — e.g. card front "What is the capital of France?" but AI says "Now tell me about France's capital." → fallback fires. |
| **D. Soft visual transition.**       | Keep eager card-data advance; in `CardDisplay`, `useEffect` on `currentIndex` change runs an N-second cross-fade. Previous card stays visible behind new card during fade.                                     | Pure UI, no timing risk. Hides the hard-cut.                                                             | Doesn't actually fix the ordering — both cards on screen at once. Cosmetic only.                                                                       |
| **E. Hybrid C + B.**                 | Transcript-driven by default. If the transcript hasn't crossed the threshold by N ms (e.g. 3500 ms — matches EvaluationBanner duration), force-advance. Plus `response.done` fallback.                         | Best of both: snaps to the auditory transition when matching works; degrades gracefully when it doesn't. | More code (~50 lines) + tests for each branch.                                                                                                         |

**Recommendation:** **E** if it's worth investing in, **A** if not. **C alone** is too fragile — Gemini paraphrases a lot in this app's prompt style. **D** is a band-aid that doesn't address the user's complaint.

**Files to touch (if implementing E):** `App/src/services/sessionManager.ts:614-666` (split "advance cache index" from "advance UI" — data layer stays eager for BUG 4 liveness, UI advance is gated). Add a new piece of session state (`pendingUIAdvance: number | null`) or wire the existing `currentCardIndex` to lag behind `cardLoader.currentIndex`. Subscribe to `response.audio_transcript.done` (deltas) events.

**Implementation note (v1, shipped 2026-05-24):** Option E shipped, but a regression surfaced immediately in device testing — the UI was flipping ~1 s into the feedback, much earlier than the user wanted. Root cause: the matcher was being passed each `outputTranscription` chunk _individually_ (Gemini chunks the transcript per-word, e.g. "Good afternoon!", " Let's", " study", " Aws"), not the running accumulated transcript. So the matcher could never satisfy the 2-token threshold and _always_ fell back to the 3500 ms timeout, which the user perceived as "flipping while the tutor is still giving feedback." See BUG 14 below for the v2 fix.

**Implementation note (v2, shipped 2026-05-24):** v2 added per-window transcript accumulation + extended timeout to 5500 ms. Symptom still persists — see BUG 14 status block for the remaining hypotheses.

---

### BUG 13 — First SFX of a session doesn't play (and now: ALL incorrect chimes silent) **[OPEN — v1 fix regressed, pending revert + revised approach]**

**Status:** Open. Reported: user, sesión 4 (2026-05-24). Reproduced symptom: on the first card of a session, answering incorrectly produces no chime; the green/red banner appears as expected, but the audio file is silent. Subsequent cards in the same session play the chime normally. Not yet confirmed whether `correct` on the first card has the same symptom — user explicitly observed it for incorrect.

**Symptom (verbatim):**

> The first flashcard of the session, if I answer incorrectly, the incorrect sound doesn't sound — only in the first one.

**Likely root cause:**

`expo-audio`'s `createAudioPlayer(source)` returns a player synchronously, but the underlying Android `MediaPlayer`/`ExoPlayer` loads the asset asynchronously. The `AudioPlayer.isLoaded` boolean transitions from `false` → `true` once decoding completes. Calling `player.play()` while `isLoaded === false` does **not** queue the play — it's a silent no-op on Android (the call returns, but no audio output happens).

Our `sfxPlayer.preload()` calls `createAudioPlayer` in `startSession` (`sessionManager.ts:76`). The first `play()` for the first card happens whenever the user finishes answering — typically 10+ seconds later — so for `correct.mp3` (10 KB) loading completes in well under a second. For `incorrect.mp3` (8 KB) likewise. But on a cold start when the audio subsystem is also booting (foreground service, AudioFocus, mic init), the loading thread can be starved enough that one of the players isn't ready in time for the first call. Once warm, subsequent plays are fine.

Why specifically "incorrect" sees the bug more often: the second player created (`incorrectPlayer`) gets less head-start than the first (`correctPlayer`) — the construction calls are sequential and the audio module's loader processes them in order. So `incorrectPlayer.isLoaded` reliably arrives a few ms later than `correctPlayer.isLoaded`. On a cold-boot device, that delta can cross the user's first-answer threshold.

**Proposed fix:**

1. **Preload-time wait:** in `sfxPlayer.preload()`, after `createAudioPlayer`, poll `player.isLoaded` (50 ms interval, ~1.5 s cap) before returning. Either both players are ready, or we log a warning and let `play()` no-op gracefully.
2. **Play-time guard:** in `sfxPlayer.play()`, if `!player.isLoaded`, log a warning + skip (don't try to retry — better to drop the chime than to play it late, mid-tutor-feedback).
3. **(optional) Move preload earlier:** call `sfxPlayer.preload()` from the root `_layout.tsx` on mount instead of `startSession`. Players have the entire onboarding + deck-select screen to load — by the time the user starts a session, isLoaded is guaranteed true.

Recommendation: ship fix 1 + 2 first (small diff, addresses the symptom). Move preload earlier (fix 3) if the polling solution still misses on slow boots.

**Files to touch:** `App/src/services/sfxPlayer.ts`.

**v1 fix attempt (2026-05-24, did NOT resolve AND introduced a regression):**

- `sfxPlayer.preload()` now polls until both `AudioPlayer.isLoaded === true` (`sfxPlayer.ts:waitUntilLoaded`).
- Added a guard in `play()`: skip + log warning if `!player.isLoaded`.
- Moved `sfxPlayer.preload()` from `startSession` to the root `_layout.tsx` so both players have the entire onboarding + deck-select window to load.
- Tests: 8 new cases covering load-state guard + polling.

**Symptom persists AND worsens**: user reports on sesión 4 (2026-05-24) post-v1-fix:

- The first card's incorrect chime is still silent (original symptom — unchanged).
- **NEW REGRESSION**: ALL incorrect chimes are silent across the whole session, not just the first one. Correct chimes appear to still play.

**Likely cause of the regression (high confidence, not yet verified on device):**

The `!player.isLoaded` guard added in v1 is too strict. expo-audio's `AudioPlayer.isLoaded` likely flips back to `false` (or to a transient state) after playback completes — the player has "no media currently loaded for immediate playback" until the next `seekTo(0) + play()` cycle re-prepares the asset. The guard then rejects every play call after the first one, with the warning `[sfx] player not loaded yet — chime skipped`.

That `incorrectPlayer` is more affected than `correctPlayer` is consistent with the user's observation: if the asymmetric load timing means `incorrectPlayer` reaches "ended" state slightly faster (different file length, ~8 KB vs ~10 KB), it sits in `isLoaded === false` longer than `correctPlayer` between plays.

**Resolution status (2026-05-25 sesión 5):**

- **Regression resolved.** The v1 guard was reverted (already on disk at start of sesión 5) and a new `[sfx] played quality=… wasLoaded=…` log line was added. In the captured session log:
  - First chime fired with `wasLoaded: true` — the player WAS loaded.
  - Every subsequent chime fired with `wasLoaded: false` — expo-audio's `isLoaded` does flip back to false after each playback completes. Without the guard, `play()` still produces audio. **Hypothesis "isLoaded flips false after play" is now confirmed.** Keeping the guard removed is correct.
- **Original first-card-silent symptom NOT resolved.** The user confirmed: on Aws Exam SA the first incorrect chime was inaudible; on Refold English Phrasal Verbs it was audible. The Aws session log shows `[sfx] played quality=incorrect wasLoaded=true` for that first card — we called `play()`, the player reported loaded, but no audio came out. This **eliminates all loading-state hypotheses**.
- **Confirmed remaining root cause:** Android audio-focus / stream conflict (hypothesis from the audio-focus list above). The tutor's `AudioTrack` runs with `USAGE_VOICE_COMMUNICATION`; expo-audio's `AudioPlayer` uses `USAGE_MEDIA`. On the first chime, voice-communication focus is still being arbitrated and the media stream gets ducked or silenced. Once the focus arbitration settles, subsequent chimes are audible. Deck-to-deck variance (silent on Aws, audible on Refold) is consistent with a race against the foreground-service startup — sometimes we're the lucky side of it.

**Definitive fix (deferred — requires native module changes):**

Port the SFX players to a native `SoundPool` inside `expo-foreground-audio` with `AudioAttributes.USAGE_ASSISTANCE_SONIFICATION` and `CONTENT_TYPE_SONIFICATION`. SoundPool with those attributes does NOT request audio focus, so it can play through the voice-communication focus the tutor holds without any arbitration. Bonus: SoundPool is purpose-built for short, low-latency cues and avoids the MediaPlayer/ExoPlayer load lifecycle entirely (so `isLoaded` semantics stop mattering). This needs:

1. New `playSfx(name, gain)` AsyncFunction in `expo-foreground-audio` (Kotlin) that owns the SoundPool.
2. JS `sfxPlayer` switches from `createAudioPlayer` (expo-audio) to `expoForegroundAudio.playSfx(...)`.
3. SFX assets bundled into `modules/expo-foreground-audio/android/src/main/res/raw/` (or passed as URIs).
4. APK rebuild required.

Not attempted in sesión 5 (per orientation: no native changes without confirmation). The user marked BUG 13 as "fixed enough" pending the native rework.

---

### BUG 14 — UI advance still flips during feedback (transcript chunks not accumulated) **[OPEN — v2 fix shipped but symptom persists, pending root cause]**

**Status:** Open. Surfaced immediately after BUG 12 v1 shipped. Reported: user, sesión 4 (2026-05-24).

**Symptom (verbatim):**

> Now the flashcard doesn't immediately change with the label correct/incorrect appearing, but it only delays a second to flip. So the tutor just starts the feedback sentence while the flashcard already changed.

The card flip moved from "instant on tool result" to "~1 s after tool result" — better than before, but still wrong. The desired moment is "when the tutor starts pronouncing the next question," typically 2–6 s into the turn.

**Root cause:**

In `sessionManager.registerEventHandlers` (`response.audio_transcript.done` handler), the matcher is called with `event.transcript` — but Gemini Live emits `outputTranscription` deltas **per-chunk**, not as a running accumulated transcript. A typical sequence for "Good afternoon! Let's study Aws Exam SA." looks like:

```
13:19:22.922  AI → transcript   text: "Good afternoon!"
13:19:23.225  AI → transcript   text: " Let's"
13:19:23.564  AI → transcript   text: " study"
13:19:23.618  AI → transcript   text: " Aws"
13:19:23.700  AI → transcript   text: " Exam"
13:19:23.800  AI → transcript   text: " SA."
```

Each handler invocation receives just a 1–3 word chunk. The matcher tokenizes those chunks (e.g. `["aws"]`, `["exam"]`, `["sa"]`) and tries to match against the next card front's significant tokens. A single-chunk fragment can never satisfy the "≥ 2 hits AND ≥ 50% coverage" threshold (it has at most 1 significant token per call). So the transcript-match path **never fires**, and every UI advance falls back to the 3500 ms timeout — which is the "~1 second" the user perceives (3500 ms minus the time spent talking through "Correct!"/"Incorrect..." minus the user's reaction time).

**Proposed fix (BUG 12 v2):**

1. **Accumulate transcript per pending-advance window.** Add `pendingUiTranscriptAccum: string` to sessionManager. Reset when `armPendingUiAdvance` is called. Append `event.transcript` on each delta. Pass the accumulated string to `transcriptIndicatesNextCard`.
2. **Extend the timeout.** 3500 ms was calibrated against the `EvaluationBanner` duration, not the real feedback duration. Bump to `5500 ms` (covers the long end of feedback turns) or remove the timeout entirely and rely on `response.done` as the only fallback — but a timeout safeguards against a stuck transcript handler. Settle on `5500 ms`.
3. **Re-tune the matcher threshold** with accumulated text in mind. Once the matcher sees the full running transcript (not chunks), the existing `hits ≥ 2 && coverage ≥ 50%` threshold is appropriate and doesn't need to change.
4. **Reset the accumulator on commit.** `commitPendingUiAdvance` should clear `pendingUiTranscriptAccum` so the next pending-advance window starts clean.

**Files to touch:** `App/src/services/sessionManager.ts` — the `registerEventHandlers` transcript branch and the pending-advance state machine.

**v2 fix attempt (2026-05-24, did NOT resolve):**

- Accumulated transcript deltas into `pendingUiTranscriptAccum`, passed to matcher instead of per-chunk text.
- Bumped `PENDING_UI_ADVANCE_TIMEOUT_MS` from 3500 → 5500 ms.
- Reset accumulator on arm + commit.
- Tests: 200/202 passing including new accumulation-across-chunks test.

**Symptom persists**: user reports the UI still flips ~1 s after the label, well before the tutor finishes feedback. With a 5500 ms timeout, that means the early commit is coming from the `transcript_match` path, not the timeout.

**Next hypotheses to investigate:**

1. **Each `outputTranscription` delta is actually CUMULATIVE on the wire (or our handler concatenates duplicates).** If Gemini sends "Good afternoon!" then "Good afternoon! Let's", and we naively concatenate, the accumulated string explodes with duplicated content and the matcher hits the threshold prematurely on bogus repeated tokens. Worth printing the raw `event.transcript` payloads for 10 consecutive deltas to confirm chunk-vs-cumulative semantics on this specific Gemini model.
2. **The matcher's `≥ 2 hits AND ≥ 50% coverage` threshold is too permissive on common tutor prefaces.** Feedback like "Correct! That was right. Now consider what defines …" can contain enough generic content words to match a 2-token short card front. Tighten to e.g. `≥ 3 hits AND ≥ 70% coverage`, with a minimum-significant-token-count guard.
3. **A different commit trigger is firing early.** `response.done` from a _previous_ turn could arrive after the new turn's `armPendingUiAdvance` and commit immediately. Worth instrumenting `commitPendingUiAdvance` to dump `reason` to logcat (already done) and reading the log to see which reason actually wins on a real card-grading.

**Suggested next attempt:** capture a single card-grading from logcat, including all `AI → transcript` lines + the `card advance committed` line, and identify (a) which reason wins (transcript_match / timeout / response_done / superseded), (b) the exact transcript string at the moment of match.

**Diagnostic logging to add before next attempt:**

- Log `pendingUiTranscriptAccum` (or its length) on every transcript event in verbose mode, so we can see how it grows.
- Log the matcher input (transcript + nextCardFront) immediately before the `commitPendingUiAdvance('transcript_match')` call.

**Update 2026-05-25 (sesión 5):** v2's hypothesis #1 ("deltas cumulative on the wire / accum doubles them") was **refuted** by `live-resilient-20260524-223012.log` — accum_len grows monotonically and additively, the accumulation logic is correct. The early-commit reason was actually **`timeout`** at 5500 ms — exactly the safeguard, not `transcript_match`. So the v2 fix's threshold concern was a red herring. Mitigation shipped in sesión 5: `PENDING_UI_ADVANCE_TIMEOUT_MS` bumped 5500 → **30000 ms** (defensive-only — under normal flow `response.done` or `transcript_match` always wins first). User reports this brought BUG 14 to "good enough, needs polish later"; root-cause work on the matcher's preface-tolerance is deferred.

---

### BUG 15 — Mid-session disconnect with code 1011 "Internal error encountered." from Gemini **[PARTIALLY MITIGATED 2026-06-24 — native session resumption now wired; recoverable-fallback UX still open]**

**Status:** Partially mitigated. Reporter: user, sesión 5 (2026-05-25). Observed once during testing on Aws Exam SA after ~1 m 45 s of session. The single-attempt reconnect succeeded at the transport level but the resume of the session context failed with the same error code, sending the app to the `error` phase. User had to manually end and restart.

**Mitigation (2026-06-24):** Native Gemini **session resumption** is now wired in `geminiManager`. Until now the "resume" was purely app-level — `resumeAfterReconnect` reconnected the transport and re-sent the system prompt plus a text "resume message"; it never sent a `sessionResumption` handle, so the server had no real context to restore (the root-cause note below predates the wiring and described the intended path, not the shipped one). The manager now opts in with `sessionResumption: {}` in the setup, caches the server's `sessionResumptionUpdate` handle, and replays it (`{ handle }`) in the reconnect setup so the server restores the actual conversation context. Paired with `contextWindowCompression` (which also removes the ~15-min cap that produces some of these terminations). This makes resumes succeed in the common transient-hiccup case. **Still open:** the UX items below (1–3) — `resume_failed` is still terminal in `sessionManager`, with no fresh-session fallback or extended resume retries.

**Symptom (verbatim):**

> At some point an error stopped my session. Before the error appeared it said "reconnecting".

**Evidence from `live-resilient-20260525-150637.log`:**

```
15:08:57.205  [sfx] played   quality=incorrect   ← user's 3rd answer of the session
15:08:57.913  ! [Gemini] WebSocket closed
              reason: "Internal error encountered."
15:08:57.915  ! connection dropped — starting reconnect flow
15:08:57.917  ↳ phase  evaluating → reconnecting  (connection_dropped)
15:08:57.918  [Gemini] reconnect attempt 1/3
15:08:59.957  [Gemini] WebSocket opened          ← reconnect succeeded at transport
15:09:00.134  [Gemini] reconnected on attempt 1
15:09:00.137  Resuming session after reconnect
15:09:01.085  ! [Gemini] WebSocket closed        ← Gemini closed us again ~1 s later
              reason: "Internal error encountered."
15:09:01.097  x failed to resume session after reconnect
              message: Gemini WebSocket closed while waiting for response: code=1011, reason=Internal error encountered.
15:09:01.106  ↳ phase  reconnecting → error  (resume_failed)
```

**Root cause:**

Gemini Live emitted WebSocket close code **1011** ("Server is terminating the connection because it encountered an unexpected condition that prevented it from fulfilling the request"). This is server-side. Our client did nothing wrong. The retry at the transport layer succeeded (Gemini accepted a new connection), but when we attempted to resume the session context (via `sessionResumption` handle) Gemini's backend hit the same error and dropped us again. The resume failure path then transitioned to `error` instead of starting reconnect attempt #2 — so we exhausted the recovery without ever trying a fresh session.

This class of disconnect appears to be transient on Gemini's side (consistent with model loading hiccups, internal load-balancer churn, or a server-side timeout on the audio stream). There is no client-side fix that prevents it.

**What we CAN do (UX improvements, not a root-cause fix):**

1. **Treat `resume_failed` as a recoverable case.** Today `reconnecting → error` is terminal; the user has to end + restart manually. Better: on resume failure, fall back to starting a fresh session with the same deck, replaying state from `useSessionStore` (`stats`, `totalDueAtStart`, currently-displayed card), so the user only loses the in-flight turn rather than the whole session. The tutor would receive a freshly-built system prompt with "you're mid-session, you've reviewed N cards, the current card is X" baked in. Implementation surface: `sessionManager.resumeSession` and the `error` transition handler.
2. **Better user-facing error message.** Today the user sees an opaque error toast. Replace with: "Tutor service had a hiccup. Your progress is saved — tap to continue with the next card." Single tap = the recovery in (1).
3. **Extend reconnect retries.** Currently we cap at 3 attempts and treat resume-failure as terminal. Allow 3 _resume_ attempts on top of the 3 _transport_ attempts, with exponential backoff (1 s, 3 s, 9 s). One server-side hiccup shouldn't end the session if a brief wait clears it.

**Out of scope / not a fix:**

- Switching to a different Gemini model. The model version is fixed by the app's prompt + tool contract; swapping is a separate decision.
- Implementing a server-side proxy that buffers messages during a Gemini reconnect. The token broker (P0 in `06-status.md` bloqueantes) doesn't address this — the WebSocket lives end-to-end client↔Gemini, not via our backend.

**Files involved:** `App/src/services/geminiManager.ts` (reconnect/resume logic), `App/src/services/sessionManager.ts` (resume flow + error transition).

**Diagnostic next step if this becomes frequent:** instrument `geminiManager` to log the exact bytes sent on the resume attempt, so we can confirm we're not mis-formatting the `sessionResumption` handle. Today we trust Gemini's "Internal error" verdict; a malformed resume payload could be misread by their server as an internal error.

---

### BUG 16 — Gemini WS 1007 "Unsupported language code" when starting a non-English deck **[FIXED 2026-05-25]**

**Status:** Fixed. Surfaced the moment we shipped the per-deck language picker. Reporter: user, sesión 5 (2026-05-25).

**Symptom:**

The session-error screen showed:

> Gemini WebSocket closed during setup: code=1007, reason=Unsupported language code 'es-ES' for model models/gemini-2.5-flash-native-audio-preview-12-2025

The WebSocket closed mid-setup before the first card was sent. WS code 1007 = "invalid frame payload data" per the WebSocket spec, but the human-readable `reason` makes the actual cause explicit: Gemini's server rejected the `speechConfig.languageCode` field for this specific model.

**Root cause:**

The native-audio preview model (`gemini-2.5-flash-native-audio-preview-12-2025`) is a single-stage audio-in / audio-out model. Per Google's published docs:

- `speechConfig.languageCode` is only valid on **half-cascade** models (where the response is generated as text and then sent through a separate TTS step — the TTS step needs an explicit language code).
- **Native-audio** models auto-detect the language from the system instruction text + the user's spoken audio. They do not expose a `languageCode` hook because the model itself decides moment-to-moment what to speak.

When sesión 5 shipped the per-deck language picker, `sessionManager.configureAISession` started forwarding the picked code into `geminiManager.updateSession({ languageCode })`, which embedded it in `speechConfig`. Gemini's server validated the field against the active model, found no support, and dropped the connection.

**Fix:**

`geminiManager.updateSession` accepts `languageCode` on its argument shape (callers don't have to special-case) but **does not forward it onto the wire**. `void config.languageCode;` is left in place as a deliberate "we consumed this on purpose" marker. Language is now steered entirely through the system prompt:

```
ROLE: You are an expert Anki Study Tutor. Language: ${languageLabel} ONLY — speak this language for the entire session, including the greeting, every question, every evaluation word, every feedback explanation, and the closing summary. Even if the user replies in another language, stay in ${languageLabel}.
```

The native-audio model honors this directive reliably. The per-deck picker still serves its purpose (it picks `languageLabel` via `languageLabelFromCode`).

**Trade-off (acceptable):**

- We lose the STT-side language hint that `speechConfig.languageCode` would have provided on a half-cascade model. In practice the native-audio model's auto-detection is robust as long as the system prompt is unambiguous (and ours is — "${languageLabel} ONLY" appears in the very first line and is reinforced through the greeting template).
- If we ever swap to a half-cascade model (different TTS quality / latency tradeoff), `languageCode` becomes valid again — re-enable the forwarding by removing the `void` line.

**Files touched:** `App/src/services/geminiManager.ts` (the `updateSession` setup payload). No other call sites change; the argument shape is preserved.

**See also:** `App/src/config/prompts.ts` (the `Language: X ONLY` directive + `LANGUAGE_LABELS` map), `(main)/deck-select.tsx` (the `LANGUAGE_OPTIONS` picker list), `useSettingsStore.deckLanguages` (persistence).

**Follow-up 2026-05-25 — prompt templates were English-locked:**

After the WS 1007 fix landed and a Catalan session ran cleanly end-to-end, the user reported the **closing summary** ("Great work! You reviewed N cards…") was spoken in English even though every prior turn was in Catalan. Root cause: rule 7 in the system prompt was a verbatim English quote ("`When no more cards OR user says end, say: "Great work! ..."`"). The model treated the quote as a script to recite rather than a content reference to translate. Rules 1 (greeting), 8 (read-back of correct/incorrect), and 9 (didn't-catch-that apology) had the same shape and were latent foot-guns waiting to surface on other decks.

Fix: rewrote those four rules so every English-language template is explicitly labeled as a "CONTENT REFERENCE — NOT a script to recite" and the rule requires the model to render the content in `${languageLabel}` instead. The `${languageLabel}` interpolation now appears in:

- Rule 1 START — greeting structure (salutation by time of day, deck name, count).
- Rule 7 SESSION END — closing summary structure (praise, total, correct/incorrect split, encouragement).
- Rule 8 READ BACK — "Correct!" / "Incorrect!" / "The correct answer is" framing words.
- Rule 9 NOISE — "I didn't catch that, let me repeat" apology.

Card answers (`answered_card_back`) and card fronts (`next_card.front`) stay in whatever language the deck content uses — they're read verbatim, never translated. The framing is what switches.

Verified the prompt structure compiles; on-device verification expected on the next Catalan session.

---

## 5. Proposed Design Change: Immediate Card Advance

**Current (fragile):**

```
tool result sent → pendingCardAdvance = true → wait for response.done in giving_feedback → advance
```

**Proposed (robust):**

```
tool result sent → advance immediately → AI gives feedback → AI reads next card
```

Code change in `handleEvaluateAndMoveNext` (after sending tool result):

```ts
// Advance immediately — don't wait for AI audio events
if (nextCard) {
  useSessionStore.getState().advanceCard();
  advanceCacheIndex();
  // pendingCardAdvance flag removed
} else {
  useSessionStore.getState().advanceCard();
  advanceCacheIndex();
  transitionTo("session_complete", "no_more_cards");
  await this.onSessionComplete();
}
```

And remove from `response.done` handler:

```ts
// REMOVE this block:
if (this.pendingCardAdvance) {
  this.pendingCardAdvance = false;
  useSessionStore.getState().advanceCard();
  advanceCacheIndex();
}
```

---

## 6. Testing Strategy: Why Tests Pass But App Breaks

**The core problem:** current tests mock `realtimeManager` entirely. They call `handleEvaluateAndMoveNext` directly and assert on `mockSendToolResult`, `mockAnswerCard`, etc. This tests the tool handler in isolation but NEVER tests:

1. The event chain: `toolCall msg → response.output_item.added → response.function_call_arguments.done → handleToolCall → handleEvaluateAndMoveNext`
2. The phase machine: whether `evaluating → giving_feedback → awaiting_answer` actually fires from real event sequences
3. The timing: whether `response.done` fires before or after `response.audio.delta` (which drives Bug 4)
4. Gemini's actual message format: whether the mock matches real Gemini WebSocket messages

**What needs to change:**

### Layer 2 — Integration tests with realistic event sequences

Instead of calling `handleEvaluateAndMoveNext` directly, emit realistic event sequences into `geminiManager`'s event bus and assert on the full outcome.

Add these fixtures:

```ts
// fixture: normalCard — the happy path
emit('response.output_item.added', { item: { type: 'function_call', call_id: 'c1', name: 'evaluate_and_move_next' }})
emit('response.function_call_arguments.done', { call_id: 'c1', arguments: '{"user_response_quality":"correct","feedback_text":"Right."}' })
// verify: toolResult sent, cardAdvanced, phase → evaluating
emit('response.audio.delta', {})
// verify: phase → giving_feedback
emit('response.done', {})
// verify: phase → awaiting_answer

// fixture: silentToolTurn — turnComplete fires before audio (Bug 4 root)
emit('response.output_item.added', ...)
emit('response.function_call_arguments.done', ...)
emit('response.done', {})  // no audio.delta first!
// verify: card was already advanced (proposed fix) — phase correctly moves on

// fixture: toolCallCancellation — Gemini cancels the tool call
emit('response.output_item.added', ...)
// 1500ms passes without response.function_call_arguments.done
// verify: timeout fires with skipped quality

// fixture: aiSpeaksBeforeToolCall (Bug 3)
emit('response.audio.delta', {}) // AI starts speaking — bad!
// verify: phase → giving_feedback (defensive)
// then: response.done fires — card never marked
// verify: evaluating-phase timeout triggers recovery
```

### Layer 3 — Gemini message format tests

Test `geminiManager.handleMessage()` directly with real-format JSON strings.

```ts
// Does a real toolCall message format emit the right events?
const realGeminiToolCallMsg = JSON.stringify({
  toolCall: {
    functionCalls: [
      {
        id: "fc_123",
        name: "evaluate_and_move_next",
        args: { user_response_quality: "correct", feedback_text: "ok" },
      },
    ],
  },
});
geminiManager.handleMessage(realGeminiToolCallMsg);
// assert: response.output_item.added fired with call_id 'fc_123'
// assert: response.function_call_arguments.done fired with correct args JSON

// Does empty turnComplete NOT trigger response.done when no audio preceded?
const emptyTurnComplete = JSON.stringify({
  serverContent: { turnComplete: true },
});
// assert: response.done fires (it does today — this is the bug)
// this test should FAIL now, drive the fix
```

---

## 7. Files to Touch for Each Fix

| Bug                   | File                                                            | Change                                                                                                                                                |
| --------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 (premature resolve) | `geminiManager.ts`                                              | Track whether current turn had audio; only emit `response.done` from non-empty turns, OR add flag to `waitForNextResponseDone`                        |
| 1 (initial message)   | `prompts.ts` `getInitialMessage()`                              | Make intent clearer: greet + ask in same turn, don't stop after greeting                                                                              |
| 2 (mic echo)          | `sessionManager.ts` `sendFirstCard`                             | Add 200ms delay after `waitForNextResponseDone` before `setMicrophoneMuted(false)`                                                                    |
| 3 (no tool call)      | `prompts.ts` system prompt rule 2                               | Strengthen: "EVERY evaluation MUST use the tool. No exceptions."                                                                                      |
| 3 (timeout)           | `sessionManager.ts` `registerEventHandlers`                     | Add 8s timer in `evaluating` phase; force `skipped` if expires                                                                                        |
| 4 (UI freeze)         | `sessionManager.ts` `handleEvaluateAndMoveNext`                 | Advance card immediately after `sendToolResult`; remove `pendingCardAdvance`                                                                          |
| 4 (UI freeze)         | `sessionManager.ts` `response.done` handler                     | Remove `pendingCardAdvance` branch; keep only phase transition                                                                                        |
| 5 ✅ shipped          | `AnkiDroidQueries.kt` `queryDueCards`                           | Pad code path removed. Returns scheduler head only.                                                                                                   |
| 5 ✅ shipped          | `useCardCacheStore.ts`                                          | New `pushCard(card)` — append, no dedupe (failed cards re-appear).                                                                                    |
| 5 ✅ shipped          | `cardLoader.ts`                                                 | New `fetchAndAppendNextCard(deckName)` — re-queries scheduler + pushCard.                                                                             |
| 5 ✅ shipped          | `sessionManager.ts` `handleEvaluateAndMoveNext`                 | `await answerCard` → `await fetchAndAppendNextCard` → send tool_result. Wrapped in `Promise.race` with 500 ms cap.                                    |
| 6 ✅ shipped          | `AudioTrackManager.kt`                                          | `@Volatile halted` flag; `writeChunk` early-returns when set; `flush`/`stop` set it; `init` clears it; `setHalted(value)` sync setter.                |
| 6 ✅ shipped          | `ExpoForegroundAudioModule.kt`                                  | `Function("haltAudioPlayer")` (sync, not AsyncFunction) so JS can flip the flag without queueing behind pending chunks.                               |
| 6 ✅ shipped          | `expo-foreground-audio/index.ts`                                | Added `haltAudioPlayer(halted: boolean): void` to the typed API.                                                                                      |
| 6 ✅ shipped          | `geminiManager.ts` `stopCurrentAudio`                           | Calls sync `haltAudioPlayer(true)` BEFORE async `flushAudioPlayer()`. Also keeps JS `playbackHalted` belt-and-suspenders.                             |
| 6 ✅ shipped          | `sessionManager.ts` `endSession` / `endSessionFromNotification` | Reordered: `stopCurrentAudio()` → `disconnect()` immediately, before remaining cleanup. Notification end now also calls `disconnect()` (was missing). |
| 7 ✅ shipped          | `AnkiDroidQueries.kt`                                           | Reverted to `null` projection. Superseded by BUG 5 v3b which removed the pad entirely → the BUG 7 code path is unreachable.                           |

---

### BUG 17 — Foreground notification reads "Card N of N" instead of "Card N of <deck total>" **[FIXED 2026-06-25]**

**Status:** Fixed. Deterministic — happened on every advance under the v3b architecture. Reporter: user, session 11 (2026-06-25). Same family as BUG 10 / BUG 11 (a `cache.length` leak), this time in the phone-call-style foreground notification.

**Symptom (verbatim):**

> The notification is not working properly since when a session is running it says card 1 of 1, then card 2 of 2 then card 3 of 3 and so on when you continue resolving flashcards but should be card 1 of 323 for example.

**Root cause:**

The per-advance notification update in `handleEvaluateAndMoveNext` sourced the total from `getTotalCardCount()`:

```ts
// App/src/services/sessionManager.ts (pre-fix)
const total = getTotalCardCount(); // cardLoader → useCardCacheStore.cards.length
const completed = stats.correct + stats.incorrect;
updateForegroundNotification(
  "Voice Study Session",
  `Card ${completed + 1} of ${total}`,
);
```

Under BUG 5 v3b (refill-from-scheduler) the cache only ever holds the cards loaded so far, so `cards.length === completed + 1` on every turn → the denominator tracked the numerator → "Card 1 of 1, Card 2 of 2, …". The same leak sat in the post-reconnect `resumeAfterReconnect` path, where the cache size was also fed to `configureAISession` (so a resumed session's AI prompt would have inherited the wrong count too).

Note the session-start notification (line ~306) was already correct — it used the local `dueAtStart` snapshot. Only the per-advance and resume paths leaked.

**Fix:**

Both sites now read the AnkiDroid due-count snapshot taken at `startSession` (`useSessionStore.totalDueAtStart`) — the same source the start notification and `remaining_cards` (BUG 10 v.A) already use. `getTotalCardCount` is no longer referenced in `sessionManager`; the import was dropped. This is the count-source rule in the Tutor Utterance Contract (§3a): the total must be `totalDueAtStart`, never `cache.length`.

**Files touched:** `App/src/services/sessionManager.ts` (per-advance notification + `resumeAfterReconnect`), `App/src/services/__tests__/sessionManager.test.ts` (regression test: notification body uses `totalDueAtStart` even when the cache size diverges).

**Verification:** Full Jest suite 429 passed. Verified live on the Pixel 9 by polling `dumpsys notification` through a scenario run — the body stepped `Card 1 of 10 → Card 7 of 10` with the denominator pinned at the deck total. Commit `bdf1190`.

---

## 8. Session Start Checklist (manual verification)

Run this against the real device/emulator after each change:

- [ ] WebSocket connects (no timeout in logs)
- [ ] `[Gemini] Setup complete` appears in logs
- [ ] `[Gemini] First AI response complete, enabling server_vad` appears
- [ ] Tutor says greeting AND reads first card in the SAME turn (no silence between)
- [ ] `[User]: <transcript>` appears in logs when user speaks
- [ ] `[SessionManager] Evaluation: correct/incorrect` appears immediately after user turn
- [ ] `[Gemini] Sending tool result for evaluate_and_move_next` appears
- [ ] UI advances to next card (cardIndex increments in store)
- [ ] Tutor gives feedback verbally AFTER tool result is sent
- [ ] Tutor reads NEXT card aloud (not the previous one again)
- [ ] On last card: tool result `next_card: null` → tutor says summary → session_complete phase
- [ ] AnkiDroid card status updated (check AnkiDroid due count decreased)
