import Constants from "expo-constants";
import functions from "@react-native-firebase/functions";
import { requiresPayment } from "../config/env";

/**
 * Live-session auth broker (pre-launch blocker #1).
 *
 * The Gemini API key must not ship in the APK. In a real (release) build this
 * asks the `mintLiveToken` Cloud Function for a short-lived, single-use
 * ephemeral token; the client opens the Live WebSocket with it in the
 * `?access_token=` query param (v1alpha) instead of `?key=<apiKey>`.
 *
 * Two shapes so callers can build the right URL without branching on env:
 *   - { kind: "token", value } — ephemeral token → `?access_token=` on v1alpha.
 *   - { kind: "key",   value } — raw dev key      → `?key=` on v1beta.
 *
 * Bypass: when the payment gate is bypassed (a dev binary with PAYMENT_REQUIRED
 * unset), skip the network round-trip and use the raw key baked into the dev
 * config. A release build can never take this path (`requiresPayment()` is
 * hard-true when `!__DEV__`), and the raw key is null in a production config
 * (see app.config.js), so the ephemeral path is the only option there.
 */
export type LiveCredential =
  { kind: "token"; value: string } | { kind: "key"; value: string };

function rawKey(): string {
  const key = Constants.expoConfig?.extra?.geminiApiKey;
  if (!key) {
    throw new Error(
      "GEMINI_API_KEY not found in app config (dev fallback unavailable)",
    );
  }
  return key;
}

/**
 * Obtain the credential to open a Live session with.
 * Throws if the trial/subscription is spent — the Cloud Function refuses to
 * mint a token for an expired free user (`failed-precondition` / "trial_expired"),
 * which surfaces here as the thrown error the session flow already handles.
 */
export async function getLiveCredential(): Promise<LiveCredential> {
  if (!requiresPayment()) {
    return { kind: "key", value: rawKey() };
  }

  // Explicit timeout: the default (70 s) is far longer than a mid-session
  // reconnect can tolerate — a slow mint call starves the reconnect loop
  // (autopilot run 20260704-165928).
  const callable = functions().httpsCallable("mintLiveToken", {
    timeout: 15000,
  });
  const result = await callable();
  const token = (result.data as { token?: string })?.token;
  if (!token) {
    throw new Error("mintLiveToken returned no token");
  }
  return { kind: "token", value: token };
}
