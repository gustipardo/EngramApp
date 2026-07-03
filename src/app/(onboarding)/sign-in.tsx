import { useState } from "react";
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  StyleSheet,
} from "react-native";
import Svg, { Path } from "react-native-svg";
import { useRouter } from "expo-router";
import { statusCodes } from "@react-native-google-signin/google-signin";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useTrialStore } from "../../stores/useTrialStore";
import { signInWithGoogle } from "../../services/authService";
import { AnalyticsEvents } from "../../services/analytics";
import { light as t, palette } from "../../theme/colors";
import { EngramWordmark } from "../../components/EngramWordmark";
import { useT } from "../../i18n";

/** Official multi-color Google "G" mark. Brand colors are exact by design
 *  (Google branding guidelines) — not theme tokens. */
function GoogleG({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <Path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <Path
        fill="#FBBC05"
        d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <Path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </Svg>
  );
}

export default function SignInScreen() {
  const router = useRouter();
  const tr = useT();
  const setOnboardingCompleted = useSettingsStore(
    (s) => s.setOnboardingCompleted,
  );
  const refreshTrialStatus = useTrialStore((s) => s.refresh);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGoogleSignIn() {
    if (isSigningIn) return;
    setIsSigningIn(true);
    setError(null);
    AnalyticsEvents.signupStarted();

    try {
      await signInWithGoogle();
      AnalyticsEvents.signupCompleted("google");
      if (!useSettingsStore.getState().onboardingCompleted) {
        AnalyticsEvents.onboardingCompleted();
      }
      setOnboardingCompleted(true);
      // Start/sync the trial clock server-side (checkTrialStatus creates the
      // user doc + trialStart on first login), then show the trial-started
      // confirmation which continues into the selected deck's session.
      await refreshTrialStatus();
      router.replace("/(onboarding)/trial-started");
    } catch (err: any) {
      // User-cancel and "already in progress" are not real errors — stay quiet.
      const code = err?.code;
      if (
        code === statusCodes.SIGN_IN_CANCELLED ||
        code === statusCodes.IN_PROGRESS
      ) {
        return;
      }
      if (code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
        setError(tr("onboarding.signIn.playServicesUnavailable"));
      } else {
        console.error("Sign-in failed:", err);
        setError(tr("onboarding.signIn.failed"));
      }
    } finally {
      setIsSigningIn(false);
    }
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <EngramWordmark width={200} style={{ marginBottom: 24 }} />
        <Text style={styles.tagline}>{tr("onboarding.signIn.tagline")}</Text>
        <Text style={styles.trialNote}>
          {tr("onboarding.signIn.trialNote")}
        </Text>
      </View>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <Pressable
        onPress={handleGoogleSignIn}
        disabled={isSigningIn}
        accessibilityRole="button"
        accessibilityLabel={tr("common.signInWithGoogle")}
        accessibilityState={{ disabled: isSigningIn, busy: isSigningIn }}
        android_ripple={{ color: palette.navy[200] }}
        style={[
          styles.googleButton,
          isSigningIn && styles.googleButtonDisabled,
        ]}
      >
        {isSigningIn ? (
          <ActivityIndicator size="small" color={palette.navy[900]} />
        ) : (
          <GoogleG size={20} />
        )}
        <Text style={styles.googleButtonText}>
          {isSigningIn
            ? tr("onboarding.signIn.signingIn")
            : tr("common.signInWithGoogle")}
        </Text>
      </Pressable>

      <Text style={styles.legal}>{tr("onboarding.signIn.legal")}</Text>

      {/* Full-screen loading scrim — unmistakable feedback while the Google
          flow + Firebase credential exchange runs. */}
      {isSigningIn && (
        <View style={styles.loadingOverlay} pointerEvents="auto">
          <ActivityIndicator size="large" color={t.accent.default} />
          <Text style={styles.loadingText}>
            {tr("onboarding.signIn.signingIn")}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.bg.base,
    paddingHorizontal: 24,
  },
  header: { marginBottom: 40, alignItems: "center" },
  tagline: {
    marginBottom: 8,
    textAlign: "center",
    fontSize: 16,
    color: t.text.secondary,
    lineHeight: 24,
    maxWidth: 320,
  },
  trialNote: {
    marginTop: 8,
    textAlign: "center",
    fontSize: 13,
    color: t.text.tertiary,
  },
  errorBox: {
    marginBottom: 16,
    width: "100%",
    borderRadius: 10,
    padding: 12,
    backgroundColor: t.error.subtleBg,
  },
  errorText: { textAlign: "center", fontSize: 13, color: t.error.text },
  // White Google-branded button on the light/cream screen. The near-white fill
  // plus a visible grey border + drop shadow make it read as a raised, tappable
  // card against the paper background.
  googleButton: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    borderRadius: 12,
    paddingHorizontal: 24,
    paddingVertical: 16,
    backgroundColor: palette.paper[50],
    borderWidth: 1,
    borderColor: palette.navy[300],
    // Raised affordance (Android elevation + iOS shadow).
    elevation: 3,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  // Press feedback is handled by android_ripple (app is Android-only).
  // NativeWind's component interop drops Pressable's `({ pressed }) => …`
  // style-callback, so the pressed style is applied via ripple, not here.
  googleButtonDisabled: { opacity: 0.7 },
  googleButtonText: {
    textAlign: "center",
    fontSize: 16,
    fontWeight: "600",
    color: palette.navy[900],
  },
  legal: {
    marginTop: 16,
    textAlign: "center",
    fontSize: 11,
    color: t.text.tertiary,
    maxWidth: 280,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    backgroundColor: t.bg.base,
    opacity: 0.96,
  },
  loadingText: { fontSize: 15, color: t.text.secondary, fontWeight: "500" },
});
