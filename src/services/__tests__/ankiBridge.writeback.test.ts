/**
 * Unit tests for ankiBridge.answerCard — the JS retry wrapper around the
 * native AnkiDroid module.
 *
 * Coverage targets:
 *  - ease mapping (pass=true → ease=4, pass=false → ease=1)
 *  - fire-and-forget path: first success → no retry, returns true immediately
 *  - 0-rows path: first call returns 0 rows → waits 500ms → retries
 *  - throw path: first call throws → waits 500ms → retries
 *  - double-fail: both calls fail → returns false (never throws)
 *  - timeTakenMs default = 0
 */

jest.useFakeTimers();

const mockNativeAnswerCard = jest.fn();

jest.mock('anki-droid', () => ({
  __esModule: true,
  default: {
    answerCard: (...a: any[]) => mockNativeAnswerCard(...a),
  },
}));

jest.mock('expo-modules-core', () => ({
  NativeModule: class {},
  requireNativeModule: (_name: string) => ({
    answerCard: (...a: any[]) => mockNativeAnswerCard(...a),
  }),
}));

// Import after mocks are set up.
// Each test file gets its own module registry via jest.isolateModules if needed;
// here a module-level import is fine because we only reset mockNativeAnswerCard.
import { ankiBridge } from '../../native/ankiBridge';

beforeEach(() => {
  // resetAllMocks: clears call history AND mockOnce implementation queues.
  // clearAllTimers: cancels any pending fake timers leaked from prior tests.
  jest.resetAllMocks();
  jest.clearAllTimers();
});

// ─── ease mapping ────────────────────────────────────────────────────────────

describe('ankiBridge.answerCard — ease mapping', () => {
  it('passes ease=4 (Easy) when pass=true', async () => {
    mockNativeAnswerCard.mockResolvedValue({ updatedCards: 1, totalCards: 1 });

    await ankiBridge.answerCard('MyDeck', 42, 0, true);

    expect(mockNativeAnswerCard).toHaveBeenCalledWith('MyDeck', 42, 0, 4, 0);
  });

  it('passes ease=1 (Again) when pass=false', async () => {
    mockNativeAnswerCard.mockResolvedValue({ updatedCards: 1, totalCards: 1 });

    await ankiBridge.answerCard('MyDeck', 42, 0, false);

    expect(mockNativeAnswerCard).toHaveBeenCalledWith('MyDeck', 42, 0, 1, 0);
  });

  it('forwards timeTakenMs when provided', async () => {
    mockNativeAnswerCard.mockResolvedValue({ updatedCards: 1, totalCards: 1 });

    await ankiBridge.answerCard('MyDeck', 42, 0, true, 3000);

    expect(mockNativeAnswerCard).toHaveBeenCalledWith('MyDeck', 42, 0, 4, 3000);
  });

  it('defaults timeTakenMs to 0 when omitted', async () => {
    mockNativeAnswerCard.mockResolvedValue({ updatedCards: 1, totalCards: 1 });

    await ankiBridge.answerCard('MyDeck', 42, 0, true);

    const call = mockNativeAnswerCard.mock.calls[0];
    expect(call[4]).toBe(0);
  });
});

// ─── happy path ───────────────────────────────────────────────────────────────

describe('ankiBridge.answerCard — happy path (first attempt succeeds)', () => {
  it('returns true when first attempt returns updatedCards=1', async () => {
    mockNativeAnswerCard.mockResolvedValue({ updatedCards: 1, totalCards: 1 });

    const result = await ankiBridge.answerCard('MyDeck', 1, 0, true);

    expect(result).toBe(true);
  });

  it('calls native module exactly once — no retry needed', async () => {
    mockNativeAnswerCard.mockResolvedValue({ updatedCards: 1, totalCards: 1 });

    const promise = ankiBridge.answerCard('MyDeck', 1, 0, true);
    // Advance time: no timers should be pending for the success path.
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(mockNativeAnswerCard).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
  });
});

// ─── 0-rows path (retry) ──────────────────────────────────────────────────────

describe('ankiBridge.answerCard — 0-rows path triggers retry', () => {
  it('retries after 500ms when first attempt returns updatedCards=0', async () => {
    mockNativeAnswerCard
      .mockResolvedValueOnce({ updatedCards: 0, totalCards: 0 })
      .mockResolvedValueOnce({ updatedCards: 1, totalCards: 1 });

    const promise = ankiBridge.answerCard('MyDeck', 99, 0, true);
    await jest.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(mockNativeAnswerCard).toHaveBeenCalledTimes(2);
    expect(result).toBe(true);
  });

  it('returns false when both attempts return updatedCards=0', async () => {
    mockNativeAnswerCard
      .mockResolvedValueOnce({ updatedCards: 0, totalCards: 0 })
      .mockResolvedValueOnce({ updatedCards: 0, totalCards: 0 });

    const promise = ankiBridge.answerCard('MyDeck', 99, 0, true);
    await jest.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(mockNativeAnswerCard).toHaveBeenCalledTimes(2);
    expect(result).toBe(false);
  });

  it('does NOT retry before the 500ms delay elapses', async () => {
    mockNativeAnswerCard
      .mockResolvedValueOnce({ updatedCards: 0, totalCards: 0 })
      .mockResolvedValueOnce({ updatedCards: 1, totalCards: 1 });

    const promise = ankiBridge.answerCard('MyDeck', 99, 0, true);
    await jest.advanceTimersByTimeAsync(499);

    // First call done, retry not yet fired.
    expect(mockNativeAnswerCard).toHaveBeenCalledTimes(1);

    // Drain remaining 1ms so the pending timer doesn't leak into the next test.
    await jest.advanceTimersByTimeAsync(1);
    await promise;
  });
});

// ─── throw path (retry) ───────────────────────────────────────────────────────

describe('ankiBridge.answerCard — throw path triggers retry', () => {
  it('retries after 500ms when first attempt throws', async () => {
    mockNativeAnswerCard
      .mockRejectedValueOnce(new Error('ContentProvider unavailable'))
      .mockResolvedValueOnce({ updatedCards: 1, totalCards: 1 });

    const promise = ankiBridge.answerCard('MyDeck', 55, 0, false);
    await jest.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(mockNativeAnswerCard).toHaveBeenCalledTimes(2);
    expect(result).toBe(true);
  });

  it('returns false when first throws and retry returns 0 rows', async () => {
    mockNativeAnswerCard
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ updatedCards: 0, totalCards: 0 });

    const promise = ankiBridge.answerCard('MyDeck', 55, 0, false);
    await jest.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toBe(false);
  });

  it('returns false when both attempts throw — never propagates', async () => {
    mockNativeAnswerCard
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockRejectedValueOnce(new Error('permission denied'));

    const promise = ankiBridge.answerCard('MyDeck', 55, 0, true);
    await jest.advanceTimersByTimeAsync(500);

    await expect(promise).resolves.toBe(false);
  });

  it('never throws regardless of native module failure', async () => {
    mockNativeAnswerCard.mockRejectedValue(new Error('critical failure'));

    const promise = ankiBridge.answerCard('MyDeck', 55, 0, true);
    await jest.advanceTimersByTimeAsync(500);

    await expect(promise).resolves.toBeDefined();
  });
});

// ─── argument forwarding ──────────────────────────────────────────────────────

describe('ankiBridge.answerCard — argument forwarding', () => {
  it('forwards deckName, noteId, and cardOrd unchanged to native module', async () => {
    mockNativeAnswerCard.mockResolvedValue({ updatedCards: 1, totalCards: 1 });

    await ankiBridge.answerCard('Aws Exam SA', 123456789, 2, true, 1500);

    expect(mockNativeAnswerCard).toHaveBeenCalledWith('Aws Exam SA', 123456789, 2, 4, 1500);
  });

  it('retry call uses same args as first call', async () => {
    mockNativeAnswerCard
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce({ updatedCards: 1, totalCards: 1 });

    const promise = ankiBridge.answerCard('Deck B', 77, 1, false, 2000);
    await jest.advanceTimersByTimeAsync(500);
    await promise;

    expect(mockNativeAnswerCard).toHaveBeenNthCalledWith(1, 'Deck B', 77, 1, 1, 2000);
    expect(mockNativeAnswerCard).toHaveBeenNthCalledWith(2, 'Deck B', 77, 1, 1, 2000);
  });
});
