/**
 * useConnectionStore tests.
 *
 * Covers the connection state machine and the reconnect-attempt counter.
 * This store is read by geminiManager (transport events), sessionManager
 * (gates `startSession` on `disconnected`), and the deck-select UI (shows
 * "Reconnecting…").
 */

import { useConnectionStore } from '../useConnectionStore';

beforeEach(() => {
  useConnectionStore.setState({
    connectionState: 'disconnected',
    reconnectAttempts: 0,
    networkStatus: 'online',
  });
});

describe('useConnectionStore', () => {
  describe('initial state', () => {
    it('starts disconnected', () => {
      expect(useConnectionStore.getState().connectionState).toBe(
        'disconnected',
      );
    });

    it('starts with zero reconnect attempts', () => {
      expect(useConnectionStore.getState().reconnectAttempts).toBe(0);
    });

    it('starts online', () => {
      expect(useConnectionStore.getState().networkStatus).toBe('online');
    });
  });

  describe('setConnectionState', () => {
    it.each([
      'disconnected',
      'connecting',
      'connected',
      'reconnecting',
      'failed',
    ] as const)('accepts %s', (state) => {
      useConnectionStore.getState().setConnectionState(state);
      expect(useConnectionStore.getState().connectionState).toBe(state);
    });

    it('does not reset reconnectAttempts on transition', () => {
      useConnectionStore.getState().incrementReconnectAttempts();
      useConnectionStore.getState().incrementReconnectAttempts();
      expect(useConnectionStore.getState().reconnectAttempts).toBe(2);
      useConnectionStore.getState().setConnectionState('connected');
      // Counter sticks — the caller is responsible for resetReconnectAttempts
      // on a successful reconnect. Pinning the current behavior.
      expect(useConnectionStore.getState().reconnectAttempts).toBe(2);
    });
  });

  describe('reconnectAttempts counter', () => {
    it('increments by 1 on each call', () => {
      useConnectionStore.getState().incrementReconnectAttempts();
      expect(useConnectionStore.getState().reconnectAttempts).toBe(1);
      useConnectionStore.getState().incrementReconnectAttempts();
      expect(useConnectionStore.getState().reconnectAttempts).toBe(2);
    });

    it('resets to 0 on resetReconnectAttempts', () => {
      useConnectionStore.getState().incrementReconnectAttempts();
      useConnectionStore.getState().incrementReconnectAttempts();
      useConnectionStore.getState().resetReconnectAttempts();
      expect(useConnectionStore.getState().reconnectAttempts).toBe(0);
    });

    it('reset from 0 is a no-op (does not go negative)', () => {
      useConnectionStore.getState().resetReconnectAttempts();
      expect(useConnectionStore.getState().reconnectAttempts).toBe(0);
    });
  });

  describe('setNetworkStatus', () => {
    it('updates to offline', () => {
      useConnectionStore.getState().setNetworkStatus('offline');
      expect(useConnectionStore.getState().networkStatus).toBe('offline');
    });

    it('updates back to online', () => {
      useConnectionStore.getState().setNetworkStatus('offline');
      useConnectionStore.getState().setNetworkStatus('online');
      expect(useConnectionStore.getState().networkStatus).toBe('online');
    });
  });

  describe('typical reconnect flow', () => {
    it('connects → drops → reconnects (3 attempts) → connected', () => {
      // Simulate a successful reconnect sequence.
      useConnectionStore.getState().setConnectionState('connecting');
      useConnectionStore.getState().setConnectionState('connected');

      // Network drops
      useConnectionStore.getState().setConnectionState('reconnecting');
      useConnectionStore.getState().incrementReconnectAttempts();
      useConnectionStore.getState().incrementReconnectAttempts();
      useConnectionStore.getState().incrementReconnectAttempts();

      // Eventually reconnects
      useConnectionStore.getState().setConnectionState('connected');
      useConnectionStore.getState().resetReconnectAttempts();

      expect(useConnectionStore.getState().connectionState).toBe('connected');
      expect(useConnectionStore.getState().reconnectAttempts).toBe(0);
    });

    it('exhausts retries and lands in failed', () => {
      useConnectionStore.getState().setConnectionState('reconnecting');
      for (let i = 0; i < 5; i++) {
        useConnectionStore.getState().incrementReconnectAttempts();
      }
      useConnectionStore.getState().setConnectionState('failed');

      expect(useConnectionStore.getState().connectionState).toBe('failed');
      expect(useConnectionStore.getState().reconnectAttempts).toBe(5);
    });
  });
});