/**
 * Unit tests for geminiManager's session-resumption + context-window-compression
 * wiring (GEMINI-API.md §16 features; BUG 15 fix).
 *
 * geminiManager is otherwise not loaded by the node test suite (sessionManager
 * tests mock it), so this file stands up the minimal native/env mocks + a fake
 * WebSocket to exercise the real setup-payload and message-handling code paths.
 */

jest.mock("expo-constants", () => ({
  __esModule: true,
  default: { expoConfig: { extra: { geminiApiKey: "test-key" } } },
}));

jest.mock("expo-foreground-audio", () => ({
  __esModule: true,
  default: {
    initAudioPlayer: jest.fn().mockResolvedValue(undefined),
    playAudioChunk: jest.fn().mockResolvedValue(undefined),
    flushAudioPlayer: jest.fn().mockResolvedValue(undefined),
    stopAudioPlayer: jest.fn().mockResolvedValue(undefined),
    startMicCapture: jest.fn().mockResolvedValue(undefined),
    haltAudioPlayer: jest.fn(),
  },
}));

jest.mock("../micSource", () => ({
  micSource: {
    startCapture: jest.fn().mockResolvedValue(undefined),
    stopCapture: jest.fn().mockResolvedValue(undefined),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

import { geminiManager } from "../geminiManager";

// --- Fake WebSocket (global) --------------------------------------------------
let lastWs: FakeWebSocket | null = null;

class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  onmessage: ((e: any) => void) | null = null;
  onclose: ((e: any) => void) | null = null;

  constructor(public url: string) {
    lastWs = this;
    // Open on the next tick so openWebSocket() can attach handlers first.
    setTimeout(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }
}

beforeAll(() => {
  (global as any).WebSocket = FakeWebSocket as any;
});

afterEach(async () => {
  // Full teardown resets the singleton (clears handlers, ws, isSetupDone, and
  // the resumption handle) so tests don't bleed into each other.
  geminiManager.disconnect();
  lastWs = null;
});

// --- helpers ------------------------------------------------------------------

/** Parse the most recent `{ setup: ... }` payload the manager sent. */
function lastSetup(): any {
  const raw = [...(lastWs?.sent ?? [])]
    .reverse()
    .find((s) => s.includes('"setup"'));
  if (!raw) throw new Error("no setup payload was sent");
  return JSON.parse(raw).setup;
}

/** Drive updateSession to completion by feeding back a setupComplete. */
async function completeSetup(config: any): Promise<void> {
  const p = geminiManager.updateSession(config);
  // The setup payload is sent + the resolve handler registered synchronously
  // before updateSession yields; a microtask is enough to settle.
  await Promise.resolve();
  lastWs?.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) });
  await p;
}

const handle = (msg: object) =>
  (geminiManager as any).handleMessage(JSON.stringify(msg));

// --- tests --------------------------------------------------------------------

describe("geminiManager — context-window compression", () => {
  it("enables sliding-window compression in the setup payload", async () => {
    await geminiManager.connect();
    await completeSetup({ instructions: "sys" });

    expect(lastSetup().contextWindowCompression).toEqual({ slidingWindow: {} });
  });
});

describe("geminiManager — session resumption", () => {
  it("sends an empty sessionResumption on a fresh session (no handle)", async () => {
    await geminiManager.connect();
    await completeSetup({ instructions: "sys" });

    expect(lastSetup().sessionResumption).toEqual({});
  });

  it("caches a resumable handle and replays it in the next setup", async () => {
    await geminiManager.connect();
    // Server issues a resumable handle mid-session.
    await handle({
      sessionResumptionUpdate: { newHandle: "H1", resumable: true },
    });
    // Force a re-setup (as a reconnect would) and confirm the handle is replayed.
    (geminiManager as any).isSetupDone = false;
    await completeSetup({ instructions: "sys" });

    expect(lastSetup().sessionResumption).toEqual({ handle: "H1" });
  });

  it("ignores a non-resumable handle update", async () => {
    await geminiManager.connect();
    await handle({
      sessionResumptionUpdate: { newHandle: "H2", resumable: false },
    });

    expect((geminiManager as any).sessionResumptionHandle).toBeNull();
  });

  it("clearSessionResumptionHandle drops the cached handle so the next setup is cold (BUG 9 wedge recovery)", async () => {
    await geminiManager.connect();
    await handle({
      sessionResumptionUpdate: { newHandle: "H-WEDGED", resumable: true },
    });
    expect((geminiManager as any).sessionResumptionHandle).toBe("H-WEDGED");

    // Wedge recovery drops the handle so the reconnect does NOT restore the
    // poisoned conversation context (a handle-resume reproduces the
    // ctrl-token wedge on the very next eval — verified against the live
    // API 2026-07-01).
    geminiManager.clearSessionResumptionHandle();
    (geminiManager as any).isSetupDone = false;
    await completeSetup({ instructions: "sys" });

    expect(lastSetup().sessionResumption).toEqual({});
  });

  it("preserves the handle across a reconnect but clears it on a fresh connect", async () => {
    // Reconnect path: isReconnecting is set by reconnect() before connect().
    (geminiManager as any).sessionResumptionHandle = "H3";
    (geminiManager as any).isReconnecting = true;
    await geminiManager.connect();
    expect((geminiManager as any).sessionResumptionHandle).toBe("H3");

    // Fresh path: a new session must not carry the stale handle.
    (geminiManager as any).isReconnecting = false;
    await geminiManager.connect();
    expect((geminiManager as any).sessionResumptionHandle).toBeNull();
  });
});

describe("geminiManager — VAD tuning (input-death regression)", () => {
  it("never sends prefixPaddingMs — it silently kills speech detection on this model", async () => {
    await geminiManager.connect();
    await completeSetup({ instructions: "sys" });

    const aad = lastSetup().realtimeInputConfig.automaticActivityDetection;
    // Bisected against the live API 2026-07-01: {prefixPaddingMs: 300}
    // alone → no inputTranscription, user turns never commit (the session
    // goes deaf). The other three fields are safe and load-bearing.
    expect(aad.prefixPaddingMs).toBeUndefined();
    expect(aad).toEqual({
      startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
      endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
      silenceDurationMs: 800,
    });
  });
});

describe("geminiManager — goAway", () => {
  it("emits ws.goAway with the server's timeLeft", async () => {
    const spy = jest.fn();
    geminiManager.on("ws.goAway", spy);

    await handle({ goAway: { timeLeft: "5s" } });

    expect(spy).toHaveBeenCalledWith({ timeLeft: "5s" });
    geminiManager.off("ws.goAway", spy);
  });
});
