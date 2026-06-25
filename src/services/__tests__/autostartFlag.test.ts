/**
 * autostartFlag tests.
 *
 * Two paths enable autostart:
 *   1. .env `AUTO_START_ENABLED=true` (sticky) → exposed via
 *      `Constants.expoConfig.extra.autoStartEnabled`.
 *   2. Launch deep link `?autostart=1` → handled by `_layout.tsx` which
 *      calls `setAutostartOverride(true)`.
 *
 * BUG fix covered here (commit 9a27a4f): the deep-link override MUST win
 * over a stale .env value, AND the reactive hook must fire when the
 * override flips after decks have already loaded. The previous bug had a
 * non-reactive module-level var that swallowed the override when the
 * `Linking.getInitialURL` promise resolved after `deck-select`'s effect
 * had already run.
 *
 * Note: this file tests the non-reactive `isAutostartEnabled()` and
 * `setAutostartOverride()` only. The `useAutostartEnabled` hook is the
 * same logic wrapped in `useSyncExternalStore`; testing it requires a
 * React rendering env (jsdom + @testing-library/react-hooks), which the
 * repo's `node`-env Jest setup doesn't provide. The hook is exercised
 * manually in deck-select autostart (BUG 9a27a4f was a manual repro).
 */

const mockExtra: { autoStartEnabled?: boolean } = {};

// expo-constants reads happen via `Constants.expoConfig?.extra?.autoStartEnabled`.
// Module-level mock so the test fully controls the env-gate state.
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return { extra: mockExtra };
    },
  },
  expoConfig: { extra: mockExtra },
}));

// Import AFTER the mock is registered.
import { isAutostartEnabled, setAutostartOverride } from '../autostartFlag';

beforeEach(() => {
  mockExtra.autoStartEnabled = undefined;
  setAutostartOverride(false);
});

describe('autostartFlag', () => {
  describe('isAutostartEnabled', () => {
    it('returns false when env is off and override is off', () => {
      expect(isAutostartEnabled()).toBe(false);
    });

    it('returns true when env gate is on', () => {
      mockExtra.autoStartEnabled = true;
      expect(isAutostartEnabled()).toBe(true);
    });

    it('returns true when only the override is set', () => {
      setAutostartOverride(true);
      expect(isAutostartEnabled()).toBe(true);
    });

    it('returns true when BOTH env and override are on', () => {
      mockExtra.autoStartEnabled = true;
      setAutostartOverride(true);
      expect(isAutostartEnabled()).toBe(true);
    });

    it('treats env value === false as off (strict true check)', () => {
      // .env may not be set at all; autoStartEnabled will be undefined.
      // The check is `=== true` so any other value (false, undefined,
      // "TRUE", 1) is treated as off. Pinning that behavior.
      mockExtra.autoStartEnabled = false;
      expect(isAutostartEnabled()).toBe(false);
    });

    it('treats env truthy-but-not-true as off (strict true check)', () => {
      // JavaScript `=== true` rejects truthy strings. Pinning.
      (mockExtra as any).autoStartEnabled = 'true';
      expect(isAutostartEnabled()).toBe(false);
    });

    it('override survives env going back to off', () => {
      // The BUG 9a27a4f scenario: env was true, user sets override,
      // env flips back. Override must still win until explicitly cleared.
      mockExtra.autoStartEnabled = true;
      setAutostartOverride(true);
      mockExtra.autoStartEnabled = undefined;
      expect(isAutostartEnabled()).toBe(true);
    });

    it('clearing the override goes back to env-driven value', () => {
      mockExtra.autoStartEnabled = true;
      setAutostartOverride(true);
      setAutostartOverride(false);
      // Still env-on, so still enabled.
      expect(isAutostartEnabled()).toBe(true);

      mockExtra.autoStartEnabled = undefined;
      expect(isAutostartEnabled()).toBe(false);
    });
  });

  describe('setAutostartOverride', () => {
    it('toggles override off → on', () => {
      setAutostartOverride(true);
      expect(isAutostartEnabled()).toBe(true);
    });

    it('toggles override on → off', () => {
      setAutostartOverride(true);
      setAutostartOverride(false);
      // Env still off → disabled.
      expect(isAutostartEnabled()).toBe(false);
    });

    it('is independent of env state — setAutostartOverride(true) with env undefined', () => {
      // Override alone, no env backing. Useful for per-launch deep links
      // where the script doesn't want to touch .env.
      expect(isAutostartEnabled()).toBe(false);
      setAutostartOverride(true);
      expect(isAutostartEnabled()).toBe(true);
    });
  });
});