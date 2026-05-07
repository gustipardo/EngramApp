import { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Switch,
  Platform,
  StatusBar,
  Modal,
  TextInput,
  KeyboardAvoidingView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { ankiBridge } from '../../native/ankiBridge';
import { requiresPayment, requiresAuth } from '../../config/env';
import { checkTrialStatus, type TrialStatus } from '../../services/trialService';
import { signOut } from '../../services/authService';
import { AnalyticsEvents } from '../../services/analytics';
import type { DeckInfo } from '../../types/anki';
import { palette } from '../../theme/colors';
import { EngramWordmark } from '../../components/EngramWordmark';

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
  pressHighlight: string;
  switchTrackOff: string;
  switchTrackOn: string;
  switchThumbOff: string;
  switchThumbOn: string;
  errorCircleBg: string;
  warnCircleBg: string;
  trialBannerBg: string;
  trialBannerText: string;
  statusBar: 'light-content' | 'dark-content';
}

const darkTheme: Theme = {
  bg:             palette.navy[900],
  surface:        palette.navy[850],
  text:           palette.navy[50],
  textSecondary:  palette.navy[200],
  textDimmed:     palette.navy[400],
  textOnAccent:   palette.navy[900],
  border:         palette.navy[700],
  accent:         palette.amber[500],
  success:        palette.sage[500],
  error:          palette.terracota[500],
  pressHighlight: palette.navy[700],
  switchTrackOff: palette.navy[400],
  switchTrackOn:  palette.amber[700],
  switchThumbOff: palette.navy[200],
  switchThumbOn:  palette.amber[300],
  errorCircleBg:  'rgba(198, 123, 92, 0.18)',
  warnCircleBg:   'rgba(228, 161, 63, 0.18)',
  trialBannerBg:  'rgba(228, 161, 63, 0.12)',
  trialBannerText: palette.amber[300],
  statusBar:      'light-content',
};

const lightTheme: Theme = {
  bg:             palette.paper[100],
  surface:        palette.paper[50],
  text:           palette.navy[850],
  textSecondary:  palette.navy[600],
  textDimmed:     palette.navy[300],
  textOnAccent:   palette.paper[100],
  border:         palette.paper[500],
  accent:         palette.amber[700],
  success:        palette.sage[700],
  error:          palette.terracota[700],
  pressHighlight: palette.paper[300],
  switchTrackOff: palette.paper[500],
  switchTrackOn:  palette.amber[300],
  switchThumbOff: palette.paper[50],
  switchThumbOn:  palette.amber[700],
  errorCircleBg:  'rgba(165, 90, 61, 0.14)',
  warnCircleBg:   'rgba(184, 120, 38, 0.14)',
  trialBannerBg:  'rgba(184, 120, 38, 0.10)',
  trialBannerText: palette.amber[800],
  statusBar:      'dark-content',
};

type LoadingState = 'loading' | 'loaded' | 'error' | 'empty';

export default function DeckSelectScreen() {
  const router = useRouter();
  const setSelectedDeck = useSettingsStore((s) => s.setSelectedDeck);
  const alwaysReadBack = useSettingsStore((s) => s.alwaysReadBack);
  const setAlwaysReadBack = useSettingsStore((s) => s.setAlwaysReadBack);
  const darkMode = useSettingsStore((s) => s.darkMode);
  const toggleDarkMode = useSettingsStore((s) => s.toggleDarkMode);
  const deckInstructions = useSettingsStore((s) => s.deckInstructions);
  const setDeckInstructions = useSettingsStore((s) => s.setDeckInstructions);

  const [decks, setDecks] = useState<DeckInfo[]>([]);
  const [loadingState, setLoadingState] = useState<LoadingState>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [trialStatus, setTrialStatus] = useState<TrialStatus | null>(null);
  const [instructionsModal, setInstructionsModal] = useState<{ deckName: string; text: string } | null>(null);

  const t = darkMode ? darkTheme : lightTheme;

  const loadDecks = useCallback(async () => {
    try {
      const deckInfos = await ankiBridge.getDeckInfo();

      if (deckInfos.length === 0) {
        setLoadingState('empty');
        setDecks([]);
        return;
      }

      setDecks(deckInfos);
      setLoadingState('loaded');
    } catch (error) {
      console.error('Failed to load decks:', error);
      setLoadingState('error');
    }
  }, []);

  useEffect(() => {
    loadDecks();
    if (requiresPayment()) {
      checkTrialStatus()
        .then(setTrialStatus)
        .catch((err) => console.warn('Trial check failed:', err));
    }
  }, [loadDecks]);

  async function handleRefresh() {
    setRefreshing(true);
    await loadDecks();
    setRefreshing(false);
  }

  async function handleSignOut() {
    try {
      await signOut();
      useSettingsStore.getState().setOnboardingCompleted(false);
      router.replace('/(onboarding)');
    } catch (err) {
      console.error('Sign-out failed:', err);
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
      console.error('Sync failed:', error);
      setSyncing(false);
    }
  }

  function handleSelectDeck(deckName: string) {
    // Block session start if trial expired and no subscription
    if (trialStatus && !trialStatus.isActive && !trialStatus.subscriptionActive) {
      AnalyticsEvents.paywallShown('trial_expired');
      router.push('/(main)/paywall');
      return;
    }

    AnalyticsEvents.deckSelected(deckName);
    setSelectedDeck(deckName);
    router.push('/(main)/session');
  }

  // -----------------------------------------------------------------------
  // Loading
  // -----------------------------------------------------------------------
  if (loadingState === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg }}>
        <StatusBar barStyle={t.statusBar} backgroundColor={t.bg} />
        <ActivityIndicator size="large" color={t.accent} />
        <Text style={{ color: t.text, fontWeight: '600', fontSize: 16, marginTop: 16 }}>
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
  if (loadingState === 'error') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg, paddingHorizontal: 32 }}>
        <StatusBar barStyle={t.statusBar} backgroundColor={t.bg} />
        <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: t.errorCircleBg, alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
          <Text style={{ fontSize: 28, fontWeight: '800', color: t.error }}>!</Text>
        </View>
        <Text style={{ fontSize: 20, fontWeight: '700', color: t.text, textAlign: 'center', marginBottom: 8 }}>
          Cannot Load Decks
        </Text>
        <Text style={{ fontSize: 14, color: t.textSecondary, textAlign: 'center', lineHeight: 22, marginBottom: 32 }}>
          Could not connect to AnkiDroid. Make sure AnkiDroid is installed, running, and permissions are granted.
        </Text>
        <Pressable
          onPress={loadDecks}
          style={{ backgroundColor: t.accent, borderRadius: 16, paddingVertical: 14, paddingHorizontal: 40 }}
        >
          <Text style={{ color: t.textOnAccent, fontSize: 15, fontWeight: '700' }}>Try Again</Text>
        </Pressable>
      </View>
    );
  }

  // -----------------------------------------------------------------------
  // Empty
  // -----------------------------------------------------------------------
  if (loadingState === 'empty') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg, paddingHorizontal: 32 }}>
        <StatusBar barStyle={t.statusBar} backgroundColor={t.bg} />
        <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: t.warnCircleBg, alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
          <Text style={{ fontSize: 28, fontWeight: '800', color: t.accent }}>0</Text>
        </View>
        <Text style={{ fontSize: 20, fontWeight: '700', color: t.text, textAlign: 'center', marginBottom: 8 }}>
          No Decks Found
        </Text>
        <Text style={{ fontSize: 14, color: t.textSecondary, textAlign: 'center', lineHeight: 22, marginBottom: 32 }}>
          AnkiDroid does not have any decks yet. Create or import some decks in AnkiDroid, then come back.
        </Text>
        <Pressable
          onPress={handleRefresh}
          style={{ backgroundColor: t.accent, borderRadius: 16, paddingVertical: 14, paddingHorizontal: 40 }}
        >
          <Text style={{ color: t.textOnAccent, fontSize: 15, fontWeight: '700' }}>Refresh</Text>
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
          paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) + 12 : 56,
          borderBottomWidth: 1,
          borderBottomColor: t.border,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View>
            <EngramWordmark width={120} color={t.accent} style={{ marginBottom: 2 }} />
            <Text style={{ fontSize: 13, color: t.textSecondary, marginTop: 2 }}>
              {totalDue > 0 ? `${totalDue} cards due` : `${decks.length} decks`}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
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
              <Text style={{ color: t.textSecondary, fontSize: 13, fontWeight: '600' }}>
                {darkMode ? 'Light' : 'Dark'}
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
                <Text style={{ color: t.textSecondary, fontSize: 13, fontWeight: '600' }}>
                  Sign Out
                </Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>

      {/* Trial status banner */}
      {trialStatus && trialStatus.isActive && !trialStatus.subscriptionActive && (
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
          <Text style={{ fontSize: 13, fontWeight: '600', color: t.trialBannerText }}>
            Free trial: {trialStatus.daysRemaining} days / {trialStatus.sessionsRemaining} sessions remaining
          </Text>
        </View>
      )}

      {/* Settings row */}
      <View
        style={{
          marginHorizontal: 16,
          marginTop: 12,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          backgroundColor: t.surface,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.border,
          paddingHorizontal: 16,
          paddingVertical: 12,
        }}
      >
        <View style={{ flex: 1, marginRight: 12 }}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: t.text }}>Always read answer</Text>
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
          overflow: 'hidden',
          flex: 1,
          paddingHorizontal: 12,
        }}
      >
        <FlatList
          data={decks}
          keyExtractor={(item) => item.deckName}
          contentContainerStyle={{ paddingBottom: 16 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={t.textSecondary} />
          }
          ItemSeparatorComponent={() => (
            <View style={{ height: 1, backgroundColor: t.border }} />
          )}
          renderItem={({ item }) => (
            <DeckRow
              deck={item}
              onPress={() => handleSelectDeck(item.deckName)}
              onLongPress={() =>
                setInstructionsModal({
                  deckName: item.deckName,
                  text: deckInstructions[item.deckName] || '',
                })
              }
              hasInstructions={!!deckInstructions[item.deckName]}
              theme={t}
            />
          )}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', paddingVertical: 32 }}>
              <Text style={{ color: t.textSecondary }}>No decks available</Text>
            </View>
          }
        />
      </View>

      {/* Hint text */}
      <View style={{ paddingHorizontal: 20, paddingBottom: 12 }}>
        <Text style={{ fontSize: 11, color: t.textDimmed, textAlign: 'center' }}>
          Long press a deck to customize tutor instructions
        </Text>
      </View>

      {/* Custom instructions modal */}
      {instructionsModal && (
        <Modal
          visible
          transparent
          animationType="slide"
          onRequestClose={() => setInstructionsModal(null)}
        >
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={{ flex: 1, justifyContent: 'flex-end' }}
          >
            <Pressable
              style={{ flex: 1 }}
              onPress={() => setInstructionsModal(null)}
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
              }}
            >
              <Text style={{ fontSize: 17, fontWeight: '700', color: t.text, marginBottom: 4 }}>
                Tutor Instructions
              </Text>
              <Text style={{ fontSize: 13, color: t.textSecondary, marginBottom: 16 }}>
                {instructionsModal.deckName}
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
                  minHeight: 120,
                  textAlignVertical: 'top',
                }}
                multiline
                placeholder="E.g.: The back has a Core Answer and a Conceptual Answer. Only test me on the Core Answer, but read aloud the Conceptual Answer after each card."
                placeholderTextColor={t.textDimmed}
                value={instructionsModal.text}
                onChangeText={(text) =>
                  setInstructionsModal((prev) => prev && { ...prev, text })
                }
                autoFocus
              />
              <View style={{ flexDirection: 'row', gap: 12, marginTop: 16 }}>
                <Pressable
                  onPress={() => setInstructionsModal(null)}
                  style={{
                    flex: 1,
                    paddingVertical: 12,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: t.border,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ color: t.textSecondary, fontWeight: '600', fontSize: 14 }}>
                    Cancel
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setDeckInstructions(instructionsModal.deckName, instructionsModal.text);
                    setInstructionsModal(null);
                  }}
                  style={{
                    flex: 1,
                    paddingVertical: 12,
                    borderRadius: 12,
                    backgroundColor: t.accent,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ color: t.textOnAccent, fontWeight: '700', fontSize: 14 }}>Save</Text>
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
  hasInstructions,
  theme: t,
}: {
  deck: DeckInfo;
  onPress: () => void;
  onLongPress: () => void;
  hasInstructions: boolean;
  theme: Theme;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => ({
        paddingVertical: 14,
        paddingHorizontal: 8,
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: pressed ? t.pressHighlight : 'transparent',
      })}
    >
      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text
          style={{ flexShrink: 1, fontSize: 16, fontWeight: '700', color: t.text }}
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
            }}
          />
        )}
      </View>
      <View style={{ flexDirection: 'row', marginLeft: 12 }}>
        <Text
          style={{
            minWidth: 28,
            textAlign: 'right',
            fontSize: 13,
            fontWeight: '600',
            color: deck.newCount > 0 ? t.accent : t.textDimmed,
          }}
        >
          {deck.newCount}
        </Text>
        <Text
          style={{
            minWidth: 28,
            textAlign: 'right',
            fontSize: 13,
            fontWeight: '600',
            marginLeft: 6,
            color: deck.learnCount > 0 ? t.error : t.textDimmed,
          }}
        >
          {deck.learnCount}
        </Text>
        <Text
          style={{
            minWidth: 28,
            textAlign: 'right',
            fontSize: 13,
            fontWeight: '600',
            marginLeft: 6,
            color: deck.reviewCount > 0 ? t.success : t.textDimmed,
          }}
        >
          {deck.reviewCount}
        </Text>
      </View>
    </Pressable>
  );
}
