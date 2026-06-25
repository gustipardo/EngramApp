import { useSessionStore } from '../useSessionStore';

// Reset store before each test
beforeEach(() => {
  useSessionStore.getState().resetSession();
});

describe('useSessionStore', () => {
  describe('initial state', () => {
    it('starts with idle phase', () => {
      expect(useSessionStore.getState().phase).toBe('idle');
    });

    it('starts with currentCardIndex 0', () => {
      expect(useSessionStore.getState().currentCardIndex).toBe(0);
    });

    it('starts with zeroed stats', () => {
      expect(useSessionStore.getState().stats).toEqual({ correct: 0, incorrect: 0 });
    });
  });

  describe('transitionTo', () => {
    it('changes phase to connecting', () => {
      useSessionStore.getState().transitionTo('connecting', 'user_start');
      expect(useSessionStore.getState().phase).toBe('connecting');
    });

    it('changes phase to asking_question', () => {
      useSessionStore.getState().transitionTo('asking_question', 'card_loaded');
      expect(useSessionStore.getState().phase).toBe('asking_question');
    });

    it('transitions through multiple phases', () => {
      const store = useSessionStore.getState();
      store.transitionTo('loading_cards', 'session_start');
      expect(useSessionStore.getState().phase).toBe('loading_cards');

      useSessionStore.getState().transitionTo('connecting', 'cards_loaded');
      expect(useSessionStore.getState().phase).toBe('connecting');

      useSessionStore.getState().transitionTo('ready', 'connected');
      expect(useSessionStore.getState().phase).toBe('ready');
    });
  });

  describe('recordAnswer', () => {
    it('increments correct count', () => {
      useSessionStore.getState().recordAnswer('correct');
      expect(useSessionStore.getState().stats.correct).toBe(1);
      expect(useSessionStore.getState().stats.incorrect).toBe(0);
    });

    it('increments incorrect count', () => {
      useSessionStore.getState().recordAnswer('incorrect');
      expect(useSessionStore.getState().stats.correct).toBe(0);
      expect(useSessionStore.getState().stats.incorrect).toBe(1);
    });

    it('tracks multiple answers', () => {
      useSessionStore.getState().recordAnswer('correct');
      useSessionStore.getState().recordAnswer('correct');
      useSessionStore.getState().recordAnswer('incorrect');
      expect(useSessionStore.getState().stats).toEqual({ correct: 2, incorrect: 1 });
    });
  });

  describe('advanceCard', () => {
    it('increments currentCardIndex', () => {
      useSessionStore.getState().advanceCard();
      expect(useSessionStore.getState().currentCardIndex).toBe(1);
    });

    it('increments multiple times', () => {
      useSessionStore.getState().advanceCard();
      useSessionStore.getState().advanceCard();
      useSessionStore.getState().advanceCard();
      expect(useSessionStore.getState().currentCardIndex).toBe(3);
    });
  });

  describe('resetSession', () => {
    it('resets all state to initial values', () => {
      useSessionStore.getState().transitionTo('asking_question', 'test');
      useSessionStore.getState().advanceCard();
      useSessionStore.getState().advanceCard();
      useSessionStore.getState().recordAnswer('correct');
      useSessionStore.getState().recordAnswer('incorrect');
      useSessionStore.getState().setTotalDueAtStart(234);

      useSessionStore.getState().resetSession();

      const state = useSessionStore.getState();
      expect(state.phase).toBe('idle');
      expect(state.currentCardIndex).toBe(0);
      expect(state.stats).toEqual({ correct: 0, incorrect: 0 });
      expect(state.totalDueAtStart).toBe(0);
    });
  });

  describe('totalDueAtStart (BUG 11)', () => {
    it('starts at 0 (unknown until sessionManager snapshots it)', () => {
      expect(useSessionStore.getState().totalDueAtStart).toBe(0);
    });

    it('setTotalDueAtStart updates the value', () => {
      useSessionStore.getState().setTotalDueAtStart(234);
      expect(useSessionStore.getState().totalDueAtStart).toBe(234);
    });

    it('survives a recordAnswer (the snapshot is for the whole session)', () => {
      useSessionStore.getState().setTotalDueAtStart(50);
      useSessionStore.getState().recordAnswer('correct');
      useSessionStore.getState().recordAnswer('incorrect');
      expect(useSessionStore.getState().totalDueAtStart).toBe(50);
    });
  });
});
