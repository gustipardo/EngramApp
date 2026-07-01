/**
 * Integration test for sessionManager.startSession() — focused on what cards
 * actually end up in the in-memory cache after the start flow runs.
 *
 * Unlike sessionManager.test.ts (which mocks cardLoader to isolate tool-call
 * dispatch), this file uses the REAL cardLoader and useCardCacheStore so we
 * exercise the full path:
 *
 *   startSession() → loadDueCards(deckName) → ankiBridge.getDueCards(deckName)
 *     → AnkiDroidModule.getDueCards(deckName) [mocked here] → setCards(...)
 *
 * The mock on AnkiDroidModule simulates what the native Kotlin layer returns:
 *
 *   - Pre-fix behavior: schedule URI returns one card per query, so mock
 *     returns a single card. Cache ends up with 1 card → reproduces the
 *     "session is only ever 1 card" bug the user reported on device.
 *   - Post-fix behavior: native getDueCards uses the schedule URI for the
 *     head card and pads from notes/?deckID= up to deck.dueCount. Mock
 *     returns N cards. Cache ends up with N cards → fix verified.
 *
 * Side-effect modules (realtime/audio/analytics/prompts) are still mocked
 * because they require a connected device or running services to function.
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

// Mock the NATIVE module (anki-droid), not the JS bridge above it. This is
// the boundary the Kotlin fix lives behind — the test pretends to be the
// native module returning cards. ankiBridge.getDueCards is exercised for
// real, so its mapping logic (cardOrd default, etc.) is also covered.
const mockNativeGetDueCards = jest.fn();
const mockNativeAnswerCard = jest
  .fn()
  .mockResolvedValue({ updatedCards: 1, totalCards: 1 });
const mockNativeTriggerSync = jest.fn().mockResolvedValue(undefined);
const mockNativeIsInstalled = jest.fn().mockResolvedValue(true);
const mockNativeHasApiPermission = jest.fn().mockResolvedValue(true);
const mockNativeGetDeckNames = jest.fn().mockResolvedValue(["Aws Exam SA"]);
const mockNativeGetDeckInfo = jest.fn().mockResolvedValue([
  {
    deckName: "Aws Exam SA",
    dueCount: 10,
    newCount: 5,
    learnCount: 0,
    reviewCount: 5,
  },
]);
jest.mock("anki-droid", () => ({
  __esModule: true,
  default: {
    isInstalled: (...a: any[]) => mockNativeIsInstalled(...a),
    hasApiPermission: (...a: any[]) => mockNativeHasApiPermission(...a),
    requestApiPermission: jest.fn().mockResolvedValue(true),
    getDeckNames: (...a: any[]) => mockNativeGetDeckNames(...a),
    getDeckInfo: (...a: any[]) => mockNativeGetDeckInfo(...a),
    getDueCards: (...a: any[]) => mockNativeGetDueCards(...a),
    answerCard: (...a: any[]) => mockNativeAnswerCard(...a),
    triggerSync: (...a: any[]) => mockNativeTriggerSync(...a),
  },
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

jest.mock("../audioLevelTracker", () => ({
  startAudioLevelTracking: jest.fn(),
  stopAudioLevelTracking: jest.fn(),
}));

jest.mock("../analytics", () => ({
  AnalyticsEvents: {
    sessionStarted: jest.fn(),
    sessionCompleted: jest.fn(),
    sessionError: jest.fn(),
    sessionReconnected: jest.fn(),
    // New: sessionManager fires this on the trial-expired-mid-start path.
    paywallShown: jest.fn(),
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

jest.mock("../trialService", () => ({
  // Default: trial is active with quota remaining. Individual tests can
  // override via mockRecordSession.mockResolvedValueOnce(...) to exercise
  // the "trial expired mid-deck-select" branch.
  recordSession: jest.fn().mockResolvedValue({
    isActive: true,
    daysRemaining: 7,
    sessionsRemaining: 9,
    subscriptionActive: false,
  }),
  checkTrialStatus: jest.fn().mockResolvedValue({
    isActive: true,
    daysRemaining: 7,
    sessionsRemaining: 9,
    subscriptionActive: false,
  }),
}));
const mockRecordSession = require("../trialService").recordSession as jest.Mock;

jest.mock("../../config/prompts", () => ({
  getSystemPrompt: jest.fn().mockReturnValue("SYS"),
  getInitialMessage: jest.fn().mockReturnValue("FIRST"),
  getResumeMessage: jest.fn().mockReturnValue("RESUME"),
  formatToolResult: jest.fn().mockReturnValue({ status: "success" }),
  allTools: [],
}));

import { sessionManager } from "../sessionManager";
import { useSessionStore } from "../../stores/useSessionStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useCardCacheStore } from "../../stores/useCardCacheStore";

const DECK = "Aws Exam SA";

const makeNativeCard = (id: number, ord = 0) => ({
  cardId: id,
  cardOrd: ord,
  front: `Q${id}`,
  back: `A${id}`,
  deckName: DECK,
});

beforeEach(() => {
  jest.clearAllMocks();
  useSessionStore.getState().resetSession();
  useCardCacheStore.getState().clear();
  useSettingsStore.setState({
    selectedDeck: DECK,
    onboardingCompleted: true,
    darkMode: true,
    deckReadBack: {},
    deckInstructions: {},
  });
  (sessionManager as any).clearEvaluatingRecovery?.();
  (sessionManager as any).lastAnsweredCardId = null;
  (sessionManager as any).lastAnsweredCardOrd = null;
  (sessionManager as any).toolCallNames = new Map();
});

describe("sessionManager.startSession() — cache contents after start", () => {
  it("reproduces the bug: native module returns 1 card → cache has 1 card", async () => {
    // Pre-fix behavior. AnkiDroid 2.23.x schedule URI returns one card per
    // query and the old getDueCards stopped there. Result on device: every
    // session is exactly one card long regardless of the deck's due count.
    mockNativeGetDueCards.mockResolvedValueOnce([makeNativeCard(101)]);

    await sessionManager.startSession();

    const { cards, currentIndex } = useCardCacheStore.getState();
    expect(cards).toHaveLength(1);
    expect(cards[0].cardId).toBe(101);
    expect(currentIndex).toBe(0);

    // The native bridge was called exactly once with the selected deck —
    // proves we exercised the real loadDueCards → ankiBridge.getDueCards path.
    expect(mockNativeGetDueCards).toHaveBeenCalledWith(DECK);
    expect(mockNativeGetDueCards).toHaveBeenCalledTimes(1);
  });

  it("verifies the fix: native module returns N cards → cache has N cards", async () => {
    // Post-fix behavior. The Kotlin getDueCards now hybrid-loads (schedule
    // URI for the head + ord, notes URI for the rest, capped at dueCount).
    // The native bridge therefore returns multiple cards in one call.
    const nativeCards = [
      makeNativeCard(201, 0), // head card from schedule URI (real ord)
      makeNativeCard(202), // padding from notes URI
      makeNativeCard(203),
      makeNativeCard(204),
      makeNativeCard(205),
    ];
    mockNativeGetDueCards.mockResolvedValueOnce(nativeCards);

    await sessionManager.startSession();

    const { cards, currentIndex } = useCardCacheStore.getState();
    expect(cards).toHaveLength(5);
    expect(cards.map((c) => c.cardId)).toEqual([201, 202, 203, 204, 205]);
    expect(currentIndex).toBe(0);
    // First card from schedule URI keeps its ord (used for write-back).
    expect(cards[0].cardOrd).toBe(0);
  });

  it("throws when native module returns no due cards (empty deck case)", async () => {
    // No cards due → loadDueCards returns []  → startSession transitions
    // to error('no_cards') and rethrows. Captures the existing contract so
    // we don't silently break the no-cards-due UX while fixing the count bug.
    mockNativeGetDueCards.mockResolvedValueOnce([]);

    await expect(sessionManager.startSession()).rejects.toThrow(/No cards due/);
    expect(useCardCacheStore.getState().cards).toHaveLength(0);
    expect(useSessionStore.getState().phase).toBe("error");
  });

  it("passes the selected deck name through to the native module", async () => {
    // Regression check: the wrong-deck bug from 2026-05-06 was a side effect
    // of AnkiDroid ignoring ?deckID= on the schedule URI; the JS layer must
    // still pass the user's selected deck through unchanged so the Kotlin
    // setSelectedDeck() call has the right input.
    useSettingsStore.setState({ selectedDeck: "A Different Deck" });
    mockNativeGetDueCards.mockResolvedValueOnce([makeNativeCard(301)]);

    await sessionManager.startSession();

    expect(mockNativeGetDueCards).toHaveBeenCalledWith("A Different Deck");
  });
});

describe("sessionManager.startSession() — totalDueAtStart snapshot (BUG 11)", () => {
  it("snapshots the deck's true dueCount from getDeckInfo, not the cache size", async () => {
    // Under BUG 5 v3b the cache starts with 1 card, but the real deck has
    // many more due. The session header denominator must reflect the deck,
    // not the cache.
    mockNativeGetDueCards.mockResolvedValueOnce([makeNativeCard(401)]);
    mockNativeGetDeckInfo.mockResolvedValueOnce([
      {
        deckName: DECK,
        dueCount: 234,
        newCount: 50,
        learnCount: 0,
        reviewCount: 184,
      },
    ]);

    await sessionManager.startSession();

    expect(useSessionStore.getState().totalDueAtStart).toBe(234);
  });

  it("falls back to cache size when the deck is not present in getDeckInfo", async () => {
    // Defensive: a renamed deck or a stale-cached deck list shouldn't
    // wedge the session. We log a warning and degrade to the old behavior.
    mockNativeGetDueCards.mockResolvedValueOnce([makeNativeCard(501)]);
    mockNativeGetDeckInfo.mockResolvedValueOnce([
      {
        deckName: "Some Other Deck",
        dueCount: 99,
        newCount: 0,
        learnCount: 0,
        reviewCount: 99,
      },
    ]);

    await sessionManager.startSession();

    expect(useSessionStore.getState().totalDueAtStart).toBe(1);
  });

  it("falls back to cache size when getDeckInfo throws", async () => {
    mockNativeGetDueCards.mockResolvedValueOnce([makeNativeCard(601)]);
    mockNativeGetDeckInfo.mockRejectedValueOnce(
      new Error("ContentProvider unavailable"),
    );

    await sessionManager.startSession();

    expect(useSessionStore.getState().totalDueAtStart).toBe(1);
  });
});

describe("sessionManager.startSession() — trial quota (Step 1b)", () => {
  // Step 1b is the server-authoritative trial check that runs after the
  // WebSocket connects but before any expensive work (audio init, card
  // load, AI prompt). The deck-select pre-check is a UI hint; this is
  // the real gate. See FREE-QUOTA.md for the design.

  it("calls recordSession after connect (active trial → session proceeds)", async () => {
    // Default mock in the suite header returns isActive=true — this test
    // just pins the call ordering: recordSession runs after connect and
    // before the card load.
    mockNativeGetDueCards.mockResolvedValueOnce([makeNativeCard(701)]);

    await sessionManager.startSession();

    expect(mockRecordSession).toHaveBeenCalledTimes(1);
    // The audio stack was initialized — proves the trial check did NOT
    // short-circuit the session.
    expect(mockSetMicrophoneMuted).toHaveBeenCalled();
    expect(useSessionStore.getState().phase).toBe("awaiting_answer");
  });

  it("aborts the session when recordSession reports trial exhausted (TOCTOU window)", async () => {
    // Server says the trial just expired between deck-select's pre-check
    // and this start. We must NOT start a session the user has no quota
    // for, even if the pre-check passed.
    mockNativeGetDueCards.mockResolvedValueOnce([makeNativeCard(702)]);
    mockRecordSession.mockResolvedValueOnce({
      isActive: false,
      daysRemaining: 0,
      sessionsRemaining: 0,
      subscriptionActive: false,
    });

    await expect(sessionManager.startSession()).rejects.toMatchObject({
      code: "trial_expired",
    });

    // We opened the socket for Step 1, so it has to come back down.
    expect(mockDisconnect).toHaveBeenCalled();
    // We did NOT proceed to set up the audio stack or load cards.
    expect(mockSetMicrophoneMuted).not.toHaveBeenCalled();
    expect(mockNativeGetDueCards).not.toHaveBeenCalled();
    // The phase machine lands on error so the UI can show the right copy.
    expect(useSessionStore.getState().phase).toBe("error");
  });

  it("proceeds when subscription is active even if the trial would be exhausted", async () => {
    // recordSession is a no-op server-side when subscriptionStatus='active'
    // and returns isActive=true. The client doesn't need to branch — the
    // shape is identical and the post-check just passes.
    mockNativeGetDueCards.mockResolvedValueOnce([makeNativeCard(703)]);
    mockRecordSession.mockResolvedValueOnce({
      isActive: true,
      daysRemaining: 0,
      sessionsRemaining: 0,
      subscriptionActive: true,
    });

    await sessionManager.startSession();

    expect(mockRecordSession).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().phase).toBe("awaiting_answer");
  });

  it("proceeds when recordSession returns the dev-bypass unlocked shape", async () => {
    // The "network blip" path is owned by trialService (it catches and
    // returns the unlocked shape). This test pins the contract from
    // sessionManager's side: whatever shape trialService returns, as
    // long as isActive=true the session proceeds. (Real dev runs go
    // through this exact path because the bypass returns the same shape.)
    mockNativeGetDueCards.mockResolvedValueOnce([makeNativeCard(704)]);
    mockRecordSession.mockResolvedValueOnce({
      isActive: true,
      daysRemaining: 99,
      sessionsRemaining: 99,
      subscriptionActive: true,
    });

    await sessionManager.startSession();

    expect(mockRecordSession).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().phase).toBe("awaiting_answer");
  });
});

describe("sessionManager.endSessionIfActive() — screen-unmount teardown", () => {
  // Regression for the stale-closure unmount bug: session.tsx's cleanup used
  // to read a phase captured at mount ('idle') and never ended the session,
  // leaving the mic, WebSocket and foreground service running after a
  // hardware-back. The fix routes cleanup through endSessionIfActive, which
  // reads the live phase from the store.

  it("tears down a running session", async () => {
    mockNativeGetDueCards.mockResolvedValueOnce([makeNativeCard(801)]);
    await sessionManager.startSession();
    expect(useSessionStore.getState().phase).toBe("awaiting_answer");

    const ended = sessionManager.endSessionIfActive();

    expect(ended).toBe(true);
    expect(mockDisconnect).toHaveBeenCalled();
    expect(useSessionStore.getState().phase).toBe("idle");
  });

  it("is a no-op when no session is running", () => {
    expect(useSessionStore.getState().phase).toBe("idle");

    const ended = sessionManager.endSessionIfActive();

    expect(ended).toBe(false);
    expect(mockDisconnect).not.toHaveBeenCalled();
  });
});
