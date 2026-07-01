import PostHog from "posthog-react-native";
import { isDev } from "../config/env";

let posthog: PostHog | null = null;

/**
 * Initialize PostHog analytics.
 * In dev mode, events are logged to console only — no network calls.
 * Call this once at app startup.
 */
export async function initAnalytics(
  apiKey: string,
  host: string,
): Promise<void> {
  if (isDev()) {
    console.log("[Analytics] Dev mode — events will be logged to console only");
    return;
  }

  if (!apiKey || /YOUR_/.test(apiKey)) {
    console.warn(
      "[Analytics] PostHog key is missing or a placeholder — analytics disabled",
    );
    return;
  }

  posthog = new PostHog(apiKey, { host });
}

/**
 * Track an analytics event.
 */
export function track(event: string, properties?: Record<string, any>): void {
  if (isDev()) {
    console.log(`[Analytics] ${event}`, properties ?? "");
    return;
  }
  posthog?.capture(event, properties);
}

/**
 * Identify the current user (call after auth).
 */
export function identify(
  userId: string,
  properties?: Record<string, any>,
): void {
  if (isDev()) {
    console.log(`[Analytics] identify: ${userId}`, properties ?? "");
    return;
  }
  posthog?.identify(userId, properties);
}

/**
 * Reset identity (call on sign-out).
 */
export function resetAnalytics(): void {
  if (isDev()) {
    console.log("[Analytics] reset");
    return;
  }
  posthog?.reset();
}

// ─── Typed event helpers ────────────────────────────────────────────

export const AnalyticsEvents = {
  // App lifecycle
  appOpened: () => track("app_opened"),

  // Auth
  signupStarted: () => track("signup_started"),
  signupCompleted: (method: string) => track("signup_completed", { method }),

  // Onboarding
  onboardingAnkidroidCheck: (installed: boolean) =>
    track("onboarding_ankidroid_check", { installed }),
  onboardingPermissionsGranted: () => track("onboarding_permissions_granted"),
  onboardingCompleted: () => track("onboarding_completed"),

  // Trial
  trialStarted: () => track("trial_started"),
  trialExpired: () => track("trial_expired"),

  // Deck
  deckSelected: (deckName: string) =>
    track("deck_selected", { deck_name: deckName }),

  // Session
  sessionStarted: (deckName: string, cardCount: number) =>
    track("session_started", { deck_name: deckName, card_count: cardCount }),
  sessionFirstCardAnswered: () => track("session_first_card_answered"),
  sessionCompleted: (stats: {
    correct: number;
    incorrect: number;
    duration_s: number;
  }) => track("session_completed", stats),
  sessionStats: (stats: Record<string, any>) => track("session_stats", stats),
  sessionError: (error: string) => track("session_error", { error }),
  sessionReconnected: (attempt: number) =>
    track("session_reconnected", { attempt }),

  // Settings
  settingsChanged: (setting: string, value: any) =>
    track("settings_changed", { setting, value }),

  // Paywall
  paywallShown: (reason: string) => track("paywall_shown", { reason }),
  subscriptionStarted: (plan: string) =>
    track("subscription_started", { plan }),
  subscriptionCancelled: () => track("subscription_cancelled"),
} as const;
