/**
 * Drives a Fixture (deck + scripted turns) against the real sessionManager
 * with mocked Gemini, mocked AnkiDroid, and a DeckSimulator standing in
 * for cardLoader. Returns assertion-ready results so individual tests can
 * verify whatever subset of behavior they care about.
 *
 * Wiring is the responsibility of the caller (jest.mock at the top of the
 * test file) — this runner only orchestrates events on objects it is
 * handed.
 */

import type { Fixture, Turn } from './fixtures/scripts';
import type { MockGeminiManager } from './mockGeminiManager';
import type { DeckSimulator } from './deckSimulator';

export interface RunContext {
  /** The mock geminiManager singleton (returned via jest.mock). */
  mockMgr: MockGeminiManager;
  /** The deck simulator the cardLoader mocks delegate to. */
  simulator: DeckSimulator;
  /** Spy on `ankiBridge.answerCard(deckName, noteId, cardOrd, pass, timeTakenMs?)`. */
  answerCardSpy: jest.Mock;
  /** sessionManager singleton. */
  sessionManager: any;
  /** Real Zustand stores. */
  useSessionStore: any;
  useCardCacheStore: any;
  useConnectionStore: any;
}

export interface RunResult {
  /** Every recorded ankiBridge.answerCard call, in order. */
  ankiWrites: Array<{ cardId: number; pass: boolean }>;
  /** Final stats from the session store. */
  finalStats: { correct: number; incorrect: number };
  /** Final phase from the session store (e.g. 'awaiting_answer', 'session_complete'). */
  finalPhase: string;
  /** Tool results sent back to the (mock) AI, in order. */
  toolResults: Array<{ callId: string; result: any }>;
  /** Per-turn diagnostics for debugging failed assertions. */
  perTurn: Array<{
    turn: Turn;
    ankiWritesAfter: Array<{ cardId: number; pass: boolean }>;
    statsAfter: { correct: number; incorrect: number };
    /** Phase observed at the end of this turn — used to assert UI/state isn't stuck. */
    phaseAfter: string;
    /** lastEvaluation in the session store at end of turn — drives the verdict popup. */
    lastEvaluationAfter: 'correct' | 'incorrect' | null;
    /** sessionStore.currentCardIndex at end of turn — what the UI binds to. */
    cardIndexAfter: number;
    toolResultAfter: { callId: string; result: any } | null;
  }>;
}

export async function runFixture(fixture: Fixture, ctx: RunContext): Promise<RunResult> {
  const {
    mockMgr,
    simulator,
    answerCardSpy,
    sessionManager,
    useSessionStore,
    useCardCacheStore,
    useConnectionStore,
  } = ctx;

  // -------------------------------------------------------------------------
  // Reset state before each fixture run.
  // -------------------------------------------------------------------------
  // We deliberately do NOT use jest.useFakeTimers() here. Fake timers
  // globally intercept setImmediate (used by flushMicrotasks) and the
  // test runner's own 5s timeout, which causes hangs. Instead, the
  // runner uses real timers + queueMicrotask for flushing, and the
  // end_session 5s summary wait is handled by the end_session test
  // (it pins the *intermediate* awaiting_answer state — the final
  // session_complete transition after 5s is left to the integration
  // tests since simulating the full real-time wait in unit tests is
  // not worth the harness complexity).
  mockMgr.__reset();
  simulator.reset(fixture.cards);
  answerCardSpy.mockClear();
  answerCardSpy.mockResolvedValue(true);
  useSessionStore.getState().resetSession();
  useCardCacheStore.getState().clear();
  useConnectionStore.setState({
    connectionState: 'disconnected',
    reconnectAttempts: 0,
    networkStatus: 'online',
  });
  // Reset internal sessionManager state.
  // (pendingCardAdvance was removed in the BUG 4 fix — advance now happens
  // synchronously in handleEvaluateAndMoveNext. Recovery timer is cleared
  // here in case a previous run left one armed.)
  (sessionManager as any).clearEvaluatingRecovery?.();
  sessionManager.lastAnsweredCardId = null;
  sessionManager.toolCallNames = new Map();

  // Tell the settings store which deck we're "studying".
  const { useSettingsStore } = require('../stores/useSettingsStore');
  useSettingsStore.setState({ selectedDeck: fixture.cards[0]?.deckName ?? 'TEST' });

  // -------------------------------------------------------------------------
  // Start the session — this registers handlers on mockMgr, sends the
  // initial card, etc.
  // -------------------------------------------------------------------------
  await sessionManager.startSession();

  // -------------------------------------------------------------------------
  // Drive turns.
  // -------------------------------------------------------------------------
  const perTurn: RunResult['perTurn'] = [];

  for (const turn of fixture.turns) {
    const writesBefore = mockMgr.sentToolResults.length;

    if (turn.kind === 'answer') {
      mockMgr.__simulateUserTranscript(turn.userSaid);
      // Production shape: Gemini emits two model turns per evaluation:
      //   (1) silent turn ending in toolCall + turnComplete — response.done
      //       arrives while phase is still 'evaluating' and is intentionally
      //       skipped by the handler.
      //   (2) speaking turn — audio.delta flips phase to 'giving_feedback',
      //       then turnComplete (response.done) advances the card.
      // Compressing both into one (audio before tool, single done) used to
      // work, but the response.done handler in sessionManager was tightened
      // to only act on 'giving_feedback' to match real Gemini — so the
      // runner has to mirror that two-turn shape.
      mockMgr.__simulateAiToolCall('evaluate_and_move_next', {
        user_response_quality: turn.aiGraded,
        feedback_text: turn.feedbackText ?? `[${turn.aiGraded}]`,
      });
      await flushMicrotasks();
      mockMgr.__simulateAiResponseDone();   // silent tool-call turn ends — handler skipped
      mockMgr.__simulateAiAudioDelta();     // speaking turn begins — phase → giving_feedback
      mockMgr.__simulateAiResponseDone();   // speaking turn ends — advance + awaiting_answer
    } else if (turn.kind === 'override') {
      mockMgr.__simulateUserTranscript(turn.userSaid);
      mockMgr.__simulateAiAudioDelta();
      mockMgr.__simulateAiToolCall('override_evaluation', { override_to: turn.to });
      await flushMicrotasks();
      mockMgr.__simulateAiResponseDone();
    } else if (turn.kind === 'endRequested') {
      mockMgr.__simulateUserTranscript(turn.userSaid);
      mockMgr.__simulateAiToolCall('end_session', {});
      await flushMicrotasks();
      // handleEndSessionTool uses a 5-second setTimeout to wait for the
      // AI to deliver the closing summary before transitioning to
      // session_complete. That 5s wait is intentional UX (lets the user
      // hear the summary) and is left to the integration tests.
      // In the unit-test runner we snapshot the intermediate state
      // (phase = awaiting_answer, AI already received the 'ending'
      // tool result) — the final transition is covered by the
      // end_session "after summary completes" assertion in the test.
    } else if (turn.kind === 'silentGrade') {
      // AI verbalises a verdict but never tool-calls. Mirrors the
      // production failure mode users have reported: tutor says
      // "correct" / "incorrect" but no popup, no card advance, no
      // write — because evaluate_and_move_next never fires.
      mockMgr.__simulateUserTranscript(turn.userSaid);
      mockMgr.__simulateAiAudioDelta();
      await flushMicrotasks();
      mockMgr.__simulateAiResponseDone();
    } else if (turn.kind === 'toolCallNoAudio') {
      // AI calls the tool correctly but never speaks the verdict. The
      // first response.done arrives while phase is still 'evaluating'
      // and is intentionally skipped; with no follow-up audio.delta
      // the session sticks. Captures the "UI stuck on a card while
      // tutor advances internally" symptom.
      mockMgr.__simulateUserTranscript(turn.userSaid);
      mockMgr.__simulateAiToolCall('evaluate_and_move_next', {
        user_response_quality: turn.aiGraded,
        feedback_text: turn.feedbackText ?? `[${turn.aiGraded}]`,
      });
      await flushMicrotasks();
      mockMgr.__simulateAiResponseDone();
    } else if (turn.kind === 'connectionDropped') {
      // Configure reconnect-failure mode if requested.
      mockMgr.__setReconnectWillFail(turn.reconnectFails ?? false);
      // Fire the drop handler. The handler runs `attemptReconnectAndResume`
      // async — we drain the microtask chain before the next turn.
      mockMgr.__simulateConnectionDropped();
      // Microtask flush so the synchronous part of the handler runs
      // (transitionTo reconnecting, mute mic, schedule reconnect).
      await flushMicrotasks();
      // Extra microtask for the reconnect promise chain.
      await flushMicrotasks();
    }

    const toolResultAfter = mockMgr.sentToolResults[writesBefore] ?? null;

    perTurn.push({
      turn,
      ankiWritesAfter: collectAnkiWrites(answerCardSpy),
      statsAfter: { ...useSessionStore.getState().stats },
      phaseAfter: useSessionStore.getState().phase,
      lastEvaluationAfter: useSessionStore.getState().lastEvaluation,
      cardIndexAfter: useSessionStore.getState().currentCardIndex,
      toolResultAfter,
    });
  }

  return {
    ankiWrites: collectAnkiWrites(answerCardSpy),
    finalStats: { ...useSessionStore.getState().stats },
    finalPhase: useSessionStore.getState().phase,
    toolResults: [...mockMgr.sentToolResults],
    perTurn,
  };
}

function collectAnkiWrites(
  spy: jest.Mock
): Array<{ cardId: number; pass: boolean }> {
  // ankiBridge.answerCard signature: (deckName, noteId, cardOrd, pass, timeTakenMs?)
  return spy.mock.calls.map(([, cardId, , pass]) => ({ cardId, pass }));
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
