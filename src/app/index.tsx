import { useEffect } from "react";
import { Redirect } from "expo-router";
import Constants from "expo-constants";
import { useSettingsStore } from "../stores/useSettingsStore";

export default function Index() {
  const onboardingCompleted = useSettingsStore((s) => s.onboardingCompleted);
  const setOnboardingCompleted = useSettingsStore(
    (s) => s.setOnboardingCompleted,
  );
  const skipOnboarding: boolean =
    (Constants.expoConfig?.extra as any)?.skipOnboarding ?? false;

  // Dev-only: AUTO_SKIP_ONBOARDING=true in .env marks onboarding done
  // on first mount so pm clear + relaunch (used by test-flow.sh) doesn't
  // land on the onboarding flow and block the autostart.
  useEffect(() => {
    if (skipOnboarding && !onboardingCompleted) {
      setOnboardingCompleted(true);
    }
  }, []);

  // Flow: onboarding (AnkiDroid setup only) → deck list. Auth is NOT a launch
  // gate anymore — the deck list is browsable signed-out; login is requested
  // when the user actually enters a deck (see deck-select.handleSelectDeck).
  if (onboardingCompleted || skipOnboarding) {
    return <Redirect href="/(main)/deck-select" />;
  }

  return <Redirect href="/(onboarding)" />;
}
