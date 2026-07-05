import { useEffect } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { sessionManager } from '../services/sessionManager';
import { sessionLog } from '../services/sessionDebugLogger';
import { isDev } from '../config/env';

/**
 * Dev-only deep-link bridge for the debug simulator.
 *
 * Trigger from host with:
 *   adb shell am start -a android.intent.action.VIEW \
 *     -d "engram://simulate?answer=<url-encoded>"
 *
 * Why a route (not a `Linking.addEventListener`):
 *   expo-router catches the URL anyway and would push `/simulate` on top
 *   of the navigation stack. If the route doesn't exist, we get an
 *   "Unmatched Route" 404 *and* — depending on how the stack reacts —
 *   the underlying session screen can unmount, triggering
 *   `sessionManager.endSession()`. That was the bug behind the test-flow
 *   TIMEOUTs: cards 2/4 inject arrived, the route push killed the
 *   session, and a new one auto-started.
 *
 * Now this is a real route that:
 *   1. Mounts above the session screen via Stack push (session.tsx stays
 *      mounted — Stack push is non-destructive).
 *   2. Reads the `answer` query param.
 *   3. Calls `sessionManager.simulateUserAnswer(text)`.
 *   4. Pops itself off the stack — session.tsx is visible again.
 *
 * Returns null so nothing renders visibly during the brief mount.
 * No-op in production builds.
 */
export default function SimulateRoute() {
  const params = useLocalSearchParams<{ answer?: string | string[] }>();

  useEffect(() => {
    if (!isDev()) {
      sessionLog.warn('SIM', 'simulate route hit in non-dev build — ignored');
      if (router.canGoBack()) router.back();
      return;
    }

    const raw = params.answer;
    const text = Array.isArray(raw) ? raw[0] : raw;

    if (typeof text !== 'string' || !text.trim()) {
      sessionLog.warn('SIM', 'simulate route missing/empty ?answer', { params });
    } else {
      sessionLog.info('SIM', 'route received', { answer: text });
      sessionManager.simulateUserAnswer(text);
    }

    // Pop back to whatever was underneath (typically the session screen).
    // Wrapped in a microtask so the navigator finishes its current
    // transaction before we pop.
    queueMicrotask(() => {
      try {
        if (router.canGoBack()) router.back();
      } catch {/* no-op */}
    });
  }, []);

  return null;
}
