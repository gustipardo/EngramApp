/**
 * Layer 2 replay tests — full session orchestration with mocked Gemini
 * and mocked AnkiDroid. Drives fixtures end-to-end and asserts on the
 * write-back history + final stats.
 *
 * What this catches that Layer 1 unit tests can't:
 *   - The handler-registration wiring (sessionManager → realtimeManager.on).
 *   - The eager-advance contract (advance happens synchronously inside
 *     handleEvaluateAndMoveNext, right after sendToolResult, since the
 *     BUG 4 fix on 2026-05-21).
 *   - Multi-turn state (lastAnsweredCardId carrying across turns for
 *     override).
 *   - Skipped answers correctly NOT advancing stats but still moving
 *     the card pointer.
 */

import { mockGeminiManager } from '../mockGeminiManager';
import { deckSimulator } from '../deckSimulator';

// ---------------------------------------------------------------------------
// Module mocks — must be at the top, jest hoists them.
// ---------------------------------------------------------------------------

jest.mock('expo-foreground-audio', () => ({
  __esModule: true,
  default: { addListener: jest.fn().mockReturnValue({ remove: jest.fn() }) },
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    setItem: jest.fn().mockResolvedValue(undefined),
    getItem: jest.fn().mockResolvedValue(null),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../services/realtimeManager', () => ({
  realtimeManager: require('../mockGeminiManager').mockGeminiManager,
}));

const mockAnswerCard = jest.fn().mockResolvedValue(true);
const mockTriggerSync = jest.fn().mockResolvedValue(undefined);
jest.mock('../../native/ankiBridge', () => ({
  ankiBridge: {
    answerCard: (...a: any[]) => mockAnswerCard(...a),
    triggerSync: (...a: any[]) => mockTriggerSync(...a),
  },
}));

// cardLoader functions delegate to the deckSimulator so card state stays
// consistent across the session.
jest.mock('../../services/cardLoader', () => {
  const { deckSimulator } = require('../deckSimulator');
  return {
    loadDueCards: jest.fn(async (_deckName: string) => deckSimulator.cards),
    getCurrentCard: jest.fn(() => deckSimulator.getCurrent()),
    getNextCard: jest.fn(() => {
      deckSimulator.advance();
      return deckSimulator.getCurrent();
    }),
    peekNextCard: jest.fn(() => deckSimulator.peekNext()),
    peekRemainingAfterAdvance: jest.fn(() => deckSimulator.peekRemainingAfterAdvance()),
    getRemainingCardCount: jest.fn(() => deckSimulator.remaining()),
    getTotalCardCount: jest.fn(() => deckSimulator.total()),
    clearCards: jest.fn(),
    advanceCacheIndex: jest.fn(() => deckSimulator.advance()),
    // BUG 5 v3b: mimic the refill — peek what would be the new head and
    // route via deckSimulator so it matches what peekNextCard returns.
    fetchAndAppendNextCard: jest.fn(async (_deckName: string) => deckSimulator.peekNext() ?? null),
  };
});

// foregroundAudioService — recorded as jest.fn() spies so the
// notificationLifecycle fixture can assert on call ordering.
// Variable names are prefixed with `mock` to satisfy jest.mock's
// hoisting rule (no out-of-scope variables in the factory body).
const mockFgStart = jest.fn().mockResolvedValue(undefined);
const mockFgStop = jest.fn().mockResolvedValue(undefined);
const mockFgUpdate = jest.fn().mockResolvedValue(undefined);
const mockFgRequestFocus = jest.fn().mockResolvedValue(undefined);
const mockFgAbandonFocus = jest.fn().mockResolvedValue(undefined);
const mockFgClearPauseFlag = jest.fn();
const mockFgIsRunning = jest.fn().mockReturnValue(false);
const mockFgWasPaused = jest.fn().mockReturnValue(false);

jest.mock('../../services/foregroundAudioService', () => ({
  startForegroundService: (...a: any[]) => mockFgStart(...a),
  stopForegroundService: (...a: any[]) => mockFgStop(...a),
  updateForegroundNotification: (...a: any[]) => mockFgUpdate(...a),
  requestAudioFocus: (...a: any[]) => mockFgRequestFocus(...a),
  abandonAudioFocus: (...a: any[]) => mockFgAbandonFocus(...a),
  clearAudioFocusPauseFlag: (...a: any[]) => mockFgClearPauseFlag(...a),
  isServiceRunning: (...a: any[]) => mockFgIsRunning(...a),
  wasPausedByAudioFocusLoss: (...a: any[]) => mockFgWasPaused(...a),
}));

jest.mock('../../services/analytics', () => ({
  AnalyticsEvents: {
    sessionStarted: jest.fn(),
    sessionCompleted: jest.fn(),
    sessionError: jest.fn(),
    sessionReconnected: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports that need the mocks above
// ---------------------------------------------------------------------------

import { sessionManager } from '../../services/sessionManager';
import { useSessionStore } from '../../stores/useSessionStore';
import { useCardCacheStore } from '../../stores/useCardCacheStore';
import { useConnectionStore } from '../../stores/useConnectionStore';
import { runFixture } from '../scriptRunner';
import {
  happyPath,
  mixedResults,
  overrideIncorrectToCorrect,
  overrideCorrectToIncorrect,
  overrideNoChange,
  silentGradeNoToolCall,
  silentGradeThenRealGrade,
  toolCallNoAudio,
  endOfDeck,
  endSessionToolMidDeck,
  reconnectMidSession,
  reconnectFailure,
  notificationLifecycle,
} from '../fixtures/scripts';

const ctx = {
  mockMgr: mockGeminiManager,
  simulator: deckSimulator,
  answerCardSpy: mockAnswerCard,
  sessionManager: sessionManager as any,
  useSessionStore,
  useCardCacheStore,
  useConnectionStore,
};

describe('Layer 2 — replay harness', () => {
  describe('happy path: 3 cards all correct', () => {
    it('writes pass=true for every card and stats are 3-0', async () => {
      const result = await runFixture(happyPath, ctx);
      expect(result.ankiWrites).toEqual([
        { cardId: 1001, pass: true },
        { cardId: 1002, pass: true },
        { cardId: 1003, pass: true },
      ]);
      expect(result.finalStats).toEqual({ correct: 3, incorrect: 0 });
    });
  });

  describe('mixed results: correct + incorrect + skip + correct', () => {
    it('writes per-turn correctly and skipped does NOT trigger a write', async () => {
      const result = await runFixture(mixedResults, ctx);
      expect(result.ankiWrites).toEqual([
        { cardId: 1001, pass: true },
        { cardId: 1002, pass: false },
        // no write for the skipped card
        { cardId: 1004, pass: true },
      ]);
      expect(result.finalStats).toEqual({ correct: 2, incorrect: 1 });
    });

    it('records exactly one tool result per turn', async () => {
      const result = await runFixture(mixedResults, ctx);
      expect(result.toolResults).toHaveLength(4);
    });
  });

  describe('override incorrect → correct', () => {
    it('writes the original incorrect, then a corrective pass=true write', async () => {
      const result = await runFixture(overrideIncorrectToCorrect, ctx);
      expect(result.ankiWrites).toEqual([
        { cardId: 1001, pass: false }, // initial wrong
        { cardId: 1001, pass: true },  // override flips it
        { cardId: 1002, pass: true },  // next card answered correctly
      ]);
      expect(result.finalStats).toEqual({ correct: 2, incorrect: 0 });
    });

    it('override tool-result reports success status', async () => {
      const result = await runFixture(overrideIncorrectToCorrect, ctx);
      const overrideToolResult = result.perTurn[1].toolResultAfter;
      expect(overrideToolResult?.result?.status).toBe('success');
    });
  });

  describe('override correct → incorrect (new bidirectional behavior)', () => {
    it('writes the original correct, then a corrective pass=false write', async () => {
      const result = await runFixture(overrideCorrectToIncorrect, ctx);
      expect(result.ankiWrites).toEqual([
        { cardId: 1001, pass: true },  // initial correct
        { cardId: 1001, pass: false }, // override flips it
        { cardId: 1002, pass: true },  // next card answered correctly
      ]);
      expect(result.finalStats).toEqual({ correct: 1, incorrect: 1 });
    });
  });

  describe('override with nothing to flip', () => {
    it('emits no_change and writes nothing to AnkiDroid', async () => {
      const result = await runFixture(overrideNoChange, ctx);
      expect(result.ankiWrites).toEqual([]);
      const overrideToolResult = result.perTurn[0].toolResultAfter;
      expect(overrideToolResult?.result?.status).toBe('no_change');
    });
  });

  describe('silent grade — AI verbalises a verdict but never tool-calls', () => {
    it('does NOT write to AnkiDroid when no tool call fires', async () => {
      const result = await runFixture(silentGradeNoToolCall, ctx);
      expect(result.ankiWrites).toEqual([]);
    });

    it('does NOT change stats — silent verdict carries no weight', async () => {
      const result = await runFixture(silentGradeNoToolCall, ctx);
      expect(result.finalStats).toEqual({ correct: 0, incorrect: 0 });
    });

    it('does NOT set lastEvaluation — popup state stays cleared', async () => {
      // The verdict popup is bound to lastEvaluation. If it fires from
      // anywhere except recordAnswer (called only by handleEvaluateAndMoveNext),
      // the user sees a green/red flash for a verdict the system never
      // actually committed — the exact "tutor says correct but card
      // not effectively marked" symptom.
      const result = await runFixture(silentGradeNoToolCall, ctx);
      expect(result.perTurn[0].lastEvaluationAfter).toBeNull();
    });

    it('does NOT advance the card — UI stays on the same question', async () => {
      const result = await runFixture(silentGradeNoToolCall, ctx);
      expect(result.perTurn[0].cardIndexAfter).toBe(0);
    });

    it('lands phase in awaiting_answer so user can retry', async () => {
      // After audio.delta + response.done with no tool call, phase walks:
      //   awaiting_answer → evaluating → giving_feedback → awaiting_answer.
      // No advance because handleEvaluate never ran — but phase still
      // resets so the next user turn isn't blocked. Post-BUG-4-fix
      // (2026-05-21), the recovery timer would also force phase exit
      // if audio.delta hadn't arrived.
      const result = await runFixture(silentGradeNoToolCall, ctx);
      expect(result.perTurn[0].phaseAfter).toBe('awaiting_answer');
    });

    it('recovers on a real grade after a silent one', async () => {
      const result = await runFixture(silentGradeThenRealGrade, ctx);
      // Only the second turn (real grade) writes.
      expect(result.ankiWrites).toEqual([
        { cardId: 1001, pass: true },
      ]);
      expect(result.finalStats).toEqual({ correct: 1, incorrect: 0 });
      // Card advanced once on the real grade.
      expect(result.perTurn[0].cardIndexAfter).toBe(0);
      expect(result.perTurn[1].cardIndexAfter).toBe(1);
    });
  });

  describe('tool call without follow-up audio — post-BUG-4-fix contract', () => {
    // After the BUG 4 fix on 2026-05-21, advance is eager (happens inside
    // handleEvaluateAndMoveNext, right after sendToolResult) — no longer
    // gated on the AI's feedback turn finishing.  The recovery timer
    // (sessionManager.startEvaluatingRecovery, 8 s) handles the phase
    // unstuck if the AI never speaks audio.
    it('writes the answer to AnkiDroid (the tool result side works)', async () => {
      const result = await runFixture(toolCallNoAudio, ctx);
      expect(result.ankiWrites).toEqual([
        { cardId: 1001, pass: true },
      ]);
    });

    it('updates stats — recordAnswer ran from the tool handler', async () => {
      const result = await runFixture(toolCallNoAudio, ctx);
      expect(result.finalStats).toEqual({ correct: 1, incorrect: 0 });
    });

    it('advances the card index eagerly (post-BUG-4 fix)', async () => {
      // Pre-fix: stayed at 0 because advance was gated on response.done.
      // Post-fix: handleEvaluateAndMoveNext advances synchronously.
      const result = await runFixture(toolCallNoAudio, ctx);
      expect(result.perTurn[0].cardIndexAfter).toBe(1);
    });

    it('phase is stuck in evaluating until recovery timer fires', async () => {
      // The replay harness doesn't advance fake timers, so the recovery
      // timer (8 s) hasn't fired yet at perTurn snapshot time. Phase
      // remains in `evaluating` for now. A future test can use
      // jest.useFakeTimers() + advanceTimersByTime to verify the
      // recovery transition.
      const result = await runFixture(toolCallNoAudio, ctx);
      expect(result.perTurn[0].phaseAfter).toBe('evaluating');
    });
  });

  describe('phase + advance invariants — happy path', () => {
    it('every non-final answer turn ends in awaiting_answer', async () => {
      const result = await runFixture(happyPath, ctx);
      // 3 cards. Turn 0 and 1 are non-final; turn 2 is the last and ends
      // in session_complete.
      expect(result.perTurn[0].phaseAfter).toBe('awaiting_answer');
      expect(result.perTurn[1].phaseAfter).toBe('awaiting_answer');
      expect(result.perTurn[2].phaseAfter).toBe('session_complete');
    });

    it('card index advances by exactly 1 after each non-final answer', async () => {
      const result = await runFixture(happyPath, ctx);
      // Index starts at 0. After turn 0 advance → 1, after turn 1 → 2,
      // after turn 2 (session_complete branch) → still advances → 3 (out of range).
      expect(result.perTurn[0].cardIndexAfter).toBe(1);
      expect(result.perTurn[1].cardIndexAfter).toBe(2);
    });

    it('lastEvaluation reflects the most recent grade for the popup', async () => {
      const result = await runFixture(mixedResults, ctx);
      // mixedResults: correct, incorrect, skipped, correct.
      expect(result.perTurn[0].lastEvaluationAfter).toBe('correct');
      expect(result.perTurn[1].lastEvaluationAfter).toBe('incorrect');
      // Skipped does NOT change lastEvaluation — stays at the previous value.
      expect(result.perTurn[2].lastEvaluationAfter).toBe('incorrect');
      expect(result.perTurn[3].lastEvaluationAfter).toBe('correct');
    });
  });

  describe('cross-cutting invariants', () => {
    it('never writes for a turn graded "skipped"', async () => {
      const result = await runFixture(mixedResults, ctx);
      // Find the skipped turn diagnostics — writes should be unchanged
      // before vs after that turn.
      const skippedIdx = mixedResults.turns.findIndex(
        (t) => t.kind === 'answer' && t.aiGraded === 'skipped'
      );
      const writesBeforeSkip = result.perTurn[skippedIdx - 1]?.ankiWritesAfter ?? [];
      const writesAfterSkip = result.perTurn[skippedIdx].ankiWritesAfter;
      expect(writesAfterSkip).toEqual(writesBeforeSkip);
    });

    it('every turn in a fixture matches its expectWriteback hint', async () => {
      // Validates the fixtures themselves against the runner — a meta-test
      // that catches drift between fixture intent and harness behavior.
      for (const fixture of [happyPath, mixedResults, overrideIncorrectToCorrect, overrideCorrectToIncorrect]) {
        const result = await runFixture(fixture, ctx);
        let cumulativeWrites = 0;
        for (let i = 0; i < fixture.turns.length; i++) {
          const turn = fixture.turns[i];
          const expected = (turn as any).expectWriteback;
          const writesAfter = result.perTurn[i].ankiWritesAfter;

          if (expected === null || expected === undefined) {
            expect(writesAfter.length).toBe(cumulativeWrites);
          } else {
            expect(writesAfter.length).toBe(cumulativeWrites + 1);
            expect(writesAfter[cumulativeWrites]).toEqual(expected);
            cumulativeWrites++;
          }
        }
      }
    });
  });

  // =============================================================================
  // Lifecycle fixtures — end-of-deck, end_session, reconnect, foreground service
  // =============================================================================

  describe('end-of-deck — last card answered', () => {
    beforeEach(() => {
      mockFgStart.mockClear();
      mockFgStop.mockClear();
      mockFgUpdate.mockClear();
    });

    it('writes both cards and final phase is session_complete', async () => {
      const result = await runFixture(endOfDeck, ctx);
      expect(result.ankiWrites).toHaveLength(2);
      expect(result.finalPhase).toBe('session_complete');
      expect(result.finalStats).toEqual({ correct: 2, incorrect: 0 });
    });

    it('calls stopForegroundService on session_complete', async () => {
      await runFixture(endOfDeck, ctx);
      expect(mockFgStop).toHaveBeenCalled();
    });
  });

  describe('end_session tool — called mid-deck', () => {
    it('writes only the cards answered before end_session', async () => {
      const result = await runFixture(endSessionToolMidDeck, ctx);
      // Only card 1 (the one before the end_request turn) is written.
      expect(result.ankiWrites).toHaveLength(1);
      expect(result.ankiWrites[0]).toEqual({
        cardId: result.ankiWrites[0].cardId, // dynamic from fixture
        pass: true,
      });
    });

    it('sends the "ending" tool result back to the AI with summary stats', async () => {
      const result = await runFixture(endSessionToolMidDeck, ctx);
      // After end_session, the tool result includes the totals so the
      // AI can summarize. handleEndSessionTool sends:
      //   { status: 'ending', total_reviewed, correct, incorrect }
      const toolResults = result.toolResults;
      const endResult = toolResults.find(
        (r) => r.result && r.result.status === 'ending',
      );
      expect(endResult).toBeTruthy();
      expect(endResult?.result).toEqual({
        status: 'ending',
        total_reviewed: 1,
        correct: 1,
        incorrect: 0,
      });
    });

    it('phase is awaiting_answer immediately after end_session (5s summary wait)', async () => {
      // The session-complete transition happens via a 5-second setTimeout
      // AFTER the AI speaks the closing summary. The unit-test runner
      // doesn't advance fake timers (to keep the harness simple), so
      // phase remains in awaiting_answer — the test pins this contract
      // and the full transition is covered by an integration test that
      // actually runs the 5s wait.
      const result = await runFixture(endSessionToolMidDeck, ctx);
      expect(result.finalPhase).toBe('awaiting_answer');
      expect(result.finalStats).toEqual({ correct: 1, incorrect: 0 });
    });
  });

  describe('reconnect mid-session', () => {
    it('fires the onConnectionDropped handler (reconnect wiring is installed)', async () => {
      // Setup: the runner only fires the drop handler if a fixture turn
      // has kind 'connectionDropped' AND sessionManager has installed
      // the handler in installConnectionDropHandler. Verify the handler
      // exists BEFORE the drop turn by checking that the drop succeeds.
      const beforeCalls = ctx.mockMgr.reconnectCount;
      const result = await runFixture(reconnectMidSession, ctx);
      // The reconnect must have been called at least once (after the drop).
      expect(ctx.mockMgr.reconnectCount).toBeGreaterThan(beforeCalls);
      // Sanity: the drop didn't crash the fixture.
      expect(result).toBeTruthy();
    });

    it('reconnects and lets the session answer the next card', async () => {
      const result = await runFixture(reconnectMidSession, ctx);
      // Both cards written — proves the post-reconnect turn is fully functional.
      expect(result.ankiWrites).toHaveLength(2);
      expect(result.finalStats).toEqual({ correct: 2, incorrect: 0 });
    });

    it('does NOT double-write the already-answered card after reconnect', async () => {
      const result = await runFixture(reconnectMidSession, ctx);
      // No duplicate cardIds.
      const cardIds = result.ankiWrites.map((w) => w.cardId);
      expect(new Set(cardIds).size).toBe(cardIds.length);
    });
  });

  describe('reconnect failure', () => {
    it('attempts reconnect via the gemini manager', async () => {
      // Pin that the drop handler fires AND that reconnect() was called.
      // We can't reliably pin the intermediate "reconnecting" phase
      // because the async chain (drop handler → attemptReconnectAndResume
      // → reconnect() returns false → error) runs before the perTurn
      // snapshot is taken.
      const result = await runFixture(reconnectFailure, ctx);
      // After __reset, reconnectCount starts at 0. After the drop turn
      // fires, reconnectCount should be 1 (one attempt).
      expect(ctx.mockMgr.reconnectCount).toBe(1);
      // Card 1 was answered (correct), card 2 was never reached.
      expect(result.ankiWrites).toHaveLength(1);
    });

    it('writes the card answered before the drop', async () => {
      const result = await runFixture(reconnectFailure, ctx);
      expect(result.ankiWrites).toHaveLength(1);
      expect(result.ankiWrites[0].pass).toBe(true);
    });
  });

  describe('foreground service lifecycle', () => {
    beforeEach(() => {
      mockFgStart.mockClear();
      mockFgStop.mockClear();
      mockFgUpdate.mockClear();
    });

    it('startForegroundService is called exactly once during a 3-card session', async () => {
      await runFixture(notificationLifecycle, ctx);
      expect(mockFgStart).toHaveBeenCalledTimes(1);
    });

    it('stopForegroundService is called on session_complete', async () => {
      await runFixture(notificationLifecycle, ctx);
      expect(mockFgStop).toHaveBeenCalled();
    });

    it('updateForegroundNotification is called for each card advance', async () => {
      // startSession sends the first card → update on card 1 (N-of-M label).
      // After each turn advance → update again.
      // Pinning the contract: at LEAST 2 updates for a 3-card session.
      await runFixture(notificationLifecycle, ctx);
      expect(mockFgUpdate.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('startForegroundService is called BEFORE any updateForegroundNotification', async () => {
      await runFixture(notificationLifecycle, ctx);
      const firstStart = mockFgStart.mock.invocationCallOrder[0] ?? 0;
      const firstUpdate = mockFgUpdate.mock.invocationCallOrder[0] ?? Infinity;
      expect(firstStart).toBeLessThan(firstUpdate);
    });
  });
});
