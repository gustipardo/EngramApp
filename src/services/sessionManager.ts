import { realtimeManager as webrtcManager, syncActiveProvider } from './realtimeManager';
import { loadDueCards, getCurrentCard, getNextCard, getRemainingCardCount, getTotalCardCount, clearCards, peekNextCard, peekRemainingAfterAdvance, advanceCacheIndex } from './cardLoader';
import { useSessionStore } from '../stores/useSessionStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useConnectionStore } from '../stores/useConnectionStore';
import { ankiBridge } from '../native/ankiBridge';
import { getSystemPrompt, allTools, getInitialMessage, getResumeMessage, formatToolResult } from '../config/prompts';
import { startForegroundService, stopForegroundService, updateForegroundNotification, requestAudioFocus, clearAudioFocusPauseFlag } from './foregroundAudioService';
import { isTokenError } from './tokenService';
import { AnalyticsEvents } from './analytics';

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
   * True when a card has been evaluated but the visual index hasn't
   * advanced yet.  The advance happens on `response.done` so the
   * displayed card stays in sync with the AI's speech.
   */
  private pendingCardAdvance = false;

  /**
   * Start a new study session
   */
  async startSession(): Promise<void> {
    const { transitionTo, resetSession } = useSessionStore.getState();
    const { selectedDeck } = useSettingsStore.getState();

    if (!selectedDeck) {
      throw new Error('No deck selected');
    }

    // Pick the right AI backend before anything else
    syncActiveProvider();

    // Reset session state
    resetSession();

    try {
      // 1. Connect to WebRTC (if not already)
      const connectionState = useConnectionStore.getState().connectionState;
      if (connectionState !== 'connected') {
        transitionTo('connecting', 'startSession');
        await webrtcManager.connect();
      }

      // 2. Mute microphone during setup to prevent default server_vad
      //    from picking up audio before our session config is applied.
      webrtcManager.setMicrophoneMuted(true);

      // 3. Load cards from AnkiDroid
      transitionTo('loading_cards', 'startSession');
      const cards = await loadDueCards(selectedDeck);

      if (cards.length === 0) {
        transitionTo('error', 'no_cards');
        throw new Error('No cards due for review in this deck');
      }

      // 4. Configure AI session and wait for server acknowledgement
      transitionTo('ready', 'cards_loaded');
      await this.configureAISession(selectedDeck, cards.length);

      // 5. Register event handlers
      this.registerEventHandlers();

      // 5b. Wire up connection drop handler for auto-reconnect
      this.installConnectionDropHandler();

      // 5c. Subscribe to connection state changes for network-loss detection
      this.subscribeToConnectionState();

      // 6. Send first card to AI, wait for first response, then enable VAD
      const firstCard = getCurrentCard();
      if (firstCard) {
        await this.sendFirstCard(firstCard.front, firstCard.back);
        // The AI has finished its first response (greeting + question).
        // Go straight to awaiting_answer since the question was already asked.
        transitionTo('awaiting_answer', 'first_card_sent');
      }

      // 7. Unmute microphone now that server_vad is enabled
      webrtcManager.setMicrophoneMuted(false);

      // Track session start
      AnalyticsEvents.sessionStarted(selectedDeck, cards.length);

      // 8. Start foreground service for background audio
      try {
        await startForegroundService(
          'Voice Study Session',
          `Card 1 of ${cards.length}`
        );
      } catch (fgError) {
        console.warn('[SessionManager] Failed to start foreground service:', fgError);
        // Non-fatal: session works without it, just no background audio
      }

    } catch (error: any) {
      AnalyticsEvents.sessionError(error?.message || 'start_failed');
      transitionTo('error', 'start_failed');
      throw error;
    }
  }

  /**
   * Configure AI session with system prompt and tools.
   * Deliberately starts with turn_detection DISABLED (null) so that
   * server_vad cannot race with our initial card message.
   * Waits for the server to acknowledge the update before resolving.
   */
  private async configureAISession(deckName: string, cardCount: number): Promise<void> {
    const { alwaysReadBack, deckInstructions } = useSettingsStore.getState();
    const customInstructions = deckInstructions[deckName] || undefined;
    const systemPrompt = getSystemPrompt(deckName, cardCount, alwaysReadBack, customInstructions);

    await webrtcManager.updateSession({
      instructions: systemPrompt,
      tools: allTools,
      modalities: ['text', 'audio'],
      turn_detection: null,  // Disabled until first AI response completes
    });
  }

  /**
   * Send first card to AI and wait for the AI's first response to complete.
   * Only after the response finishes do we enable server_vad for voice interaction.
   */
  private async sendFirstCard(front: string, back: string): Promise<void> {
    const message = getInitialMessage(front, back);
    console.log('[SessionManager] sendFirstCard - front:', front);
    console.log('[SessionManager] sendFirstCard - back:', back);
    console.log('[SessionManager] sendFirstCard - full message:', message);

    // Send the card as a user message and request a response
    webrtcManager.sendTextMessage(message);

    // Wait for the AI to finish its first response before enabling VAD.
    // This guarantees the AI has processed the card content in its context.
    await webrtcManager.waitForNextResponseDone();

    console.log('[SessionManager] First AI response complete, enabling server_vad');

    // Clear any buffered audio from the manual-mode phase before enabling VAD
    webrtcManager.sendEvent({ type: 'input_audio_buffer.clear' });

    // NOW enable server_vad for ongoing voice interaction
    // Threshold 0.6 (above default 0.5) to reduce false triggers from ambient noise
    await webrtcManager.updateSession({
      turn_detection: {
        type: 'server_vad',
        threshold: 0.6,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
      },
    });

    console.log('[SessionManager] server_vad enabled successfully');
    await webrtcManager.debugAudioTrackState('after-vad-enabled');
    // Check again after 5s to see if bytes are increasing (audio actually flowing)
    setTimeout(() => webrtcManager.debugAudioTrackState('5s-after-vad'), 5000);
  }

  /**
   * Register WebRTC event handlers
   */
  private registerEventHandlers(): void {
    const { transitionTo } = useSessionStore.getState();

    // Handle tool calls
    webrtcManager.on('response.function_call_arguments.done', this.handleToolCall.bind(this));

    // Handle AI speaking (giving feedback)
    webrtcManager.on('response.audio.delta', () => {
      const phase = useSessionStore.getState().phase;
      if (phase === 'evaluating') {
        useSessionStore.getState().transitionTo('giving_feedback', 'ai_speaking');
      }
    });

    // Handle AI finished speaking — advance card and transition to awaiting_answer
    webrtcManager.on('response.done', () => {
      const phase = useSessionStore.getState().phase;
      if (phase === 'giving_feedback' || phase === 'asking_question' || phase === 'evaluating') {
        // Advance the visual card now that the AI finished feedback + next question
        if (this.pendingCardAdvance) {
          this.pendingCardAdvance = false;
          useSessionStore.getState().advanceCard();
          advanceCacheIndex();
        }
        useSessionStore.getState().transitionTo('awaiting_answer', 'ai_done');
      }
    });

    // Handle user speaking
    webrtcManager.on('input_audio_buffer.speech_started', () => {
      const phase = useSessionStore.getState().phase;
      if (phase === 'awaiting_answer') {
        console.log('[SessionManager] User started speaking');
      }
    });

    // Handle AI transcripts (for debugging)
    webrtcManager.on('response.audio_transcript.done', (event: any) => {
      console.log('[AI]:', event.transcript);
    });

    // Handle user transcripts
    webrtcManager.on('conversation.item.input_audio_transcription.completed', (event: any) => {
      console.log('[User]:', event.transcript);
      useSessionStore.getState().transitionTo('evaluating', 'user_answered');
    });

    // Track tool call names
    webrtcManager.on('response.output_item.added', (event: any) => {
      const item = event.item;
      if (item?.type === 'function_call') {
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

    this.connectionUnsubscribe = useConnectionStore.subscribe((state, prevState) => {
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
      if (connectionState === 'reconnecting' || connectionState === 'failed') {
        const activePhases = [
          'asking_question', 'awaiting_answer', 'evaluating',
          'giving_feedback', 'advancing', 'ready',
        ];
        if (activePhases.includes(phase)) {
          console.warn(`[SessionManager] Connection state -> ${connectionState}, muting mic`);
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
      if (connectionState === 'connected' && (prevConnectionState === 'reconnecting' || prevConnectionState === 'failed')) {
        if (this.phaseBeforeNetworkPause && (phase === 'paused' || phase === 'reconnecting')) {
          // If phase is 'reconnecting', the resumeAfterReconnect flow
          // will handle restoration — don't interfere.
          if (phase === 'paused') {
            console.log('[SessionManager] ICE self-recovered, resuming session');
            webrtcManager.setMicrophoneMuted(false);
            transitionTo(this.phaseBeforeNetworkPause as any, 'connection_restored');
            this.phaseBeforeNetworkPause = null;
          }
        }
      }
    });
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
        'asking_question', 'awaiting_answer', 'evaluating',
        'giving_feedback', 'advancing', 'ready', 'paused',
      ];
      if (!activePhases.includes(phase)) return;

      console.log('[SessionManager] Connection dropped, starting reconnect flow');

      // Save the phase so we can restore it later
      if (phase !== 'paused') {
        this.phaseBeforeNetworkPause = phase;
      }

      const { transitionTo } = useSessionStore.getState();
      webrtcManager.setMicrophoneMuted(true);
      transitionTo('reconnecting', 'connection_dropped');

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
          useConnectionStore.getState().reconnectAttempts
        );
      } catch (error) {
        console.error('[SessionManager] Failed to resume session after reconnect:', error);
        transitionTo('error', 'resume_failed');
      }
    } else {
      console.error('[SessionManager] Reconnect failed, transitioning to error');
      transitionTo('error', 'reconnect_failed');
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
      throw new Error('No deck selected for resume');
    }

    console.log('[SessionManager] Resuming session after reconnect');

    // 1. Re-configure AI session (system prompt + tools)
    const totalCards = getTotalCardCount();
    await this.configureAISession(selectedDeck, totalCards);

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
        stats
      );

      console.log('[SessionManager] Sending resume message to AI');
      webrtcManager.sendTextMessage(resumeMsg);

      // Wait for AI to finish its resume response
      await webrtcManager.waitForNextResponseDone();

      console.log('[SessionManager] AI resume response complete, enabling server_vad');

      // Clear buffered audio and enable server_vad
      webrtcManager.sendEvent({ type: 'input_audio_buffer.clear' });
      await webrtcManager.updateSession({
        turn_detection: { type: 'server_vad' },
      });
    }

    // 5. Transition back to active phase
    const restorePhase = this.phaseBeforeNetworkPause || 'awaiting_answer';
    transitionTo(restorePhase as any, 'reconnect_resumed');
    this.phaseBeforeNetworkPause = null;

    console.log('[SessionManager] Session resumed after reconnect');
  }

  /**
   * Handle tool call from AI
   */
  private async handleToolCall(event: any): Promise<void> {
    const { call_id, arguments: argsStr } = event;
    const toolName = this.toolCallNames.get(call_id);

    try {
      const args = JSON.parse(argsStr || '{}');

      switch (toolName) {
        case 'evaluate_and_move_next':
          await this.handleEvaluateAndMoveNext(call_id, args);
          break;
        case 'override_evaluation':
          await this.handleOverrideEvaluation(call_id, args);
          break;
        case 'end_session':
          await this.handleEndSessionTool(call_id);
          break;
        default:
          console.warn('[SessionManager] Unknown tool:', toolName);
      }
    } catch (error) {
      console.error('[SessionManager] Tool call error:', error);
    }
  }

  /**
   * Handle evaluate_and_move_next tool
   */
  private async handleEvaluateAndMoveNext(callId: string, args: any): Promise<void> {
    const { user_response_quality, feedback_text } = args;
    console.log(`[SessionManager] Evaluation: ${user_response_quality} - ${feedback_text}`);

    const { transitionTo, recordAnswer } = useSessionStore.getState();

    // Get current card's back for feedback
    const currentCard = getCurrentCard();
    const answeredCardBack = currentCard?.back || null;

    // Record answer (except for skipped)
    if (user_response_quality !== 'skipped') {
      recordAnswer(user_response_quality as 'correct' | 'incorrect');
      transitionTo('evaluating', 'tool_called');
    }

    // Peek at next card WITHOUT advancing — the visual card stays on
    // the current one while the AI gives feedback. Advance happens
    // on response.done so card display stays in sync with AI speech.
    const nextCard = peekNextCard();
    const remainingCards = peekRemainingAfterAdvance();
    const stats = useSessionStore.getState().stats;

    // Format result
    const result = formatToolResult(
      answeredCardBack,
      nextCard ? { front: nextCard.front, back: nextCard.back } : null,
      remainingCards,
      stats
    );

    // Send result back to AI
    webrtcManager.sendToolResult(callId, result);

    // Stay in 'evaluating' phase — the response.audio.delta handler will
    // transition to 'giving_feedback', then response.done → 'awaiting_answer'.
    if (nextCard) {
      // Mark that card advance should happen when AI finishes speaking
      this.pendingCardAdvance = true;
      const total = getTotalCardCount();
      const completed = stats.correct + stats.incorrect;
      updateForegroundNotification(
        'Voice Study Session',
        `Card ${completed + 1} of ${total}`
      ).catch(() => {}); // Non-fatal
    } else {
      // No more cards — advance immediately and end session
      useSessionStore.getState().advanceCard();
      advanceCacheIndex();
      this.pendingCardAdvance = false;
      transitionTo('session_complete', 'no_more_cards');
      await this.onSessionComplete();
    }
  }

  /**
   * Handle override_evaluation tool - correct previous answer
   */
  private async handleOverrideEvaluation(callId: string, _args: any): Promise<void> {
    console.log('[SessionManager] Override evaluation - marking previous as correct');

    const { stats } = useSessionStore.getState();

    // Only override if there was a previous incorrect answer
    if (stats.incorrect > 0) {
      // Correct the stats: remove one incorrect, add one correct
      useSessionStore.setState({
        stats: {
          correct: stats.correct + 1,
          incorrect: stats.incorrect - 1,
        },
      });

      webrtcManager.sendToolResult(callId, {
        status: 'success',
        message: 'Previous answer marked as correct',
        updated_stats: useSessionStore.getState().stats,
      });
    } else {
      webrtcManager.sendToolResult(callId, {
        status: 'no_change',
        message: 'No incorrect answer to override',
      });
    }
  }

  /**
   * Handle end_session tool
   */
  private async handleEndSessionTool(callId: string): Promise<void> {
    console.log('[SessionManager] End session requested by user');

    const stats = useSessionStore.getState().stats;
    const total = stats.correct + stats.incorrect;

    webrtcManager.sendToolResult(callId, {
      status: 'ending',
      total_reviewed: total,
      correct: stats.correct,
      incorrect: stats.incorrect,
    });

    // Trigger completion after AI gives summary
    setTimeout(async () => {
      useSessionStore.getState().transitionTo('session_complete', 'user_ended');
      await this.onSessionComplete();
    }, 5000); // Wait for AI to speak summary
  }

  /**
   * Handle session completion
   */
  private async onSessionComplete(): Promise<void> {
    const stats = useSessionStore.getState().stats;
    console.log('[SessionManager] Session complete:', stats);
    AnalyticsEvents.sessionCompleted({
      correct: stats.correct,
      incorrect: stats.incorrect,
      duration_s: 0, // TODO: track session duration
    });

    // Stop foreground service
    try {
      await stopForegroundService();
    } catch (error) {
      console.warn('[SessionManager] Failed to stop foreground service:', error);
    }

    // Trigger AnkiDroid sync
    try {
      await ankiBridge.triggerSync();
      console.log('[SessionManager] Triggered AnkiDroid sync');
    } catch (error) {
      console.warn('[SessionManager] Failed to trigger sync:', error);
    }
  }

  /**
   * End session triggered from the notification bar.
   * Runs the full completion flow (sync + session_complete screen).
   */
  async endSessionFromNotification(): Promise<void> {
    const { transitionTo } = useSessionStore.getState();
    this.unsubscribeFromConnectionState();
    webrtcManager.onConnectionDropped = null;
    this.phaseBeforeNetworkPause = null;
    this.pendingCardAdvance = false;
    transitionTo('session_complete', 'notification_end');
    await this.onSessionComplete();
  }

  /**
   * End the current session immediately (e.g. user taps "End Session" in-app or navigates away).
   * Does NOT show summary — caller is responsible for navigation.
   */
  endSession(): void {
    const { transitionTo } = useSessionStore.getState();

    this.unsubscribeFromConnectionState();
    webrtcManager.onConnectionDropped = null;
    this.phaseBeforeNetworkPause = null;
    this.pendingCardAdvance = false;

    stopForegroundService().catch((error) => {
      console.warn('[SessionManager] Failed to stop foreground service:', error);
    });

    webrtcManager.disconnect();
    clearCards();
    transitionTo('idle', 'session_ended');

    console.log('[SessionManager] Session ended');
  }

  /**
   * Pause the session
   */
  pause(): void {
    const { transitionTo } = useSessionStore.getState();
    webrtcManager.setMicrophoneMuted(true);
    transitionTo('paused', 'user_paused');
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
      console.warn('[SessionManager] Failed to re-request audio focus:', err);
    });
    transitionTo('asking_question', 'user_resumed');
  }
}

// Export singleton
export const sessionManager = new SessionManager();
