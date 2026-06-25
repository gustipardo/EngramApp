import { ankiBridge } from '../native/ankiBridge';
import { useCardCacheStore } from '../stores/useCardCacheStore';
import { useSessionStore } from '../stores/useSessionStore';
import { sessionLog } from './sessionDebugLogger';
import type { AnkiCard } from '../types/anki';

/**
 * Load due cards from AnkiDroid into the card cache.
 * Returns the loaded cards for immediate use.
 */
export async function loadDueCards(deckName: string): Promise<AnkiCard[]> {
  const { transitionTo } = useSessionStore.getState();
  const { setCards } = useCardCacheStore.getState();

  transitionTo('loading_cards', 'loadDueCards');

  try {
    const cards = await ankiBridge.getDueCards(deckName);

    if (cards.length === 0) {
      sessionLog.warn('CardLoader', 'no due cards found', { deck: deckName });
      return [];
    }

    setCards(cards);
    sessionLog.event('CardLoader', 'cards loaded', { deck: deckName, count: cards.length });
    return cards;
  } catch (error: any) {
    sessionLog.error('CardLoader', 'failed to load cards', { deck: deckName, message: error?.message });
    throw error;
  }
}

/**
 * Get the current card from cache.
 */
export function getCurrentCard(): AnkiCard | undefined {
  return useCardCacheStore.getState().getCurrentCard();
}

/**
 * Advance to the next card and return it.
 * Returns undefined if no more cards.
 */
export function getNextCard(): AnkiCard | undefined {
  return useCardCacheStore.getState().getNextCard();
}

/**
 * Peek at the next card WITHOUT advancing the index.
 * Used to prepare tool results before the AI finishes speaking.
 */
export function peekNextCard(): AnkiCard | undefined {
  const { cards, currentIndex } = useCardCacheStore.getState();
  return cards[currentIndex + 1];
}

/**
 * Get remaining card count.
 */
export function getRemainingCardCount(): number {
  const { cards, currentIndex } = useCardCacheStore.getState();
  return Math.max(0, cards.length - currentIndex);
}

/**
 * Get remaining card count as if we had already advanced by one.
 * Used to report correct remaining count in tool results before actual advance.
 */
export function peekRemainingAfterAdvance(): number {
  const { cards, currentIndex } = useCardCacheStore.getState();
  return Math.max(0, cards.length - (currentIndex + 1));
}

/**
 * Advance the card cache index by one (without returning the card).
 * Used to sync the visual card display after the AI finishes speaking.
 */
export function advanceCacheIndex(): void {
  const store = useCardCacheStore.getState();
  const { cards, currentIndex } = store;
  if (currentIndex + 1 < cards.length) {
    useCardCacheStore.setState({ currentIndex: currentIndex + 1 });
  }
}

/**
 * Get total card count.
 */
export function getTotalCardCount(): number {
  return useCardCacheStore.getState().cards.length;
}

/**
 * Clear the card cache.
 */
export function clearCards(): void {
  useCardCacheStore.getState().clear();
}

/**
 * Refill path (BUG 5 v3b). After each answerCard write-back, the
 * AnkiDroid scheduler's head advances to the next due card in the deck.
 * We re-query, push it onto the cache (no dedupe — failed cards can
 * legitimately re-appear), and return it so the caller can include it
 * in the next tool_result.
 *
 * Returns `null` when the deck is exhausted (scheduler returns empty).
 * The caller should treat that as the "no more cards" signal.
 */
export async function fetchAndAppendNextCard(deckName: string): Promise<AnkiCard | null> {
  try {
    const cards = await ankiBridge.getDueCards(deckName);
    if (!cards || cards.length === 0) {
      sessionLog.event('CardLoader', 'scheduler returned no more cards', { deck: deckName });
      return null;
    }
    // queryDueCards now returns only the scheduler head — take [0].
    const next = cards[0];
    useCardCacheStore.getState().pushCard(next);
    sessionLog.event('CardLoader', 'refilled next card from scheduler', {
      deck: deckName,
      cardId: next.cardId,
      ord: next.cardOrd,
    });
    return next;
  } catch (error: any) {
    sessionLog.error('CardLoader', 'refill failed', { deck: deckName, message: error?.message });
    return null;
  }
}
