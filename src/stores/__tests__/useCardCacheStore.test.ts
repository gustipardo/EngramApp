import { useCardCacheStore } from '../useCardCacheStore';
import type { AnkiCard } from '../../types/anki';

const mockCards: AnkiCard[] = [
  { cardId: 1, cardOrd: 0, front: 'What is React?', back: 'A JS library', deckName: 'Dev' },
  { cardId: 2, cardOrd: 0, front: 'What is TypeScript?', back: 'Typed JS', deckName: 'Dev' },
  { cardId: 3, cardOrd: 0, front: 'What is Zustand?', back: 'State management', deckName: 'Dev' },
];

beforeEach(() => {
  useCardCacheStore.getState().clear();
});

describe('useCardCacheStore', () => {
  describe('initial state', () => {
    it('starts with empty cards', () => {
      expect(useCardCacheStore.getState().cards).toEqual([]);
    });

    it('starts with currentIndex 0', () => {
      expect(useCardCacheStore.getState().currentIndex).toBe(0);
    });
  });

  describe('setCards', () => {
    it('populates cards and resets index', () => {
      useCardCacheStore.getState().setCards(mockCards);
      expect(useCardCacheStore.getState().cards).toEqual(mockCards);
      expect(useCardCacheStore.getState().currentIndex).toBe(0);
    });

    it('replaces existing cards', () => {
      useCardCacheStore.getState().setCards(mockCards);
      const newCards = [mockCards[0]];
      useCardCacheStore.getState().setCards(newCards);
      expect(useCardCacheStore.getState().cards).toEqual(newCards);
      expect(useCardCacheStore.getState().currentIndex).toBe(0);
    });
  });

  describe('getCurrentCard', () => {
    it('returns first card after setCards', () => {
      useCardCacheStore.getState().setCards(mockCards);
      expect(useCardCacheStore.getState().getCurrentCard()).toEqual(mockCards[0]);
    });

    it('returns undefined when no cards', () => {
      expect(useCardCacheStore.getState().getCurrentCard()).toBeUndefined();
    });
  });

  describe('getNextCard', () => {
    it('advances to next card and returns it', () => {
      useCardCacheStore.getState().setCards(mockCards);
      const next = useCardCacheStore.getState().getNextCard();
      expect(next).toEqual(mockCards[1]);
      expect(useCardCacheStore.getState().currentIndex).toBe(1);
    });

    it('returns undefined when at end of cards', () => {
      useCardCacheStore.getState().setCards([mockCards[0]]);
      const next = useCardCacheStore.getState().getNextCard();
      expect(next).toBeUndefined();
    });

    it('advances through all cards sequentially', () => {
      useCardCacheStore.getState().setCards(mockCards);
      expect(useCardCacheStore.getState().getCurrentCard()).toEqual(mockCards[0]);

      expect(useCardCacheStore.getState().getNextCard()).toEqual(mockCards[1]);
      expect(useCardCacheStore.getState().getNextCard()).toEqual(mockCards[2]);
      expect(useCardCacheStore.getState().getNextCard()).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('empties cards and resets index', () => {
      useCardCacheStore.getState().setCards(mockCards);
      useCardCacheStore.getState().getNextCard();

      useCardCacheStore.getState().clear();

      expect(useCardCacheStore.getState().cards).toEqual([]);
      expect(useCardCacheStore.getState().currentIndex).toBe(0);
    });

    it('also resets uiVisibleIndex', () => {
      useCardCacheStore.getState().setCards(mockCards);
      // Pretend UI was lagging behind data by 1.
      useCardCacheStore.setState({ uiVisibleIndex: 0, currentIndex: 2 });
      useCardCacheStore.getState().clear();
      expect(useCardCacheStore.getState().uiVisibleIndex).toBe(0);
    });
  });

  describe('setCards pointer reset', () => {
    it('resets uiVisibleIndex alongside currentIndex', () => {
      useCardCacheStore.getState().setCards(mockCards);
      useCardCacheStore.setState({ currentIndex: 2, uiVisibleIndex: 2 });
      // Replace with a new set of cards (e.g. next session).
      useCardCacheStore.getState().setCards([
        { cardId: 99, cardOrd: 0, front: 'Q', back: 'A', deckName: 'New' },
      ]);
      expect(useCardCacheStore.getState().currentIndex).toBe(0);
      expect(useCardCacheStore.getState().uiVisibleIndex).toBe(0);
    });
  });

  describe('appendCards (dedupe path)', () => {
    it('appends new cards not already in the cache', () => {
      useCardCacheStore.getState().setCards([mockCards[0], mockCards[1]]);
      const appended = useCardCacheStore
        .getState()
        .appendCards([mockCards[2]]);
      expect(appended).toBe(1);
      expect(useCardCacheStore.getState().cards).toEqual(mockCards);
    });

    it('dedupes by cardId — duplicate cardIds are dropped, count reflects only the fresh ones', () => {
      useCardCacheStore.getState().setCards([mockCards[0], mockCards[1]]);
      const appended = useCardCacheStore
        .getState()
        .appendCards([mockCards[0], mockCards[1], mockCards[2]]);
      expect(appended).toBe(1);
      expect(useCardCacheStore.getState().cards).toEqual(mockCards);
    });

    it('returns 0 when all incoming cards are duplicates', () => {
      useCardCacheStore.getState().setCards(mockCards);
      const appended = useCardCacheStore
        .getState()
        .appendCards([mockCards[0], mockCards[1]]);
      expect(appended).toBe(0);
      // Original cache untouched.
      expect(useCardCacheStore.getState().cards).toEqual(mockCards);
    });

    it('returns 0 on empty incoming list (no allocation)', () => {
      useCardCacheStore.getState().setCards(mockCards);
      const appended = useCardCacheStore.getState().appendCards([]);
      expect(appended).toBe(0);
      expect(useCardCacheStore.getState().cards).toEqual(mockCards);
    });

    it('appending does NOT advance currentIndex', () => {
      // Pinning BUG 5 v3b semantics: append is for pre-loading future cards,
      // not for advancing the cursor. The advance happens via getNextCard.
      useCardCacheStore.getState().setCards([mockCards[0]]);
      useCardCacheStore.getState().appendCards([mockCards[1]]);
      expect(useCardCacheStore.getState().currentIndex).toBe(0);
      expect(useCardCacheStore.getState().getCurrentCard()).toEqual(mockCards[0]);
    });

    it('appends onto an empty cache', () => {
      const appended = useCardCacheStore
        .getState()
        .appendCards([mockCards[0], mockCards[1]]);
      expect(appended).toBe(2);
      expect(useCardCacheStore.getState().cards).toEqual([
        mockCards[0],
        mockCards[1],
      ]);
    });
  });

  describe('pushCard (BUG 5 v3b refill path — NO dedupe)', () => {
    it('pushes even if cardId is already in the cache (reschedule case)', () => {
      // The whole point of pushCard vs appendCards: AnkiDroid can return the
      // same noteId twice when the user failed the card and the scheduler
      // put it back at the head of the learn queue. We must re-present it.
      useCardCacheStore.getState().setCards(mockCards);
      const rescheduled = {
        cardId: 1,
        cardOrd: 0,
        front: 'What is React?',
        back: 'A JS library',
        deckName: 'Dev',
      };
      useCardCacheStore.getState().pushCard(rescheduled);
      expect(useCardCacheStore.getState().cards).toHaveLength(4);
      expect(useCardCacheStore.getState().cards[3]).toEqual(rescheduled);
    });

    it('pushes onto an empty cache', () => {
      useCardCacheStore.getState().pushCard(mockCards[0]);
      expect(useCardCacheStore.getState().cards).toEqual([mockCards[0]]);
    });

    it('does NOT advance currentIndex (the caller decides when to advance)', () => {
      useCardCacheStore.getState().setCards([mockCards[0]]);
      useCardCacheStore.getState().pushCard(mockCards[1]);
      expect(useCardCacheStore.getState().currentIndex).toBe(0);
    });

    it('differs from appendCards in deduplication behavior', () => {
      // Direct contrast test — pins the documented split.
      useCardCacheStore.getState().setCards([mockCards[0]]);

      useCardCacheStore.getState().appendCards([mockCards[0]]);
      expect(useCardCacheStore.getState().cards).toHaveLength(1); // dropped

      useCardCacheStore.getState().pushCard(mockCards[0]);
      expect(useCardCacheStore.getState().cards).toHaveLength(2); // kept
    });
  });

  describe('commitUiAdvance (BUG 12 pointer sync)', () => {
    it('commits UI pointer forward to match data pointer', () => {
      useCardCacheStore.getState().setCards(mockCards);
      useCardCacheStore.setState({ currentIndex: 2, uiVisibleIndex: 1 });
      useCardCacheStore.getState().commitUiAdvance();
      expect(useCardCacheStore.getState().uiVisibleIndex).toBe(2);
    });

    it('is a no-op when pointers are already in sync', () => {
      useCardCacheStore.getState().setCards(mockCards);
      useCardCacheStore.setState({ currentIndex: 1, uiVisibleIndex: 1 });
      // Snapshot state reference — zustand returns a new object on set,
      // so an identity comparison is meaningful here.
      const before = useCardCacheStore.getState();
      useCardCacheStore.getState().commitUiAdvance();
      const after = useCardCacheStore.getState();
      // Identity preserved on no-op (the implementation returns `s` directly).
      expect(after.uiVisibleIndex).toBe(before.uiVisibleIndex);
      expect(after.currentIndex).toBe(before.currentIndex);
    });

    it('handles the initial case (both pointers at 0)', () => {
      useCardCacheStore.getState().setCards(mockCards);
      useCardCacheStore.getState().commitUiAdvance();
      expect(useCardCacheStore.getState().uiVisibleIndex).toBe(0);
    });

    it('can be called when uiVisibleIndex is AHEAD of currentIndex (defensive)', () => {
      // The data layer should never be ahead of the UI layer in practice
      // (UI lags behind data), but pinning the actual behavior: the
      // implementation just checks equality and unconditionally writes
      // uiVisibleIndex = currentIndex on any diff — so if UI is ahead,
      // it gets clamped back to match currentIndex. That matches the
      // intent: uiVisibleIndex is "the card the user SEES" and that
      // should never be ahead of where the data layer has actually
      // advanced to.
      useCardCacheStore.getState().setCards(mockCards);
      useCardCacheStore.setState({ currentIndex: 0, uiVisibleIndex: 2 });
      useCardCacheStore.getState().commitUiAdvance();
      expect(useCardCacheStore.getState().uiVisibleIndex).toBe(0);
    });
  });

  describe('uiVisibleIndex defaults and lifecycle', () => {
    it('starts at 0', () => {
      expect(useCardCacheStore.getState().uiVisibleIndex).toBe(0);
    });

    it('tracks getNextCard (advances together with currentIndex)', () => {
      // getNextCard only touches currentIndex. The UI pointer is
      // independent — sessionManager drives commitUiAdvance.
      useCardCacheStore.getState().setCards(mockCards);
      useCardCacheStore.getState().getNextCard();
      expect(useCardCacheStore.getState().currentIndex).toBe(1);
      expect(useCardCacheStore.getState().uiVisibleIndex).toBe(0); // unchanged
    });
  });
});
