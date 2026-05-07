// Mock the native module before importing ankiBridge.
const mockAnswerCard = jest.fn();
const mockIsInstalled = jest.fn();
const mockHasApiPermission = jest.fn();
const mockRequestApiPermission = jest.fn();
const mockGetDeckNames = jest.fn();
const mockGetDeckInfo = jest.fn();
const mockGetDueCards = jest.fn();
const mockTriggerSync = jest.fn();

jest.mock('anki-droid', () => ({
  __esModule: true,
  default: {
    isInstalled: (...a: any[]) => mockIsInstalled(...a),
    hasApiPermission: (...a: any[]) => mockHasApiPermission(...a),
    requestApiPermission: (...a: any[]) => mockRequestApiPermission(...a),
    getDeckNames: (...a: any[]) => mockGetDeckNames(...a),
    getDeckInfo: (...a: any[]) => mockGetDeckInfo(...a),
    getDueCards: (...a: any[]) => mockGetDueCards(...a),
    answerCard: (...a: any[]) => mockAnswerCard(...a),
    triggerSync: (...a: any[]) => mockTriggerSync(...a),
  },
}));

import { ankiBridge } from '../ankiBridge';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ankiBridge.answerCard', () => {
  describe('ease mapping', () => {
    it('maps pass=true to ease=4 (Easy)', async () => {
      mockAnswerCard.mockResolvedValueOnce({ updatedCards: 1, totalCards: 1 });
      await ankiBridge.answerCard('TestDeck', 123, 0, true);
      expect(mockAnswerCard).toHaveBeenCalledWith('TestDeck', 123, 0, 4, 0);
    });

    it('maps pass=false to ease=1 (Again)', async () => {
      mockAnswerCard.mockResolvedValueOnce({ updatedCards: 1, totalCards: 1 });
      await ankiBridge.answerCard('TestDeck', 123, 0, false);
      expect(mockAnswerCard).toHaveBeenCalledWith('TestDeck', 123, 0, 1, 0);
    });

    it('forwards timeTakenMs argument', async () => {
      mockAnswerCard.mockResolvedValueOnce({ updatedCards: 1, totalCards: 1 });
      await ankiBridge.answerCard('TestDeck', 456, 0, true, 1234);
      expect(mockAnswerCard).toHaveBeenCalledWith('TestDeck', 456, 0, 4, 1234);
    });
  });

  describe('return value', () => {
    it('returns true when at least one card was updated', async () => {
      mockAnswerCard.mockResolvedValueOnce({ updatedCards: 1, totalCards: 1 });
      await expect(ankiBridge.answerCard('TestDeck', 1, 0, true)).resolves.toBe(true);
    });

    it('returns true when multiple sibling cards were updated (cloze)', async () => {
      mockAnswerCard.mockResolvedValueOnce({ updatedCards: 3, totalCards: 3 });
      await expect(ankiBridge.answerCard('TestDeck', 1, 0, true)).resolves.toBe(true);
    });

    it('retries and returns false when both attempts return zero rows', async () => {
      mockAnswerCard
        .mockResolvedValueOnce({ updatedCards: 0, totalCards: 1 })
        .mockResolvedValueOnce({ updatedCards: 0, totalCards: 1 });
      await expect(ankiBridge.answerCard('TestDeck', 1, 0, true)).resolves.toBe(false);
      expect(mockAnswerCard).toHaveBeenCalledTimes(2);
    });
  });

  describe('retry behavior', () => {
    it('retries once after a thrown error and returns true on second success', async () => {
      mockAnswerCard
        .mockRejectedValueOnce(new Error('transient ContentResolver error'))
        .mockResolvedValueOnce({ updatedCards: 1, totalCards: 1 });
      await expect(ankiBridge.answerCard('TestDeck', 1, 0, true)).resolves.toBe(true);
      expect(mockAnswerCard).toHaveBeenCalledTimes(2);
    });

    it('returns false (never throws) when both attempts throw', async () => {
      mockAnswerCard
        .mockRejectedValueOnce(new Error('first'))
        .mockRejectedValueOnce(new Error('retry'));
      await expect(ankiBridge.answerCard('TestDeck', 1, 0, true)).resolves.toBe(false);
      expect(mockAnswerCard).toHaveBeenCalledTimes(2);
    });

    it('does not retry when first call already returned success', async () => {
      mockAnswerCard.mockResolvedValueOnce({ updatedCards: 1, totalCards: 1 });
      await ankiBridge.answerCard('TestDeck', 1, 0, true);
      expect(mockAnswerCard).toHaveBeenCalledTimes(1);
    });
  });
});
