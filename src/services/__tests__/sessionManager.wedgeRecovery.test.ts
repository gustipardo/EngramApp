/**
 * BUG 9 — wedged-session detection + cold-resume recovery.
 *
 * Root cause (confirmed against the live API 2026-07-01): Gemini sometimes
 * answers an evaluation turn with a loop of literal control tokens
 * (`<ctrl46>` in outputTranscription), no audio and no tool call. Text
 * nudges don't recover it, and reconnecting WITH the sessionResumption
 * handle restores the poisoned context (the next eval wedges again). The
 * only working recovery is a COLD reconnect + app-level resume message.
 *
 * Verifies:
 *  1. A ctrl-token transcript chunk during `evaluating` followed by
 *     response.done triggers the cold recovery (handle cleared, reconnect,
 *     resume message sent, phase restored to awaiting_answer).
 *  2. The first 8 s evaluating-recovery bounce keeps today's behavior
 *     (phase flip to awaiting_answer, no reconnect).
 *  3. A second consecutive bounce triggers the cold recovery.
 *  4. A successful evaluate_and_move_next resets the bounce counter.
 *  5. Ctrl tokens outside `evaluating` do not trigger recovery.
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
const mockClearSessionResumptionHandle = jest.fn();
const mockWaitForNextResponseDone = jest.fn().mockResolvedValue(undefined);
const mockStopCurrentAudio = jest.fn();

jest.mock("expo-foreground-audio", () => ({
  __esModule: true,
  default: { addListener: jest.fn().mockReturnValue({ remove: jest.fn() }) },
}));

jest.mock("@react-native-async-storage/async-storage", () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
      setItem: jest.fn((k: string, v: string) => {
        store.set(k, v);
        return Promise.resolve();
      }),
      removeItem: jest.fn((k: string) => {
        store.delete(k);
        return Promise.resolve();
      }),
      clear: jest.fn(() => {
        store.clear();
        return Promise.resolve();
      }),
    },
  };
});

jest.mock("../realtimeManager", () => ({
  realtimeManager: {
    connect: (...a: any[]) => mockConnect(...a),
    disconnect: (...a: any[]) => mockDisconnect(...a),
    reconnect: (...a: any[]) => mockReconnect(...a),
    clearSessionResumptionHandle: (...a: any[]) =>
      mockClearSessionResumptionHandle(...a),
    setMicrophoneMuted: (...a: any[]) => mockSetMicrophoneMuted(...a),
    updateSession: (...a: any[]) => mockUpdateSession(...a),
    sendTextMessage: (...a: any[]) => mockSendTextMessage(...a),
    sendToolResult: (...a: any[]) => mockSendToolResult(...a),
    sendEvent: (...a: any[]) => mockSendEvent(...a),
    on: (...a: any[]) => mockOn(...a),
    off: (...a: any[]) => mockOff(...a),
    offAll: (...a: any[]) => mockOffAll(...a),
    waitForNextResponseDone: (...a: any[]) => mockWaitForNextResponseDone(...a),
    stopCurrentAudio: (...a: any[]) => mockStopCurrentAudio(...a),
    onConnectionDropped: null as null | (() => void),
  },
}));

const mockAnswerCard = jest.fn().mockResolvedValue(true);
jest.mock("../../native/ankiBridge", () => ({
  ankiBridge: {
    answerCard: (...a: any[]) => mockAnswerCard(...a),
    triggerSync: jest.fn().mockResolvedValue(undefined),
    getDeckInfo: jest.fn().mockResolvedValue([]),
    getDueCards: jest.fn().mockResolvedValue([]),
  },
}));

const mockGetCurrentCard = jest.fn();
const mockPeekNextCard = jest.fn();
const mockAdvanceCacheIndex = jest.fn();
const mockFetchAndAppendNextCard = jest.fn();
jest.mock("../cardLoader", () => ({
  loadDueCards: jest.fn().mockResolvedValue([]),
  getCurrentCard: (...a: any[]) => mockGetCurrentCard(...a),
  getNextCard: jest.fn(),
  getRemainingCardCount: jest.fn().mockReturnValue(5),
  getTotalCardCount: jest.fn().mockReturnValue(8),
  clearCards: jest.fn(),
  peekNextCard: (...a: any[]) => mockPeekNextCard(...a),
  peekRemainingAfterAdvance: jest.fn().mockReturnValue(1),
  advanceCacheIndex: (...a: any[]) => mockAdvanceCacheIndex(...a),
  fetchAndAppendNextCard: (...a: any[]) => mockFetchAndAppendNextCard(...a),
}));

jest.mock("../../services/foregroundAudioService", () => ({
  startForegroundService: jest.fn().mockResolvedValue(undefined),
  stopForegroundService: jest.fn().mockResolvedValue(undefined),
  updateForegroundNotification: jest.fn().mockResolvedValue(undefined),
  requestAudioFocus: jest.fn().mockResolvedValue(undefined),
  clearAudioFocusPauseFlag: jest.fn(),
  isServiceRunning: jest.fn().mockReturnValue(true),
}));

jest.mock("../sfxPlayer", () => ({
  sfxPlayer: {
    play: jest.fn(),
    stop: jest.fn(),
    preload: jest.fn(),
    isPlayingRecently: jest.fn().mockReturnValue(false),
  },
}));

jest.mock("../../services/analytics", () => ({
  AnalyticsEvents: {
    sessionStarted: jest.fn(),
    sessionCompleted: jest.fn(),
    sessionError: jest.fn(),
    sessionReconnected: jest.fn(),
    sessionFirstCardAnswered: jest.fn(),
    trialExpired: jest.fn(),
    paywallShown: jest.fn(),
  },
}));

jest.mock("../../config/prompts", () => ({
  getSystemPrompt: jest.fn().mockReturnValue("prompt"),
  getInitialMessage: jest.fn().mockReturnValue("initial"),
  getResumeMessage: jest.fn().mockReturnValue("resume-msg"),
  formatToolResult: jest.fn().mockReturnValue({ status: "ok" }),
  allTools: [],
}));

import { sessionManager } from "../sessionManager";
import { useSessionStore } from "../../stores/useSessionStore";
import { useSettingsStore } from "../../stores/useSettingsStore";

const DECK = "Engram Test — AWS SA";
const CARD = {
  cardId: 1,
  cardOrd: 0,
  front: "What does IAM stand for?",
  back: "Identity and Access Management",
  deckName: DECK,
};

/** Find the handler registered for an event name via webrtcManager.on. */
function handlerFor(event: string): (e: any) => void {
  const call = mockOn.mock.calls.find(([name]) => name === event);
  if (!call) throw new Error(`no handler registered for ${event}`);
  return call[1];
}

/** Flush pending microtasks (the recovery chain is async). */
async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  useSessionStore.setState({
    phase: "evaluating",
    stats: { correct: 0, incorrect: 0 },
    totalDueAtStart: 8,
  } as any);
  useSettingsStore.setState({ selectedDeck: DECK } as any);
  mockGetCurrentCard.mockReturnValue(CARD);
  mockPeekNextCard.mockReturnValue(CARD);
  mockFetchAndAppendNextCard.mockResolvedValue(CARD);
  (sessionManager as any).wedgeRecoveryInFlight = false;
  (sessionManager as any).sawCtrlTokenTurnInEvaluating = false;
  (sessionManager as any).evaluatingRecoveryBounces = 0;
  (sessionManager as any).awaitingToolCallForAnswer = false;
  (sessionManager as any).noToolCallTurns = 0;
  (sessionManager as any).phaseBeforeNetworkPause = null;
  (sessionManager as any).registerEventHandlers();
});

afterEach(() => {
  (sessionManager as any).clearEvaluatingRecovery();
  // handleEvaluateAndMoveNext arms a 30 s pending-UI-advance timer; drop it
  // so Jest can exit cleanly.
  if ((sessionManager as any).pendingUiAdvanceTimer) {
    clearTimeout((sessionManager as any).pendingUiAdvanceTimer);
    (sessionManager as any).pendingUiAdvanceTimer = null;
  }
  (sessionManager as any).pendingUiNextCardFront = null;
  (sessionManager as any).pendingUiTargetIndex = null;
  jest.useRealTimers();
});

describe("BUG 9 — ctrl-token wedge detection", () => {
  it("ctrl-token turn in evaluating + response.done triggers cold reconnect + resume", async () => {
    handlerFor("response.audio_transcript.done")({ transcript: "<ctrl46>" });
    expect((sessionManager as any).sawCtrlTokenTurnInEvaluating).toBe(true);

    handlerFor("response.done")({});
    await flush();

    // Cold: the poisoned resumption handle must be dropped BEFORE reconnect.
    expect(mockClearSessionResumptionHandle).toHaveBeenCalledTimes(1);
    expect(mockReconnect).toHaveBeenCalledTimes(1);
    // App-level resume: the current card is re-sent as a text message.
    expect(mockSendTextMessage).toHaveBeenCalledWith("resume-msg");
    // The user re-answers the re-asked card.
    expect(useSessionStore.getState().phase).toBe("awaiting_answer");
  });

  it("ctrl tokens outside evaluating do not trigger recovery", async () => {
    useSessionStore.setState({ phase: "awaiting_answer" } as any);
    handlerFor("response.audio_transcript.done")({ transcript: "<ctrl46>" });
    expect((sessionManager as any).sawCtrlTokenTurnInEvaluating).toBe(false);

    handlerFor("response.done")({});
    await flush();
    expect(mockReconnect).not.toHaveBeenCalled();
  });

  it("a normal transcript chunk does not arm the wedge flag", () => {
    handlerFor("response.audio_transcript.done")({ transcript: "Correct!" });
    expect((sessionManager as any).sawCtrlTokenTurnInEvaluating).toBe(false);
  });
});

describe("BUG 9 — repeated recovery bounces", () => {
  it("first 8s bounce keeps the old behavior (phase flip, no reconnect)", async () => {
    jest.useFakeTimers();
    (sessionManager as any).startEvaluatingRecovery();
    jest.advanceTimersByTime(8001);
    await flush();

    expect(useSessionStore.getState().phase).toBe("awaiting_answer");
    expect(mockReconnect).not.toHaveBeenCalled();
  });

  it("second consecutive bounce triggers the cold recovery", async () => {
    jest.useFakeTimers();
    (sessionManager as any).startEvaluatingRecovery();
    jest.advanceTimersByTime(8001);
    await flush();
    expect(mockReconnect).not.toHaveBeenCalled();

    // The user re-answers, the debounce moves us back into evaluating,
    // and the model stays silent again.
    useSessionStore.setState({ phase: "evaluating" } as any);
    (sessionManager as any).startEvaluatingRecovery();
    jest.advanceTimersByTime(8001);
    await flush();

    expect(mockClearSessionResumptionHandle).toHaveBeenCalledTimes(1);
    expect(mockReconnect).toHaveBeenCalledTimes(1);
    expect(mockSendTextMessage).toHaveBeenCalledWith("resume-msg");
  });

  it("a successful evaluate_and_move_next resets the bounce counter", async () => {
    (sessionManager as any).evaluatingRecoveryBounces = 1;
    (sessionManager as any).sawCtrlTokenTurnInEvaluating = true;

    await (sessionManager as any).handleEvaluateAndMoveNext("c1", {
      user_response_quality: "correct",
      feedback_text: "ok",
    });

    expect((sessionManager as any).evaluatingRecoveryBounces).toBe(0);
    expect((sessionManager as any).sawCtrlTokenTurnInEvaluating).toBe(false);
  });
});

describe("live-lock watchdog — AI turns without tool call (autopilot 20260704)", () => {
  /** Simulate one full "user answered → model spoke, no tool call" turn. */
  async function noToolTurn() {
    (sessionManager as any).awaitingToolCallForAnswer = true;
    useSessionStore.setState({ phase: "giving_feedback" } as any);
    handlerFor("response.done")({});
    await flush();
  }

  it("3 consecutive no-tool turns after user answers trigger cold recovery", async () => {
    await noToolTurn();
    await noToolTurn();
    expect(mockReconnect).not.toHaveBeenCalled();

    await noToolTurn();
    expect(mockClearSessionResumptionHandle).toHaveBeenCalledTimes(1);
    expect(mockReconnect).toHaveBeenCalledTimes(1);
    expect(mockSendTextMessage).toHaveBeenCalledWith("resume-msg");
    expect(useSessionStore.getState().phase).toBe("awaiting_answer");
  });

  it("any tool call resets the no-tool-turn counter", async () => {
    await noToolTurn();
    await noToolTurn();
    await (sessionManager as any).handleToolCall({
      call_id: "x",
      arguments: "{}",
    });
    expect((sessionManager as any).noToolCallTurns).toBe(0);

    await noToolTurn();
    expect(mockReconnect).not.toHaveBeenCalled();
  });
});

describe("reconnect resume — mic unmute (autopilot fix #1)", () => {
  it("resumeAfterReconnect unmutes the mic after re-arming server_vad", async () => {
    await (sessionManager as any).resumeAfterReconnect();

    expect(mockSetMicrophoneMuted).toHaveBeenCalledWith(false);
    // handleConnectionDrop mutes; the unmute must land AFTER server_vad is
    // re-armed or the buffered audio clear could race a hot mic.
    const unmuteOrder = mockSetMicrophoneMuted.mock.invocationCallOrder.at(-1)!;
    const updateOrder = mockUpdateSession.mock.invocationCallOrder.at(-1)!;
    expect(unmuteOrder).toBeGreaterThan(updateOrder);
    expect(useSessionStore.getState().phase).toBe("awaiting_answer");
  });

  it("cold wedge recovery ends with the mic unmuted", async () => {
    handlerFor("response.audio_transcript.done")({ transcript: "<ctrl46>" });
    handlerFor("response.done")({});
    await flush();

    expect(mockReconnect).toHaveBeenCalledTimes(1);
    expect(mockSetMicrophoneMuted).toHaveBeenLastCalledWith(false);
  });
});

describe("BUG 9 — recovery guards", () => {
  it("does not run recovery twice concurrently", async () => {
    let resolveReconnect: (v: boolean) => void = () => {};
    mockReconnect.mockImplementationOnce(
      () => new Promise((r) => (resolveReconnect = r)),
    );

    const first = (sessionManager as any).recoverFromWedgedSession("test");
    await flush();
    const second = (sessionManager as any).recoverFromWedgedSession("test");
    await flush();
    expect(mockReconnect).toHaveBeenCalledTimes(1);

    resolveReconnect(true);
    await first;
    await second;
  });

  it("does nothing when the session is not in a recoverable phase", async () => {
    useSessionStore.setState({ phase: "idle" } as any);
    await (sessionManager as any).recoverFromWedgedSession("test");
    expect(mockReconnect).not.toHaveBeenCalled();
  });
});
