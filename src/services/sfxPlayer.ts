/**
 * SFX player for evaluation feedback (correct / incorrect chimes).
 *
 * Trigger: `sessionManager.handleEvaluateAndMoveNext` fires play(quality) the
 * instant the tool call lands, in parallel with `recordAnswer` (which is what
 * makes the EvaluationBanner in `(main)/session.tsx` appear). The audible cue
 * fills the 1–2 s gap before the tutor starts speaking feedback so the user
 * gets confirmation that their answer landed.
 *
 * Playback uses expo-audio (the SDK 54+ replacement for the deprecated
 * expo-av) on its own AudioPlayer instance — independent of the tutor's
 * AudioTrack in expo-foreground-audio. That keeps SFX from interleaving with
 * tutor speech (no shared PCM buffer), but means End Session has to stop
 * this player explicitly. `sessionManager.endSession` calls `stop()` for
 * the same reason `webrtcManager.stopCurrentAudio()` flips the halted flag
 * on the tutor track (see BUG 6 in SESSION-FLOW.md).
 *
 * Skipped answers are silent — only correct/incorrect produce a chime.
 */

import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { sessionLog } from './sessionDebugLogger';

type Quality = 'correct' | 'incorrect' | 'skipped';

const SOURCES = {
  correct: require('../../assets/sfx/correct.mp3'),
  incorrect: require('../../assets/sfx/incorrect.mp3'),
} as const;

let correctPlayer: AudioPlayer | null = null;
let incorrectPlayer: AudioPlayer | null = null;
let initialized = false;

/**
 * Timestamp (ms) of the most recent play() call. Used by
 * foregroundAudioService to ignore Android audio-focus 'loss' callbacks that
 * fire because expo-audio requested AUDIOFOCUS_GAIN to play this clip.
 * Without this guard, every SFX would pause the session (the tutor sees an
 * external focus stealer and bails). The window must be long enough to
 * cover the SFX duration + Android's asynchronous focus callback latency
 * (~hundreds of ms in practice), short enough that a real phone-call
 * interruption within ~2 s of an SFX play still pauses us. 2000 ms is a
 * conservative middle ground; if a phone call comes in mid-SFX we will
 * briefly miss the pause but the call's own audio-focus retention will
 * keep the system in our 'loss' state past the window, and the *next*
 * focus event (or the user manually pausing) recovers.
 */
let lastPlayAt = 0;
const FOCUS_LOSS_IGNORE_WINDOW_MS = 2000;

function ensureLoaded(): void {
  if (initialized) return;
  try {
    correctPlayer = createAudioPlayer(SOURCES.correct);
    incorrectPlayer = createAudioPlayer(SOURCES.incorrect);
    initialized = true;
  } catch (err) {
    sessionLog.warn('sfx', 'failed to preload SFX players', { error: String(err) });
  }
}

/**
 * Poll for `player.isLoaded === true` up to `maxWaitMs`. Returns once both
 * players are loaded or the cap is hit. expo-audio's `createAudioPlayer`
 * is synchronous but the underlying MediaPlayer/ExoPlayer decodes the
 * asset asynchronously — `play()` is a silent no-op while `isLoaded` is
 * still false. On a cold device boot this can leak into the first SFX of
 * the session (BUG 13). The poll caps at 1.5 s; in practice both players
 * load in under 300 ms on a Pixel 9.
 */
async function waitUntilLoaded(maxWaitMs = 1500, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const cLoaded = !correctPlayer || correctPlayer.isLoaded;
    const iLoaded = !incorrectPlayer || incorrectPlayer.isLoaded;
    if (cLoaded && iLoaded) return;
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  sessionLog.warn('sfx', 'waitUntilLoaded timed out — first chime may be silent', {
    correctLoaded: correctPlayer?.isLoaded,
    incorrectLoaded: incorrectPlayer?.isLoaded,
  });
}

export const sfxPlayer = {
  /**
   * Eagerly create the two AudioPlayer instances. Safe to call multiple times;
   * subsequent calls are no-ops. Called once from startSession so the first
   * play() of the session doesn't incur the loading cost.
   *
   * Fire-and-forget: kicks off a background poll that waits for both
   * players to report `isLoaded`. Calling `play()` before they're ready
   * is a silent no-op (BUG 13), so any caller that wants to be 100% sure
   * can `await preloadAsync()` instead.
   */
  preload(): void {
    ensureLoaded();
    waitUntilLoaded().catch(() => { /* logged inside */ });
  },

  /**
   * Same as preload() but returns a promise that resolves once both
   * players report `isLoaded` (or the load-poll times out). Used by paths
   * that need a guarantee the first chime won't be silent. See BUG 13.
   */
  async preloadAsync(): Promise<void> {
    ensureLoaded();
    await waitUntilLoaded();
  },

  /**
   * Play the chime that matches the evaluation quality. `skipped` is silent
   * by design — there's no audible reward/penalty for a card the user opted
   * to pass on. Errors are logged but never thrown; SFX is non-critical.
   */
  play(quality: Quality): void {
    if (quality === 'skipped') return;
    ensureLoaded();
    const player = quality === 'correct' ? correctPlayer : incorrectPlayer;
    if (!player) return;
    try {
      // Rewind so back-to-back plays restart from the beginning.
      // expo-audio leaves the player paused at the end after playback.
      // Do NOT guard on player.isLoaded here — it flips back to false
      // after each play() completes, which would silence every chime
      // after the first (BUG 13 v1 regression). preloadAsync() at app
      // boot is the safety net for a genuinely unloaded player.
      const wasLoaded = player.isLoaded;
      player.seekTo(0);
      player.play();
      lastPlayAt = Date.now();
      sessionLog.info('sfx', 'played', { quality, wasLoaded });
    } catch (err) {
      sessionLog.warn('sfx', 'play failed', { quality, error: String(err) });
    }
  },

  /**
   * True if play() was called within FOCUS_LOSS_IGNORE_WINDOW_MS.
   * foregroundAudioService consults this to swallow audio-focus 'loss'
   * callbacks that are our own SFX's fault, not an external interruption.
   */
  isPlayingRecently(): boolean {
    return Date.now() - lastPlayAt < FOCUS_LOSS_IGNORE_WINDOW_MS;
  },

  /**
   * Pause both players. Used by endSession to cut SFX immediately when the
   * user ends the session — mirrors the BUG 6 fix for tutor audio.
   */
  stop(): void {
    try { correctPlayer?.pause(); } catch {}
    try { incorrectPlayer?.pause(); } catch {}
  },

  /**
   * Release both players. Currently unused — the session may be re-entered
   * many times across an app lifetime, so we keep the players warm. Exposed
   * for future cleanup paths (e.g. app teardown).
   */
  release(): void {
    try { correctPlayer?.remove(); } catch {}
    try { incorrectPlayer?.remove(); } catch {}
    correctPlayer = null;
    incorrectPlayer = null;
    initialized = false;
  },
};
