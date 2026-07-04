/**
 * Unit tests for sessionManager — focused on tool-call dispatch and write-back.
 *
 * Strategy: mock every external collaborator (realtimeManager, cardLoader,
 * ankiBridge, foregroundAudioService, analytics, prompts) and let the real
 * Zustand stores run. Each test resets modules so sessionManager state is
 * isolated.
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
const mockGetAudioStats = jest
  .fn()
  .mockResolvedValue({ bytesSent: 0, packetsSent: 0 });
const mockDebugAudioTrackState = jest.fn().mockResolvedValue(undefined);

jest.mock("expo-foreground-audio", () => ({
  __esModule: true,
  default: { addListener: jest.fn().mockReturnValue({ remove: jest.fn() }) },
}));

// useSettingsStore persists via AsyncStorage; in Jest's node env we provide
// an in-memory shim so setState() doesn't try to hit window.localStorage.
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
const mockGetDeckInfo = jest.fn().mockResolvedValue([]);
jest.mock("../../native/ankiBridge", () => ({
  ankiBridge: {
    answerCard: (...a: any[]) => mockAnswerCard(...a),
    triggerSync: (...a: any[]) => mockTriggerSync(...a),
    getDueCards: (...a: any[]) => mockGetDueCardsBridge(...a),
    getDeckInfo: (...a: any[]) => mockGetDeckInfo(...a),
  },
}));

const mockLoadDueCards = jest.fn();
const mockGetCurrentCard = jest.fn();
const mockPeekNextCard = jest.fn();
const mockPeekRemainingAfterAdvance = jest.fn();
const mockGetRemainingCardCount = jest.fn();
const mockGetTotalCardCount = jest.fn();
const mockClearCards = jest.fn();
const mockAdvanceCacheIndex = jest.fn();
const mockGetNextCard = jest.fn();
const mockFetchAndAppendNextCard = jest.fn();
jest.mock("../cardLoader", () => ({
  loadDueCards: (...a: any[]) => mockLoadDueCards(...a),
  getCurrentCard: (...a: any[]) => mockGetCurrentCard(...a),
  getNextCard: (...a: any[]) => mockGetNextCard(...a),
  peekNextCard: (...a: any[]) => mockPeekNextCard(...a),
  peekRemainingAfterAdvance: (...a: any[]) =>
    mockPeekRemainingAfterAdvance(...a),
  getRemainingCardCount: (...a: any[]) => mockGetRemainingCardCount(...a),
  getTotalCardCount: (...a: any[]) => mockGetTotalCardCount(...a),
  clearCards: (...a: any[]) => mockClearCards(...a),
  advanceCacheIndex: (...a: any[]) => mockAdvanceCacheIndex(...a),
  fetchAndAppendNextCard: (...a: any[]) => mockFetchAndAppendNextCard(...a),
}));

jest.mock("../foregroundAudioService", () => ({
  startForegroundService: jest.fn().mockResolvedValue(undefined),
  stopForegroundService: jest.fn().mockResolvedValue(undefined),
  updateForegroundNotification: jest.fn().mockResolvedValue(undefined),
  requestAudioFocus: jest.fn().mockResolvedValue(undefined),
  abandonAudioFocus: jest.fn().mockResolvedValue(undefined),
  clearAudioFocusPauseFlag: jest.fn(),
  isServiceRunning: jest.fn().mockReturnValue(false),
  wasPausedByAudioFocusLoss: jest.fn().mockReturnValue(false),
}));

jest.mock("../analytics", () => ({
  AnalyticsEvents: {
    sessionStarted: jest.fn(),
    sessionCompleted: jest.fn(),
    sessionError: jest.fn(),
    sessionReconnected: jest.fn(),
    sessionFirstCardAnswered: jest.fn(),
    trialExpired: jest.fn(),
  },
}));

jest.mock("../sfxPlayer", () => ({
  sfxPlayer: {
    play: jest.fn(),
    stop: jest.fn(),
    preload: jest.fn(),
    release: jest.fn(),
  },
}));

jest.mock("../../config/prompts", () => ({
  getSystemPrompt: jest.fn().mockReturnValue("SYS"),
  getInitialMessage: jest.fn().mockReturnValue("FIRST"),
  getResumeMessage: jest.fn().mockReturnValue("RESUME"),
  formatToolResult: jest
    .fn()
    .mockImplementation(
      (back: string | null, next: any, remaining: number, stats: any) => ({
        status: next ? "success" : "session_complete",
        answered_card_back: back,
        next_card: next,
        remaining_cards: remaining,
        session_stats: stats,
      }),
    ),
  allTools: [],
}));

import { sessionManager } from "../sessionManager";
import { updateForegroundNotification } from "../foregroundAudioService";
import { useSessionStore } from "../../stores/useSessionStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useCardCacheStore } from "../../stores/useCardCacheStore";

const mockUpdateForegroundNotification =
  updateForegroundNotification as jest.Mock;

const SAMPLE_CARD = {
  cardId: 9001,
  cardOrd: 0,
  front: "Network ACL controls inbound and outbound traffic at what level?",
  back: "subnet level",
  deckName: "Aws Exam SA",
};
const NEXT_CARD = {
  cardId: 9002,
  cardOrd: 0,
  front: "AWS DLM is used for?",
  back: "automated EBS snapshot backups",
  deckName: "Aws Exam SA",
};

beforeEach(() => {
  jest.clearAllMocks();
  useSessionStore.getState().resetSession();
  useCardCacheStore.getState().clear();
  useSettingsStore.setState({ selectedDeck: "Aws Exam SA" });
  // Reset internal sessionManager state by clearing private fields via cast.
  // Cleaner than jest.resetModules() because we keep the same singleton ref
  // that other modules might already hold.
  (sessionManager as any).clearEvaluatingRecovery?.();
  (sessionManager as any).lastAnsweredCardId = null;
  (sessionManager as any).lastAnsweredCardOrd = null;
  (sessionManager as any).toolCallNames = new Map();

  mockGetCurrentCard.mockReturnValue(SAMPLE_CARD);
  mockPeekNextCard.mockReturnValue(NEXT_CARD);
  mockPeekRemainingAfterAdvance.mockReturnValue(4);
  mockGetTotalCardCount.mockReturnValue(5);
  mockGetRemainingCardCount.mockReturnValue(5);
  mockAnswerCard.mockResolvedValue(true);
  mockGetDueCardsBridge.mockResolvedValue([]); // default: no more due cards
  // BUG 5 v3b: default refill returns NEXT_CARD so existing tests that
  // expected a populated cache after answer keep their semantics.
  mockFetchAndAppendNextCard.mockResolvedValue(NEXT_CARD);
});

describe("sessionManager — evaluate_and_move_next dispatch", () => {
  it('writes pass=true to AnkiDroid when grade is "correct"', async () => {
    await (sessionManager as any).handleEvaluateAndMoveNext("call_1", {
      user_response_quality: "correct",
      feedback_text: "Right.",
    });

    expect(mockAnswerCard).toHaveBeenCalledTimes(1);
    expect(mockAnswerCard).toHaveBeenCalledWith(
      SAMPLE_CARD.deckName,
      SAMPLE_CARD.cardId,
      SAMPLE_CARD.cardOrd,
      true,
    );
  });

  it('writes pass=false to AnkiDroid when grade is "incorrect"', async () => {
    await (sessionManager as any).handleEvaluateAndMoveNext("call_2", {
      user_response_quality: "incorrect",
      feedback_text: "Wrong, the answer is X.",
    });

    expect(mockAnswerCard).toHaveBeenCalledTimes(1);
    expect(mockAnswerCard).toHaveBeenCalledWith(
      SAMPLE_CARD.deckName,
      SAMPLE_CARD.cardId,
      SAMPLE_CARD.cardOrd,
      false,
    );
  });

  // BUG 10 (skip-path variant), fixed 2026-06-25. A skip must still advance the
  // AnkiDroid scheduler head — there is no bury API, so it is written back as
  // "Again" (pass=false). Previously the whole write-back+refill block was
  // guarded by `quality !== "skipped"`, so a skip never refilled, peekNextCard()
  // returned undefined, and the session falsely ended (next_card: null →
  // no_more_cards) even with cards still due.
  it('writes pass=false (Again) to AnkiDroid when grade is "skipped" (to advance the scheduler)', async () => {
    await (sessionManager as any).handleEvaluateAndMoveNext("call_3", {
      user_response_quality: "skipped",
      feedback_text: "Skipping.",
    });

    expect(mockAnswerCard).toHaveBeenCalledTimes(1);
    expect(mockAnswerCard).toHaveBeenCalledWith(
      SAMPLE_CARD.deckName,
      SAMPLE_CARD.cardId,
      SAMPLE_CARD.cardOrd,
      false,
    );
  });

  it("triggers the scheduler refill on a skip so the session can continue (BUG 10 skip-path regression)", async () => {
    await (sessionManager as any).handleEvaluateAndMoveNext("call_3b", {
      user_response_quality: "skipped",
      feedback_text: "Skipping.",
    });

    expect(mockFetchAndAppendNextCard).toHaveBeenCalledTimes(1);
    // The tool result must carry the refilled next card, NOT a null that the AI
    // would read as end-of-deck.
    const result = mockSendToolResult.mock.calls[0][1];
    expect(result.status).toBe("success");
    expect(result.next_card).toEqual({
      front: NEXT_CARD.front,
      back: NEXT_CARD.back,
    });
  });

  it("does not end the session on a skip while the deck still has due cards", async () => {
    useSessionStore.setState({ totalDueAtStart: 6 });

    await (sessionManager as any).handleEvaluateAndMoveNext("call_3c", {
      user_response_quality: "skipped",
      feedback_text: "Skipping.",
    });

    expect(useSessionStore.getState().phase).not.toBe("session_complete");
  });

  it("records the answer in the session store on correct/incorrect", async () => {
    await (sessionManager as any).handleEvaluateAndMoveNext("c", {
      user_response_quality: "correct",
      feedback_text: "ok",
    });
    expect(useSessionStore.getState().stats).toEqual({
      correct: 1,
      incorrect: 0,
    });

    await (sessionManager as any).handleEvaluateAndMoveNext("c", {
      user_response_quality: "incorrect",
      feedback_text: "no",
    });
    expect(useSessionStore.getState().stats).toEqual({
      correct: 1,
      incorrect: 1,
    });
  });

  it("does NOT increment stats when skipped", async () => {
    await (sessionManager as any).handleEvaluateAndMoveNext("c", {
      user_response_quality: "skipped",
      feedback_text: "skip",
    });
    expect(useSessionStore.getState().stats).toEqual({
      correct: 0,
      incorrect: 0,
    });
  });

  it("sends tool result back to the AI with answered_card_back + next_card", async () => {
    await (sessionManager as any).handleEvaluateAndMoveNext("call_x", {
      user_response_quality: "correct",
      feedback_text: "good",
    });

    expect(mockSendToolResult).toHaveBeenCalledTimes(1);
    const [callId, result] = mockSendToolResult.mock.calls[0];
    expect(callId).toBe("call_x");
    expect(result.answered_card_back).toBe(SAMPLE_CARD.back);
    expect(result.next_card).toEqual({
      front: NEXT_CARD.front,
      back: NEXT_CARD.back,
    });
  });

  // BUG 10 fix: `remaining_cards` must report the AnkiDroid deck's actual due
  // pile (snapshotted at startSession into totalDueAtStart), not the size of
  // the 1-deep in-memory cache. Under refill-from-scheduler the cache always
  // holds at most 2 cards, so the old `peekRemainingAfterAdvance()` source
  // returned 1 every turn and the tutor concluded "this is the last card"
  // even with 200 cards left in the deck.
  it("reports remaining_cards from the AnkiDroid due snapshot, not the cache", async () => {
    useSessionStore.setState({ totalDueAtStart: 200 });

    await (sessionManager as any).handleEvaluateAndMoveNext("c", {
      user_response_quality: "correct",
      feedback_text: "ok",
    });

    const result = mockSendToolResult.mock.calls[0][1];
    // 200 due at start − 1 just-answered = 199 (snapshot fallback; the
    // scheduler query returns no matching deck in this test).
    expect(result.remaining_cards).toBe(199);
  });

  // Autopilot 20260704-161510: snapshot arithmetic under-reports during a
  // wrong-answer storm (8 due, 9 answered → formula says ~1 while the real
  // queue holds 5), which made the model wrap up mid-session. When the
  // bridge can report the deck's real queue depth, use it.
  it("reports remaining_cards from the scheduler's real queue depth when available", async () => {
    useSessionStore.setState({
      totalDueAtStart: 8,
      stats: { correct: 3, incorrect: 6 },
    });
    mockGetDeckInfo.mockResolvedValueOnce([
      {
        deckName: "Aws Exam SA",
        newCount: 2,
        learnCount: 3,
        dueCount: 0,
        reviewCount: 0,
      },
    ]);

    await (sessionManager as any).handleEvaluateAndMoveNext("c", {
      user_response_quality: "correct",
      feedback_text: "ok",
    });

    const result = mockSendToolResult.mock.calls[0][1];
    expect(result.remaining_cards).toBe(5);
  });

  it("keeps remaining_cards coherent with next_card past the snapshot (re-served ease-1 card)", async () => {
    useSessionStore.setState({
      totalDueAtStart: 1,
      stats: { correct: 2, incorrect: 0 },
    });

    await (sessionManager as any).handleEvaluateAndMoveNext("c", {
      user_response_quality: "correct",
      feedback_text: "ok",
    });

    const result = mockSendToolResult.mock.calls[0][1];
    // The snapshot term clamps at 0, but a next_card is attached (the
    // cache still holds one — e.g. a re-served ease-1 card), so the
    // model must not see the contradicting pair {remaining: 0,
    // next_card ≠ null} that made it wrap up without end_session.
    expect(result.remaining_cards).toBe(1);
    expect(result.next_card).not.toBeNull();
  });

  // Same BUG 10 family as remaining_cards: the foreground notification's
  // "Card X of N" total must come from totalDueAtStart, NOT getTotalCardCount()
  // (the cache size). Under refill-from-scheduler the cache holds only the cards
  // loaded so far, so its length == completed + 1 every turn → the notification
  // read "Card 1 of 1, Card 2 of 2, …" instead of "Card 1 of 200".
  it("notification total comes from totalDueAtStart, not the cache size", async () => {
    useSessionStore.setState({
      totalDueAtStart: 200,
      stats: { correct: 0, incorrect: 0 },
    });
    // The cache size is a misleading source — make it diverge from the truth.
    // The old buggy code read this (getTotalCardCount) → "Card 2 of 1".
    mockGetTotalCardCount.mockReturnValue(1);

    await (sessionManager as any).handleEvaluateAndMoveNext("c", {
      user_response_quality: "correct",
      feedback_text: "ok",
    });

    // One card just answered → now on card 2, of the 200-card deck snapshot.
    expect(mockUpdateForegroundNotification).toHaveBeenCalledWith(
      "Voice Study Session",
      "Card 2 of 200",
    );
  });

  it("captures lastAnsweredCardId so override can target the right card later", async () => {
    await (sessionManager as any).handleEvaluateAndMoveNext("c", {
      user_response_quality: "incorrect",
      feedback_text: "no",
    });
    expect((sessionManager as any).lastAnsweredCardId).toBe(SAMPLE_CARD.cardId);
  });

  it("write-back failures do not throw or block the session", async () => {
    mockAnswerCard.mockRejectedValueOnce(new Error("AnkiDroid unreachable"));

    // Should not reject — fire-and-forget pattern.
    await expect(
      (sessionManager as any).handleEvaluateAndMoveNext("c", {
        user_response_quality: "correct",
        feedback_text: "ok",
      }),
    ).resolves.not.toThrow();

    expect(mockSendToolResult).toHaveBeenCalled();
  });

  it("transitions to session_complete when no next card", async () => {
    mockPeekNextCard.mockReturnValueOnce(null);
    mockPeekRemainingAfterAdvance.mockReturnValueOnce(0);

    await (sessionManager as any).handleEvaluateAndMoveNext("c", {
      user_response_quality: "correct",
      feedback_text: "ok",
    });

    expect(useSessionStore.getState().phase).toBe("session_complete");
    expect(mockTriggerSync).toHaveBeenCalled();
  });

  it("walks through the pre-populated cache without re-querying AnkiDroid (multi-card session)", async () => {
    // sessionManager populates the cache once via loadDueCards at session
    // start, then walks it via peekNextCard. Re-querying inside the tool
    // handler used to live here but was removed — it added latency that
    // raced Gemini's toolCallCancellation timeout. This test pins the new
    // behavior: three answers in a row, no getDueCards call, session_complete
    // when peekNextCard returns null.
    const cardA = {
      cardId: 1,
      cardOrd: 0,
      front: "A",
      back: "a",
      deckName: "Aws Exam SA",
    };
    const cardB = {
      cardId: 2,
      cardOrd: 0,
      front: "B",
      back: "b",
      deckName: "Aws Exam SA",
    };
    const cardC = {
      cardId: 3,
      cardOrd: 0,
      front: "C",
      back: "c",
      deckName: "Aws Exam SA",
    };

    mockGetCurrentCard
      .mockReturnValueOnce(cardA)
      .mockReturnValueOnce(cardB)
      .mockReturnValueOnce(cardC);
    mockPeekNextCard
      .mockReturnValueOnce(cardB)
      .mockReturnValueOnce(cardC)
      .mockReturnValueOnce(null);
    mockPeekRemainingAfterAdvance
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(0);

    await (sessionManager as any).handleEvaluateAndMoveNext("c1", {
      user_response_quality: "correct",
      feedback_text: "ok",
    });
    expect(mockAnswerCard).toHaveBeenNthCalledWith(
      1,
      "Aws Exam SA",
      1,
      0,
      true,
    );
    expect(useSessionStore.getState().phase).not.toBe("session_complete");

    await (sessionManager as any).handleEvaluateAndMoveNext("c2", {
      user_response_quality: "incorrect",
      feedback_text: "nope",
    });
    expect(mockAnswerCard).toHaveBeenNthCalledWith(
      2,
      "Aws Exam SA",
      2,
      0,
      false,
    );
    expect(useSessionStore.getState().phase).not.toBe("session_complete");

    await (sessionManager as any).handleEvaluateAndMoveNext("c3", {
      user_response_quality: "correct",
      feedback_text: "ok",
    });
    expect(mockAnswerCard).toHaveBeenNthCalledWith(
      3,
      "Aws Exam SA",
      3,
      0,
      true,
    );
    expect(useSessionStore.getState().phase).toBe("session_complete");

    // Regression guard: the tool handler must NEVER re-query AnkiDroid.
    // Doing so re-introduces the toolCallCancellation race.
    expect(mockGetDueCardsBridge).not.toHaveBeenCalled();
    expect(mockTriggerSync).toHaveBeenCalled();
  });
});

describe("sessionManager — override_evaluation dispatch (bidirectional)", () => {
  describe("incorrect → correct", () => {
    it("flips one incorrect into correct in stats", async () => {
      useSessionStore.setState({ stats: { correct: 2, incorrect: 1 } });
      (sessionManager as any).lastAnsweredCardId = 555;

      await (sessionManager as any).handleOverrideEvaluation("cb", {
        override_to: "correct",
      });

      expect(useSessionStore.getState().stats).toEqual({
        correct: 3,
        incorrect: 0,
      });
    });

    it("writes pass=true to AnkiDroid for the last answered card", async () => {
      useSessionStore.setState({ stats: { correct: 0, incorrect: 1 } });
      (sessionManager as any).lastAnsweredCardId = 555;
      (sessionManager as any).lastAnsweredCardOrd = 0;

      await (sessionManager as any).handleOverrideEvaluation("cb", {
        override_to: "correct",
      });

      expect(mockAnswerCard).toHaveBeenCalledWith("Aws Exam SA", 555, 0, true);
    });

    it("returns no_change when there is no incorrect to flip", async () => {
      useSessionStore.setState({ stats: { correct: 3, incorrect: 0 } });
      (sessionManager as any).lastAnsweredCardId = 555;

      await (sessionManager as any).handleOverrideEvaluation("cb", {
        override_to: "correct",
      });

      const [, result] = mockSendToolResult.mock.calls[0];
      expect(result.status).toBe("no_change");
      expect(mockAnswerCard).not.toHaveBeenCalled();
    });
  });

  describe("correct → incorrect (NEW behavior — TDD)", () => {
    it("flips one correct into incorrect in stats", async () => {
      useSessionStore.setState({ stats: { correct: 2, incorrect: 1 } });
      (sessionManager as any).lastAnsweredCardId = 777;

      await (sessionManager as any).handleOverrideEvaluation("cb", {
        override_to: "incorrect",
      });

      expect(useSessionStore.getState().stats).toEqual({
        correct: 1,
        incorrect: 2,
      });
    });

    it("writes pass=false to AnkiDroid for the last answered card", async () => {
      useSessionStore.setState({ stats: { correct: 1, incorrect: 0 } });
      (sessionManager as any).lastAnsweredCardId = 777;
      (sessionManager as any).lastAnsweredCardOrd = 0;

      await (sessionManager as any).handleOverrideEvaluation("cb", {
        override_to: "incorrect",
      });

      expect(mockAnswerCard).toHaveBeenCalledWith("Aws Exam SA", 777, 0, false);
    });

    it("returns no_change when there is no correct to flip", async () => {
      useSessionStore.setState({ stats: { correct: 0, incorrect: 2 } });
      (sessionManager as any).lastAnsweredCardId = 777;

      await (sessionManager as any).handleOverrideEvaluation("cb", {
        override_to: "incorrect",
      });

      const [, result] = mockSendToolResult.mock.calls[0];
      expect(result.status).toBe("no_change");
      expect(mockAnswerCard).not.toHaveBeenCalled();
    });
  });

  it('defaults to "correct" override_to when arg is missing (backwards-compat)', async () => {
    useSessionStore.setState({ stats: { correct: 0, incorrect: 1 } });
    (sessionManager as any).lastAnsweredCardId = 1;

    await (sessionManager as any).handleOverrideEvaluation("cb", {});

    expect(useSessionStore.getState().stats).toEqual({
      correct: 1,
      incorrect: 0,
    });
  });
});

describe("sessionManager — handleToolCall routing", () => {
  it("routes evaluate_and_move_next to its handler", async () => {
    const spy = jest
      .spyOn(sessionManager as any, "handleEvaluateAndMoveNext")
      .mockResolvedValue(undefined);
    (sessionManager as any).toolCallNames = new Map([
      ["c", "evaluate_and_move_next"],
    ]);

    await (sessionManager as any).handleToolCall({
      call_id: "c",
      arguments: JSON.stringify({
        user_response_quality: "correct",
        feedback_text: "ok",
      }),
    });

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("routes override_evaluation to its handler", async () => {
    const spy = jest
      .spyOn(sessionManager as any, "handleOverrideEvaluation")
      .mockResolvedValue(undefined);
    (sessionManager as any).toolCallNames = new Map([
      ["c", "override_evaluation"],
    ]);

    await (sessionManager as any).handleToolCall({
      call_id: "c",
      arguments: JSON.stringify({ override_to: "correct" }),
    });

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("routes end_session to its handler", async () => {
    const spy = jest
      .spyOn(sessionManager as any, "handleEndSessionTool")
      .mockResolvedValue(undefined);
    (sessionManager as any).toolCallNames = new Map([["c", "end_session"]]);

    await (sessionManager as any).handleToolCall({
      call_id: "c",
      arguments: "{}",
    });

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("logs and continues when tool name is unknown", async () => {
    (sessionManager as any).toolCallNames = new Map([["c", "mystery_tool"]]);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      (sessionManager as any).handleToolCall({ call_id: "c", arguments: "{}" }),
    ).resolves.not.toThrow();

    warn.mockRestore();
  });

  it("catches malformed JSON arguments without throwing", async () => {
    (sessionManager as any).toolCallNames = new Map([
      ["c", "evaluate_and_move_next"],
    ]);
    const err = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      (sessionManager as any).handleToolCall({
        call_id: "c",
        arguments: "not-json{",
      }),
    ).resolves.not.toThrow();

    err.mockRestore();
  });
});

describe("sessionManager — end_session tool delayed completion (ghost timer)", () => {
  // handleEndSessionTool gives the AI 5 s to speak its summary before
  // flipping to session_complete. The timer used to be untracked: if the
  // user ended the session (or a new one started) inside that window, it
  // still fired — yanking an idle app or a fresh session into
  // session_complete and running onSessionComplete a second time.

  afterEach(() => {
    (sessionManager as any).clearEndSessionToolTimer();
    jest.useRealTimers();
  });

  it("completes the session 5s after the tool when still active", async () => {
    jest.useFakeTimers();
    useSessionStore.getState().transitionTo("giving_feedback", "test");

    await (sessionManager as any).handleEndSessionTool("call-1");
    expect(useSessionStore.getState().phase).toBe("giving_feedback");

    await jest.advanceTimersByTimeAsync(5000);

    expect(useSessionStore.getState().phase).toBe("session_complete");
    expect(mockTriggerSync).toHaveBeenCalledTimes(1);
  });

  it("does not fire after endSession() cancelled it", async () => {
    jest.useFakeTimers();
    useSessionStore.getState().transitionTo("giving_feedback", "test");

    await (sessionManager as any).handleEndSessionTool("call-2");
    sessionManager.endSession();
    expect(useSessionStore.getState().phase).toBe("idle");

    await jest.advanceTimersByTimeAsync(6000);

    expect(useSessionStore.getState().phase).toBe("idle");
    expect(mockTriggerSync).not.toHaveBeenCalled();
  });

  it("phase guard: does not double-complete an already-complete session", async () => {
    jest.useFakeTimers();
    useSessionStore.getState().transitionTo("giving_feedback", "test");

    await (sessionManager as any).handleEndSessionTool("call-3");
    useSessionStore
      .getState()
      .transitionTo("session_complete", "no_more_cards");

    await jest.advanceTimersByTimeAsync(6000);

    expect(mockTriggerSync).not.toHaveBeenCalled();
  });
});

describe("sessionManager — slow answer+refill must not falsely end the session", () => {
  // The 500 ms Promise.race protects Gemini's tool-call deadline, but when
  // the answer+refill chain loses the race, peekNextCard() is empty and the
  // no_more_cards branch used to end the session mid-deck. With cards still
  // due (per the totalDueAtStart snapshot) the handler now grants the refill
  // a bounded grace window and re-peeks.

  afterEach(() => {
    (sessionManager as any).clearEvaluatingRecovery();
    (sessionManager as any).commitPendingUiAdvance("test_cleanup");
    jest.useRealTimers();
  });

  it("waits out a slow AnkiDroid write-back instead of declaring no_more_cards", async () => {
    jest.useFakeTimers();
    useSessionStore.getState().setTotalDueAtStart(5);
    mockAnswerCard.mockImplementation(
      () => new Promise((r) => setTimeout(() => r(true), 800)),
    );
    mockPeekNextCard.mockReset();
    mockPeekNextCard.mockReturnValueOnce(undefined).mockReturnValue(NEXT_CARD);

    const call = (sessionManager as any).handleEvaluateAndMoveNext("call_g1", {
      user_response_quality: "correct",
      feedback_text: "ok",
    });
    await jest.advanceTimersByTimeAsync(900);
    await call;

    expect(useSessionStore.getState().phase).not.toBe("session_complete");
    expect(mockFetchAndAppendNextCard).toHaveBeenCalledTimes(1);
    expect(mockAdvanceCacheIndex).toHaveBeenCalledTimes(1);
  });

  it("still ends the session when the refill never lands (grace bounded)", async () => {
    jest.useFakeTimers();
    useSessionStore.getState().setTotalDueAtStart(5);
    mockAnswerCard.mockImplementation(() => new Promise(() => {}));
    mockPeekNextCard.mockReset();
    mockPeekNextCard.mockReturnValue(undefined);

    const call = (sessionManager as any).handleEvaluateAndMoveNext("call_g2", {
      user_response_quality: "correct",
      feedback_text: "ok",
    });
    await jest.advanceTimersByTimeAsync(6000);
    await call;

    expect(useSessionStore.getState().phase).toBe("session_complete");
  });
});

describe("sessionManager — pause/resume phase restore", () => {
  it("resume() returns to the phase the user paused from", () => {
    useSessionStore.getState().transitionTo("awaiting_answer", "test");

    sessionManager.pause();
    expect(useSessionStore.getState().phase).toBe("paused");

    sessionManager.resume();
    expect(useSessionStore.getState().phase).toBe("awaiting_answer");
  });

  it("resume() falls back to awaiting_answer without a snapshot", () => {
    (sessionManager as any).phaseBeforeUserPause = null;
    useSessionStore.getState().transitionTo("paused", "test");

    sessionManager.resume();
    expect(useSessionStore.getState().phase).toBe("awaiting_answer");
  });
});
