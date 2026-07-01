import { PermissionsAndroid, Platform } from "react-native";
import { realtimeManager as webrtcManager } from "./realtimeManager";
import {
  loadDueCards,
  getCurrentCard,
  getNextCard,
  getRemainingCardCount,
  clearCards,
  peekNextCard,
  peekRemainingAfterAdvance,
  advanceCacheIndex,
  fetchAndAppendNextCard,
} from "./cardLoader";
import { useSessionStore } from "../stores/useSessionStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useConnectionStore } from "../stores/useConnectionStore";
import { ankiBridge } from "../native/ankiBridge";
import {
  getSystemPrompt,
  allTools,
  getInitialMessage,
  getResumeMessage,
  formatToolResult,
} from "../config/prompts";
import {
  startForegroundService,
  stopForegroundService,
  updateForegroundNotification,
  requestAudioFocus,
  clearAudioFocusPauseFlag,
  isServiceRunning,
} from "./foregroundAudioService";
import {
  startAudioLevelTracking,
  stopAudioLevelTracking,
} from "./audioLevelTracker";
import { AnalyticsEvents } from "./analytics";
import { sessionLog } from "./sessionDebugLogger";
import { sfxPlayer } from "./sfxPlayer";
import { transcriptIndicatesNextCard } from "./uiAdvanceMatcher";
import { useCardCacheStore } from "../stores/useCardCacheStore";
import { recordSession, type TrialStatus } from "./trialService";

/**
 * Session Manager - Orchestrates the study session
 */
class SessionManager {
  private toolCallNames: Map<string, string> = new Map();
  private connectionUnsubscribe: (() => void) | null = null;

  /**
   * Phase the session was in before a network-loss pause.
   * Used to decide whether to restore the phase on reconnection.
   */
  private phaseBeforeNetworkPause: string | null = null;

  /**
   * Recovery timer fired when the session has been stuck in `evaluating`
   * for too long without any AI audio arriving. Catches BUG 3/4
   * (Gemini emits ctrl tokens + turnComplete but no audio.delta, so the
   * phase machine never reaches `giving_feedback` → never recovers to
   * `awaiting_answer`). Without this, a single non-tool-calling turn
   * locks the session forever.
   */
  private evaluatingRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly EVALUATING_RECOVERY_TIMEOUT_MS = 8000;

  /**
   * Debounce timer for "user stopped speaking → evaluating". Gemini emits
   * `inputTranscription.text` chunks incrementally during the user's
   * utterance; the last chunk has no special marker. We treat 800ms of
   * silence after the latest chunk as "user truly done" and transition to
   * Evaluating, giving the UI immediate feedback while Gemini's inference
   * runs (1–3s) before the tool call lands.
   */
  private userDoneSpeakingTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly USER_DONE_DEBOUNCE_MS = 800;

  /**
   * AnkiDroid (note_id, card_ord) of the most recently evaluated card.
   * Captured at evaluate time because by the time the override tool fires,
   * currentCard already points at card N+1. Both pieces are needed for the
   * write-back update — see ankiBridge.answerCard.
   */
  private lastAnsweredCardId: number | null = null;
  private lastAnsweredCardOrd: number | null = null;

  /**
   * BUG 12 — UI advance is gated on three triggers:
   *   1. Gemini's outputTranscription transitions to the next card's question.
   *   2. PENDING_UI_ADVANCE_TIMEOUT_MS elapses (force-advance — matches
   *      EvaluationBanner duration so visuals stay in sync).
   *   3. response.done — the AI's whole turn finished without us matching;
   *      flush before next card grading.
   * `pendingUiNextCardFront` holds the next card's front text used by the
   * transcript matcher; `pendingUiTargetIndex` is the cache index the UI
   * should land on when committed (captured at arm time so a subsequent
   * eager advance for the *next* grading doesn't skip the previous card).
   * Both null means no pending advance. The data-layer `currentIndex` in
   * `useCardCacheStore` advances eagerly (BUG 4 liveness) — only the UI
   * pointer lags.
   */
  private pendingUiNextCardFront: string | null = null;
  private pendingUiTargetIndex: number | null = null;
  /**
   * Accumulated running transcript of the AI's current turn since the
   * pending advance was armed. Gemini emits `outputTranscription` as
   * per-chunk deltas (typically 1–3 words each), so matching a card front
   * against any single delta is hopeless — we have to accumulate. Reset
   * on arm + commit; appended on every transcript event. See SESSION-FLOW.md
   * §4.BUG 14.
   */
  private pendingUiTranscriptAccum: string = "";
  private pendingUiAdvanceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Timeout fallback for when the transcript matcher never crosses the
   * threshold AND `response.done` never arrives. Under normal flow the
   * commit fires from either the matcher (when the AI begins the next
   * question) or `response.done` (turn ends) — both happen well within
   * 30 s. This timeout exists only to prevent a wedged handler from
   * pinning the UI on a stale card forever. Earlier values (3500 / 5500)
   * fired during normal-length feedback turns and produced the BUG 14
   * "flips while tutor is still talking" symptom.
   */
  private static readonly PENDING_UI_ADVANCE_TIMEOUT_MS = 30000;

  /**
   * Start a new study session
   */
  async startSession(): Promise<void> {
    const { transitionTo, resetSession } = useSessionStore.getState();
    const { selectedDeck } = useSettingsStore.getState();

    if (!selectedDeck) {
      throw new Error("No deck selected");
    }

    sessionLog.banner(`Starting session — deck: "${selectedDeck}"`);

    // Reset session state
    resetSession();

    // Warm the SFX players so the first chime of the session doesn't pay
    // the audio-asset load cost. No-op on subsequent sessions.
    sfxPlayer.preload();

    try {
      // ── PRE-CHECK ── Mic permission ────────────────────────────────────────
      // Must run BEFORE connect() because geminiManager.connect() calls
      // startCapture() internally (step 3 of its setup). On Android ≥ 34, that
      // call needs RECORD_AUDIO already granted — asking for it here, before the
      // WebSocket opens, ensures the capture initialises correctly the first time.
      // Asking after connect() (the old position) left startCapture() running
      // without permission, producing an uninitialised mic stream that the later
      // unmute step could not recover.
      const hasMicPermission = await this.ensureMicPermission();
      if (!hasMicPermission) {
        throw Object.assign(
          new Error(
            "Microphone access is needed to study by voice. Tap Try Again and allow it, or enable it in Settings → Apps → Engram → Permissions.",
          ),
          { code: "missing_mic_permission" },
        );
      }

      // ── STEP 1 ── Connect WebSocket to Gemini ─────────────────────────────
      const connectionState = useConnectionStore.getState().connectionState;
      sessionLog.step(1, { deck: selectedDeck, prev_state: connectionState });
      if (connectionState !== "connected") {
        transitionTo("connecting", "startSession");
        await webrtcManager.connect();
      } else {
        sessionLog.info(
          "SessionManager",
          "WebSocket already connected — skipping connect()",
        );
      }
      sessionLog.stepDone(1, {
        state: useConnectionStore.getState().connectionState,
      });

      // ── STEP 1b ── Trial quota check (server-authoritative) ──────────────
      // The deck-select screen pre-checks trialStatus on focus, but there's
      // a TOCTOU window: the user could tap a deck right as the trial
      // expires. recordSession() atomically increments sessionCount AND
      // returns the post-increment status — the server is the source of
      // truth. If the trial was exhausted in the last few seconds, we
      // catch it here before doing any expensive work (cards, AI prompt).
      //
      // recordSession() is a no-op in dev (payment bypassed) and
      // best-effort on network errors (returns the unlocked shape), so a
      // transient blip doesn't block the session — the next checkTrialStatus
      // from deck-select will re-sync.
      sessionLog.step("1b", { waiting_for: "recordSession" });
      const trialAfterStart: TrialStatus = await recordSession();
      sessionLog.stepDone("1b", {
        subscriptionActive: trialAfterStart.subscriptionActive,
        daysRemaining: trialAfterStart.daysRemaining,
        sessionsRemaining: trialAfterStart.sessionsRemaining,
      });
      if (!trialAfterStart.isActive && !trialAfterStart.subscriptionActive) {
        // Server says trial expired between the deck-select pre-check and
        // here. Bail out before we touch the audio stack or load cards.
        sessionLog.warn(
          "SessionManager",
          "trial expired between deck-select and startSession",
        );
        // Disconnect what Step 1 just opened — the audio socket is open
        // but we don't want to leave the user on a connect-then-paywall
        // dead-end.
        try {
          webrtcManager.disconnect();
        } catch (_) {
          /* best-effort */
        }
        transitionTo("error", "trial_expired");
        AnalyticsEvents.paywallShown("trial_expired_at_start");
        const err: any = new Error("Trial expired");
        err.code = "trial_expired";
        throw err;
      }

      // ── STEP 2 ── Audio I/O + mic capture (muted) ─────────────────────────
      sessionLog.step(2);
      // Start RMS-based mic level tracking. Independent of mute —
      // we want the meter live even when sessionManager has muted
      // the send path so the user can see "is my mic delivering
      // audio at all?"
      startAudioLevelTracking();
      // Mute microphone during setup to prevent default server_vad
      // from picking up audio before our session config is applied.
      webrtcManager.setMicrophoneMuted(true);
      sessionLog.stepDone(2, { mic: "muted", level_tracker: "started" });

      // ── STEP 3 ── Load due cards from AnkiDroid ───────────────────────────
      sessionLog.step(3, { deck: selectedDeck });
      transitionTo("loading_cards", "startSession");
      const cards = await loadDueCards(selectedDeck);

      if (cards.length === 0) {
        sessionLog.stepFail(3, "no cards due for this deck");
        transitionTo("error", "no_cards");
        throw new Error("No cards due for review in this deck");
      }
      sessionLog.stepDone(3, {
        cards_loaded: cards.length,
        first_card_front: cards[0]?.front,
      });

      // Snapshot the deck's true due-card count for the session header AND
      // the tutor's initial greeting. The card cache only holds the scheduler
      // head + refills (BUG 5 v3b), so cards.length is a useless denominator
      // here — see SESSION-FLOW.md §4.BUG 11. AnkiDroid's getDeckInfo gives
      // us the honest "due today" count. Best-effort: if the call fails or
      // the deck isn't found, fall back to cards.length so the UI still
      // shows *something* and the session isn't blocked.
      let dueAtStart = cards.length;
      try {
        const deckInfos = await ankiBridge.getDeckInfo();
        const matched = deckInfos.find((d) => d.deckName === selectedDeck);
        dueAtStart = matched?.dueCount ?? cards.length;
        useSessionStore.getState().setTotalDueAtStart(dueAtStart);
        sessionLog.info("SessionManager", "totalDueAtStart snapshot", {
          deck: selectedDeck,
          due_today: dueAtStart,
          cache_size: cards.length,
        });
      } catch (err) {
        sessionLog.warn(
          "SessionManager",
          "getDeckInfo for due snapshot failed — falling back to cache size",
          {
            error: String(err),
          },
        );
        useSessionStore.getState().setTotalDueAtStart(cards.length);
      }

      // ── STEP 4 ── Configure AI session ────────────────────────────────────
      // Pass the AnkiDroid due-count (dueAtStart), NOT cards.length: the
      // system prompt's "You have N cards to review" line goes into the
      // tutor's greeting, and cards.length is always 1 under the v3b cache.
      // That's how BUG 10's "tutor says you have 1 card" symptom landed
      // even though we'd already fixed remaining_cards in the tool result.
      sessionLog.step(4, {
        cards: dueAtStart,
        vad: "disabled (until first reply)",
      });
      transitionTo("ready", "cards_loaded");
      await this.configureAISession(selectedDeck, dueAtStart);
      sessionLog.stepDone(4, { setup: "acknowledged" });

      // Register event handlers + connection-loss machinery
      this.registerEventHandlers();
      this.installConnectionDropHandler();
      this.subscribeToConnectionState();

      // Notifications power the phone-call-style in-session banner (pause/end
      // when minimized). Best-effort: request once, never block the session on
      // the outcome — a denied notification only costs the background banner.
      await this.ensureNotificationsPermission();

      // Start foreground service NOW — before sendFirstCard. The phone-call-style
      // notification needs to be live the moment the user commits to a session, not
      // gated on the AI's first response completing. Previously this ran as the last
      // step (after sendFirstCard's waitForNextResponseDone): if the WebSocket
      // dropped during that wait, auto-reconnect kicked in and the service never
      // started — user saw a session running with no notification when minimized.
      try {
        await startForegroundService(
          "Voice Study Session",
          `Card 1 of ${dueAtStart}`,
        );
        sessionLog.info("SessionManager", "foreground service started");
      } catch (fgError) {
        sessionLog.warn(
          "SessionManager",
          "foreground service failed (non-fatal)",
          { error: String(fgError) },
        );
      }

      // ── STEP 5+6 ── Send first card → wait for first response ─────────────
      const firstCard = getCurrentCard();
      if (firstCard) {
        await this.sendFirstCard(firstCard.front, firstCard.back);
        // The AI has finished its first response (greeting + question).
        // Go straight to awaiting_answer since the question was already asked.
        transitionTo("awaiting_answer", "first_card_sent");
      }

      // ── STEP 7 ── Unmute microphone (study loop active) ───────────────────
      sessionLog.step(7);
      webrtcManager.setMicrophoneMuted(false);
      sessionLog.stepDone(7, { mic: "live", vad: "server_vad@0.6" });

      // Track session start
      AnalyticsEvents.sessionStarted(selectedDeck, cards.length);
    } catch (error: any) {
      sessionLog.error("SessionManager", "startSession failed", {
        message: error?.message,
      });
      AnalyticsEvents.sessionError(error?.message || "start_failed");
      stopAudioLevelTracking();
      transitionTo("error", "start_failed");
      throw error;
    }
  }

  /**
   * Ensure RECORD_AUDIO. Returns true if already granted, otherwise fires the
   * standard Android permission popup and returns the user's decision. Never
   * throws — caller decides what to do with a denial.
   */
  private async ensureMicPermission(): Promise<boolean> {
    if (Platform.OS !== "android") return true;
    const already = await PermissionsAndroid.check(
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    );
    if (already) return true;
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      {
        title: "Microphone access",
        message:
          "Engram needs your microphone to hear your spoken answers during a voice study session.",
        buttonPositive: "Allow",
        buttonNegative: "Not now",
      },
    );
    return result === PermissionsAndroid.RESULTS.GRANTED;
  }

  /**
   * Best-effort POST_NOTIFICATIONS request (Android 13+). Powers the
   * in-session pause/end banner when the app is backgrounded. Never blocks
   * the session — a denial only costs the background banner.
   */
  private async ensureNotificationsPermission(): Promise<void> {
    if (Platform.OS !== "android") return;
    if (typeof Platform.Version === "number" && Platform.Version < 33) return;
    try {
      const already = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      );
      if (already) return;
      await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
        {
          title: "Notifications",
          message:
            "Engram shows a phone-call-style banner during a session so you can pause or end it from anywhere.",
          buttonPositive: "Allow",
          buttonNegative: "Not now",
        },
      );
    } catch {
      /* best-effort — ignore */
    }
  }

  /**
   * Configure AI session with system prompt and tools.
   * Deliberately starts with turn_detection DISABLED (null) so that
   * server_vad cannot race with our initial card message.
   * Waits for the server to acknowledge the update before resolving.
   */
  private async configureAISession(
    deckName: string,
    cardCount: number,
  ): Promise<void> {
    const { deckReadBack, deckInstructions, deckLanguages } =
      useSettingsStore.getState();
    // Read-back is a per-deck setting (configured in the deck-settings sheet).
    // Decks without an entry fall back to false (read-back on incorrect only).
    const alwaysReadBack = deckReadBack[deckName] ?? false;
    const customInstructions = deckInstructions[deckName] || undefined;
    // Per-deck language: drives both the system prompt's "Language: X ONLY"
    // line and Gemini Live's speechConfig.languageCode (TTS voice + tighter
    // recognition). Undefined → English fallback inside getSystemPrompt and
    // server default for speechConfig.
    const languageCode = deckLanguages[deckName] || undefined;
    const systemPrompt = getSystemPrompt(
      deckName,
      cardCount,
      alwaysReadBack,
      customInstructions,
      languageCode,
    );

    await webrtcManager.updateSession({
      instructions: systemPrompt,
      tools: allTools,
      modalities: ["text", "audio"],
      turn_detection: null, // Disabled until first AI response completes
      languageCode,
    });
  }

  /**
   * Send first card to AI and wait for the AI's first response to complete.
   * Only after the response finishes do we enable server_vad for voice interaction.
   */
  private async sendFirstCard(front: string, back: string): Promise<void> {
    const message = getInitialMessage(front, back);

    sessionLog.step(5, { front, back, message_len: message.length });
    sessionLog.debug("SessionManager", "initial message body", { message });

    // Send the card as a user message and request a response
    webrtcManager.sendTextMessage(message);
    sessionLog.stepDone(5, { sent: "clientContent[user] + turnComplete" });

    // Wait for the AI to finish its first response before enabling VAD.
    // This guarantees the AI has processed the card content in its context.
    sessionLog.step(6, { waiting_for: "response.done" });
    await webrtcManager.waitForNextResponseDone();
    sessionLog.stepDone(6, { result: "AI first turn complete" });

    // Clear any buffered audio from the manual-mode phase before enabling VAD
    webrtcManager.sendEvent({ type: "input_audio_buffer.clear" });

    // NOW enable server_vad for ongoing voice interaction
    // Threshold 0.6 (above default 0.5) to reduce false triggers from ambient noise
    await webrtcManager.updateSession({
      turn_detection: {
        type: "server_vad",
        threshold: 0.6,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
      },
    });
    sessionLog.info("SessionManager", "server_vad enabled");
    sessionLog.debug("SessionManager", "audio track state — after vad enable");
    await webrtcManager.debugAudioTrackState("after-vad-enabled");
    if (sessionLog.isVerbose()) {
      setTimeout(
        () => webrtcManager.debugAudioTrackState("5s-after-vad"),
        5000,
      );
    }
  }

  /**
   * Register WebRTC event handlers
   */
  private registerEventHandlers(): void {
    const { transitionTo } = useSessionStore.getState();

    // Handle tool calls
    webrtcManager.on(
      "response.function_call_arguments.done",
      this.handleToolCall.bind(this),
    );

    // Handle AI speaking (giving feedback). Audio.delta is the first real
    // signal that the AI is *actually* speaking (not just emitting control
    // tokens). It also cancels the evaluating-recovery timer.
    webrtcManager.on("response.audio.delta", () => {
      const phase = useSessionStore.getState().phase;
      if (phase === "evaluating") {
        this.clearEvaluatingRecovery();
        useSessionStore
          .getState()
          .transitionTo("giving_feedback", "ai_speaking");
      }
    });

    // Handle AI finished speaking. The card index is advanced eagerly in
    // `handleEvaluateAndMoveNext` (right after sendToolResult) so the UI
    // can never end up stuck on a stale card — see SESSION-FLOW.md
    // §4.BUG 4. This handler is responsible only for the phase transition.
    //
    // Three cases:
    //   1. Tool-call turn (silent) → response.done in `evaluating`. Do
    //      nothing — wait for the AI's feedback turn that follows.
    //   2. Feedback turn (audio) → response.done in `giving_feedback`.
    //      Transition back to `awaiting_answer`.
    //   3. Recovery: turn ended in `evaluating` WITHOUT preceding audio
    //      (Gemini emitted only control tokens, BUG 3 shape). The
    //      recovery timer handles forcing us out — we don't act here.
    webrtcManager.on("response.done", () => {
      // BUG 12 fallback: if a UI advance is still pending, the AI's whole
      // turn finished without the transcript ever crossing the next-card
      // threshold (and the 3.5 s timer hasn't fired yet — rare, only on
      // very short feedback turns). Flush now so the next grading cycle
      // doesn't start with stale UI.
      this.commitPendingUiAdvance("response_done");
      const phase = useSessionStore.getState().phase;
      if (phase === "giving_feedback") {
        useSessionStore.getState().transitionTo("awaiting_answer", "ai_done");
      }
    });

    // Handle user speaking (logging only — debounce cancel is below).
    webrtcManager.on("input_audio_buffer.speech_started", () => {
      const phase = useSessionStore.getState().phase;
      if (phase === "awaiting_answer") {
        sessionLog.event("mic", "user speech started");
      }
    });

    // Handle AI transcripts. The event name is historical — these are
    // incremental DELTAS streamed by Gemini's outputTranscription, NOT
    // end-of-turn snapshots and NOT cumulative-so-far. Each delta is
    // typically 1–3 words. We use them for two things:
    //   1. Debug log of what the AI is saying (per-chunk — fine).
    //   2. BUG 14 fix — accumulate the deltas into a running transcript
    //      and match the running text against the next card's front. A
    //      per-chunk match is impossible (1 word can't satisfy the
    //      2-hit threshold) so this accumulation step is load-bearing.
    webrtcManager.on("response.audio_transcript.done", (event: any) => {
      const chunk =
        typeof event.transcript === "string" ? event.transcript : "";
      sessionLog.event("AI", "transcript", { text: chunk });
      if (!this.pendingUiNextCardFront) return;
      this.pendingUiTranscriptAccum = (
        this.pendingUiTranscriptAccum +
        " " +
        chunk
      ).trim();
      sessionLog.event("AI", "transcript accum", {
        accum_len: this.pendingUiTranscriptAccum.length,
        accum: this.pendingUiTranscriptAccum,
      });
      if (
        transcriptIndicatesNextCard(
          this.pendingUiTranscriptAccum,
          this.pendingUiNextCardFront,
        )
      ) {
        sessionLog.event("UI", "transcript_match firing", {
          accum: this.pendingUiTranscriptAccum,
          next_card_front: this.pendingUiNextCardFront,
        });
        this.commitPendingUiAdvance("transcript_match");
      }
    });

    // Handle user transcripts. Gemini streams `inputTranscription.text`
    // chunks as the user speaks; the final chunk has no marker. Schedule
    // a debounced transition to Evaluating — if no new chunk arrives
    // within USER_DONE_DEBOUNCE_MS, we treat the user as done. This shows
    // the Evaluating state during Gemini's inference window instead of
    // waiting for the tool call (which can be 1–3s later).
    webrtcManager.on(
      "conversation.item.input_audio_transcription.completed",
      (event: any) => {
        sessionLog.event("user", "transcript", { text: event.transcript });
        const phase = useSessionStore.getState().phase;
        if (phase !== "awaiting_answer") return;
        if (this.userDoneSpeakingTimer)
          clearTimeout(this.userDoneSpeakingTimer);
        this.userDoneSpeakingTimer = setTimeout(() => {
          this.userDoneSpeakingTimer = null;
          if (useSessionStore.getState().phase !== "awaiting_answer") return;
          useSessionStore
            .getState()
            .transitionTo("evaluating", "user_done_debounced");
          this.startEvaluatingRecovery();
        }, SessionManager.USER_DONE_DEBOUNCE_MS);
      },
    );

    // Cancel debounce if user starts speaking again (new utterance begins).
    webrtcManager.on("input_audio_buffer.speech_started", () => {
      if (this.userDoneSpeakingTimer) {
        clearTimeout(this.userDoneSpeakingTimer);
        this.userDoneSpeakingTimer = null;
      }
    });

    // Track tool call names
    webrtcManager.on("response.output_item.added", (event: any) => {
      const item = event.item;
      if (item?.type === "function_call") {
        this.toolCallNames.set(item.call_id, item.name);
      }
    });
  }

  /**
   * Subscribe to the connection store so the session reacts to network loss.
   */
  private subscribeToConnectionState(): void {
    // Unsubscribe any previous listener (safety)
    this.unsubscribeFromConnectionState();

    this.connectionUnsubscribe = useConnectionStore.subscribe(
      (state, prevState) => {
        const { connectionState } = state;
        const prevConnectionState = prevState.connectionState;

        // Skip if state hasn't actually changed
        if (connectionState === prevConnectionState) return;

        const { phase } = useSessionStore.getState();
        const { transitionTo } = useSessionStore.getState();

        // --- Connection lost ---
        // The onConnectionDropped handler manages full reconnect flow.
        // This subscriber handles the intermediate state where ICE briefly
        // goes to 'reconnecting' but may self-recover without needing a
        // full reconnect. If the phase is already 'reconnecting', the
        // drop handler is managing the flow — don't interfere.
        if (
          connectionState === "reconnecting" ||
          connectionState === "failed"
        ) {
          const activePhases = [
            "asking_question",
            "awaiting_answer",
            "evaluating",
            "giving_feedback",
            "advancing",
            "ready",
          ];
          if (activePhases.includes(phase)) {
            sessionLog.warn(
              "SessionManager",
              "connection state changed — muting mic",
              { to: connectionState },
            );
            this.phaseBeforeNetworkPause = phase;
            webrtcManager.setMicrophoneMuted(true);
            // Don't transition to paused here — let onConnectionDropped
            // handle the transition to 'reconnecting' phase.
          }
        }

        // --- Connection restored (ICE self-recovery) ---
        // ICE can transition back to 'connected' after a brief 'disconnected'
        // without needing a full reconnect. In that case the session phase
        // will still be in a network-paused state with phaseBeforeNetworkPause set.
        if (
          connectionState === "connected" &&
          (prevConnectionState === "reconnecting" ||
            prevConnectionState === "failed")
        ) {
          if (
            this.phaseBeforeNetworkPause &&
            (phase === "paused" || phase === "reconnecting")
          ) {
            // If phase is 'reconnecting', the resumeAfterReconnect flow
            // will handle restoration — don't interfere.
            if (phase === "paused") {
              sessionLog.info(
                "SessionManager",
                "ICE self-recovered — resuming session",
              );
              webrtcManager.setMicrophoneMuted(false);
              transitionTo(
                this.phaseBeforeNetworkPause as any,
                "connection_restored",
              );
              this.phaseBeforeNetworkPause = null;
            }
          }
        }
      },
    );
  }

  /**
   * Unsubscribe from connection state changes.
   */
  private unsubscribeFromConnectionState(): void {
    if (this.connectionUnsubscribe) {
      this.connectionUnsubscribe();
      this.connectionUnsubscribe = null;
    }
  }

  /**
   * Install a callback on webrtcManager that fires when the connection
   * drops mid-session. This triggers the full reconnect + resume flow.
   */
  private installConnectionDropHandler(): void {
    webrtcManager.onConnectionDropped = () => {
      const phase = useSessionStore.getState().phase;

      // Only attempt reconnect if we are in an active study phase
      const activePhases = [
        "asking_question",
        "awaiting_answer",
        "evaluating",
        "giving_feedback",
        "advancing",
        "ready",
        "paused",
      ];
      if (!activePhases.includes(phase)) return;

      sessionLog.warn(
        "SessionManager",
        "connection dropped — starting reconnect flow",
        { phase },
      );

      // Save the phase so we can restore it later
      if (phase !== "paused") {
        this.phaseBeforeNetworkPause = phase;
      }

      const { transitionTo } = useSessionStore.getState();
      webrtcManager.setMicrophoneMuted(true);
      transitionTo("reconnecting", "connection_dropped");

      // Kick off reconnect asynchronously
      this.attemptReconnectAndResume();
    };
  }

  /**
   * Attempt to reconnect the WebRTC connection and, on success,
   * resume the AI session from the current card position.
   */
  private async attemptReconnectAndResume(): Promise<void> {
    const { transitionTo } = useSessionStore.getState();

    const success = await webrtcManager.reconnect();

    if (success) {
      try {
        await this.resumeAfterReconnect();
        AnalyticsEvents.sessionReconnected(
          useConnectionStore.getState().reconnectAttempts,
        );
      } catch (error) {
        sessionLog.error(
          "SessionManager",
          "failed to resume session after reconnect",
          { message: (error as any)?.message },
        );
        transitionTo("error", "resume_failed");
      }
    } else {
      sessionLog.error(
        "SessionManager",
        "reconnect failed — transitioning to error",
      );
      transitionTo("error", "reconnect_failed");
    }
  }

  /**
   * Resume the AI session after a successful reconnect.
   * Re-configures the new AI session with the system prompt, tools,
   * and the current card so the user can continue where they left off.
   * Card cache and session stats are still in memory — only the AI
   * context needs to be re-established.
   */
  private async resumeAfterReconnect(): Promise<void> {
    const { transitionTo } = useSessionStore.getState();
    const { selectedDeck } = useSettingsStore.getState();

    if (!selectedDeck) {
      throw new Error("No deck selected for resume");
    }

    sessionLog.banner("Resuming session after reconnect");

    // 1. Re-configure AI session (system prompt + tools).
    // Use the totalDueAtStart snapshot, NOT getTotalCardCount() (cache size) —
    // startSession passes dueAtStart here too, and under refill-from-scheduler
    // the cache size is meaningless as a deck total. Keeps the resumed prompt
    // and notification count consistent with the original session.
    const totalCards = useSessionStore.getState().totalDueAtStart;
    await this.configureAISession(selectedDeck, totalCards);

    // 1a. Defensive: start the foreground notification if it didn't get to run
    // during the original startSession (e.g. WebSocket dropped while we were
    // waiting on the AI's first response). startForegroundService is idempotent
    // for an already-running service — the underlying ACTION_START intent just
    // updates the existing notification.
    if (!isServiceRunning()) {
      try {
        const completedSoFar =
          useSessionStore.getState().stats.correct +
          useSessionStore.getState().stats.incorrect;
        await startForegroundService(
          "Voice Study Session",
          `Card ${completedSoFar + 1} of ${totalCards}`,
        );
      } catch (fgError) {
        sessionLog.warn(
          "SessionManager",
          "failed to start foreground service on resume",
          { error: String(fgError) },
        );
      }
    }

    // 3. Re-register event handlers (they were preserved during reconnect
    //    via cleanupConnection, but the new data channel dispatches fresh
    //    events so the handlers are still valid)
    // Note: event handlers are preserved across reconnect — no need to
    // re-register them since cleanupConnection() keeps them intact.

    // 4. Send the current card to the new AI session as a resume message
    const currentCard = getCurrentCard();
    if (currentCard) {
      const remainingCards = getRemainingCardCount();
      const stats = useSessionStore.getState().stats;
      const resumeMsg = getResumeMessage(
        currentCard.front,
        currentCard.back,
        remainingCards,
        stats,
      );

      sessionLog.info("SessionManager", "sending resume message to AI", {
        remaining: remainingCards,
        stats,
      });
      webrtcManager.sendTextMessage(resumeMsg);

      // Wait for AI to finish its resume response
      await webrtcManager.waitForNextResponseDone();

      sessionLog.info(
        "SessionManager",
        "AI resume response complete — enabling server_vad",
      );

      // Clear buffered audio and enable server_vad
      webrtcManager.sendEvent({ type: "input_audio_buffer.clear" });
      await webrtcManager.updateSession({
        turn_detection: { type: "server_vad" },
      });
    }

    // 5. Transition back to active phase
    const restorePhase = this.phaseBeforeNetworkPause || "awaiting_answer";
    transitionTo(restorePhase as any, "reconnect_resumed");
    this.phaseBeforeNetworkPause = null;

    sessionLog.info("SessionManager", "session resumed", {
      phase: restorePhase,
    });
  }

  /**
   * Handle tool call from AI
   */
  private async handleToolCall(event: any): Promise<void> {
    const { call_id, arguments: argsStr } = event;
    const toolName = this.toolCallNames.get(call_id);

    try {
      const args = JSON.parse(argsStr || "{}");

      switch (toolName) {
        case "evaluate_and_move_next":
          await this.handleEvaluateAndMoveNext(call_id, args);
          break;
        case "override_evaluation":
          await this.handleOverrideEvaluation(call_id, args);
          break;
        case "end_session":
          await this.handleEndSessionTool(call_id);
          break;
        default:
          sessionLog.warn("SessionManager", "unknown tool", {
            name: toolName,
            call_id,
          });
      }
    } catch (error: any) {
      sessionLog.error("SessionManager", "tool call handler threw", {
        message: error?.message,
      });
    }
  }

  /**
   * Handle evaluate_and_move_next tool
   */
  private async handleEvaluateAndMoveNext(
    callId: string,
    args: any,
  ): Promise<void> {
    const { user_response_quality, feedback_text } = args;
    sessionLog.event("tool_call", "evaluate_and_move_next", {
      quality: user_response_quality,
      feedback: feedback_text,
      call_id: callId,
    });

    const { transitionTo, recordAnswer } = useSessionStore.getState();

    // Get current card's back for feedback
    const currentCard = getCurrentCard();
    const answeredCardBack = currentCard?.back || null;
    const answeredCardId = currentCard?.cardId ?? null;
    const answeredCardOrd = currentCard?.cardOrd ?? null;

    // BUG 5 v3b: answerCard + refill-from-scheduler.
    //
    // Old design (fire-and-forget): kicked off answerCard async and read
    // the next card from a pre-loaded cache. The cache came from a
    // padded-up-front query whose ordering was wrong (slot[1] always the
    // deck's oldest-added card — SESSION-FLOW.md BUG 5). Multiple attempts
    // to coax `due`-ordered results from AnkiDroid's cards URI failed.
    //
    // New design: await answerCard, then re-query the scheduler URI to
    // get the next head card. Always-correct ordering with no dependency
    // on `due` being exposed.
    //
    // Timeout: 500 ms cap on the answer + refill chain protects against
    // the original concern (a slow AnkiDroid update would block past
    // Gemini Live's ~1 s tool-call timeout and trigger
    // toolCallCancellation). On timeout we still send the tool_result —
    // the refill may return the same noteId (AnkiDroid hadn't reshuffled
    // yet, user sees the same card briefly), but the session does not
    // lock up.
    // BUG 10 (skip-path variant): the write-back + refill below MUST run for a
    // skipped card too. Previously this whole block was guarded by
    // `user_response_quality !== "skipped"`, so on a skip `fetchAndAppendNextCard`
    // never ran. With the BUG 5 v3b refill-from-scheduler cache (current card +
    // at most a 1-card lookahead), `peekNextCard()` then returned undefined →
    // the tool result carried `next_card: null` → the session falsely declared
    // `no_more_cards` and ended, even with cards still due. Reproduced on-device
    // 2026-06-25 (refold-english-mixed: session ended on the card-3 skip while
    // `remaining: 8`).
    //
    // A skip now advances exactly like a graded answer; it only differs in that
    // it does not touch the correct/incorrect stats or play the feedback chime.
    const isSkip = user_response_quality === "skipped";
    if (!isSkip) {
      recordAnswer(user_response_quality as "correct" | "incorrect");
      // Fire the SFX in the same tick as recordAnswer — that's the action
      // that flips `lastEvaluation`, which makes the on-screen banner
      // appear. The chime lands with the banner and fills the silent gap
      // before the tutor's spoken feedback starts (~1–2 s later).
      sfxPlayer.play(user_response_quality as "correct" | "incorrect");
    }
    transitionTo("evaluating", "tool_called");

    const { selectedDeck: deckForAnswer } = useSettingsStore.getState();
    if (answeredCardId != null && answeredCardOrd != null && deckForAnswer) {
      this.lastAnsweredCardId = answeredCardId;
      this.lastAnsweredCardOrd = answeredCardOrd;
      // A skip still has to advance the AnkiDroid scheduler head, otherwise the
      // re-query inside fetchAndAppendNextCard returns the SAME card (the head
      // only moves once a card is answered or buried) and the session loops on
      // it. The anki-droid module exposes no bury API, so a skip is written back
      // as "Again" (ease=1, i.e. pass=false): it is NOT counted into the
      // correct/incorrect stats, but it is rescheduled to reappear later — the
      // right behaviour for "I don't know this one, move on".
      const pass = user_response_quality === "correct";
      sessionLog.event("AnkiDroid", "write-back + refill", {
        cardId: answeredCardId,
        ord: answeredCardOrd,
        pass,
        skip: isSkip,
      });
      const ANSWER_REFILL_TIMEOUT_MS = 500;
      await Promise.race([
        (async () => {
          try {
            await ankiBridge.answerCard(
              deckForAnswer,
              answeredCardId,
              answeredCardOrd,
              pass,
            );
          } catch (err) {
            sessionLog.warn("AnkiDroid", "write-back error (non-fatal)", {
              error: String(err),
            });
          }
          await fetchAndAppendNextCard(deckForAnswer);
        })(),
        new Promise<void>((resolve) =>
          setTimeout(resolve, ANSWER_REFILL_TIMEOUT_MS),
        ),
      ]);
    }

    // Peek at next card from the existing cache WITHOUT advancing — the
    // visual card stays on the current one while the AI gives feedback.
    // Advance happens on response.done so card display stays in sync
    // with AI speech.
    const nextCard = peekNextCard();
    const stats = useSessionStore.getState().stats;
    // Compute remaining from the AnkiDroid due-count snapshot taken at
    // startSession, not from the in-memory cache. Under the BUG 5 v3b
    // refill-from-scheduler architecture the cache only ever holds the
    // current card + a 1-card lookahead, so `peekRemainingAfterAdvance()`
    // always returned 1 (or 0) regardless of the deck's real due pile.
    // The tutor read that and reliably concluded "this is the last card"
    // every single turn (BUG 10). totalDueAtStart - answered is exact
    // for a fresh-start session; if the user keeps studying past the
    // initial snapshot (newly-due cards) the count clamps at 0 — still
    // better than a hard "1" that contradicts a 200-card deck.
    const { totalDueAtStart } = useSessionStore.getState();
    const answered = stats.correct + stats.incorrect;
    const remainingCards = Math.max(0, totalDueAtStart - answered);

    // Format result
    const result = formatToolResult(
      answeredCardBack,
      nextCard ? { front: nextCard.front, back: nextCard.back } : null,
      remainingCards,
      stats,
    );

    // Send result back to AI
    sessionLog.event("tool_result", "evaluate_and_move_next → Gemini", {
      answered_back: answeredCardBack,
      next_card_front: nextCard?.front ?? null,
      remaining: remainingCards,
      stats,
    });
    webrtcManager.sendToolResult(callId, result);

    // BUG 4 fix: advance the card index EAGERLY (right after the tool
    // result is sent), not when the AI's feedback turn ends. The previous
    // design waited for `response.done` in the `giving_feedback` phase to
    // call advanceCard(). That only worked when Gemini produced real audio
    // in the feedback turn. If the model emitted ctrl tokens + a silent
    // turnComplete (BUG 3 shape), the audio.delta event never fired, the
    // phase never reached `giving_feedback`, and the card never advanced.
    // Reproducible E2E via `./scripts/test-flow.sh` on May 21 2026.
    //
    // Trade-off acknowledged: the visible card may switch to the next one
    // a fraction of a second before the AI finishes speaking the feedback
    // for the previous one. The user's ears track the AI; the screen is
    // secondary. Freezing on the wrong card is worse than an early flip.
    if (nextCard) {
      useSessionStore.getState().advanceCard();
      advanceCacheIndex();
      // BUG 12: data layer advances eagerly, UI doesn't. The UI's view of
      // the visible card is committed by armPendingUiAdvance's timeout, by
      // the transcript listener detecting the next-question start, or by
      // response.done — whichever fires first. Target index is the
      // current data-layer index right after advanceCacheIndex (i.e. where
      // nextCard now lives). We capture it here so a later grading's
      // eager advance can't make this UI commit overshoot. See
      // SESSION-FLOW.md §4.BUG 12.
      const targetIndex = useCardCacheStore.getState().currentIndex;
      this.armPendingUiAdvance(nextCard.front, targetIndex);
      this.startEvaluatingRecovery();
      // Count source MUST be totalDueAtStart, never getTotalCardCount() (the
      // cache size). Under refill-from-scheduler (BUG 5 v3b) the cache holds
      // only the cards loaded so far, so its length == completed + 1 every
      // turn → the notification read "Card 1 of 1, Card 2 of 2, …". See the
      // Tutor Utterance Contract in SESSION-FLOW.md §3a.
      const total = useSessionStore.getState().totalDueAtStart;
      const completed = stats.correct + stats.incorrect;
      updateForegroundNotification(
        "Voice Study Session",
        `Card ${completed + 1} of ${total}`,
      ).catch(() => {}); // Non-fatal
    } else {
      // No more cards — end session.
      sessionLog.step(8, { reason: "no_more_cards", stats });
      useSessionStore.getState().advanceCard();
      advanceCacheIndex();
      this.clearEvaluatingRecovery();
      // Flush any still-pending UI advance from the previous card so the
      // session_complete transition doesn't leave a half-applied lag.
      this.commitPendingUiAdvance("session_complete");
      transitionTo("session_complete", "no_more_cards");
      await this.onSessionComplete();
    }
  }

  /**
   * Arm the recovery timer that forces the session out of `evaluating`
   * if no AI audio arrives within EVALUATING_RECOVERY_TIMEOUT_MS.
   * The timer is cancelled in `response.audio.delta` (real feedback) and
   * by any phase change away from `evaluating` (override / endSession).
   */
  private startEvaluatingRecovery(): void {
    this.clearEvaluatingRecovery();
    this.evaluatingRecoveryTimer = setTimeout(() => {
      const phase = useSessionStore.getState().phase;
      if (phase !== "evaluating") return;
      sessionLog.warn(
        "SessionManager",
        "evaluating-recovery: no AI audio after tool result — forcing awaiting_answer",
        { timeout_ms: SessionManager.EVALUATING_RECOVERY_TIMEOUT_MS },
      );
      useSessionStore
        .getState()
        .transitionTo("awaiting_answer", "evaluating_recovery");
    }, SessionManager.EVALUATING_RECOVERY_TIMEOUT_MS);
  }

  private clearEvaluatingRecovery(): void {
    if (this.evaluatingRecoveryTimer) {
      clearTimeout(this.evaluatingRecoveryTimer);
      this.evaluatingRecoveryTimer = null;
    }
  }

  /**
   * Arm a pending UI advance (BUG 12). Called right after the data layer
   * advances the cache index. Snapshots the target index NOW so a later
   * superseding evaluate-call (which moves currentIndex again before
   * committing this pending advance) doesn't cause the UI to skip the
   * previous card entirely. Sets up the timeout fallback; the transcript
   * listener commits early if Gemini starts pronouncing the next question.
   * Any previous pending advance is committed to ITS target first.
   */
  private armPendingUiAdvance(
    nextCardFront: string,
    targetIndex: number,
  ): void {
    if (this.pendingUiNextCardFront !== null) {
      this.commitPendingUiAdvance("superseded_by_new_advance");
    }
    this.pendingUiNextCardFront = nextCardFront;
    this.pendingUiTargetIndex = targetIndex;
    this.pendingUiTranscriptAccum = "";
    this.pendingUiAdvanceTimer = setTimeout(() => {
      this.commitPendingUiAdvance("timeout");
    }, SessionManager.PENDING_UI_ADVANCE_TIMEOUT_MS);
  }

  /**
   * Commit the pending UI advance if one is armed. Idempotent and safe to
   * call from multiple triggers (transcript match, timeout, response.done,
   * endSession). Sets `uiVisibleIndex` to the target captured at arm time —
   * NOT the current data-layer `currentIndex`, which may have advanced
   * past the target if another grading came in.
   */
  private commitPendingUiAdvance(reason: string): void {
    if (this.pendingUiNextCardFront === null) return;
    if (this.pendingUiAdvanceTimer) {
      clearTimeout(this.pendingUiAdvanceTimer);
      this.pendingUiAdvanceTimer = null;
    }
    const target = this.pendingUiTargetIndex;
    this.pendingUiNextCardFront = null;
    this.pendingUiTargetIndex = null;
    this.pendingUiTranscriptAccum = "";
    if (target !== null) {
      useCardCacheStore.setState({ uiVisibleIndex: target });
    }
    sessionLog.event("UI", "card advance committed", {
      reason,
      target_index: target,
    });
  }

  /**
   * Handle override_evaluation tool — flip the previous answer in either
   * direction (incorrect→correct or correct→incorrect). The latest write
   * to AnkiDroid drives the next due date, which is what we want.
   */
  private async handleOverrideEvaluation(
    callId: string,
    args: any,
  ): Promise<void> {
    const overrideTo: "correct" | "incorrect" =
      args?.override_to === "incorrect" ? "incorrect" : "correct";
    sessionLog.event("tool_call", "override_evaluation", {
      override_to: overrideTo,
      call_id: callId,
    });

    const { stats } = useSessionStore.getState();
    const canFlip =
      overrideTo === "correct" ? stats.incorrect > 0 : stats.correct > 0;

    if (!canFlip) {
      webrtcManager.sendToolResult(callId, {
        status: "no_change",
        message:
          overrideTo === "correct"
            ? "No incorrect answer to override"
            : "No correct answer to override",
      });
      return;
    }

    // Adjust stats by flipping one tally from one bucket to the other.
    if (overrideTo === "correct") {
      useSessionStore.setState({
        stats: { correct: stats.correct + 1, incorrect: stats.incorrect - 1 },
      });
    } else {
      useSessionStore.setState({
        stats: { correct: stats.correct - 1, incorrect: stats.incorrect + 1 },
      });
    }

    // Re-write the last answered card to AnkiDroid with the flipped grade.
    const { selectedDeck: deckForOverride } = useSettingsStore.getState();
    if (
      this.lastAnsweredCardId != null &&
      this.lastAnsweredCardOrd != null &&
      deckForOverride
    ) {
      const pass = overrideTo === "correct";
      ankiBridge
        .answerCard(
          deckForOverride,
          this.lastAnsweredCardId,
          this.lastAnsweredCardOrd,
          pass,
        )
        .catch((err) => {
          sessionLog.warn("AnkiDroid", "override write-back error", {
            error: String(err),
          });
        });
    }

    webrtcManager.sendToolResult(callId, {
      status: "success",
      message: `Previous answer marked as ${overrideTo}`,
      updated_stats: useSessionStore.getState().stats,
    });
  }

  /**
   * Handle end_session tool
   */
  private async handleEndSessionTool(callId: string): Promise<void> {
    sessionLog.event("tool_call", "end_session", { call_id: callId });
    sessionLog.step(8, { reason: "user_ended" });

    const stats = useSessionStore.getState().stats;
    const total = stats.correct + stats.incorrect;

    webrtcManager.sendToolResult(callId, {
      status: "ending",
      total_reviewed: total,
      correct: stats.correct,
      incorrect: stats.incorrect,
    });

    // Trigger completion after AI gives summary
    setTimeout(async () => {
      useSessionStore.getState().transitionTo("session_complete", "user_ended");
      await this.onSessionComplete();
    }, 5000); // Wait for AI to speak summary
  }

  /**
   * Handle session completion
   */
  private async onSessionComplete(): Promise<void> {
    const stats = useSessionStore.getState().stats;
    sessionLog.stepDone(8, { stats });
    AnalyticsEvents.sessionCompleted({
      correct: stats.correct,
      incorrect: stats.incorrect,
      duration_s: 0, // TODO: track session duration
    });

    // Stop foreground service
    try {
      await stopForegroundService();
    } catch (error) {
      sessionLog.warn("SessionManager", "failed to stop foreground service", {
        error: String(error),
      });
    }

    // Trigger AnkiDroid sync
    try {
      await ankiBridge.triggerSync();
      sessionLog.info("AnkiDroid", "sync triggered");
    } catch (error) {
      sessionLog.warn("AnkiDroid", "failed to trigger sync", {
        error: String(error),
      });
    }
  }

  /**
   * End session triggered from the notification bar.
   * Runs the full completion flow (sync + session_complete screen).
   */
  async endSessionFromNotification(): Promise<void> {
    const { transitionTo } = useSessionStore.getState();
    // Same ordering as endSession() — flag + disconnect first so the
    // tutor cuts off immediately even if onSessionComplete is async (BUG 6).
    webrtcManager.stopCurrentAudio();
    sfxPlayer.stop();
    webrtcManager.disconnect();
    this.unsubscribeFromConnectionState();
    webrtcManager.onConnectionDropped = null;
    this.phaseBeforeNetworkPause = null;
    this.clearEvaluatingRecovery();
    this.commitPendingUiAdvance("end_from_notification");
    this.lastAnsweredCardId = null;
    this.lastAnsweredCardOrd = null;
    stopAudioLevelTracking();
    transitionTo("session_complete", "notification_end");
    await this.onSessionComplete();
  }

  /**
   * End the session only if one is actually running. Safe to call from
   * screen unmount cleanups: reads the phase from the store at call time
   * (a React cleanup closure captures stale state — see BUG session.tsx
   * unmount, audit 2026-07-01), so navigating away mid-session tears the
   * session down instead of leaving the mic, WebSocket and foreground
   * service alive. Returns true when a teardown ran.
   */
  endSessionIfActive(): boolean {
    const phase = useSessionStore.getState().phase;
    if (phase === "idle") return false;
    this.endSession();
    return true;
  }

  /**
   * End the current session immediately (e.g. user taps "End Session" in-app or navigates away).
   * Does NOT show summary — caller is responsible for navigation.
   */
  endSession(): void {
    const { transitionTo } = useSessionStore.getState();

    // Order matters for the audio cut to be instant (BUG 6):
    //   1. Set the playback-halted flag and flush the AudioTrack buffer.
    //   2. Tear down the WebSocket + release the AudioTrack so no late
    //      audio chunk can refill the hardware queue. Done BEFORE the rest
    //      of the cleanup so the audio window is microseconds, not the
    //      ~10 statements it took before.
    webrtcManager.stopCurrentAudio();
    sfxPlayer.stop();
    webrtcManager.disconnect();

    this.unsubscribeFromConnectionState();
    webrtcManager.onConnectionDropped = null;
    this.phaseBeforeNetworkPause = null;
    this.clearEvaluatingRecovery();
    this.commitPendingUiAdvance("end_session");
    this.lastAnsweredCardId = null;
    this.lastAnsweredCardOrd = null;

    stopForegroundService().catch((error) => {
      sessionLog.warn("SessionManager", "failed to stop foreground service", {
        error: String(error),
      });
    });

    stopAudioLevelTracking();
    clearCards();
    transitionTo("idle", "session_ended");

    sessionLog.banner("Session ended (user)");
  }

  /**
   * Dev/debug: inject a fake user answer as if the user had spoken it.
   * Bypasses the mic entirely — sends a user-role clientContent text turn
   * directly to Gemini. The AI then runs its normal evaluate_and_move_next
   * cycle (tool call → write-back → advance), so the whole eval pipeline
   * downstream is exercised end-to-end.
   *
   * Logged with [SIM] prefix so the trace is honest about the source.
   * Only valid while the session is in an answering phase; rejected
   * otherwise to avoid corrupting the conversation state.
   */
  simulateUserAnswer(text: string): void {
    const trimmed = (text ?? "").trim();
    if (!trimmed) {
      sessionLog.warn(
        "SIM",
        "simulateUserAnswer called with empty text — ignored",
      );
      return;
    }

    const { phase, transitionTo } = useSessionStore.getState();
    const acceptablePhases = ["awaiting_answer", "giving_feedback", "ready"];
    if (!acceptablePhases.includes(phase)) {
      sessionLog.warn("SIM", "rejected — session not in an answering phase", {
        current_phase: phase,
        text: trimmed,
      });
      return;
    }

    sessionLog.event("SIM", "injecting user answer", { text: trimmed, phase });

    // Mute mic during injection so VAD can't race the text turn and
    // double-commit. Restore previous mute state on next tick.
    webrtcManager.setMicrophoneMuted(true);
    transitionTo("evaluating", "sim_user_answered");
    // Arm recovery so a silent-no-tool reply (BUG 3 shape) can't lock the
    // session in `evaluating`. The audio.delta handler clears it on real
    // feedback; the timer forces awaiting_answer if 8 s pass silent.
    this.startEvaluatingRecovery();

    webrtcManager.sendTextMessage(trimmed);
    // Mic stays muted after inject. server_vad on a no-input device fires
    // immediately on unmute, racing the text turn → ctrl tokens instead of
    // evaluate_and_move_next (BUG 3). Real users speak naturally; this path
    // is dev/sim only. resume() unmutes explicitly when needed.
  }

  /**
   * Pause the session
   */
  pause(): void {
    const { transitionTo } = useSessionStore.getState();
    webrtcManager.stopCurrentAudio(); // stop tutor speaking immediately
    webrtcManager.setMicrophoneMuted(true);
    transitionTo("paused", "user_paused");
  }

  /**
   * Resume the session
   */
  resume(): void {
    const { transitionTo } = useSessionStore.getState();
    webrtcManager.setMicrophoneMuted(false);
    clearAudioFocusPauseFlag();
    // Re-request audio focus in case it was lost (e.g., after a phone call)
    requestAudioFocus().catch((err) => {
      sessionLog.warn("SessionManager", "failed to re-request audio focus", {
        error: String(err),
      });
    });
    transitionTo("asking_question", "user_resumed");
  }
}

// Export singleton
export const sessionManager = new SessionManager();
