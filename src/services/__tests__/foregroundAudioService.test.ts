// Mock react-native BEFORE the production module loads — Jest's default
// transform can't parse RN's Flow syntax (`import typeof …`), so the suite
// would otherwise fail to load before any test runs.
jest.mock('react-native', () => ({
  __esModule: true,
  AppState: {
    currentState: 'active',
    addEventListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
  },
}));

import {
  startForegroundService,
  stopForegroundService,
  updateForegroundNotification,
  isServiceRunning,
  requestAudioFocus,
  abandonAudioFocus,
  wasPausedByAudioFocusLoss,
} from '../foregroundAudioService';

// Mock the native module
const mockStartService = jest.fn().mockResolvedValue(undefined);
const mockStopService = jest.fn().mockResolvedValue(undefined);
const mockUpdateNotification = jest.fn().mockResolvedValue(undefined);
const mockIsServiceRunning = jest.fn().mockReturnValue(false);
const mockAddListener = jest.fn();
const mockRequestAudioFocus = jest.fn().mockResolvedValue(undefined);
const mockAbandonAudioFocus = jest.fn().mockResolvedValue(undefined);
const mockTriggerHeadsUp = jest.fn().mockResolvedValue(undefined);

jest.mock('expo-foreground-audio', () => ({
  __esModule: true,
  default: {
    startService: (...args: any[]) => mockStartService(...args),
    stopService: (...args: any[]) => mockStopService(...args),
    updateNotification: (...args: any[]) => mockUpdateNotification(...args),
    isServiceRunning: (...args: any[]) => mockIsServiceRunning(...args),
    addListener: (...args: any[]) => mockAddListener(...args),
    requestAudioFocus: (...args: any[]) => mockRequestAudioFocus(...args),
    abandonAudioFocus: (...args: any[]) => mockAbandonAudioFocus(...args),
    triggerHeadsUp: (...args: any[]) => mockTriggerHeadsUp(...args),
  },
}));

// Mock sessionManager (lazy-required inside foregroundAudioService for circular dep avoidance)
const mockEndSessionFromNotification = jest.fn();
jest.mock('../sessionManager', () => ({
  sessionManager: { endSessionFromNotification: mockEndSessionFromNotification },
}));

// Mock stores and webrtcManager
const mockTransitionTo = jest.fn();
const mockSetMicrophoneMuted = jest.fn();

jest.mock('../../stores/useSessionStore', () => ({
  useSessionStore: {
    getState: jest.fn().mockReturnValue({
      phase: 'asking_question',
      transitionTo: mockTransitionTo,
    }),
  },
}));

jest.mock('../realtimeManager', () => ({
  realtimeManager: {
    setMicrophoneMuted: (...args: any[]) => mockSetMicrophoneMuted(...args),
  },
}));

// Helper: get the registered listener callback by event name
function getListenerCallback(eventName: string): Function | undefined {
  const call = mockAddListener.mock.calls.find(
    (c: any[]) => c[0] === eventName
  );
  return call ? call[1] : undefined;
}

describe('foregroundAudioService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEndSessionFromNotification.mockClear();
    // Re-setup the mock return for useSessionStore since clearAllMocks resets it
    const { useSessionStore } = require('../../stores/useSessionStore');
    useSessionStore.getState.mockReturnValue({
      phase: 'asking_question',
      transitionTo: mockTransitionTo,
    });
  });

  describe('startForegroundService', () => {
    it('calls native startService with title and body', async () => {
      await startForegroundService('Test Title', 'Test Body');
      expect(mockStartService).toHaveBeenCalledWith('Test Title', 'Test Body');
    });

    it('registers event listeners on first call', async () => {
      // Reset module to clear listenersRegistered flag
      jest.resetModules();
      const { startForegroundService: start } = require('../foregroundAudioService');
      await start('Title', 'Body');
      expect(mockAddListener).toHaveBeenCalledWith('onNotificationAction', expect.any(Function));
      expect(mockAddListener).toHaveBeenCalledWith('onAudioFocusChange', expect.any(Function));
    });
  });

  describe('stopForegroundService', () => {
    it('calls native stopService', async () => {
      await stopForegroundService();
      expect(mockStopService).toHaveBeenCalled();
    });
  });

  describe('updateForegroundNotification', () => {
    it('calls native updateNotification when service is running', async () => {
      mockIsServiceRunning.mockReturnValue(true);
      await updateForegroundNotification('Updated', 'Card 5 of 10');
      expect(mockUpdateNotification).toHaveBeenCalledWith('Updated', 'Card 5 of 10');
    });

    it('does not call native updateNotification when service is not running', async () => {
      mockIsServiceRunning.mockReturnValue(false);
      await updateForegroundNotification('Updated', 'Card 5 of 10');
      expect(mockUpdateNotification).not.toHaveBeenCalled();
    });
  });

  describe('isServiceRunning', () => {
    it('returns the native module value', () => {
      mockIsServiceRunning.mockReturnValue(true);
      expect(isServiceRunning()).toBe(true);

      mockIsServiceRunning.mockReturnValue(false);
      expect(isServiceRunning()).toBe(false);
    });
  });

  describe('notification action handlers', () => {
    // Ensure listeners are registered before testing handlers
    beforeEach(async () => {
      jest.resetModules();
      mockAddListener.mockClear();
      mockTransitionTo.mockClear();
      mockSetMicrophoneMuted.mockClear();

      const { useSessionStore } = require('../../stores/useSessionStore');
      useSessionStore.getState.mockReturnValue({
        phase: 'asking_question',
        transitionTo: mockTransitionTo,
      });

      const { startForegroundService: start } = require('../foregroundAudioService');
      await start('Title', 'Body');
    });

    it('mutes mic and transitions to paused on "pause" action', () => {
      const handler = getListenerCallback('onNotificationAction');
      expect(handler).toBeDefined();

      handler!({ action: 'pause' });

      expect(mockSetMicrophoneMuted).toHaveBeenCalledWith(true);
      expect(mockTransitionTo).toHaveBeenCalledWith('paused', 'notification_pause');
    });

    it('unmutes mic, re-requests audio focus, and transitions on "resume" action', () => {
      const handler = getListenerCallback('onNotificationAction');
      handler!({ action: 'resume' });

      expect(mockSetMicrophoneMuted).toHaveBeenCalledWith(false);
      expect(mockRequestAudioFocus).toHaveBeenCalled();
      expect(mockTransitionTo).toHaveBeenCalledWith('asking_question', 'notification_resume');
    });

    it('calls sessionManager.endSessionFromNotification on "end" action', () => {
      const handler = getListenerCallback('onNotificationAction');
      handler!({ action: 'end' });

      expect(mockEndSessionFromNotification).toHaveBeenCalled();
    });
  });

  describe('audio focus change handlers', () => {
    beforeEach(async () => {
      jest.resetModules();
      mockAddListener.mockClear();
      mockTransitionTo.mockClear();
      mockSetMicrophoneMuted.mockClear();

      const { useSessionStore } = require('../../stores/useSessionStore');
      useSessionStore.getState.mockReturnValue({
        phase: 'asking_question',
        transitionTo: mockTransitionTo,
      });

      const { startForegroundService: start } = require('../foregroundAudioService');
      await start('Title', 'Body');
    });

    it('mutes mic and pauses on "loss_transient"', () => {
      const handler = getListenerCallback('onAudioFocusChange');
      handler!({ state: 'loss_transient' });

      expect(mockSetMicrophoneMuted).toHaveBeenCalledWith(true);
      expect(mockTransitionTo).toHaveBeenCalledWith('paused', 'audio_focus_loss_transient');
    });

    it('does not double-pause on "loss_transient" when already paused', () => {
      const { useSessionStore } = require('../../stores/useSessionStore');
      useSessionStore.getState.mockReturnValue({
        phase: 'paused',
        transitionTo: mockTransitionTo,
      });

      const handler = getListenerCallback('onAudioFocusChange');
      handler!({ state: 'loss_transient' });

      expect(mockSetMicrophoneMuted).toHaveBeenCalledWith(true);
      expect(mockTransitionTo).not.toHaveBeenCalled();
    });

    it('unmutes mic and resumes on "gain" when paused by audio focus loss', () => {
      const { useSessionStore } = require('../../stores/useSessionStore');
      const handler = getListenerCallback('onAudioFocusChange');

      // First trigger a focus loss to set the flag
      handler!({ state: 'loss_transient' });
      mockTransitionTo.mockClear();
      mockSetMicrophoneMuted.mockClear();

      // Now simulate regaining focus while paused
      useSessionStore.getState.mockReturnValue({
        phase: 'paused',
        transitionTo: mockTransitionTo,
      });

      handler!({ state: 'gain' });

      expect(mockSetMicrophoneMuted).toHaveBeenCalledWith(false);
      expect(mockTransitionTo).toHaveBeenCalledWith('asking_question', 'audio_focus_gain');
    });

    it('does not auto-resume on "gain" when paused by user (not by focus loss)', () => {
      const { useSessionStore } = require('../../stores/useSessionStore');
      useSessionStore.getState.mockReturnValue({
        phase: 'paused',
        transitionTo: mockTransitionTo,
      });

      // "gain" without prior focus loss — user paused manually
      const handler = getListenerCallback('onAudioFocusChange');
      handler!({ state: 'gain' });

      expect(mockSetMicrophoneMuted).toHaveBeenCalledWith(false);
      expect(mockTransitionTo).not.toHaveBeenCalled();
    });

    it('does not transition on "gain" when not paused', () => {
      const handler = getListenerCallback('onAudioFocusChange');
      handler!({ state: 'gain' });

      expect(mockSetMicrophoneMuted).toHaveBeenCalledWith(false);
      expect(mockTransitionTo).not.toHaveBeenCalled();
    });

    it('mutes mic and pauses on permanent "loss"', () => {
      const handler = getListenerCallback('onAudioFocusChange');
      handler!({ state: 'loss' });

      expect(mockSetMicrophoneMuted).toHaveBeenCalledWith(true);
      expect(mockTransitionTo).toHaveBeenCalledWith('paused', 'audio_focus_loss');
    });

    it('does not pause on "loss" when idle', () => {
      const { useSessionStore } = require('../../stores/useSessionStore');
      useSessionStore.getState.mockReturnValue({
        phase: 'idle',
        transitionTo: mockTransitionTo,
      });

      const handler = getListenerCallback('onAudioFocusChange');
      handler!({ state: 'loss' });

      expect(mockSetMicrophoneMuted).toHaveBeenCalledWith(true);
      expect(mockTransitionTo).not.toHaveBeenCalled();
    });

    it('mutes mic and pauses on "loss_transient_can_duck"', () => {
      const handler = getListenerCallback('onAudioFocusChange');
      handler!({ state: 'loss_transient_can_duck' });

      expect(mockSetMicrophoneMuted).toHaveBeenCalledWith(true);
      expect(mockTransitionTo).toHaveBeenCalledWith('paused', 'audio_focus_duck');
    });
  });

  describe('requestAudioFocus', () => {
    it('calls native requestAudioFocus when service is running', async () => {
      mockIsServiceRunning.mockReturnValue(true);
      await requestAudioFocus();
      expect(mockRequestAudioFocus).toHaveBeenCalled();
    });

    it('does not call native requestAudioFocus when service is not running', async () => {
      mockIsServiceRunning.mockReturnValue(false);
      await requestAudioFocus();
      expect(mockRequestAudioFocus).not.toHaveBeenCalled();
    });
  });

  describe('abandonAudioFocus', () => {
    it('calls native abandonAudioFocus', async () => {
      await abandonAudioFocus();
      expect(mockAbandonAudioFocus).toHaveBeenCalled();
    });
  });
});
