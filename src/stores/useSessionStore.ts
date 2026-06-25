import { create } from 'zustand';
import type { SessionPhase, SessionStats } from '../types/session';
import { sessionLog } from '../services/sessionDebugLogger';

export interface SessionStore {
  phase: SessionPhase;
  currentCardIndex: number;
  stats: SessionStats;
  lastEvaluation: 'correct' | 'incorrect' | null;
  /**
   * Snapshot of the deck's true due-card count at session start (from
   * `ankiBridge.getDeckInfo()`). Used as the denominator of the session
   * progress bar so the UI displays "answered / due-at-start" instead of
   * "currentIndex / cache.length" (which under the BUG 5 v3b refill-from-
   * scheduler design starts at 1 and only grows as cards are answered —
   * see SESSION-FLOW.md §4.BUG 11). 0 means "unknown / not yet snapshotted".
   */
  totalDueAtStart: number;
  transitionTo: (phase: SessionPhase, trigger: string) => void;
  recordAnswer: (evaluation: 'correct' | 'incorrect') => void;
  advanceCard: () => void;
  setTotalDueAtStart: (count: number) => void;
  resetSession: () => void;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  phase: 'idle',
  currentCardIndex: 0,
  stats: { correct: 0, incorrect: 0 },
  lastEvaluation: null,
  totalDueAtStart: 0,

  transitionTo: (phase, trigger) => {
    const prev = get().phase;
    if (prev !== phase) sessionLog.phase(prev, phase, trigger);
    set({ phase });
  },

  recordAnswer: (evaluation) =>
    set((state) => ({
      stats: {
        correct: state.stats.correct + (evaluation === 'correct' ? 1 : 0),
        incorrect: state.stats.incorrect + (evaluation === 'incorrect' ? 1 : 0),
      },
      lastEvaluation: evaluation,
    })),

  advanceCard: () =>
    set((state) => ({ currentCardIndex: state.currentCardIndex + 1 })),

  setTotalDueAtStart: (count) => set({ totalDueAtStart: count }),

  resetSession: () =>
    set({
      phase: 'idle',
      currentCardIndex: 0,
      stats: { correct: 0, incorrect: 0 },
      lastEvaluation: null,
      totalDueAtStart: 0,
    }),
}));
