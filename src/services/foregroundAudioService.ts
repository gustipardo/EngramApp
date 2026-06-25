import ExpoForegroundAudioModule from 'expo-foreground-audio';
import { AppState } from 'react-native';
import { useSessionStore } from '../stores/useSessionStore';
import { realtimeManager as webrtcManager } from './realtimeManager';
import { sfxPlayer } from './sfxPlayer';

/**
 * Foreground Audio Service - JS wrapper for the native module.
 * Manages the Android Foreground Service that keeps WebRTC audio alive
 * when the app is backgrounded or screen is locked.
 *
 * This is the ONLY file that imports from the native module.
 * All other files interact through this wrapper.
 */

let listenersRegistered = false;
/** Tracks whether the session was paused due to audio focus loss (vs user-initiated pause). */
let pausedByAudioFocusLoss = false;
/** Last AppState value seen — used to distinguish foreground→background transitions. */
let lastAppState: string = AppState.currentState;

/**
 * Start the foreground service with a notification.
 * Call when session enters 'asking_question' phase.
 */
export async function startForegroundService(title: string, body: string): Promise<void> {
  registerListeners();
  await ExpoForegroundAudioModule.startService(title, body);
}

/**
 * Stop the foreground service.
 * Call on session_complete or error.
 */
export async function stopForegroundService(): Promise<void> {
  await ExpoForegroundAudioModule.stopService();
}

/**
 * Update the notification content (e.g., card progress).
 */
export async function updateForegroundNotification(title: string, body: string): Promise<void> {
  if (ExpoForegroundAudioModule.isServiceRunning()) {
    await ExpoForegroundAudioModule.updateNotification(title, body);
  }
}

/**
 * Check if the foreground service is currently running.
 */
export function isServiceRunning(): boolean {
  return ExpoForegroundAudioModule.isServiceRunning();
}

/**
 * Re-request audio focus. Call when manually resuming after an audio focus loss.
 */
export async function requestAudioFocus(): Promise<void> {
  if (ExpoForegroundAudioModule.isServiceRunning()) {
    await ExpoForegroundAudioModule.requestAudioFocus();
  }
}

/**
 * Abandon audio focus explicitly (rarely needed — stopService does this automatically).
 */
export async function abandonAudioFocus(): Promise<void> {
  await ExpoForegroundAudioModule.abandonAudioFocus();
}

/**
 * Whether the current pause was caused by audio focus loss.
 */
export function wasPausedByAudioFocusLoss(): boolean {
  return pausedByAudioFocusLoss;
}

/**
 * Clear the audio-focus-loss pause flag (call when user manually resumes).
 */
export function clearAudioFocusPauseFlag(): void {
  pausedByAudioFocusLoss = false;
}

/**
 * Register event listeners for notification actions and audio focus changes.
 * Only registers once — subsequent calls are no-ops.
 */
function registerListeners(): void {
  if (listenersRegistered) return;
  listenersRegistered = true;

  // Handle notification bar button presses
  ExpoForegroundAudioModule.addListener('onNotificationAction', (event) => {
    const { transitionTo } = useSessionStore.getState();

    switch (event.action) {
      case 'pause':
        webrtcManager.setMicrophoneMuted(true);
        transitionTo('paused', 'notification_pause');
        break;

      case 'resume':
        webrtcManager.setMicrophoneMuted(false);
        pausedByAudioFocusLoss = false;
        // Re-request audio focus when resuming from notification
        ExpoForegroundAudioModule.requestAudioFocus().catch(() => {});
        transitionTo('asking_question', 'notification_resume');
        break;

      case 'end':
        // Import sessionManager lazily to avoid circular dependency
        const { sessionManager } = require('./sessionManager');
        sessionManager.endSessionFromNotification();
        break;
    }
  });

  // Trigger a transient heads-up banner when the app goes to background
  // mid-session. Android suppresses heads-up animations for the persistent
  // foreground-service notification (it's already in the shade and the
  // system dedupes), so we post a *separate* short-lived notification that
  // auto-cancels after 3 seconds. Net effect: WhatsApp-style "peek" — a
  // banner slides in for ~3s, then collapses to the status bar, leaving
  // only the persistent notification in the shade.
  AppState.addEventListener('change', (nextState) => {
    const wasForeground = lastAppState === 'active';
    const isBackground = nextState === 'background' || nextState === 'inactive';
    const prev = lastAppState;
    lastAppState = nextState;
    if (!wasForeground || !isBackground) return;

    const running = ExpoForegroundAudioModule.isServiceRunning();
    console.log(`[foregroundAudio] AppState ${prev}→${nextState}, serviceRunning=${running}`);
    if (!running) return;

    ExpoForegroundAudioModule.triggerHeadsUp().catch((err) => {
      console.warn('[foregroundAudio] heads-up trigger failed:', err);
    });
  });

  // Handle audio focus changes (phone calls, other audio apps).
  //
  // Our own SFX (expo-audio) requests AUDIOFOCUS_GAIN when it plays the
  // correct/incorrect chime, which fires a 'loss' callback here even though
  // the focus stealer is *us*. We swallow any focus-loss event that arrives
  // inside the SFX play window so the session doesn't auto-pause on every
  // graded card. Real phone-call interruptions still pause because their
  // focus retention extends well past the SFX window.
  ExpoForegroundAudioModule.addListener('onAudioFocusChange', (event) => {
    const { transitionTo, phase } = useSessionStore.getState();

    const isLossEvent = event.state === 'loss'
      || event.state === 'loss_transient'
      || event.state === 'loss_transient_can_duck';
    if (isLossEvent && sfxPlayer.isPlayingRecently()) {
      console.log(`[foregroundAudio] ignoring focus '${event.state}' — within SFX window`);
      return;
    }

    switch (event.state) {
      case 'loss_transient':
        // Phone call or alarm — mute mic, keep WebRTC connection alive
        webrtcManager.setMicrophoneMuted(true);
        if (phase !== 'paused') {
          pausedByAudioFocusLoss = true;
          transitionTo('paused', 'audio_focus_loss_transient');
        }
        break;

      case 'gain':
        // Regained focus — unmute mic, resume if was paused by focus loss
        webrtcManager.setMicrophoneMuted(false);
        if (phase === 'paused' && pausedByAudioFocusLoss) {
          pausedByAudioFocusLoss = false;
          transitionTo('asking_question', 'audio_focus_gain');
        }
        break;

      case 'loss':
        // Permanent loss — pause session, do NOT auto-resume
        webrtcManager.setMicrophoneMuted(true);
        if (phase !== 'paused' && phase !== 'idle' && phase !== 'session_complete') {
          pausedByAudioFocusLoss = true;
          transitionTo('paused', 'audio_focus_loss');
        }
        break;

      case 'loss_transient_can_duck':
        // Can lower volume — for voice communication we still pause
        webrtcManager.setMicrophoneMuted(true);
        if (phase !== 'paused') {
          pausedByAudioFocusLoss = true;
          transitionTo('paused', 'audio_focus_duck');
        }
        break;
    }
  });
}
