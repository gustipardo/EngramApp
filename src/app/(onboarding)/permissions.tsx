import { useEffect, useState, useCallback } from "react";
import { View, Text, Pressable, Linking, AppState } from "react-native";
import { useRouter } from "expo-router";
import { ankiBridge } from "../../native/ankiBridge";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { light as t } from "../../theme/colors";

type PermissionStatus = "pending" | "granted";

// Onboarding only sets up the AnkiDroid connection — the one permission we
// need to read decks and show the deck list. Microphone + notifications are
// requested later, at session start, the first time the user enters a deck
// (see sessionManager.startSession). Login is also deferred to deck entry.
export default function PermissionsScreen() {
  const router = useRouter();
  const [ankidroid, setAnkidroid] = useState<PermissionStatus>("pending");
  const [isRequesting, setIsRequesting] = useState(false);
  const [needsSettings, setNeedsSettings] = useState(false);

  const checkPermissions = useCallback(async () => {
    const granted = await ankiBridge.hasApiPermission();
    setAnkidroid(granted ? "granted" : "pending");
  }, []);

  useEffect(() => {
    checkPermissions();
    const subscription = AppState.addEventListener("change", (nextAppState) => {
      if (nextAppState === "active") checkPermissions();
    });
    return () => subscription.remove();
  }, [checkPermissions]);

  async function handleRequestAnkiDroidPermission() {
    setIsRequesting(true);
    setNeedsSettings(false);
    try {
      const dialogShown = await ankiBridge.requestApiPermission();
      if (!dialogShown) {
        // Android has permanently blocked the dialog ("never ask again").
        // The only way forward is the system Settings page.
        setNeedsSettings(true);
      }
      // If dialogShown=true, the AppState listener handles the result when
      // the user returns.
    } catch (err) {
      console.warn("[permissions] requestApiPermission failed", err);
    }
    setIsRequesting(false);
  }

  function handleContinue() {
    // AnkiDroid is connected — mark onboarding done and show the deck list.
    // Auth + mic/notification permissions happen on first deck entry.
    useSettingsStore.getState().setOnboardingCompleted(true);
    router.replace("/(main)/deck-select");
  }

  const granted = ankidroid === "granted";

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: t.bg.base,
        paddingHorizontal: 24,
        paddingTop: 64,
      }}
    >
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
        Connect AnkiDroid
      </Text>

      <Text
        style={{
          marginBottom: 32,
          textAlign: "center",
          fontSize: 15,
          color: t.text.secondary,
          lineHeight: 22,
        }}
      >
        Engram reads your flashcard decks straight from AnkiDroid. Grant access
        to load your decks. You can sign in later, when you start studying.
      </Text>

      <PermissionCard
        title="AnkiDroid Access"
        description="Lets Engram read your flashcard decks and due cards from AnkiDroid."
        status={ankidroid}
        onRequest={handleRequestAnkiDroidPermission}
        disabled={isRequesting}
      />

      {needsSettings && (
        <View
          style={{
            marginBottom: 16,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: t.error.default,
            backgroundColor: t.error.subtleBg,
            padding: 16,
          }}
        >
          <Text
            style={{
              fontSize: 13,
              fontWeight: "700",
              color: t.error.text,
              marginBottom: 6,
            }}
          >
            Permission permanently blocked
          </Text>
          <Text
            style={{
              fontSize: 13,
              color: t.text.secondary,
              lineHeight: 19,
              marginBottom: 12,
            }}
          >
            Android won't show the dialog anymore. Open Settings → Apps → Engram
            → Permissions and enable AnkiDroid access manually.
          </Text>
          <Pressable
            onPress={() => Linking.openSettings()}
            android_ripple={{ color: t.accent.subtleBg }}
            style={{
              borderRadius: 10,
              borderWidth: 1,
              borderColor: t.accent.default,
              paddingHorizontal: 16,
              paddingVertical: 12,
              backgroundColor: "transparent",
            }}
          >
            <Text
              style={{
                textAlign: "center",
                fontWeight: "700",
                color: t.accent.default,
              }}
            >
              Open Settings
            </Text>
          </Pressable>
        </View>
      )}

      <View
        style={{
          marginTop: 8,
          borderRadius: 12,
          overflow: "hidden",
          backgroundColor: granted ? t.accent.default : t.bg.surface3,
        }}
      >
        <Pressable
          onPress={handleContinue}
          disabled={!granted}
          android_ripple={{ color: t.accent.pressed }}
          style={{
            paddingHorizontal: 24,
            paddingVertical: 16,
          }}
        >
          <Text
            style={{
              textAlign: "center",
              fontSize: 16,
              fontWeight: "700",
              color: granted ? t.text.onAccent : t.text.disabled,
            }}
          >
            {granted ? "See my decks" : "Grant AnkiDroid access to continue"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function PermissionCard({
  title,
  description,
  status,
  onRequest,
  disabled,
}: {
  title: string;
  description: string;
  status: PermissionStatus;
  onRequest: () => void;
  disabled?: boolean;
}) {
  return (
    <View
      style={{
        marginBottom: 16,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: t.border.subtle,
        backgroundColor: t.bg.surface1,
        padding: 16,
      }}
    >
      <View
        style={{
          marginBottom: 8,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Text
          style={{ fontSize: 16, fontWeight: "700", color: t.text.primary }}
        >
          {title}
        </Text>
        <PermissionBadge status={status} />
      </View>

      <Text
        style={{
          marginBottom: 12,
          fontSize: 13,
          color: t.text.secondary,
          lineHeight: 19,
        }}
      >
        {description}
      </Text>

      {status === "pending" && (
        <Pressable
          onPress={onRequest}
          disabled={disabled}
          android_ripple={{ color: t.accent.pressed }}
          style={{
            borderRadius: 10,
            paddingHorizontal: 16,
            paddingVertical: 12,
            opacity: disabled ? 0.5 : 1,
            backgroundColor: t.accent.default,
          }}
        >
          <Text
            style={{
              textAlign: "center",
              fontWeight: "700",
              color: t.text.onAccent,
            }}
          >
            Grant {title}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function PermissionBadge({ status }: { status: PermissionStatus }) {
  const cfg =
    status === "granted"
      ? { bg: t.success.subtleBg, color: t.success.text, label: "Granted" }
      : { bg: t.bg.surface3, color: t.text.tertiary, label: "Pending" };

  return (
    <View
      style={{
        borderRadius: 9999,
        paddingHorizontal: 12,
        paddingVertical: 4,
        backgroundColor: cfg.bg,
      }}
    >
      <Text style={{ fontSize: 12, fontWeight: "600", color: cfg.color }}>
        {cfg.label}
      </Text>
    </View>
  );
}
