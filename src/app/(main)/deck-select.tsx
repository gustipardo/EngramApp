import { useEffect, useRef, useState, useCallback } from "react";
import Constants from "expo-constants";
import {
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
  KeyboardAvoidingView,
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import {
  useSettingsStore,
  DEFAULT_DECK_LANGUAGE,
} from "../../stores/useSettingsStore";
import { useSessionStore } from "../../stores/useSessionStore";
import { ankiBridge } from "../../native/ankiBridge";
import { requiresPayment, requiresAuth } from "../../config/env";
import { useTrialStore } from "../../stores/useTrialStore";
import { signOut } from "../../services/authService";
import { AnalyticsEvents } from "../../services/analytics";
import type { DeckInfo } from "../../types/anki";
import { palette } from "../../theme/colors";
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

// ---------------------------------------------------------------------------
// Theme — Engram tokens (see src/theme/colors.ts)
// ---------------------------------------------------------------------------
interface Theme {
  bg: string;
  surface: string;
  text: string;
  textSecondary: string;
  textDimmed: string;
  textOnAccent: string;
  border: string;
  accent: string;
  success: string;
  error: string;
  info: string;
  pressHighlight: string;
  switchTrackOff: string;
  switchTrackOn: string;
  switchThumbOff: string;
  switchThumbOn: string;
  errorCircleBg: string;
  warnCircleBg: string;
  trialBannerBg: string;
  trialBannerText: string;
  statusBar: "light-content" | "dark-content";
}

const darkTheme: Theme = {
  bg: palette.navy[900],
  surface: palette.navy[850],
  text: palette.navy[50],
  textSecondary: palette.navy[200],
  textDimmed: palette.navy[400],
  textOnAccent: palette.navy[900],
  border: palette.navy[700],
  accent: palette.amber[500],
  success: palette.sage[500],
  error: palette.terracota[500],
  info: palette.slate[500],
  pressHighlight: palette.navy[700],
  switchTrackOff: palette.navy[400],
  switchTrackOn: palette.amber[700],
  switchThumbOff: palette.navy[200],
  switchThumbOn: palette.amber[300],
  errorCircleBg: "rgba(198, 123, 92, 0.18)",
  warnCircleBg: "rgba(228, 161, 63, 0.18)",
  trialBannerBg: "rgba(228, 161, 63, 0.12)",
  trialBannerText: palette.amber[300],
  statusBar: "light-content",
};

const lightTheme: Theme = {
  bg: palette.paper[100],
  surface: palette.paper[50],
  text: palette.navy[850],
  textSecondary: palette.navy[600],
  textDimmed: palette.navy[300],
  textOnAccent: palette.paper[100],
  border: palette.paper[500],
  accent: palette.amber[700],
  success: palette.sage[700],
  error: palette.terracota[700],
  info: palette.slate[700],
  pressHighlight: palette.paper[300],
  switchTrackOff: palette.paper[500],
  switchTrackOn: palette.amber[300],
  switchThumbOff: palette.paper[50],
  switchThumbOn: palette.amber[700],
  errorCircleBg: "rgba(165, 90, 61, 0.14)",
  warnCircleBg: "rgba(184, 120, 38, 0.14)",
  trialBannerBg: "rgba(184, 120, 38, 0.10)",
  trialBannerText: palette.amber[800],
  statusBar: "dark-content",
};

type LoadingState = "loading" | "loaded" | "error" | "empty";

export default function DeckSelectScreen() {
  const router = useRouter();
  const setSelectedDeck = useSettingsStore((s) => s.setSelectedDeck);
  const alwaysReadBack = useSettingsStore((s) => s.alwaysReadBack);
  const setAlwaysReadBack = useSettingsStore((s) => s.setAlwaysReadBack);
  const darkMode = useSettingsStore((s) => s.darkMode);
  const toggleDarkMode = useSettingsStore((s) => s.toggleDarkMode);
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
  // Unified deck-settings sheet (language + tutor instructions). Replaces
  // the standalone instructions modal — same surface, more obvious entry
  // point via the gear icon on each row.
  const [settingsModal, setSettingsModal] = useState<{
    deckName: string;
    instructions: string;
    language: string;
  } | null>(null);

  const openDeckSettings = useCallback(
    (deckName: string) => {
      setSettingsModal({
        deckName,
        instructions: deckInstructions[deckName] || "",
        language: deckLanguages[deckName] || DEFAULT_DECK_LANGUAGE,
      });
    },
    [deckInstructions, deckLanguages],
  );

  const t = darkMode ? darkTheme : lightTheme;

  const loadDecks = useCallback(async () => {
    try {
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

  async function handleSignOut() {
    try {
      await signOut();
      useSettingsStore.getState().setOnboardingCompleted(false);
      router.replace("/(onboarding)");
    } catch (err) {
      console.error("Sign-out failed:", err);
    }
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
    // Block session start if trial expired and no subscription
    if (
      trialStatus &&
      !trialStatus.isActive &&
      !trialStatus.subscriptionActive
    ) {
      AnalyticsEvents.paywallShown("trial_expired");
      router.push("/(main)/paywall");
      return;
    }

    AnalyticsEvents.deckSelected(deckName);
    setSelectedDeck(deckName);
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
          <View>
            <EngramWordmark
              width={120}
              color={t.accent}
              style={{ marginBottom: 2 }}
            />
            <Text
              style={{ fontSize: 13, color: t.textSecondary, marginTop: 2 }}
            >
              {totalDue > 0 ? `${totalDue} cards due` : `${decks.length} decks`}
            </Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Pressable
              onPress={handleSync}
              disabled={syncing}
              style={{
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
                <Text style={{ color: t.textSecondary, fontSize: 18 }}>⟳</Text>
              )}
            </Pressable>
            <Pressable
              onPress={toggleDarkMode}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 8,
                backgroundColor: t.pressHighlight,
              }}
            >
              <Text
                style={{
                  color: t.textSecondary,
                  fontSize: 13,
                  fontWeight: "600",
                }}
              >
                {darkMode ? "Light" : "Dark"}
              </Text>
            </Pressable>
            {requiresAuth() && (
              <Pressable
                onPress={handleSignOut}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 8,
                  backgroundColor: t.pressHighlight,
                }}
              >
                <Text
                  style={{
                    color: t.textSecondary,
                    fontSize: 13,
                    fontWeight: "600",
                  }}
                >
                  Sign Out
                </Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>

      {/* Trial status banner */}
      {trialStatus &&
        trialStatus.isActive &&
        !trialStatus.subscriptionActive && (
          <View
            style={{
              marginHorizontal: 16,
              marginTop: 12,
              backgroundColor: t.trialBannerBg,
              borderRadius: 12,
              paddingHorizontal: 16,
              paddingVertical: 10,
            }}
          >
            <Text
              style={{
                fontSize: 13,
                fontWeight: "600",
                color: t.trialBannerText,
              }}
            >
              Free trial: {trialStatus.daysRemaining} days /{" "}
              {trialStatus.sessionsRemaining} sessions remaining
            </Text>
          </View>
        )}

      {/* Settings row */}
      <View
        style={{
          marginHorizontal: 16,
          marginTop: 12,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          backgroundColor: t.surface,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.border,
          paddingHorizontal: 16,
          paddingVertical: 12,
        }}
      >
        <View style={{ flex: 1, marginRight: 12 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: t.text }}>
            Always read answer
          </Text>
          <Text style={{ fontSize: 11, color: t.textSecondary }}>
            Read the back of the card after every answer
          </Text>
        </View>
        <Switch
          value={alwaysReadBack}
          onValueChange={setAlwaysReadBack}
          trackColor={{ false: t.switchTrackOff, true: t.switchTrackOn }}
          thumbColor={alwaysReadBack ? t.switchThumbOn : t.switchThumbOff}
        />
      </View>

      {/* Deck list */}
      <View
        style={{
          marginHorizontal: 16,
          marginTop: 8,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.border,
          overflow: "hidden",
          flex: 1,
          paddingHorizontal: 12,
        }}
      >
        <FlatList
          data={decks}
          keyExtractor={(item) => item.deckName}
          contentContainerStyle={{ paddingBottom: 16 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={t.textSecondary}
            />
          }
          ItemSeparatorComponent={() => (
            <View style={{ height: 1, backgroundColor: t.border }} />
          )}
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
          Tap the gear to set language + tutor instructions for each deck
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
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : "height"}
            style={{ flex: 1, justifyContent: "flex-end" }}
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
          </KeyboardAvoidingView>
        </Modal>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Deck row — matches AnkiDroid style: name left, colored counts right
// ---------------------------------------------------------------------------
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
  // Layout contract (see SESSION-FLOW conventions; mirrored from a
  // standard mobile list-row pattern):
  //   - LEADING (left, snug): deck name + (optional) custom-instructions
  //     dot + counts cluster. These travel together as one tap target.
  //   - TRAILING (right, pinned): gear icon, sibling Pressable with its
  //     own touch target. Anchored to the row's right edge via the outer
  //     wrapper's `justifyContent: 'space-between'`.
  //
  // Two Pressables as SIBLINGS inside a View — not nested — because on
  // Android a Pressable inside a Pressable can break out of the parent's
  // flex row layout and stack vertically. The outer View must claim
  // `width: '100%'` so `space-between` has a fixed width to distribute
  // across (otherwise it shrink-wraps to content and there's no slack).
  return (
    <View
      style={{
        width: "100%",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      {/* Leading group — deck name + counts together. flexShrink so the
       * name can truncate with `…` on narrow rows rather than overflow
       * onto a second line. */}
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        style={({ pressed }) => ({
          flexShrink: 1,
          minWidth: 0,
          paddingVertical: 14,
          paddingLeft: 8,
          paddingRight: 8,
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: pressed ? t.pressHighlight : "transparent",
        })}
      >
        <View
          style={{
            flexShrink: 1,
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
        {/* Counts cluster (new / learning / review). Sits snug to the
         * right of the deck name so the whole leading group reads as
         * one logical block. `flexShrink: 0` — numbers never collapse;
         * the name yields first. */}
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
              color: deck.reviewCount > 0 ? t.success : t.textDimmed,
            }}
          >
            {deck.reviewCount}
          </Text>
        </View>
      </Pressable>
      {/* Trailing — gear pinned at the row's right edge. `space-between`
       * on the outer wrapper pushes this sibling all the way right
       * regardless of how wide the leading group is. */}
      <Pressable
        onPress={onSettings}
        hitSlop={10}
        style={({ pressed }) => ({
          flexShrink: 0,
          marginRight: 4,
          paddingHorizontal: 8,
          paddingVertical: 14,
          borderRadius: 8,
          backgroundColor: pressed ? t.pressHighlight : "transparent",
        })}
        accessibilityLabel={`Settings for ${deck.deckName}`}
      >
        <Text style={{ fontSize: 18, color: t.textSecondary }}>{"⚙"}</Text>
      </Pressable>
    </View>
  );
}
