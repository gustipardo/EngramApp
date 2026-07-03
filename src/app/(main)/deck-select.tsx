import { useEffect, useRef, useState, useCallback } from "react";
import Constants from "expo-constants";
import {
  Animated,
  View,
  Text,
  Pressable,
  FlatList,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
  Switch,
  Platform,
  StatusBar,
  Modal,
  TextInput,
  Keyboard,
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import Svg, { Path } from "react-native-svg";
import {
  useSettingsStore,
  DEFAULT_DECK_LANGUAGE,
} from "../../stores/useSettingsStore";
import { useSessionStore } from "../../stores/useSessionStore";
import { ankiBridge } from "../../native/ankiBridge";
import { requiresPayment, requiresAuth } from "../../config/env";
import { useTrialStore } from "../../stores/useTrialStore";
import { useAuthStore } from "../../stores/useAuthStore";
import { AnalyticsEvents } from "../../services/analytics";
import type { DeckInfo } from "../../types/anki";
import { type Theme, darkTheme, lightTheme } from "../../theme/appTheme";
import { EngramWordmark } from "../../components/EngramWordmark";
import { useAutostartEnabled } from "../../services/autostartFlag";

// Tutor-language options shown in the per-deck settings sheet.
// Keep in sync with `LANGUAGE_LABELS` in `src/config/prompts.ts` (the
// human-readable label injected into the system prompt). BCP-47 codes
// are what Gemini Live's `speechConfig.languageCode` accepts.
const LANGUAGE_OPTIONS: { code: string; label: string }[] = [
  { code: "en-US", label: "English (US)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "es-ES", label: "Spanish" },
  { code: "es-MX", label: "Spanish (MX)" },
  { code: "fr-FR", label: "French" },
  { code: "de-DE", label: "German" },
  { code: "it-IT", label: "Italian" },
  { code: "pt-BR", label: "Portuguese (BR)" },
  { code: "pt-PT", label: "Portuguese (PT)" },
  { code: "nl-NL", label: "Dutch" },
  { code: "ru-RU", label: "Russian" },
  { code: "ja-JP", label: "Japanese" },
  { code: "ko-KR", label: "Korean" },
  { code: "zh-CN", label: "Mandarin" },
];

type LoadingState = "loading" | "loaded" | "error" | "empty";

export default function DeckSelectScreen() {
  const router = useRouter();
  const setSelectedDeck = useSettingsStore((s) => s.setSelectedDeck);
  const darkMode = useSettingsStore((s) => s.darkMode);
  const deckReadBack = useSettingsStore((s) => s.deckReadBack);
  const setDeckReadBack = useSettingsStore((s) => s.setDeckReadBack);
  const deckInstructions = useSettingsStore((s) => s.deckInstructions);
  const setDeckInstructions = useSettingsStore((s) => s.setDeckInstructions);
  const deckLanguages = useSettingsStore((s) => s.deckLanguages);
  const setDeckLanguage = useSettingsStore((s) => s.setDeckLanguage);

  const autoStartDeck: string | null =
    (Constants.expoConfig?.extra as any)?.autoStartDeck ?? null;
  const autostartEnabled = useAutostartEnabled();
  const autoStartFiredRef = useRef(false);

  const [decks, setDecks] = useState<DeckInfo[]>([]);
  const [loadingState, setLoadingState] = useState<LoadingState>("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const trialStatus = useTrialStore((s) => s.status);
  const refreshTrialStatus = useTrialStore((s) => s.refresh);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);
  const accountInitial = (user?.displayName || user?.email || "?")
    .trim()
    .charAt(0)
    .toUpperCase();
  // Unified deck-settings sheet (language + tutor instructions). Replaces
  // the standalone instructions modal — same surface, more obvious entry
  // point via the gear icon on each row.
  const [settingsModal, setSettingsModal] = useState<{
    deckName: string;
    instructions: string;
    language: string;
    readBack: boolean;
  } | null>(null);
  // Manual keyboard tracking for the deck-settings sheet, instead of
  // KeyboardAvoidingView: on Android, KeyboardAvoidingView nested inside a
  // Modal computes its offset against the wrong window and gets stuck
  // mid-height when the keyboard hides (leaves a gap at the bottom of the
  // sheet). Tracking height directly and forcing it to 0 on
  // keyboardDidHide resets it reliably.
  const [keyboardOffset, setKeyboardOffset] = useState(0);

  useEffect(() => {
    const showSub = Keyboard.addListener("keyboardDidShow", (e) => {
      setKeyboardOffset(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener("keyboardDidHide", () => {
      setKeyboardOffset(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const openDeckSettings = useCallback(
    (deckName: string) => {
      setSettingsModal({
        deckName,
        instructions: deckInstructions[deckName] || "",
        language: deckLanguages[deckName] || DEFAULT_DECK_LANGUAGE,
        readBack: deckReadBack[deckName] ?? false,
      });
    },
    [deckInstructions, deckLanguages, deckReadBack],
  );

  const t = darkMode ? darkTheme : lightTheme;

  const loadDecks = useCallback(async () => {
    try {
      // Guard: if AnkiDroid permission was revoked (e.g. after pm clear or
      // settings change), send the user to the permissions screen rather than
      // showing the dead-end "Cannot Load Decks" error.
      const hasPermission = await ankiBridge.hasApiPermission();
      if (!hasPermission) {
        router.replace("/(onboarding)/permissions");
        return;
      }

      const deckInfos = await ankiBridge.getDeckInfo();

      if (deckInfos.length === 0) {
        setLoadingState("empty");
        setDecks([]);
        return;
      }

      setDecks(deckInfos);
      setLoadingState("loaded");
    } catch (error) {
      console.error("Failed to load decks:", error);
      setLoadingState("error");
    }
  }, []);

  // Refresh on every focus so due counts update after a session ends.
  useFocusEffect(
    useCallback(() => {
      loadDecks();
      if (requiresPayment()) {
        refreshTrialStatus();
      }
    }, [loadDecks, refreshTrialStatus]),
  );

  // Dev autostart: opt-in. Requires both a deck name (AUTO_START_DECK) AND
  // an enable signal — either AUTO_START_ENABLED=true in .env OR the launch
  // deep link carried `?autostart=1` (set by _layout.tsx). Fires once per
  // mount, after decks load, and only if the named deck exists.
  // Guard: skip if a session is already active (phase != idle). This prevents
  // a second session from starting when deck-select remounts during testing
  // (e.g. paywall router.back() landing here while a session is running).
  useEffect(() => {
    if (!autoStartDeck) return;
    if (!autostartEnabled) return;
    if (autoStartFiredRef.current) return;
    if (loadingState !== "loaded") return;
    if (useSessionStore.getState().phase !== "idle") return;
    const match = decks.find((d) => d.deckName === autoStartDeck);
    if (!match) {
      console.warn(
        `[autostart] deck "${autoStartDeck}" not found in loaded decks (have: ${decks.map((d) => d.deckName).join(" | ")})`,
      );
      return;
    }
    autoStartFiredRef.current = true;
    console.log(`[autostart] starting session for deck "${autoStartDeck}"`);
    handleSelectDeck(autoStartDeck);
  }, [autoStartDeck, autostartEnabled, loadingState, decks]);

  async function handleRefresh() {
    setRefreshing(true);
    await loadDecks();
    setRefreshing(false);
  }

  async function handleSync() {
    if (syncing) return;
    setSyncing(true);
    try {
      await ankiBridge.triggerSync();
      // Give AnkiDroid a moment to start syncing, then refresh deck list
      setTimeout(async () => {
        await loadDecks();
        setSyncing(false);
      }, 2000);
    } catch (error) {
      console.error("Sync failed:", error);
      setSyncing(false);
    }
  }

  function handleSelectDeck(deckName: string) {
    AnalyticsEvents.deckSelected(deckName);
    setSelectedDeck(deckName);

    // Auth gate lives HERE now (not at app launch): the deck list is
    // browsable signed-out, but entering a deck requires login. Sign-in then
    // continues to the trial-started screen and on into this deck's session.
    if (requiresAuth() && !isAuthenticated) {
      router.push("/(onboarding)/sign-in");
      return;
    }

    // Block session start if trial expired and no subscription.
    if (
      trialStatus &&
      !trialStatus.isActive &&
      !trialStatus.subscriptionActive
    ) {
      AnalyticsEvents.trialExpired();
      AnalyticsEvents.paywallShown("trial_expired");
      router.push("/(main)/paywall");
      return;
    }

    router.push("/(main)/session");
  }

  // -----------------------------------------------------------------------
  // Loading
  // -----------------------------------------------------------------------
  if (loadingState === "loading") {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: t.bg,
        }}
      >
        <StatusBar barStyle={t.statusBar} backgroundColor={t.bg} />
        <ActivityIndicator size="large" color={t.accent} />
        <Text
          style={{
            color: t.text,
            fontWeight: "600",
            fontSize: 16,
            marginTop: 16,
          }}
        >
          Loading decks...
        </Text>
        <Text style={{ color: t.textSecondary, fontSize: 13, marginTop: 4 }}>
          Connecting to AnkiDroid
        </Text>
      </View>
    );
  }

  // -----------------------------------------------------------------------
  // Error
  // -----------------------------------------------------------------------
  if (loadingState === "error") {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: t.bg,
          paddingHorizontal: 32,
        }}
      >
        <StatusBar barStyle={t.statusBar} backgroundColor={t.bg} />
        <View
          style={{
            width: 80,
            height: 80,
            borderRadius: 40,
            backgroundColor: t.errorCircleBg,
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 20,
          }}
        >
          <Text style={{ fontSize: 28, fontWeight: "800", color: t.error }}>
            !
          </Text>
        </View>
        <Text
          style={{
            fontSize: 20,
            fontWeight: "700",
            color: t.text,
            textAlign: "center",
            marginBottom: 8,
          }}
        >
          Cannot Load Decks
        </Text>
        <Text
          style={{
            fontSize: 14,
            color: t.textSecondary,
            textAlign: "center",
            lineHeight: 22,
            marginBottom: 32,
          }}
        >
          Could not connect to AnkiDroid. Make sure AnkiDroid is installed,
          running, and permissions are granted.
        </Text>
        <Pressable
          onPress={loadDecks}
          style={{
            backgroundColor: t.accent,
            borderRadius: 16,
            paddingVertical: 14,
            paddingHorizontal: 40,
          }}
        >
          <Text
            style={{ color: t.textOnAccent, fontSize: 15, fontWeight: "700" }}
          >
            Try Again
          </Text>
        </Pressable>
      </View>
    );
  }

  // -----------------------------------------------------------------------
  // Empty
  // -----------------------------------------------------------------------
  if (loadingState === "empty") {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: t.bg,
          paddingHorizontal: 32,
        }}
      >
        <StatusBar barStyle={t.statusBar} backgroundColor={t.bg} />
        <View
          style={{
            width: 80,
            height: 80,
            borderRadius: 40,
            backgroundColor: t.warnCircleBg,
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 20,
          }}
        >
          <Text style={{ fontSize: 28, fontWeight: "800", color: t.accent }}>
            0
          </Text>
        </View>
        <Text
          style={{
            fontSize: 20,
            fontWeight: "700",
            color: t.text,
            textAlign: "center",
            marginBottom: 8,
          }}
        >
          No Decks Found
        </Text>
        <Text
          style={{
            fontSize: 14,
            color: t.textSecondary,
            textAlign: "center",
            lineHeight: 22,
            marginBottom: 32,
          }}
        >
          AnkiDroid does not have any decks yet. Create or import some decks in
          AnkiDroid, then come back.
        </Text>
        <Pressable
          onPress={handleRefresh}
          style={{
            backgroundColor: t.accent,
            borderRadius: 16,
            paddingVertical: 14,
            paddingHorizontal: 40,
          }}
        >
          <Text
            style={{ color: t.textOnAccent, fontSize: 15, fontWeight: "700" }}
          >
            Refresh
          </Text>
        </Pressable>
      </View>
    );
  }

  // -----------------------------------------------------------------------
  // Deck list
  // -----------------------------------------------------------------------
  const totalDue = decks.reduce((sum, d) => sum + d.dueCount, 0);

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <StatusBar barStyle={t.statusBar} backgroundColor={t.surface} />

      {/* Header */}
      <View
        style={{
          backgroundColor: t.surface,
          paddingHorizontal: 20,
          paddingBottom: 12,
          paddingTop:
            Platform.OS === "android"
              ? (StatusBar.currentHeight ?? 0) + 12
              : 56,
          borderBottomWidth: 1,
          borderBottomColor: t.border,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <EngramWordmark width={120} color={t.accent} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Pressable
              onPress={handleSync}
              disabled={syncing}
              accessibilityLabel="Sync decks with AnkiDroid"
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 8,
                backgroundColor: t.pressHighlight,
                opacity: syncing ? 0.5 : 1,
              }}
            >
              {syncing ? (
                <ActivityIndicator size="small" color={t.textSecondary} />
              ) : (
                <RefreshIcon size={15} color={t.textSecondary} />
              )}
              <Text
                style={{
                  color: t.textSecondary,
                  fontSize: 13,
                  fontWeight: "600",
                }}
              >
                {syncing ? "Syncing…" : "Sync"}
              </Text>
            </Pressable>
            {/* Account + settings. Replaces the old Dark / Sign Out buttons —
             * theme toggle, billing and sign-out all live in the settings
             * screen now. Shown in every mode (the screen handles signed-out /
             * dev states). */}
            <Pressable
              testID="account-button"
              onPress={() => router.push("/(main)/settings")}
              android_ripple={{
                color: t.pressHighlight,
                borderless: true,
                radius: 24,
              }}
              hitSlop={8}
              accessibilityLabel="Account and settings"
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: t.pressHighlight,
                borderWidth: 1,
                borderColor: t.border,
              }}
            >
              <Text style={{ color: t.text, fontSize: 15, fontWeight: "700" }}>
                {accountInitial}
              </Text>
            </Pressable>
          </View>
        </View>
        <Text style={{ fontSize: 13, color: t.textSecondary, marginTop: 6 }}>
          {totalDue > 0 ? `${totalDue} cards due` : `${decks.length} decks`}
        </Text>
      </View>

      {/* Trial status banner — taps through to the account/plan screen. */}
      {trialStatus &&
        trialStatus.isActive &&
        !trialStatus.subscriptionActive && (
          <Pressable
            onPress={() => router.push("/(main)/settings")}
            android_ripple={{ color: t.pressHighlight }}
            style={{
              marginHorizontal: 16,
              marginTop: 12,
              backgroundColor: t.trialBannerBg,
              borderRadius: 12,
              paddingHorizontal: 16,
              paddingVertical: 10,
              overflow: "hidden",
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <Text
              style={{
                flexShrink: 1,
                fontSize: 13,
                fontWeight: "600",
                color: t.trialBannerText,
              }}
            >
              Free trial: {trialStatus.daysRemaining} day
              {trialStatus.daysRemaining === 1 ? "" : "s"} remaining
            </Text>
            <Text
              style={{
                marginLeft: 12,
                fontSize: 13,
                fontWeight: "700",
                color: t.trialBannerText,
              }}
            >
              Manage ›
            </Text>
          </Pressable>
        )}

      {/* Deck list — one card per deck (a single wrapper card around the
       * whole list read as one giant undifferentiated block). */}
      <View style={{ flex: 1 }}>
        <FlatList
          data={decks}
          keyExtractor={(item) => item.deckName}
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 16,
            gap: 10,
          }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={t.textSecondary}
            />
          }
          renderItem={({ item }) => (
            <DeckRow
              deck={item}
              onPress={() => handleSelectDeck(item.deckName)}
              onLongPress={() => openDeckSettings(item.deckName)}
              onSettings={() => openDeckSettings(item.deckName)}
              hasInstructions={!!deckInstructions[item.deckName]}
              theme={t}
            />
          )}
          ListEmptyComponent={
            <View style={{ alignItems: "center", paddingVertical: 32 }}>
              <Text style={{ color: t.textSecondary }}>No decks available</Text>
            </View>
          }
        />
      </View>

      {/* Hint text */}
      <View style={{ paddingHorizontal: 20, paddingBottom: 12 }}>
        <Text
          style={{ fontSize: 11, color: t.textDimmed, textAlign: "center" }}
        >
          Tap the gear to set language, read-back and tutor instructions for
          each deck
        </Text>
      </View>

      {/* Deck-settings sheet: language picker + tutor instructions. Replaces
       * the older standalone instructions modal — same surface, two settings
       * in one place, opened from the gear icon on each row. Long-press on
       * the row still works as a power-user shortcut to the same sheet. */}
      {settingsModal && (
        <Modal
          visible
          transparent
          animationType="slide"
          onRequestClose={() => setSettingsModal(null)}
        >
          <View
            style={{
              flex: 1,
              justifyContent: "flex-end",
              paddingBottom: keyboardOffset,
            }}
          >
            <Pressable
              style={{ flex: 1 }}
              onPress={() => setSettingsModal(null)}
            />
            <View
              style={{
                backgroundColor: t.surface,
                borderTopLeftRadius: 20,
                borderTopRightRadius: 20,
                paddingHorizontal: 20,
                paddingTop: 20,
                paddingBottom: 32,
                borderTopWidth: 1,
                borderColor: t.border,
                maxHeight: "85%",
              }}
            >
              <Text
                style={{
                  fontSize: 17,
                  fontWeight: "700",
                  color: t.text,
                  marginBottom: 4,
                }}
              >
                Deck Settings
              </Text>
              <Text
                style={{
                  fontSize: 13,
                  color: t.textSecondary,
                  marginBottom: 20,
                }}
              >
                {settingsModal.deckName}
              </Text>

              <ScrollView
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                {/* Language */}
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: "700",
                    color: t.text,
                    marginBottom: 8,
                  }}
                >
                  Tutor language
                </Text>
                <Text
                  style={{
                    fontSize: 12,
                    color: t.textSecondary,
                    marginBottom: 10,
                  }}
                >
                  Controls the tutor's voice and the language it speaks in. Pick
                  whatever matches the deck content.
                </Text>
                <View
                  style={{
                    flexDirection: "row",
                    flexWrap: "wrap",
                    marginBottom: 20,
                  }}
                >
                  {LANGUAGE_OPTIONS.map((opt) => {
                    const selected = settingsModal.language === opt.code;
                    return (
                      <Pressable
                        key={opt.code}
                        onPress={() =>
                          setSettingsModal(
                            (prev) => prev && { ...prev, language: opt.code },
                          )
                        }
                        style={{
                          paddingHorizontal: 12,
                          paddingVertical: 8,
                          borderRadius: 999,
                          borderWidth: 1,
                          borderColor: selected ? t.accent : t.border,
                          backgroundColor: selected ? t.accent : "transparent",
                          marginRight: 8,
                          marginBottom: 8,
                        }}
                      >
                        <Text
                          style={{
                            fontSize: 13,
                            fontWeight: "600",
                            color: selected ? t.textOnAccent : t.textSecondary,
                          }}
                        >
                          {opt.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                {/* Always read answer (per deck) */}
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 20,
                  }}
                >
                  <View style={{ flex: 1, marginRight: 12 }}>
                    <Text
                      style={{
                        fontSize: 13,
                        fontWeight: "700",
                        color: t.text,
                      }}
                    >
                      Always read answer
                    </Text>
                    <Text
                      style={{
                        fontSize: 12,
                        color: t.textSecondary,
                        marginTop: 2,
                      }}
                    >
                      Read the back of the card aloud after every answer, not
                      just on incorrect ones.
                    </Text>
                  </View>
                  <Switch
                    testID="toggle-readback"
                    value={settingsModal.readBack}
                    onValueChange={(v) =>
                      setSettingsModal(
                        (prev) => prev && { ...prev, readBack: v },
                      )
                    }
                    trackColor={{
                      false: t.switchTrackOff,
                      true: t.switchTrackOn,
                    }}
                    thumbColor={
                      settingsModal.readBack
                        ? t.switchThumbOn
                        : t.switchThumbOff
                    }
                  />
                </View>

                {/* Tutor instructions */}
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: "700",
                    color: t.text,
                    marginBottom: 8,
                  }}
                >
                  Tutor instructions
                </Text>
                <Text
                  style={{
                    fontSize: 12,
                    color: t.textSecondary,
                    marginBottom: 10,
                  }}
                >
                  Optional. Free-text guidance the tutor follows for this deck
                  only.
                </Text>
                <TextInput
                  style={{
                    backgroundColor: t.bg,
                    color: t.text,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: t.border,
                    padding: 14,
                    fontSize: 14,
                    minHeight: 100,
                    textAlignVertical: "top",
                  }}
                  multiline
                  placeholder="E.g.: The back has a Core Answer and a Conceptual Answer. Only test me on the Core Answer, but read aloud the Conceptual Answer after each card."
                  placeholderTextColor={t.textDimmed}
                  value={settingsModal.instructions}
                  onChangeText={(text) =>
                    setSettingsModal(
                      (prev) => prev && { ...prev, instructions: text },
                    )
                  }
                />
              </ScrollView>

              <View style={{ flexDirection: "row", gap: 12, marginTop: 16 }}>
                <Pressable
                  onPress={() => setSettingsModal(null)}
                  style={{
                    flex: 1,
                    paddingVertical: 12,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: t.border,
                    alignItems: "center",
                  }}
                >
                  <Text
                    style={{
                      color: t.textSecondary,
                      fontWeight: "600",
                      fontSize: 14,
                    }}
                  >
                    Cancel
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setDeckInstructions(
                      settingsModal.deckName,
                      settingsModal.instructions,
                    );
                    setDeckLanguage(
                      settingsModal.deckName,
                      settingsModal.language,
                    );
                    setDeckReadBack(
                      settingsModal.deckName,
                      settingsModal.readBack,
                    );
                    setSettingsModal(null);
                  }}
                  style={{
                    flex: 1,
                    paddingVertical: 12,
                    borderRadius: 12,
                    backgroundColor: t.accent,
                    alignItems: "center",
                  }}
                >
                  <Text
                    style={{
                      color: t.textOnAccent,
                      fontWeight: "700",
                      fontSize: 14,
                    }}
                  >
                    Save
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Deck row — matches AnkiDroid style: name left, colored counts right
// ---------------------------------------------------------------------------
/** Crisp circular-arrow refresh icon (Feather "rotate-cw"). Replaces the
 *  Unicode "⟳" glyph, which rendered thin, undersized and off-center next to
 *  the "Sync" label. Stroke weight matches the bold label. */
function RefreshIcon({ size = 17, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        fill="none"
        stroke={color}
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M23 4v6h-6"
      />
      <Path
        fill="none"
        stroke={color}
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"
      />
    </Svg>
  );
}

/** Crisp settings gear (Material "settings" outline). Replaces the Unicode
 *  "⚙" glyph, which renders as an inconsistent dingbat/emoji across devices. */
function GearIcon({ size = 20, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        fill={color}
        d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.05.3-.07.62-.07.94 0 .33.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.13.22.39.3.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.25.41.48.41h3.84c.23 0 .43-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.03-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"
      />
    </Svg>
  );
}

function DeckRow({
  deck,
  onPress,
  onLongPress,
  onSettings,
  hasInstructions,
  theme: t,
}: {
  deck: DeckInfo;
  onPress: () => void;
  onLongPress: () => void;
  onSettings: () => void;
  hasInstructions: boolean;
  theme: Theme;
}) {
  // Press feedback for the gear. NativeWind drops Pressable's
  // `({ pressed }) => …` style-callback, so we animate a scale via the
  // native driver on press in/out instead.
  const gearScale = useRef(new Animated.Value(1)).current;
  const pressGear = (to: number) =>
    Animated.spring(gearScale, {
      toValue: to,
      useNativeDriver: true,
      speed: 50,
      bounciness: 6,
    }).start();

  // Subtle press feedback for the whole deck row (select).
  const rowScale = useRef(new Animated.Value(1)).current;
  const pressRow = (to: number) =>
    Animated.spring(rowScale, {
      toValue: to,
      useNativeDriver: true,
      speed: 50,
      bounciness: 4,
    }).start();

  // Layout contract — each deck is its OWN card (surface + border + radius):
  //   - LEADING (flex: 1): deck name + (optional) custom-instructions dot.
  //     Name truncates with `…`; it yields before anything else does.
  //   - TRAILING (pinned right): counts cluster (fixed-width columns, so
  //     new/learning/review align vertically across cards) + gear.
  //
  // Two Pressables as SIBLINGS inside the card View — not nested — because
  // on Android a Pressable inside a Pressable can break out of the parent's
  // flex row layout and stack vertically. The counts live inside the row
  // Pressable so they're part of the select tap target.
  return (
    <Animated.View
      style={{
        backgroundColor: t.surface,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: t.border,
        overflow: "hidden",
        flexDirection: "row",
        alignItems: "center",
        transform: [{ scale: rowScale }],
      }}
    >
      {/* Leading group — deck name (+ counts pinned to its right edge). */}
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        onPressIn={() => pressRow(0.97)}
        onPressOut={() => pressRow(1)}
        android_ripple={{ color: t.pressHighlight }}
        style={{
          flex: 1,
          minWidth: 0,
          paddingVertical: 16,
          paddingLeft: 16,
          flexDirection: "row",
          alignItems: "center",
        }}
      >
        <View
          style={{
            flex: 1,
            minWidth: 0,
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Text
            style={{
              flexShrink: 1,
              fontSize: 16,
              fontWeight: "700",
              color: t.text,
            }}
            numberOfLines={1}
          >
            {deck.deckName}
          </Text>
          {hasInstructions && (
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: t.accent,
                flexShrink: 0,
              }}
            />
          )}
        </View>
        {/* Counts cluster (new / learning / review). Pinned to the card's
         * right edge (before the gear) with fixed-width columns so the
         * numbers line up vertically across cards. `flexShrink: 0` —
         * numbers never collapse; the name yields first. */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            flexShrink: 0,
            marginLeft: 12,
          }}
        >
          <Text
            style={{
              minWidth: 28,
              textAlign: "right",
              fontSize: 13,
              fontWeight: "600",
              fontVariant: ["tabular-nums"],
              color: deck.newCount > 0 ? t.info : t.textDimmed,
            }}
          >
            {deck.newCount}
          </Text>
          <Text
            style={{
              minWidth: 28,
              textAlign: "right",
              fontSize: 13,
              fontWeight: "600",
              marginLeft: 6,
              fontVariant: ["tabular-nums"],
              color: deck.learnCount > 0 ? t.error : t.textDimmed,
            }}
          >
            {deck.learnCount}
          </Text>
          <Text
            style={{
              minWidth: 28,
              textAlign: "right",
              fontSize: 13,
              fontWeight: "600",
              marginLeft: 6,
              fontVariant: ["tabular-nums"],
              color: deck.reviewCount > 0 ? t.success : t.textDimmed,
            }}
          >
            {deck.reviewCount}
          </Text>
        </View>
      </Pressable>
      {/* Trailing — gear pinned at the card's right edge. */}
      <Pressable
        onPress={onSettings}
        onPressIn={() => pressGear(0.92)}
        onPressOut={() => pressGear(1)}
        hitSlop={10}
        android_ripple={{
          color: t.pressHighlight,
          borderless: true,
          radius: 22,
        }}
        style={{
          flexShrink: 0,
          paddingLeft: 10,
          paddingRight: 14,
          paddingVertical: 16,
        }}
        accessibilityLabel={`Settings for ${deck.deckName}`}
      >
        <Animated.View style={{ transform: [{ scale: gearScale }] }}>
          <GearIcon size={20} color={t.textSecondary} />
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}
