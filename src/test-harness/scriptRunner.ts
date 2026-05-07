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
  /** Tool results sent back to the (mock) AI, in order. */
  toolResults: Array<{ callId: string; result: any }>;
  /** Per-turn diagnostics for debugging failed assertions. */
  perTurn: Array<{
    turn: Turn;
    ankiWritesAfter: Array<{ cardId: number; pass: boolean }>;
    statsAfter: { correct: number; incorrect: number };
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
  sessionManager.pendingCardAdvance = false;
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
      mockMgr.__simulateAiAudioDelta();
      mockMgr.__simulateAiToolCall('evaluate_and_move_next', {
        user_response_quality: turn.aiGraded,
        feedback_text: turn.feedbackText ?? `[${turn.aiGraded}]`,
      });
      // Let any micro-tasks queued by the handler settle (anki write-back
      // is fire-and-forget, but the tool result is sent synchronously).
      await flushMicrotasks();
      mockMgr.__simulateAiResponseDone();
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
    }

    const toolResultAfter = mockMgr.sentToolResults[writesBefore] ?? null;

    perTurn.push({
      turn,
      ankiWritesAfter: collectAnkiWrites(answerCardSpy),
      statsAfter: { ...useSessionStore.getState().stats },
      toolResultAfter,
    });
  }

  return {
    ankiWrites: collectAnkiWrites(answerCardSpy),
    finalStats: { ...useSessionStore.getState().stats },
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
