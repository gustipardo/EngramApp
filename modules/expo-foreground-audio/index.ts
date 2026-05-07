import { NativeModule, requireNativeModule } from 'expo-modules-core';

// Expo SDK 54 EventsMap constraint requires events to be listener function
// signatures (`(...args: any[]) => any`), not raw payload object types.
type ForegroundAudioEvents = {
  onAudioFocusChange: (event: { state: 'gain' | 'loss' | 'loss_transient' | 'loss_transient_can_duck' }) => void;
  onNotificationAction: (event: { action: 'pause' | 'resume' | 'end' }) => void;
  onAudioData: (event: { data: string }) => void;
};

// Use `declare class extends NativeModule<...>` (not `interface extends`) so
// the inherited `addListener`/`removeListener`/etc. methods from EventEmitter
// resolve properly under SDK 54. The interface form picks up the `typeof
// NativeModule` constructor side instead of the instance side.
declare class ExpoForegroundAudioNativeModule extends NativeModule<ForegroundAudioEvents> {
  startService(title: string, body: string): Promise<void>;
  stopService(): Promise<void>;
  updateNotification(title: string, body: string): Promise<void>;
  // Posts a transient 3-second heads-up notification (WhatsApp-style peek)
  // alongside the persistent foreground-service notification. Used when the
  // app is minimized mid-session so the user sees a quick reminder banner.
  triggerHeadsUp(): Promise<void>;
  isServiceRunning(): boolean;
  requestAudioFocus(): Promise<void>;
  abandonAudioFocus(): Promise<void>;
  // PCM mic capture
  startMicCapture(sampleRate: number): Promise<void>;
  stopMicCapture(): Promise<void>;
  // PCM audio playback
  initAudioPlayer(sampleRate: number): Promise<void>;
  playAudioChunk(base64Data: string): Promise<void>;
  stopAudioPlayer(): Promise<void>;
}

const ExpoForegroundAudioModule =
  requireNativeModule<ExpoForegroundAudioNativeModule>('ExpoForegroundAudio');

export default ExpoForegroundAudioModule;
