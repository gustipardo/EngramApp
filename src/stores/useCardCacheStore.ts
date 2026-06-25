import { create } from 'zustand';
import type { AnkiCard } from '../types/anki';

export interface CardCacheStore {
  cards: AnkiCard[];
  /**
   * Data-layer pointer to the "card being graded right now." Advances
   * eagerly the moment `sendToolResult` fires so `getCurrentCard()` and
   * write-back use the correct card identity. See BUG 4 in
   * SESSION-FLOW.md — gating this on response.done caused freezes on
   * silent eval turns.
   */
  currentIndex: number;
  /**
   * UI-layer pointer to the card the user SEES. Lags behind `currentIndex`
   * during the feedback turn so the visible card matches what the tutor is
   * still speaking about. Committed forward to match `currentIndex` by
   * sessionManager's BUG 12 mechanism — transcript-driven when the AI
   * starts pronouncing the next question, or timeout/response.done
   * fallback when the transcript match can't be detected. Equal to
   * `currentIndex` when no advance is pending.
   */
  uiVisibleIndex: number;
  setCards: (cards: AnkiCard[]) => void;
  appendCards: (cards: AnkiCard[]) => number; // returns count actually appended (after dedupe)
  // Refill path (BUG 5 v3b): always pushes, NO dedupe. AnkiDroid can
  // legitimately return the same noteId twice in a session if the user
  // failed the card and the scheduler put it back at the head of the
  // learn queue — we want to re-present it. appendCards (dedupe) would
  // silently drop it, ending the session early.
  pushCard: (card: AnkiCard) => void;
  getCurrentCard: () => AnkiCard | undefined;
  getNextCard: () => AnkiCard | undefined;
  /**
   * Commit the UI pointer forward to match the data pointer. Idempotent —
   * if already in sync, no-op.
   */
  commitUiAdvance: () => void;
  clear: () => void;
}

export const useCardCacheStore = create<CardCacheStore>((set, get) => ({
  cards: [],
  currentIndex: 0,
  uiVisibleIndex: 0,

  setCards: (cards) => set({ cards, currentIndex: 0, uiVisibleIndex: 0 }),

  appendCards: (incoming) => {
    const { cards } = get();
    const seen = new Set(cards.map((c) => c.cardId));
    const fresh = incoming.filter((c) => !seen.has(c.cardId));
    if (fresh.length === 0) return 0;
    set({ cards: [...cards, ...fresh] });
    return fresh.length;
  },

  pushCard: (card) => set((s) => ({ cards: [...s.cards, card] })),

  getCurrentCard: () => {
    const { cards, currentIndex } = get();
    return cards[currentIndex];
  },

  getNextCard: () => {
    const { cards, currentIndex } = get();
    const nextIndex = currentIndex + 1;
    if (nextIndex < cards.length) {
      set({ currentIndex: nextIndex });
      return cards[nextIndex];
    }
    return undefined;
  },

  commitUiAdvance: () =>
    set((s) => (s.uiVisibleIndex === s.currentIndex ? s : { uiVisibleIndex: s.currentIndex })),

  clear: () => set({ cards: [], currentIndex: 0, uiVisibleIndex: 0 }),
}));
