import { useEffect } from "react";
import { Redirect, router } from "expo-router";
import Constants from "expo-constants";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useAuthStore } from "../stores/useAuthStore";
import { requiresAuth } from "../config/env";

export default function Index() {
  const onboardingCompleted = useSettingsStore((s) => s.onboardingCompleted);
  const setOnboardingCompleted = useSettingsStore(
    (s) => s.setOnboardingCompleted,
  );
  const skipOnboarding: boolean =
    (Constants.expoConfig?.extra as any)?.skipOnboarding ?? false;
  const { isAuthenticated, isLoading } = useAuthStore();

  // Dev-only: AUTO_SKIP_ONBOARDING=true in .env marks onboarding done
  // on first mount so pm clear + relaunch (used by test-flow.sh) doesn't
  // land on the onboarding flow and block the autostart.
  useEffect(() => {
    if (skipOnboarding && !onboardingCompleted) {
      setOnboardingCompleted(true);
    }
  }, []);

  // Wait for Firebase to resolve auth state before deciding where to redirect.
  // In bypass mode (dev default) this resolves synchronously, so no flash.
  if (requiresAuth() && isLoading) {
    return null;
  }

  // Auth gate: unauthenticated users go to sign-in.
  if (requiresAuth() && !isAuthenticated) {
    return <Redirect href="/(onboarding)/sign-in" />;
  }

  if (onboardingCompleted || skipOnboarding) {
    return <Redirect href="/(main)/deck-select" />;
  }

  return <Redirect href="/(onboarding)" />;
}
