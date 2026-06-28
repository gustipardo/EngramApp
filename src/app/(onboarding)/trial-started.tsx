import { View, Text, Pressable } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useRouter } from "expo-router";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useTrialStore } from "../../stores/useTrialStore";
import { dark as t } from "../../theme/colors";
import { EngramWordmark } from "../../components/EngramWordmark";

/** Shown once right after first sign-in: confirms the free trial has started
 *  and continues into the deck the user was trying to open (set in
 *  deck-select.handleSelectDeck before routing to sign-in). */
export default function TrialStartedScreen() {
  const router = useRouter();
  const status = useTrialStore((s) => s.status);
  const selectedDeck = useSettingsStore((s) => s.selectedDeck);

  // Prefer the server's number; fall back to the trial length (7 days).
  const days =
    status && status.daysRemaining > 0 && status.daysRemaining < 99
      ? status.daysRemaining
      : 7;
  const subscribed = !!status?.subscriptionActive;

  function handleContinue() {
    // Deck was set before login. Continue into its session (mic permission is
    // requested there). Fall back to the deck list if somehow unset.
    if (selectedDeck) {
      router.replace("/(main)/session");
    } else {
      router.replace("/(main)/deck-select");
    }
  }

  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: t.bg.base,
        paddingHorizontal: 24,
      }}
    >
      <EngramWordmark width={160} style={{ marginBottom: 40 }} />

      <View
        style={{
          width: 96,
          height: 96,
          borderRadius: 48,
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 24,
          backgroundColor: t.success.subtleBg,
        }}
      >
        <Svg width={48} height={48} viewBox="0 0 24 24">
          <Path
            fill="none"
            stroke={t.success.text}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M20 6L9 17l-5-5"
          />
        </Svg>
      </View>

      <Text
        style={{
          marginBottom: 8,
          textAlign: "center",
          fontSize: 26,
          fontWeight: "700",
          color: t.text.primary,
          letterSpacing: -0.4,
        }}
      >
        {subscribed ? "You're all set" : "Your free trial has started"}
      </Text>

      <Text
        style={{
          marginBottom: 32,
          textAlign: "center",
          fontSize: 15,
          color: t.text.secondary,
          lineHeight: 22,
          maxWidth: 320,
        }}
      >
        {subscribed
          ? "Your subscription is active. Jump in and start studying by voice."
          : `You have ${days} day${days === 1 ? "" : "s"} of full access. Study any deck by voice with the AI tutor — no limits during your trial.`}
      </Text>

      <Pressable
        onPress={handleContinue}
        android_ripple={{ color: t.accent.pressed }}
        style={{
          width: "100%",
          borderRadius: 12,
          paddingHorizontal: 24,
          paddingVertical: 16,
          backgroundColor: t.accent.default,
        }}
      >
        <Text
          style={{
            textAlign: "center",
            fontSize: 16,
            fontWeight: "700",
            color: t.text.onAccent,
          }}
        >
          Start studying
        </Text>
      </Pressable>
    </View>
  );
}
