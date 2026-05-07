import Constants from 'expo-constants';

export type AppMode = 'dev' | 'production' | 'test';

/**
 * Determine the current app mode.
 * Priority: APP_MODE env variable > __DEV__ global.
 *
 * `test` mode enables the audio-injection harness: mic capture is
 * routed through `fakeMicSource` so a pre-recorded PCM clip can stand
 * in for a live microphone. Output (AI speech) still plays normally,
 * and the rest of the app behaves like dev.
 */
export function getAppMode(): AppMode {
  const envMode = Constants.expoConfig?.extra?.appMode;
  if (envMode === 'production' || envMode === 'dev' || envMode === 'test') {
    return envMode;
  }
  return __DEV__ ? 'dev' : 'production';
}

export function isDev(): boolean {
  return getAppMode() === 'dev';
}

export function isProd(): boolean {
  return getAppMode() === 'production';
}

export function isTestMode(): boolean {
  return getAppMode() === 'test';
}

/** True in production — requires Firebase Auth sign-in. */
export function requiresAuth(): boolean {
  return isProd();
}

/** True in production — enforces trial/subscription checks. */
export function requiresPayment(): boolean {
  return isProd();
}
