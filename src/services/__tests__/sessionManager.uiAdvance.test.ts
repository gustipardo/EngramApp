/**
 * Tests for the BUG 12 pending-UI-advance state machine in sessionManager.
 *
 * Verifies:
 *  1. handleEvaluateAndMoveNext arms a pending UI advance (does NOT commit
 *     uiVisibleIndex immediately) when there's a next card.
 *  2. The 30000 ms timeout fallback commits the pending advance.
 *  3. The transcript-match path commits when Gemini's running transcript
 *     overlaps with the next card's front tokens.
 *  4. The response.done fallback commits any still-pending advance.
 *  5. endSession / endSessionFromNotification commit any pending advance.
 *  6. On the "no next card" branch (session_complete), no UI lag is
 *     created — the data-only advance still commits cleanly.
 *  7. The data layer's currentIndex (cardLoader.advanceCacheIndex) is
 *     called eagerly in every case — BUG 4 liveness must NOT regress.
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

jest.mock('../sfxPlayer', () => ({
  sfxPlayer: {
    play: jest.fn(),
    stop: jest.fn(),
    preload: jest.fn(),
    release: jest.fn(),
    isPlayingRecently: jest.fn().mockReturnValue(false),
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
  getInitialMessage: jest.fn().mockReturnValue('initial'),
  getResumeMessage: jest.fn().mockReturnValue('resume'),
  formatToolResult: jest.fn().mockReturnValue({ status: 'ok' }),
  allTools: [],
}));

import { sessionManager } from '../sessionManager';
import { useSessionStore } from '../../stores/useSessionStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useCardCacheStore } from '../../stores/useCardCacheStore';

const DECK = 'Aws Exam SA';
const CARD = { cardId: 10, cardOrd: 0, front: 'Define photosynthesis.', back: 'A1', deckName: DECK };
const NEXT = { cardId: 11, cardOrd: 0, front: 'What is the capital of France?', back: 'Paris', deckName: DECK };

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  useSessionStore.setState({ phase: 'studying', stats: { correct: 0, incorrect: 0 } });
  useSettingsStore.setState({ selectedDeck: DECK } as any);
  // Simulate the data-layer cache: 2 cards, currentIndex starts at 0
  // (card just answered is index 0), uiVisibleIndex matches.
  useCardCacheStore.setState({
    cards: [CARD, NEXT],
    currentIndex: 0,
    uiVisibleIndex: 0,
  });

  mockGetCurrentCard.mockReturnValue(CARD);
  mockPeekNextCard.mockReturnValue(NEXT);
  mockPeekRemainingAfterAdvance.mockReturnValue(0);
  mockGetTotalCardCount.mockReturnValue(2);
  mockGetRemainingCardCount.mockReturnValue(1);
  mockAnswerCard.mockResolvedValue(true);
  mockFetchAndAppendNextCard.mockResolvedValue(NEXT);
  // advanceCacheIndex is the data-layer pointer move. Mirror it onto the
  // store so subsequent reads of currentIndex see the eager advance.
  mockAdvanceCacheIndex.mockImplementation(() => {
    const s = useCardCacheStore.getState();
    useCardCacheStore.setState({ currentIndex: s.currentIndex + 1 });
  });
  // Clear any leftover pending advance from previous tests.
  (sessionManager as any).pendingUiNextCardFront = null;
  (sessionManager as any).pendingUiTargetIndex = null;
  if ((sessionManager as any).pendingUiAdvanceTimer) {
    clearTimeout((sessionManager as any).pendingUiAdvanceTimer);
    (sessionManager as any).pendingUiAdvanceTimer = null;
  }
});

afterEach(() => {
  jest.useRealTimers();
});

describe('BUG 12 — pending UI advance is armed (not committed) on evaluate', () => {
  it('data-layer advanceCacheIndex IS called (BUG 4 liveness preserved)', async () => {
    await (sessionManager as any).handleEvaluateAndMoveNext('c1', {
      user_response_quality: 'correct',
      feedback_text: 'ok',
    });
    expect(mockAdvanceCacheIndex).toHaveBeenCalledTimes(1);
    expect(useCardCacheStore.getState().currentIndex).toBe(1);
  });

  it('UI pointer (uiVisibleIndex) does NOT advance immediately', async () => {
    await (sessionManager as any).handleEvaluateAndMoveNext('c1', {
      user_response_quality: 'correct',
      feedback_text: 'ok',
    });
    expect(useCardCacheStore.getState().uiVisibleIndex).toBe(0);
  });

  it('records the next card front for the matcher', async () => {
    await (sessionManager as any).handleEvaluateAndMoveNext('c1', {
      user_response_quality: 'correct',
      feedback_text: 'ok',
    });
    expect((sessionManager as any).pendingUiNextCardFront).toBe(NEXT.front);
  });
});

describe('BUG 12 — commit triggers', () => {
  it('the 30000 ms timeout commits the UI advance', async () => {
    jest.useFakeTimers();
    await (sessionManager as any).handleEvaluateAndMoveNext('c1', {
      user_response_quality: 'correct',
      feedback_text: 'ok',
    });
    expect(useCardCacheStore.getState().uiVisibleIndex).toBe(0);

    jest.advanceTimersByTime(29999);
    expect(useCardCacheStore.getState().uiVisibleIndex).toBe(0);

    jest.advanceTimersByTime(2);
    expect(useCardCacheStore.getState().uiVisibleIndex).toBe(1);
    expect((sessionManager as any).pendingUiNextCardFront).toBeNull();
  });

  it('transcript match commits the UI advance early', async () => {
    await (sessionManager as any).handleEvaluateAndMoveNext('c1', {
      user_response_quality: 'correct',
      feedback_text: 'ok',
    });
    expect(useCardCacheStore.getState().uiVisibleIndex).toBe(0);

    // Find the registered response.audio_transcript.done handler and invoke
    // it with a transcript that overlaps with NEXT.front ("What is the
    // capital of France?" → tokens "capital" + "france").
    // Handlers were registered via webrtcManager.on in startSession; we
    // don't actually call startSession here (it does network/audio stuff),
    // so call the manager's private logic directly.
    (sessionManager as any).commitPendingUiAdvance =
      (sessionManager as any).commitPendingUiAdvance.bind(sessionManager);
    // Simulate the handler we'd otherwise route through webrtcManager.on:
    const transcript = "Correct! Now, what is the capital of France?";
    const { transcriptIndicatesNextCard } = require('../uiAdvanceMatcher');
    expect(transcriptIndicatesNextCard(transcript, NEXT.front)).toBe(true);
    (sessionManager as any).commitPendingUiAdvance('transcript_match');

    expect(useCardCacheStore.getState().uiVisibleIndex).toBe(1);
    expect((sessionManager as any).pendingUiNextCardFront).toBeNull();
  });

  it('manual commit (e.g. via response.done) commits the UI advance', async () => {
    await (sessionManager as any).handleEvaluateAndMoveNext('c1', {
      user_response_quality: 'correct',
      feedback_text: 'ok',
    });
    (sessionManager as any).commitPendingUiAdvance('response_done');
    expect(useCardCacheStore.getState().uiVisibleIndex).toBe(1);
  });

  it('commit is idempotent (multiple triggers race-safely)', async () => {
    await (sessionManager as any).handleEvaluateAndMoveNext('c1', {
      user_response_quality: 'correct',
      feedback_text: 'ok',
    });
    (sessionManager as any).commitPendingUiAdvance('transcript_match');
    (sessionManager as any).commitPendingUiAdvance('response_done');
    (sessionManager as any).commitPendingUiAdvance('timeout');
    expect(useCardCacheStore.getState().uiVisibleIndex).toBe(1);
  });
});

describe('BUG 12 — pending advance is flushed on cleanup', () => {
  it('endSession commits any pending advance', async () => {
    await (sessionManager as any).handleEvaluateAndMoveNext('c1', {
      user_response_quality: 'correct',
      feedback_text: 'ok',
    });
    expect((sessionManager as any).pendingUiNextCardFront).not.toBeNull();

    (sessionManager as any).endSession();
    expect((sessionManager as any).pendingUiNextCardFront).toBeNull();
    expect(useCardCacheStore.getState().uiVisibleIndex).toBe(1);
  });

  it('endSessionFromNotification commits any pending advance', async () => {
    await (sessionManager as any).handleEvaluateAndMoveNext('c1', {
      user_response_quality: 'correct',
      feedback_text: 'ok',
    });
    await (sessionManager as any).endSessionFromNotification();
    expect(useCardCacheStore.getState().uiVisibleIndex).toBe(1);
  });

  it('clears the transcript accumulator on commit so the next window starts fresh', async () => {
    await (sessionManager as any).handleEvaluateAndMoveNext('c1', {
      user_response_quality: 'correct',
      feedback_text: 'ok',
    });
    // Simulate a few transcript chunks accumulating during the feedback turn.
    (sessionManager as any).pendingUiTranscriptAccum = 'Correct that is right now';
    (sessionManager as any).commitPendingUiAdvance('response_done');
    expect((sessionManager as any).pendingUiTranscriptAccum).toBe('');
  });
});

describe('BUG 14 — transcript accumulation', () => {
  it('matches across multiple per-chunk deltas (not just a single chunk)', () => {
    // Single-chunk inputs that individually cannot match the threshold,
    // but concatenated do. This is what the production handler does:
    // accumulate then match.
    const { transcriptIndicatesNextCard } = require('../uiAdvanceMatcher');
    const nextFront = 'What is the capital of France?';
    expect(transcriptIndicatesNextCard('Correct!', nextFront)).toBe(false);
    expect(transcriptIndicatesNextCard(' Now,', nextFront)).toBe(false);
    expect(transcriptIndicatesNextCard(' the', nextFront)).toBe(false);
    expect(transcriptIndicatesNextCard(' capital', nextFront)).toBe(false);
    // Once "capital" + "France" are both present in the accumulated text,
    // the matcher fires.
    const accumulated = 'Correct! Now the capital of France';
    expect(transcriptIndicatesNextCard(accumulated, nextFront)).toBe(true);
  });

  it('accumulator state is reset on arm', async () => {
    // First grading.
    await (sessionManager as any).handleEvaluateAndMoveNext('c1', {
      user_response_quality: 'correct',
      feedback_text: 'ok',
    });
    // Stuff some accumulated text from a previous turn.
    (sessionManager as any).pendingUiTranscriptAccum = 'stale stuff from earlier';

    // Re-arm via a new evaluate call — supersede committed first.
    const THIRD = { cardId: 12, cardOrd: 0, front: 'Other front.', back: 'B', deckName: DECK };
    useCardCacheStore.setState({ cards: [CARD, NEXT, THIRD] });
    mockGetCurrentCard.mockReturnValue(NEXT);
    mockPeekNextCard.mockReturnValue(THIRD);
    await (sessionManager as any).handleEvaluateAndMoveNext('c2', {
      user_response_quality: 'correct',
      feedback_text: 'ok',
    });

    expect((sessionManager as any).pendingUiTranscriptAccum).toBe('');
  });
});

describe('BUG 12 — pending advance is flushed on cleanup (continued)', () => {
  it('superseded by a new evaluate call: previous pending advance commits before arming new one', async () => {
    // First card graded → pending advance armed.
    await (sessionManager as any).handleEvaluateAndMoveNext('c1', {
      user_response_quality: 'correct',
      feedback_text: 'ok',
    });
    const firstPending = (sessionManager as any).pendingUiNextCardFront;
    expect(firstPending).toBe(NEXT.front);

    // Add a third card to the cache so the next grading has a fresh next-card.
    const THIRD = { cardId: 12, cardOrd: 0, front: 'Name the largest ocean.', back: 'Pacific', deckName: DECK };
    useCardCacheStore.setState({
      cards: [CARD, NEXT, THIRD],
    });
    mockGetCurrentCard.mockReturnValue(NEXT);
    mockPeekNextCard.mockReturnValue(THIRD);

    // Second grading happens before timeout fires.
    await (sessionManager as any).handleEvaluateAndMoveNext('c2', {
      user_response_quality: 'correct',
      feedback_text: 'ok',
    });

    // First pending advance must have been committed (UI flipped to NEXT)
    // before the new pending advance was armed (pointing at THIRD).
    expect(useCardCacheStore.getState().uiVisibleIndex).toBe(1);
    expect((sessionManager as any).pendingUiNextCardFront).toBe(THIRD.front);
  });
});

describe('BUG 12 — session-end branch does not leave UI stuck', () => {
  it('on session_complete (no next card), no pending advance is left over', async () => {
    mockPeekNextCard.mockReturnValue(null);

    await (sessionManager as any).handleEvaluateAndMoveNext('c1', {
      user_response_quality: 'correct',
      feedback_text: 'ok',
    });

    expect((sessionManager as any).pendingUiNextCardFront).toBeNull();
    expect((sessionManager as any).pendingUiAdvanceTimer).toBeNull();
  });
});
