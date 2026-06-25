/**
 * sessionManager write-back edge cases NOT covered by sessionManager.test.ts.
 *
 * Cases here:
 *  1. override with no prior evaluated card (lastAnsweredCardId === null)
 *  2. stopSession / cleanup clears lastAnsweredCardId and lastAnsweredCardOrd
 *  3. write-back is truly fire-and-forget: sendToolResult is called before
 *     the answerCard promise settles, even when answerCard is slow
 *  4. write-back uses the card's identity AT THE TIME OF EVALUATION (before
 *     the cache index advances) — regression guard for "stale ord" bug
 */

const mockSendToolResult = jest.fn();
const mockSendTextMessage = jest.fn();
const mockSendEvent = jest.fn();
const mockSetMicrophoneMuted = jest.fn();
const mockUpdateSession = jest.fn().mockResolvedValue(undefined);
const mockOn = jest.fn();
const mockOff = jest.fn();
const mockOffAll = jest.fn();
const mockConnect = jest.fn().mockResolvedValue(true);
const mockDisconnect = jest.fn();
const mockReconnect = jest.fn().mockResolvedValue(true);
const mockWaitForNextResponseDone = jest.fn().mockResolvedValue(undefined);
const mockGetAudioStats = jest.fn().mockResolvedValue({ bytesSent: 0, packetsSent: 0 });
const mockDebugAudioTrackState = jest.fn().mockResolvedValue(undefined);

jest.mock('expo-foreground-audio', () => ({
  __esModule: true,
  default: { addListener: jest.fn().mockReturnValue({ remove: jest.fn() }) },
}));

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
      setItem: jest.fn((k: string, v: string) => { store.set(k, v); return Promise.resolve(); }),
      removeItem: jest.fn((k: string) => { store.delete(k); return Promise.resolve(); }),
      clear: jest.fn(() => { store.clear(); return Promise.resolve(); }),
    },
  };
});

jest.mock('../realtimeManager', () => ({
  realtimeManager: {
    connect: (...a: any[]) => mockConnect(...a),
    disconnect: (...a: any[]) => mockDisconnect(...a),
    reconnect: (...a: any[]) => mockReconnect(...a),
    setMicrophoneMuted: (...a: any[]) => mockSetMicrophoneMuted(...a),
    updateSession: (...a: any[]) => mockUpdateSession(...a),
    sendTextMessage: (...a: any[]) => mockSendTextMessage(...a),
    sendToolResult: (...a: any[]) => mockSendToolResult(...a),
    sendEvent: (...a: any[]) => mockSendEvent(...a),
    on: (...a: any[]) => mockOn(...a),
    off: (...a: any[]) => mockOff(...a),
    offAll: (...a: any[]) => mockOffAll(...a),
    waitForNextResponseDone: (...a: any[]) => mockWaitForNextResponseDone(...a),
    getAudioStats: (...a: any[]) => mockGetAudioStats(...a),
    debugAudioTrackState: (...a: any[]) => mockDebugAudioTrackState(...a),
    onConnectionDropped: null as null | (() => void),
    stopCurrentAudio: jest.fn(),
  },
}));

const mockAnswerCard = jest.fn().mockResolvedValue(true);
const mockTriggerSync = jest.fn().mockResolvedValue(undefined);
const mockGetDueCardsBridge = jest.fn().mockResolvedValue([]);
jest.mock('../../native/ankiBridge', () => ({
  ankiBridge: {
    answerCard: (...a: any[]) => mockAnswerCard(...a),
    triggerSync: (...a: any[]) => mockTriggerSync(...a),
    getDueCards: (...a: any[]) => mockGetDueCardsBridge(...a),
  },
}));

const mockLoadDueCards = jest.fn();
const mockGetCurrentCard = jest.fn();
const mockPeekNextCard = jest.fn();
const mockPeekRemainingAfterAdvance = jest.fn();
const mockGetRemainingCardCount = jest.fn();
const mockGetTotalCardCount = jest.fn();
const mockAdvanceCacheIndex = jest.fn();
const mockFetchAndAppendNextCard = jest.fn();

jest.mock('../cardLoader', () => ({
  loadDueCards: (...a: any[]) => mockLoadDueCards(...a),
  getCurrentCard: (...a: any[]) => mockGetCurrentCard(...a),
  peekNextCard: (...a: any[]) => mockPeekNextCard(...a),
  peekRemainingAfterAdvance: (...a: any[]) => mockPeekRemainingAfterAdvance(...a),
  getRemainingCardCount: (...a: any[]) => mockGetRemainingCardCount(...a),
  getTotalCardCount: (...a: any[]) => mockGetTotalCardCount(...a),
  advanceCacheIndex: (...a: any[]) => mockAdvanceCacheIndex(...a),
  fetchAndAppendNextCard: (...a: any[]) => mockFetchAndAppendNextCard(...a),
  clearCards: jest.fn(),
}));

jest.mock('../../services/foregroundAudioService', () => ({
  startForegroundService: jest.fn().mockResolvedValue(undefined),
  stopForegroundService: jest.fn().mockResolvedValue(undefined),
  updateForegroundNotification: jest.fn().mockResolvedValue(undefined),
  requestAudioFocus: jest.fn().mockResolvedValue(undefined),
  clearAudioFocusPauseFlag: jest.fn(),
  isServiceRunning: jest.fn().mockReturnValue(false),
}));

const mockSfxPlay = jest.fn();
const mockSfxStop = jest.fn();
const mockSfxPreload = jest.fn();
jest.mock('../sfxPlayer', () => ({
  sfxPlayer: {
    play: (...a: any[]) => mockSfxPlay(...a),
    stop: (...a: any[]) => mockSfxStop(...a),
    preload: (...a: any[]) => mockSfxPreload(...a),
    release: jest.fn(),
  },
}));

jest.mock('../../services/analytics', () => ({
  AnalyticsEvents: {
    sessionStarted: jest.fn(),
    sessionEnded: jest.fn(),
    sessionCompleted: jest.fn(),
    sessionError: jest.fn(),
    sessionReconnected: jest.fn(),
    cardEvaluated: jest.fn(),
  },
}));

jest.mock('../../config/prompts', () => ({
  getSystemPrompt: jest.fn().mockReturnValue('prompt'),
  getToolDefinitions: jest.fn().mockReturnValue([]),
  getInitialMessage: jest.fn().mockReturnValue('initial'),
  getResumeMessage: jest.fn().mockReturnValue('resume'),
  formatToolResult: jest.fn().mockReturnValue({ status: 'ok' }),
  evaluateAndMoveNextTool: {},
  overrideEvaluationTool: {},
  endSessionTool: {},
  allTools: [],
}));

import { sessionManager } from '../sessionManager';
import { useSessionStore } from '../../stores/useSessionStore';
import { useSettingsStore } from '../../stores/useSettingsStore';

const CARD = { cardId: 10, cardOrd: 2, front: 'Q', back: 'A', deckName: 'Aws Exam SA' };
const NEXT_CARD = { cardId: 11, cardOrd: 0, front: 'Q2', back: 'A2', deckName: 'Aws Exam SA' };

beforeEach(() => {
  jest.clearAllMocks();
  useSessionStore.setState({ phase: 'studying', stats: { correct: 0, incorrect: 0 } });
  useSettingsStore.setState({ selectedDeck: 'Aws Exam SA' } as any);

  mockGetCurrentCard.mockReturnValue(CARD);
  mockPeekNextCard.mockReturnValue(NEXT_CARD);
  mockPeekRemainingAfterAdvance.mockReturnValue(3);
  mockGetTotalCardCount.mockReturnValue(5);
  mockGetRemainingCardCount.mockReturnValue(4);
  mockAnswerCard.mockResolvedValue(true);
  // BUG 5 v3b: refill returns the next card from the scheduler. Default
  // for these tests is NEXT_CARD; individual tests can override to null
  // (deck exhausted) or to a same-noteId card (failed answer reschedule).
  mockFetchAndAppendNextCard.mockResolvedValue(NEXT_CARD);
});

// ─── override with no prior answer ───────────────────────────────────────────

describe('override with no prior evaluated card', () => {
  it('does NOT call answerCard when lastAnsweredCardId is null', async () => {
    // Force a fresh-state sessionManager with no prior evaluation.
    (sessionManager as any).lastAnsweredCardId = null;
    (sessionManager as any).lastAnsweredCardOrd = null;
    useSessionStore.setState({ stats: { correct: 1, incorrect: 0 } });

    await (sessionManager as any).handleOverrideEvaluation('cb', { override_to: 'incorrect' });

    expect(mockAnswerCard).not.toHaveBeenCalled();
  });

  it('sends a tool result even with no prior card', async () => {
    (sessionManager as any).lastAnsweredCardId = null;
    (sessionManager as any).lastAnsweredCardOrd = null;
    useSessionStore.setState({ stats: { correct: 1, incorrect: 0 } });

    await (sessionManager as any).handleOverrideEvaluation('cb', { override_to: 'incorrect' });

    expect(mockSendToolResult).toHaveBeenCalled();
  });
});

// ─── lastAnsweredCard cleared after session ends ───────────────────────────────

describe('lastAnsweredCard fields cleared on session reset', () => {
  it('clears lastAnsweredCardId and lastAnsweredCardOrd when stopSession is called', async () => {
    // Simulate having evaluated a card.
    (sessionManager as any).lastAnsweredCardId = 42;
    (sessionManager as any).lastAnsweredCardOrd = 1;

    (sessionManager as any).endSession();

    expect((sessionManager as any).lastAnsweredCardId).toBeNull();
    expect((sessionManager as any).lastAnsweredCardOrd).toBeNull();
  });

  it('prevents a stale override write-back after session restart', async () => {
    // Simulate card evaluated → session stopped → new session hasn't evaluated yet.
    (sessionManager as any).lastAnsweredCardId = 42;
    (sessionManager as any).lastAnsweredCardOrd = 1;
    (sessionManager as any).endSession();

    // Override attempt after the session was reset.
    useSessionStore.setState({ stats: { correct: 1, incorrect: 0 } });
    await (sessionManager as any).handleOverrideEvaluation('cb2', { override_to: 'incorrect' });

    expect(mockAnswerCard).not.toHaveBeenCalled();
  });
});

// ─── answer + refill ordering (BUG 5 v3b) ────────────────────────────────────

describe('answer + refill chain (BUG 5 v3b)', () => {
  it('calls answerCard then fetchAndAppendNextCard before sending tool result', async () => {
    const order: string[] = [];
    mockAnswerCard.mockImplementation(async () => { order.push('answer'); return true; });
    mockFetchAndAppendNextCard.mockImplementation(async () => { order.push('refill'); return NEXT_CARD; });
    mockSendToolResult.mockImplementation(() => { order.push('toolResult'); });

    await (sessionManager as any).handleEvaluateAndMoveNext('c', {
      user_response_quality: 'correct',
      feedback_text: 'ok',
    });

    expect(order).toEqual(['answer', 'refill', 'toolResult']);
  });

  it('does not throw when answerCard rejects (refill still proceeds)', async () => {
    mockAnswerCard.mockRejectedValue(new Error('native crash'));

    await expect(
      (sessionManager as any).handleEvaluateAndMoveNext('c', {
        user_response_quality: 'correct',
        feedback_text: 'ok',
      })
    ).resolves.not.toThrow();

    expect(mockFetchAndAppendNextCard).toHaveBeenCalled();
    expect(mockSendToolResult).toHaveBeenCalled();
  });

  it('caps the answer+refill chain at 500ms so slow AnkiDroid does not trip Gemini cancellation', async () => {
    // answerCard hangs forever; the chain must still complete via timeout
    // and tool_result must still be sent.
    mockAnswerCard.mockReturnValue(new Promise<boolean>(() => { /* never resolves */ }));

    await (sessionManager as any).handleEvaluateAndMoveNext('c', {
      user_response_quality: 'correct',
      feedback_text: 'ok',
    });

    expect(mockSendToolResult).toHaveBeenCalled();
  });
});

// ─── SFX feedback chime ──────────────────────────────────────────────────────

describe('SFX feedback chime', () => {
  it("plays 'correct' chime when user_response_quality is correct", async () => {
    await (sessionManager as any).handleEvaluateAndMoveNext('c', {
      user_response_quality: 'correct',
      feedback_text: 'ok',
    });
    expect(mockSfxPlay).toHaveBeenCalledWith('correct');
  });

  it("plays 'incorrect' chime when user_response_quality is incorrect", async () => {
    await (sessionManager as any).handleEvaluateAndMoveNext('c', {
      user_response_quality: 'incorrect',
      feedback_text: 'no',
    });
    expect(mockSfxPlay).toHaveBeenCalledWith('incorrect');
  });

  it("does NOT play a chime when user_response_quality is skipped", async () => {
    await (sessionManager as any).handleEvaluateAndMoveNext('c', {
      user_response_quality: 'skipped',
      feedback_text: 'pass',
    });
    expect(mockSfxPlay).not.toHaveBeenCalled();
  });

  it('stops SFX on endSession (BUG 6 parity — instant-cut on user end)', () => {
    (sessionManager as any).endSession();
    expect(mockSfxStop).toHaveBeenCalled();
  });

  it('stops SFX on endSessionFromNotification', async () => {
    await (sessionManager as any).endSessionFromNotification();
    expect(mockSfxStop).toHaveBeenCalled();
  });
});

// ─── write-back uses card identity AT evaluation time ─────────────────────────

describe('write-back uses card identity at evaluation time', () => {
  it('writes noteId/cardOrd from the card that was CURRENT during evaluate, not the next card', async () => {
    // card A is current; card B is next.
    const cardA = { cardId: 100, cardOrd: 3, front: 'A', back: 'a', deckName: 'Aws Exam SA' };
    const cardB = { cardId: 200, cardOrd: 0, front: 'B', back: 'b', deckName: 'Aws Exam SA' };

    mockGetCurrentCard.mockReturnValue(cardA);
    mockPeekNextCard.mockReturnValue(cardB);
    mockPeekRemainingAfterAdvance.mockReturnValue(1);

    await (sessionManager as any).handleEvaluateAndMoveNext('c', {
      user_response_quality: 'correct',
      feedback_text: 'ok',
    });

    // Must write cardA's identity, not cardB's.
    expect(mockAnswerCard).toHaveBeenCalledWith('Aws Exam SA', 100, 3, true);
    expect(mockAnswerCard).not.toHaveBeenCalledWith('Aws Exam SA', 200, 0, true);
  });

  it('stores the last-answered card for a subsequent override', async () => {
    const card = { cardId: 500, cardOrd: 1, front: 'X', back: 'x', deckName: 'Aws Exam SA' };
    mockGetCurrentCard.mockReturnValue(card);
    mockPeekNextCard.mockReturnValue(NEXT_CARD);
    mockPeekRemainingAfterAdvance.mockReturnValue(2);

    await (sessionManager as any).handleEvaluateAndMoveNext('c', {
      user_response_quality: 'incorrect',
      feedback_text: 'Wrong.',
    });

    // lastAnswered fields must point to the evaluated card.
    expect((sessionManager as any).lastAnsweredCardId).toBe(500);
    expect((sessionManager as any).lastAnsweredCardOrd).toBe(1);
  });

  it('override after evaluate writes to the same (noteId, ord) as the prior evaluate', async () => {
    const card = { cardId: 500, cardOrd: 1, front: 'X', back: 'x', deckName: 'Aws Exam SA' };
    mockGetCurrentCard.mockReturnValue(card);
    mockPeekNextCard.mockReturnValue(NEXT_CARD);
    mockPeekRemainingAfterAdvance.mockReturnValue(2);
    useSessionStore.setState({ stats: { correct: 0, incorrect: 1 } });

    // First evaluate card 500 as incorrect.
    await (sessionManager as any).handleEvaluateAndMoveNext('c1', {
      user_response_quality: 'incorrect',
      feedback_text: 'Wrong.',
    });
    jest.clearAllMocks();

    // Then override it to correct — must write to card 500, not the new current card.
    await (sessionManager as any).handleOverrideEvaluation('c2', { override_to: 'correct' });

    expect(mockAnswerCard).toHaveBeenCalledWith('Aws Exam SA', 500, 1, true);
  });
});
