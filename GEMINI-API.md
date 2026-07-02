# Gemini Live API — reference for Engram

> How the Gemini Live API works and exactly how this app uses it. Provider is **Gemini-only** (see `.claude/context/03-ai-providers.md`). All client wiring lives in `src/services/geminiManager.ts` (re-exported as `realtimeManager`).
>
> Docs verified against Google AI for Developers, June 2026. The model surface is in Preview and moves fast — re-check the official docs before relying on a field.

---

## 1. TL;DR — what Engram uses today

| Concern     | Engram's choice                                                                   | Where                      |
| ----------- | --------------------------------------------------------------------------------- | -------------------------- |
| API         | **Live API** (bidirectional WebSocket, `BidiGenerateContent`)                     | `geminiManager.ts`         |
| Model       | `gemini-2.5-flash-native-audio-preview-12-2025` (native audio)                    | `geminiManager.ts:7`       |
| Transport   | Raw `WebSocket` (no SDK)                                                          | `getWsUrl()`               |
| Auth        | API key in the WS query string (**in the APK** — P0 to fix, see §11)              | `getApiKey()`              |
| Audio in    | PCM 16 kHz mono → `realtimeInput.audio`                                           | `setupAudioDataListener()` |
| Audio out   | PCM 24 kHz → `serverContent.modelTurn.parts[].inlineData`                         | `handleMessage()`          |
| Voice       | `Kore`                                                                            | setup payload              |
| Modality    | `AUDIO` only (+ transcription)                                                    | setup payload              |
| Turn-taking | server VAD, tuned HIGH sensitivity                                                | `realtimeInputConfig`      |
| Tools       | 4 function declarations (`evaluate_and_move_next`, skip, override, `end_session`) | `src/config/prompts.ts`    |
| Language    | steered by the **prompt** ("Language: X ONLY"), not `languageCode`                | §10, BUG 16                |
| Resumption  | wired — handle cached + replayed on reconnect (shipped 2026-06-24)                | §9, §16, BUG 15            |

Session resumption + context-window compression are wired (shipped 2026-06-24, see §16). Ephemeral tokens are also wired (shipped 2026-07-01, see §11): `mintLiveToken` mints a single-use token server-side, so the raw API key no longer ships in a production APK.

---

## 2. What the Live API is

A stateful, low-latency **WebSocket** API for real-time voice/video conversations with Gemini. Unlike the request/response `generateContent` API, a Live session is a persistent socket: you stream audio in, the model streams audio out, and turn-taking happens server-side. One socket = one session.

**Endpoint (what Engram opens):**

```
wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=API_KEY
```

You can also use the official `@google/genai` SDK (`ai.live.connect({ model, config, callbacks })`), which wraps this socket. Engram deliberately uses the raw socket for control over the React Native audio path.

---

## 3. Models — native audio vs half-cascade

The Live API has **two model families**:

|             | **Native audio** (Engram)                                                                          | **Half-cascade**                                             |
| ----------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| How         | One model does speech→speech directly                                                              | LLM core + separate TTS                                      |
| Quality     | More natural pacing/voice/mood                                                                     | More robust tool-use, slightly more "TTS-like"               |
| Voices/lang | 30 voices, multilingual auto-switch                                                                | Same voice set, but `languageCode` is settable               |
| Extras      | Affective dialog, proactive audio                                                                  | —                                                            |
| Example IDs | `gemini-2.5-flash-native-audio-preview-12-2025`, stable alias `gemini-live-2.5-flash-native-audio` | `gemini-live-2.5-flash-preview`, `gemini-2.0-flash-live-001` |

**Engram's model — `gemini-2.5-flash-native-audio-preview-12-2025`:**

- Input limit **131,072 tokens**, output **8,192 tokens**
- Inputs: audio, video, text · Outputs: audio + text
- Knowledge cutoff **Jan 2025**
- Capabilities: function calling ✅, search grounding ✅, thinking ✅, audio gen ✅
- Not supported: caching, code execution, structured outputs, URL context, image gen
- **Preview** status (expect breaking changes; a newer `gemini-3.1-flash-live-preview` already exists as a future upgrade path)

**Why native audio matters for this project:** it auto-detects and switches language from the audio + system instruction. That's exactly why the per-deck language picker works through the prompt and why `speechConfig.languageCode` must NOT be sent (§10).

---

## 4. Session lifecycle & message types

```
client ──setup──────────────▶          (config: model, voice, tools, VAD, sysinstruction)
       ◀──setupComplete─────           session ready
client ──realtimeInput──────▶          (streamed PCM 16k audio chunks)
       ◀──serverContent─────           inputTranscription / outputTranscription / modelTurn.parts(audio) / turnComplete
       ◀──toolCall──────────           functionCalls[{id,name,args}]
client ──toolResponse───────▶          functionResponses[{id,name,response}]
       ◀──serverContent─────           turnComplete / interrupted / generationComplete
       ◀──goAway───────────            "closing soon" + timeLeft   (before forced disconnect)
```

**Server → client messages (the ones Engram maps):**

| Gemini message                               | Meaning                              | Engram maps it to              |
| -------------------------------------------- | ------------------------------------ | ------------------------------ |
| `setupComplete`                              | session configured                   | internal `session.updated`     |
| `serverContent.inputTranscription.text`      | user speech transcript               | drives `evaluating` transition |
| `serverContent.outputTranscription.text`     | tutor speech transcript              | UI-advance matcher             |
| `serverContent.modelTurn.parts[].inlineData` | output audio chunk (24 kHz)          | played via native AudioTrack   |
| `serverContent.turnComplete`                 | model finished its turn              | internal `response.done`       |
| `toolCall.functionCalls[]`                   | model invokes a tool                 | `evaluate_and_move_next` etc.  |
| `interrupted`                                | user barged in (VAD)                 | (available, stop playback)     |
| `generationComplete`                         | generation done (vs paused)          | (available)                    |
| `goAway`                                     | connection closing soon (`timeLeft`) | (not handled — see §9)         |
| `error`                                      | server error                         | logged + surfaced              |

> **Note on the codebase:** `geminiManager` translates these Gemini messages into **OpenAI-Realtime-style event names** (`response.audio.delta`, `input_audio_buffer.speech_started`, `conversation.item.input_audio_transcription.completed`, …) because `sessionManager` was first written against that event vocabulary. That internal naming is a compatibility shim, not a second provider.

---

## 5. The `setup` message (config) — full field reference

This is the first frame on the socket. Fields Engram sets are marked ✅.

```jsonc
{ "setup": {
  "model": "models/gemini-2.5-flash-native-audio-preview-12-2025",   // ✅
  "generationConfig": {
    "responseModalities": ["AUDIO"],                                  // ✅ (AUDIO or TEXT; one at a time)
    "speechConfig": {
      "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": "Kore" } }, // ✅
      "languageCode": "es-ES"        // ⛔ NOT sent on native audio (rejected, code 1007) — see §10
    },
    "temperature": 0.0,              // optional
    "thinkingConfig": { "thinkingLevel": "minimal", "includeThoughts": false } // optional (3.x)
  },
  "systemInstruction": { "parts": [{ "text": "..." }] },              // ✅ generated by prompts.ts
  "tools": [{ "functionDeclarations": [ ... ] }],                     // ✅ 4 tools
  "inputAudioTranscription": {},                                      // ✅ enable user transcript
  "outputAudioTranscription": {},                                     // ✅ enable tutor transcript
  "realtimeInputConfig": { "automaticActivityDetection": { ... } },   // ✅ VAD (see §8)
  "contextWindowCompression": { "slidingWindow": {} },               // ✅ used (see §16)
  "sessionResumption": {},                                           // ✅ used — handle replayed on reconnect (see §16)
  "proactivity": { "proactiveAudio": true },                          // ⛔ native-audio extra, v1alpha
  "enableAffectiveDialog": true                                       // ⛔ native-audio extra, v1alpha
}}
```

After `setup`, **most config is immutable** for the life of the socket. Engram's `updateSession()` is therefore a one-shot: it sends `setup` on first call and no-ops afterward.

---

## 6. Audio I/O

- **Input:** raw little-endian 16-bit PCM, **16 kHz**, mono. Sent as:
  ```json
  {
    "realtimeInput": {
      "audio": { "data": "<base64 PCM>", "mimeType": "audio/pcm;rate=16000" }
    }
  }
  ```
- **Output:** raw little-endian 16-bit PCM, always **24 kHz**. Arrives in `serverContent.modelTurn.parts[].inlineData.data` (base64), played through the `expo-foreground-audio` native AudioTrack.
- The model can be interrupted (barge-in): if the user speaks while the tutor talks, the server sends `interrupted` and you stop playback.

---

## 7. Voices & languages

- **30 prebuilt voices** (native audio shares the TTS voice set). Engram uses **Kore** (descriptor: _Firm_). Full set: Zephyr (Bright), Puck (Upbeat), Charon (Informative), Kore (Firm), Fenrir (Excitable), Leda (Youthful), Orus (Firm), Aoede (Breezy), Callirrhoe (Easy-going), Autonoe (Bright), Enceladus (Breathy), Iapetus (Clear), Umbriel (Easy-going), Algieba (Smooth), Despina (Smooth), Erinome (Clear), Algenib (Gravelly), Rasalgethi (Informative), Laomedeia (Upbeat), Achernar (Soft), Alnilam (Firm), Schedar (Even), Gacrux (Mature), Pulcherrima (Forward), Achird (Friendly), Zubenelgenubi (Casual), Vindemiatrix (Gentle), Sadachbia (Lively), Sadaltager (Knowledgeable), Sulafat (Warm). Change via `prebuiltVoiceConfig.voiceName`.
- **Languages:** native-audio output covers ~24+ languages with **automatic multilingual switching** (no config); the broader TTS/Live surface lists 65–70+. Because switching is automatic, Engram pins the target language through the system prompt (§10).

---

## 8. Voice Activity Detection (turn-taking)

Server-side VAD decides when the user's turn ends and the model should respond. Config lives in `realtimeInputConfig.automaticActivityDetection`:

| Field                      | Meaning                                                              | Engram                   |
| -------------------------- | -------------------------------------------------------------------- | ------------------------ |
| `disabled`                 | turn off auto VAD (then send `activityStart`/`activityEnd` manually) | `false`                  |
| `startOfSpeechSensitivity` | how eagerly speech start is detected                                 | `START_SENSITIVITY_HIGH` |
| `endOfSpeechSensitivity`   | how eagerly speech end is detected                                   | `END_SENSITIVITY_HIGH`   |
| `prefixPaddingMs`          | audio kept _before_ detected speech                                  | `300`                    |
| `silenceDurationMs`        | silence before the turn is committed                                 | `800`                    |

**Why Engram tuned it HIGH:** with defaults the model stalled for minutes after the user stopped talking (empty `turnComplete`, no `toolCall`) until a manual pause/resume mute-pulsed the mic. HIGH end-of-speech sensitivity + an 800 ms silence window makes Gemini commit the user turn promptly. (Docs suggest ≥500 ms; 800 ms is our safe value for noisy real-world use.)

Manual VAD (if ever needed): set `disabled: true` and frame turns yourself with `realtimeInput.activityStart {}` / `activityEnd {}`.

---

## 9. Session continuity — limits, resumption, compression

This is where Engram has headroom. Defaults and the relevant features:

- **Duration cap:** without compression an **audio-only session is capped at ~15 minutes**; the socket itself also times out around ~10 min. A long study session will hit this.
- **`goAway`:** the server warns before closing with a `timeLeft`. Engram doesn't handle it yet — handling it lets you resume gracefully instead of dropping mid-card.
- **Session resumption** (`sessionResumption`): pass `{}` in setup to opt in; the server periodically sends `sessionResumptionUpdate { newHandle, resumable }`. Store the latest `newHandle`; on reconnect send `sessionResumption: { handle: "<saved>" }` to **restore context** (handle valid ~2 h after termination). **This is the proper fix for BUG 15** (the 1011 mid-session drop where the resume used to fail — Engram reconnected the transport but lost session context). **Wired in `geminiManager` as of 2026-06-24** (see §16).
- **Context-window compression** (`contextWindowCompression: { slidingWindow: {}, triggerTokens: N }`): compresses old turns when the token threshold is hit, lifting the 15-min cap toward unlimited. The native-audio context window is **128k tokens**.

---

## 10. System instructions & the language gotcha

- `systemInstruction.parts[].text` is Engram's whole tutor contract (generated by `src/config/prompts.ts`): grading rules, turn structure, count-spoken-once, and the first line `Language: <label> ONLY`.
- **Do not send `speechConfig.languageCode` on the native-audio model.** It's a half-cascade-only field; the native-audio model rejects it at setup with WebSocket close **code 1007** (`Unsupported language code …`). The native-audio model honors the prompt's language directive instead. This is **BUG 16** — keep language steering in the prompt.

---

## 11. Authentication & the key problem

- **Shipped 2026-07-01 (token broker).** The app no longer ships the raw key in production. `mintLiveToken` (Cloud Function) mints a short-lived, single-use ephemeral token gated on an active trial/subscription; the client fetches it via `tokenService.getLiveCredential()` and opens the Live WS with `?access_token=<token.name>` on the **v1alpha** `BidiGenerateContentConstrained` method (the plain `BidiGenerateContent` rejects ephemeral tokens with 1008 "unregistered callers"). Dev bypass (payment gate off) still uses the raw key on v1beta `?key=`. Production config drops the key (`app.config.js` nulls `geminiApiKey` when `APP_MODE=production`). **Deploy steps:** `firebase functions:secrets:set GEMINI_API_KEY` then `firebase deploy --only functions`.
- **History:** the API key used to be read from `Constants.expoConfig.extra.geminiApiKey` and placed in the WS URL query string. It shipped inside the APK → anyone could extract it. (Was pre-launch blocker P0 #1/#2 in `ROADMAP.md`.)
- **Two fixes:**
  1. **GCP key restriction** (simplest): restrict the key to Android apps + package + release SHA-1 + Generative Language API only. Makes an extracted key useless off your signed app.
  2. **Ephemeral tokens** (proper, client-safe): a backend mints a short-lived token; the client opens the Live session with it instead of the real key.

**Ephemeral tokens (Live API only, `v1alpha`):**

```js
// backend (after verifying the user + trial/subscription)
const token = await client.authTokens.create({
  config: {
    uses: 1, // single session
    expireTime, // default ~30 min
    newSessionExpireTime, // window to START a session, ~1 min
    // NO liveConnectConstraints — see warning below.
  },
});
// client: use token.name where the API key would go
```

> **WARNING — do NOT set `liveConnectConstraints` (2026-07-01, root cause of
> the "tutor never advances" release bug).** When the token carries
> constraints (even model-only), `BidiGenerateContentConstrained` replaces
> the client's entire `setup` with the token's locked config: `tools`,
> `systemInstruction`, `inputAudioTranscription` and
> `outputAudioTranscription` are silently dropped. The model then has no
> tools (never calls `evaluate_and_move_next`, hallucinates next cards) and
> the app gets no transcription events (phase machine + BUG 12 UI advance
> die). Verified against the live API with the app's exact setup payload:
> constrained token → no toolCall + empty transcripts; unconstrained token →
> identical behavior to the raw-key path. Engram's setup is dynamic per
> session (deck prompt), so it must come from the client; the abuse controls
> are single-use + short expiry + the auth/trial gate in `mintLiveToken`.

This is the natural backend role for the existing single Cloud Function (`functions/src/index.ts`), alongside the trial/subscription check it already does.

---

## 12. Tools / function calling

- Declared in setup under `tools: [{ functionDeclarations: [{ name, description, parameters }] }]`. `parameters` is JSON-Schema-ish, but **types must be UPPERCASE** (`STRING`, `OBJECT`, …) — Engram's `convertSchemaTypes()` does this conversion.
- Model invokes a tool → `toolCall.functionCalls[]`, each `{ id, name, args }`.
- Client must reply (no auto-handling): `toolResponse.functionResponses[]`, each `{ id, name, response }`.
- **Async tools:** declare `behavior: "NON_BLOCKING"`; when responding add `scheduling`:
  - `INTERRUPT` — feed the result in immediately
  - `WHEN_IDLE` — wait for the current turn to finish
  - `SILENT` — record the result without nudging the model
- **Other tools:** Google Search grounding ✅ (`googleSearch`). Code execution and URL context are **not supported** on Live models.

Engram's 4 tools (`evaluate_and_move_next`, `skip`, `override`, `end_session`) drive the whole study loop; `evaluate_and_move_next` is the grading + advance path. The ~1 s tool-call timeout pressure (BUG 5/10) is why card refill is bounded — `NON_BLOCKING` + `scheduling: WHEN_IDLE` is a candidate redesign if that timing keeps biting.

---

## 13. Native-audio-only extras (optional, `v1alpha`)

- **Affective dialog** (`enableAffectiveDialog: true`): the tutor adapts tone to the user's expression/emotion. Could make feedback feel more human.
- **Proactive audio** (`proactivity: { proactiveAudio: true }`): the model may choose _not_ to respond to irrelevant input (e.g., background chatter) — useful for hands-free study in noisy places.
- **Thinking** (`thinkingConfig`): reasoning before answering; trades latency for accuracy on hard grading.

All three need the `v1alpha` API version on the socket.

---

## 14. Pricing & cost model

Native-audio Live API, paid tier (per 1M tokens; a **free tier exists** for dev):

|           | Input     | Output     |
| --------- | --------- | ---------- |
| Text      | $0.50     | $2.00      |
| **Audio** | **$3.00** | **$12.00** |

**Audio tokens dominate** — a voice session is mostly audio in + audio out, so cost ≈ audio rates, not text. This is exactly the "API cost per session" unknown flagged as the #1 economic risk in `docs/product-idea.md` / `MVP_validation_plan.md`; the audio-output rate ($12/1M) is the number to model against the $4.99/mo plan. Context-window compression (§9) also reduces resent-context tokens on long sessions.

---

## 15. Known gotchas (this project)

| Gotcha                             | Detail                                                                    | Ref         |
| ---------------------------------- | ------------------------------------------------------------------------- | ----------- |
| `languageCode` rejected            | Native-audio model closes with 1007; steer language via prompt            | BUG 16, §10 |
| VAD stalls on defaults             | Needs HIGH sensitivity + ~800 ms silence or turns never commit            | §8          |
| Mid-session 1011 close             | Server "Internal error"; resume currently fails → use `sessionResumption` | BUG 15, §9  |
| 15-min cap                         | Audio-only sessions die without `contextWindowCompression`                | §9          |
| Config is immutable post-setup     | Voice/tools/sysinstruction fixed once `setupComplete`                     | §5          |
| Tool param types must be UPPERCASE | `convertSchemaTypes()` handles it                                         | §12         |
| Key in the APK                     | Move to GCP-restricted key or ephemeral tokens before launch              | §11         |

---

## 16. Adoption assessment for Engram

All three "new" features are applicable. Priority by value vs effort:

| Feature                            | Fixes                                       | Effort                                                              | Verdict                                                                                 |
| ---------------------------------- | ------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `contextWindowCompression`         | 15-min audio-session cap (§9)               | **Low** — one setup field                                           | ✅ **Shipped** — `slidingWindow` in the setup payload                                   |
| `sessionResumption`                | BUG 15 mid-session 1011 drop (§9)           | Low–med — store `newHandle`, replay on reconnect in `geminiManager` | ✅ **Shipped** — handle cached from `sessionResumptionUpdate`, replayed on reconnect    |
| `goAway` handling                  | graceful close before a forced disconnect   | Low — read `timeLeft`, pre-empt with resumption                     | ✅ **Shipped** — logged + emits `ws.goAway`; reconnect resumes via the cached handle    |
| **Ephemeral tokens**               | API key shipped in the APK, P0 (§11)        | Med — Cloud Function mints the token, client connects with it       | **Adopt next** (security blocker — own task)                                            |
| `interrupted` handling             | tutor keeps talking when the user barges in | Low — stop playback on the event                                    | Nice-to-have                                                                            |
| Affective dialog / proactive audio | feedback warmth / noise robustness (§13)    | Low flag, but `v1alpha` + native-audio only                         | Experiment post-MVP                                                                     |
| Google Search grounding / thinking | —                                           | —                                                                   | **Skip** — deck-bound grading needs no search; thinking adds latency to a realtime loop |

**Shipped (2026-06-24):** `contextWindowCompression` (`slidingWindow`) + `sessionResumption` are now in the `setup` payload built by `geminiManager.updateSession()`. The resumption handle is cached from incoming `sessionResumptionUpdate` messages, replayed in the reconnect setup (gated on `isReconnecting` so a fresh session starts cold), and cleared on full disconnect. `goAway` is logged + surfaced as a `ws.goAway` event. Together this removes the 15-min cap and makes BUG 15 recoverable. Covered by `geminiManager.sessionResumption.test.ts`. **Still pending:** the token broker (ephemeral tokens) is the bigger, launch-blocking P0 and pairs with the existing Cloud Function — its own task.

## 17. Good practices (Live API)

- **Never ship the raw key.** Restrict it (GCP: Android + package + release SHA-1 + Generative Language API only) or move to ephemeral tokens. (§11)
- **Plan for disconnects.** Handle `goAway`, enable `sessionResumption`, and add `contextWindowCompression` for anything past a few minutes. (§9)
- **One response modality per session** — `AUDIO` _or_ `TEXT`, chosen at setup, not both.
- **Config is immutable after `setupComplete`** — reconnect to change voice/tools/instructions.
- **Native audio ≠ `languageCode`** — steer language via the system prompt; sending `speechConfig.languageCode` closes the socket (1007 / BUG 16).
- **Tune VAD** for the environment (HIGH sensitivity + ~800 ms silence here) and **handle `interrupted`** for natural barge-in.
- **Tools:** param types UPPERCASE; reply to every `toolCall` (no auto-handling); consider `NON_BLOCKING` + `scheduling` for slow tools (relevant to the BUG 5/10 ~1 s pressure).
- **Pin the model, expect churn** — it's Preview. Track the deprecation note and keep a fallback (stable `gemini-live-2.5-flash-native-audio`, or `gemini-3.1-flash-live-preview`).
- **Budget on audio tokens, not text** — audio output ($12/1M) dominates session cost. (§14)

## Sources

- [Live API overview](https://ai.google.dev/gemini-api/docs/live)
- [Live API capabilities guide](https://ai.google.dev/gemini-api/docs/live-guide)
- [Live API session management](https://ai.google.dev/gemini-api/docs/live-session)
- [Live API tool use](https://ai.google.dev/gemini-api/docs/live-tools)
- [Ephemeral tokens](https://ai.google.dev/gemini-api/docs/ephemeral-tokens)
- [Model: gemini-2.5-flash-native-audio-preview-12-2025](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-native-audio-preview-12-2025)
- [Speech generation / voices](https://ai.google.dev/gemini-api/docs/speech-generation)
- [Pricing](https://ai.google.dev/gemini-api/docs/pricing)
