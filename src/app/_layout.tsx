import "../../global.css";
import { useEffect } from "react";
import { Linking } from "react-native";
import { Slot } from "expo-router";
import Constants from "expo-constants";
import {
  isDev,
  requiresAuth,
  requiresPayment,
  logBypassStatus,
} from "../config/env";
import { initAnalytics, AnalyticsEvents } from "../services/analytics";
import { initBilling } from "../services/billingService";
import { configureGoogleSignIn } from "../services/authService";
import { installTestHarness } from "../test-harness/bootstrap";
import { setAutostartOverride } from "../services/autostartFlag";
import { sfxPlayer } from "../services/sfxPlayer";

// PostHog config — replace with your actual project key and host
const POSTHOG_API_KEY = "YOUR_POSTHOG_API_KEY";
const POSTHOG_HOST = "https://us.i.posthog.com";

// Google Sign-In web client ID (OAuth 2.0 "Web client", ends in
// .apps.googleusercontent.com). Read from .env (GOOGLE_WEB_CLIENT_ID) when set
// to a real string; otherwise use the project's Web client id directly.
// NB: Expo serializes UNSET `extra` values to `{}` (not null/undefined), so a
// plain `?? fallback` keeps the `{}` object and crashes native configure with
// "webClientId cannot be cast from ReadableNativeMap to String". Guard on the
// runtime type instead.
const webClientIdFromExtra = Constants.expoConfig?.extra?.googleWebClientId;
const GOOGLE_WEB_CLIENT_ID =
  typeof webClientIdFromExtra === "string" && webClientIdFromExtra.length > 0
    ? webClientIdFromExtra
    : "866005886684-tvsh7olnb5gd83s7t47jfq115mrk1en2.apps.googleusercontent.com";

export default function RootLayout() {
  useEffect(() => {
    // Test harness — swaps mic to fakeMicSource when APP_MODE=test.
    // No-op otherwise. Must run before any session can start.
    installTestHarness();

    // Dev-only: launch deep link can carry `?autostart=1` to opt into the
    // deck-select autostart on a per-launch basis (no .env edit required).
    // Must run before deck-select mounts so its useEffect sees the flag.
    if (isDev()) {
      Linking.getInitialURL()
        .then((url) => {
          if (!url) return;
          if (/[?&]autostart=1\b/.test(url)) {
            setAutostartOverride(true);
          }
        })
        .catch(() => {
          /* no-op */
        });
    }

    // Initialize analytics
    initAnalytics(POSTHOG_API_KEY, POSTHOG_HOST);
    AnalyticsEvents.appOpened();

    // Warm the SFX players at app boot — by the time the user navigates
    // through onboarding / deck-select and starts a session, both
    // AudioPlayers are guaranteed loaded so the first chime isn't a
    // silent no-op (BUG 13). startSession's own preload() is kept as a
    // belt-and-suspenders safety net.
    sfxPlayer.preload();

    // Loudly flag any bypassed gate so a dev run is never mistaken for real.
    logBypassStatus();

    // Gate-driven init: only stand up Google Sign-In / Play Billing when the
    // respective gate is actually enforced. In a dev binary both are bypassed
    // by default; AUTH_REQUIRED / PAYMENT_REQUIRED opt back into the real flow.
    if (requiresAuth()) {
      configureGoogleSignIn(GOOGLE_WEB_CLIENT_ID);
    }
    if (requiresPayment()) {
      initBilling().catch((err) => console.warn("Billing init failed:", err));
    }

    // Dev simulator bridge lives at `app/simulate.tsx` — expo-router routes
    // `engram://simulate?answer=...` to that screen, which pops itself
    // after dispatching. See its file for the why.
  }, []);

  return <Slot />;
}
