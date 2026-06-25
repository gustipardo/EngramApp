import { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, Pressable, ActivityIndicator, Animated, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useConnectionStore } from '../../stores/useConnectionStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useCardCacheStore } from '../../stores/useCardCacheStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useAudioLevelStore } from '../../stores/useAudioLevelStore';
import { sessionManager } from '../../services/sessionManager';
import { palette } from '../../theme/colors';

// ---------------------------------------------------------------------------
// Local theme palette
// ---------------------------------------------------------------------------
// Tailwind/NativeWind in this project resolves color classes to fixed hex
// values (`bg-bg-base` is hardcoded navy-900), so it cannot follow the
// user's runtime darkMode toggle. The session screen used to import the
// dark palette directly and render in dark even when the user picked
// light. We mirror the deck-select.tsx pattern: pick the palette from
// `useSettingsStore.darkMode` and apply colors via inline `style` rather
// than Tailwind classes. Layout-only classes (flex / padding / size) stay
// as className.
interface Theme {
  bgBase: string;
  bgSurface1: string;
  bgSurface2: string;
  bgSurface3: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textOnAccent: string;
  accent: string;
  accentPressed: string;
  accentSoft: string;       // 10%-tinted accent for chip backgrounds
  success: string;
  successText: string;
  successSoft: string;      // 10%-tinted success for chip backgrounds
  error: string;
  errorText: string;
  errorPressed: string;
  errorSoft: string;        // 10%-tinted error for chip backgrounds
  amberSoft: string;        // 15%-tinted amber for paused/reconnecting chips
  amberText: string;
  border: string;
  micMeterBg: string;
  micBarInactive: string;
}

// Aligned with `_design/03-tokens/tokens-rn.ts` (the design system's
// semantic theme objects). Values that don't have an exact semantic in
// the design system (e.g. `accentSoft` for tinted button backgrounds,
// `micMeterBg`) are derived locally with the same hue family.
const darkTheme: Theme = {
  bgBase:         palette.navy[900],
  bgSurface1:     palette.navy[850],
  bgSurface2:     palette.navy[800],
  bgSurface3:     palette.navy[700],
  textPrimary:    palette.navy[50],
  textSecondary:  palette.navy[200],
  textTertiary:   palette.navy[300],
  textOnAccent:   palette.navy[900],
  accent:         palette.amber[500],
  accentPressed:  palette.amber[600],
  accentSoft:     'rgba(228, 161, 63, 0.12)',
  success:        palette.sage[500],
  successText:    palette.sage[300],
  successSoft:    'rgba(107, 155, 126, 0.12)',
  error:          palette.terracota[500],
  errorText:      palette.terracota[300],
  errorPressed:   palette.terracota[700],
  errorSoft:      'rgba(198, 123, 92, 0.14)',
  amberSoft:      'rgba(228, 161, 63, 0.15)',
  amberText:      palette.amber[300],
  border:         palette.navy[600],
  micMeterBg:     palette.navy[800],
  micBarInactive: palette.navy[400],
};

const lightTheme: Theme = {
  bgBase:         palette.paper[100],   // base — `bg.base` in design
  bgSurface1:     palette.paper[200],   // surface1 — creamier than base; the design system explicitly uses paper[200] not paper[50] for surface1, which was the contrast bug landed in the first refactor
  bgSurface2:     palette.paper[300],
  bgSurface3:     palette.paper[400],
  textPrimary:    palette.navy[850],
  textSecondary:  palette.navy[600],
  textTertiary:   palette.navy[300],
  textOnAccent:   palette.paper[100],   // text.onAccent / onError per design
  accent:         palette.amber[700],
  accentPressed:  palette.amber[900],
  accentSoft:     'rgba(184, 120, 38, 0.10)',
  success:        palette.sage[700],
  successText:    palette.sage[700],
  successSoft:    'rgba(74, 123, 92, 0.10)',
  error:          palette.terracota[700],
  errorText:      palette.terracota[700],
  errorPressed:   palette.terracota[700],
  errorSoft:      'rgba(165, 90, 61, 0.10)',
  amberSoft:      'rgba(184, 120, 38, 0.15)',
  amberText:      palette.amber[800],
  border:         palette.paper[500],
  micMeterBg:     palette.paper[200],
  micBarInactive: palette.paper[500],
};

function useTheme(): Theme {
  const darkMode = useSettingsStore((s) => s.darkMode);
  return darkMode ? darkTheme : lightTheme;
}

// ---------------------------------------------------------------------------
// Pulsing mic indicator component
// ---------------------------------------------------------------------------
function PulsingIndicator({ active, color }: { active: boolean; color: string }) {
  const t = useTheme();
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (active) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.25, duration: 800, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
        ]),
      );
      loop.start();
      return () => loop.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [active]);

  // The color the indicator should show depends on the current phase, not
  // on dark/light mode — the semantic mapping below stays put.
  const colorHexMap: Record<string, string> = {
    blue: t.accent,
    green: t.success,
    amber: t.amberText,
    red: t.error,
    gray: t.textTertiary,
  };

  const bgColor = colorHexMap[color] ?? t.accent;

  return (
    <View className="items-center justify-center" style={{ width: 56, height: 56 }}>
      {active && (
        <Animated.View
          style={{
            position: 'absolute',
            height: 56,
            width: 56,
            borderRadius: 28,
            backgroundColor: bgColor,
            opacity: 0.25,
            transform: [{ scale: pulseAnim }],
          }}
        />
      )}
      <View
        className="items-center justify-center rounded-full"
        style={{ height: 48, width: 48, backgroundColor: bgColor }}
      >
        <Text style={{ fontSize: 20, color: t.textOnAccent }}>{getPhaseIcon(color)}</Text>
      </View>
    </View>
  );
}

function getPhaseIcon(color: string): string {
  switch (color) {
    case 'blue': return '\u{1F50A}';   // speaker
    case 'green': return '\u{1F3A4}';  // mic
    case 'amber': return '\u{2026}';   // ellipsis
    default: return '\u{1F4AC}';       // speech
  }
}

// ---------------------------------------------------------------------------
// Connection badge
// ---------------------------------------------------------------------------
function ConnectionBadge() {
  const t = useTheme();
  const connectionState = useConnectionStore((s) => s.connectionState);
  const networkStatus = useConnectionStore((s) => s.networkStatus);

  const isOnline = networkStatus === 'online';
  const isConnected = connectionState === 'connected';
  const isReconnecting = connectionState === 'reconnecting';

  let dotColor = t.success;
  let label = 'Connected';

  if (!isOnline) {
    dotColor = t.error;
    label = 'Offline';
  } else if (isReconnecting) {
    dotColor = t.accent;
    label = 'Reconnecting...';
  } else if (!isConnected) {
    dotColor = t.textTertiary;
    label = 'Disconnected';
  }

  return (
    <View
      className="flex-row items-center rounded-full px-3 py-1.5"
      style={{ backgroundColor: t.bgSurface2 }}
    >
      <View
        className="mr-2 rounded-full"
        style={{ height: 10, width: 10, backgroundColor: dotColor }}
      />
      <Text className="text-xs font-medium" style={{ color: t.textSecondary }}>{label}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Audio level meter — real RMS amplitude from PCM chunks
// (audioLevelTracker decodes base64 PCM16, computes RMS, smooths it)
// ---------------------------------------------------------------------------
function AudioLevelMeter() {
  const t = useTheme();
  const level = useAudioLevelStore((s) => s.level);
  const peakDb = useAudioLevelStore((s) => s.peakDb);
  const chunksReceived = useAudioLevelStore((s) => s.chunksReceived);
  const isListening = useAudioLevelStore((s) => s.isListening);

  // Heuristics for the status label (tuned for built-in phone mics).
  // Below -55 dB is essentially silence; above -25 dB is solid speech.
  let label = 'Silent';
  if (!isListening || chunksReceived === 0) label = 'No mic data';
  else if (peakDb > -25) label = 'Audio OK';
  else if (peakDb > -45) label = 'Quiet';

  const activeColor = level > 0.05 ? t.success : t.error;
  const dbDisplay = isFinite(peakDb) ? `${peakDb.toFixed(0)} dB` : '—';
  const barCount = 12;

  return (
    <View
      className="flex-row items-center rounded-lg px-3 py-2"
      style={{ backgroundColor: t.micMeterBg }}
    >
      <View className="flex-row items-end mr-2" style={{ height: 22 }}>
        {Array.from({ length: barCount }).map((_, i) => {
          const threshold = i / barCount;
          const isActive = level > threshold;
          return (
            <View
              key={i}
              style={{
                width: 3,
                height: 4 + (i * 1.5),
                marginHorizontal: 1,
                borderRadius: 1,
                backgroundColor: isActive ? activeColor : t.micBarInactive,
              }}
            />
          );
        })}
      </View>
      <Text className="text-xs font-mono" style={{ color: activeColor }}>
        {label} ({dbDisplay})
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Progress ring (simple bar alternative showing fraction)
// ---------------------------------------------------------------------------
function ProgressHeader({
  currentIndex,
  totalCards,
  stats,
}: {
  currentIndex: number;
  totalCards: number;
  stats: { correct: number; incorrect: number };
}) {
  const t = useTheme();
  const progress = totalCards > 0 ? (currentIndex / totalCards) * 100 : 0;

  return (
    <View>
      {/* Progress bar */}
      <View className="w-full" style={{ height: 6, backgroundColor: t.bgSurface3 }}>
        <View
          style={{
            height: 6,
            borderTopRightRadius: 9999,
            borderBottomRightRadius: 9999,
            backgroundColor: t.accent,
            width: `${progress}%`,
          }}
        />
      </View>

      {/* Stats row */}
      <View className="flex-row items-center justify-between px-5 py-2.5">
        <Text className="text-xs font-medium" style={{ color: t.textTertiary }}>
          {currentIndex} / {totalCards} cards
        </Text>
        <View className="flex-row items-center">
          <View className="flex-row items-center mr-4">
            <View
              className="mr-1.5 rounded-full"
              style={{ height: 10, width: 10, backgroundColor: t.success }}
            />
            <Text className="text-xs font-bold" style={{ color: t.successText }}>{stats.correct}</Text>
          </View>
          <View className="flex-row items-center">
            <View
              className="mr-1.5 rounded-full"
              style={{ height: 10, width: 10, backgroundColor: t.error }}
            />
            <Text className="text-xs font-bold" style={{ color: t.errorText }}>{stats.incorrect}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Evaluation banner — slides in from top showing correct/incorrect
// ---------------------------------------------------------------------------
function EvaluationBanner() {
  const t = useTheme();
  const lastEvaluation = useSessionStore((s) => s.lastEvaluation);
  const [visible, setVisible] = useState(false);
  const [displayEval, setDisplayEval] = useState<'correct' | 'incorrect' | null>(null);
  const slideAnim = useRef(new Animated.Value(-60)).current;

  useEffect(() => {
    if (lastEvaluation) {
      setDisplayEval(lastEvaluation);
      setVisible(true);
      Animated.spring(slideAnim, {
        toValue: 0,
        friction: 8,
        tension: 100,
        useNativeDriver: true,
      }).start();

      const timer = setTimeout(() => {
        Animated.timing(slideAnim, {
          toValue: -60,
          duration: 250,
          useNativeDriver: true,
        }).start(() => {
          setVisible(false);
          useSessionStore.setState({ lastEvaluation: null });
        });
      }, 3500);

      return () => clearTimeout(timer);
    }
  }, [lastEvaluation]);

  if (!visible || !displayEval) return null;

  const isCorrect = displayEval === 'correct';
  // Banner text always reads against an accent (success/error) fill, so
  // the "on accent" color from the active theme is the right choice.
  const onAccent = t.textOnAccent;

  return (
    <Animated.View
      style={{
        transform: [{ translateY: slideAnim }],
        backgroundColor: isCorrect ? t.success : t.error,
        paddingVertical: 10,
        paddingHorizontal: 20,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: onAccent, fontSize: 16, fontWeight: '800', marginRight: 8 }}>
        {isCorrect ? '✓' : '✗'}
      </Text>
      <Text style={{ color: onAccent, fontSize: 16, fontWeight: '700' }}>
        {isCorrect ? 'Correct' : 'Incorrect'}
      </Text>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Main session screen
// ---------------------------------------------------------------------------
export default function SessionScreen() {
  const t = useTheme();
  const router = useRouter();
  const connectionState = useConnectionStore((s) => s.connectionState);
  const sessionPhase = useSessionStore((s) => s.phase);
  const stats = useSessionStore((s) => s.stats);
  const totalDueAtStart = useSessionStore((s) => s.totalDueAtStart);
  const selectedDeck = useSettingsStore((s) => s.selectedDeck);
  const cards = useCardCacheStore((s) => s.cards);
  // `uiVisibleIndex` lags `currentIndex` during the AI's feedback turn so
  // the visible card matches what the tutor is still speaking about (BUG 12).
  // The data layer still uses `currentIndex` for write-back + grading.
  const currentIndex = useCardCacheStore((s) => s.uiVisibleIndex);
  const currentCard = cards[currentIndex];

  const [error, setError] = useState<string | null>(null);

  // Card fade-in animation
  const cardFade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (currentCard) {
      cardFade.setValue(0);
      Animated.timing(cardFade, { toValue: 1, duration: 250, useNativeDriver: true }).start();
    }
  }, [currentCard?.cardId]);

  const handleStartSession = useCallback(async () => {
    try {
      setError(null);
      await sessionManager.startSession();
    } catch (err: any) {
      setError(err.message || 'Failed to start session');
    }
  }, []);

  const handleEndSession = useCallback(() => {
    sessionManager.endSession();
    router.back();
  }, [router]);

  const handleRetry = useCallback(() => {
    setError(null);
    handleStartSession();
  }, [handleStartSession]);

  // Auto-start session on mount
  useEffect(() => {
    if (sessionPhase === 'idle') {
      handleStartSession();
    }

    return () => {
      if (sessionPhase !== 'idle' && sessionPhase !== 'session_complete') {
        sessionManager.endSession();
      }
    };
  }, []);

  // -------------------------------------------------------------------------
  // Loading states
  // -------------------------------------------------------------------------
  if (sessionPhase === 'connecting' || sessionPhase === 'loading_cards') {
    return (
      <View className="flex-1 items-center justify-center px-8" style={{ backgroundColor: t.bgBase }}>
        <View
          className="mb-6 items-center justify-center rounded-full"
          style={{ height: 80, width: 80, backgroundColor: t.accentSoft }}
        >
          <ActivityIndicator size="large" color={t.accent} />
        </View>
        <Text className="text-center text-xl font-bold" style={{ color: t.textPrimary }}>
          {sessionPhase === 'connecting' ? 'Connecting to AI Tutor' : 'Loading Cards'}
        </Text>
        <Text className="mt-2 text-center text-sm" style={{ color: t.textTertiary }}>
          {sessionPhase === 'connecting'
            ? 'Setting up your voice session...'
            : `Fetching cards from ${selectedDeck}...`}
        </Text>
      </View>
    );
  }

  // -------------------------------------------------------------------------
  // Error state
  // -------------------------------------------------------------------------
  if (sessionPhase === 'error' || error) {
    return (
      <View className="flex-1 items-center justify-center px-8" style={{ backgroundColor: t.bgBase }}>
        <View
          className="mb-5 items-center justify-center rounded-full"
          style={{ height: 80, width: 80, backgroundColor: t.errorSoft }}
        >
          <Text className="text-3xl font-bold" style={{ color: t.errorText }}>!</Text>
        </View>
        <Text className="mb-2 text-center text-xl font-bold" style={{ color: t.textPrimary }}>
          Something Went Wrong
        </Text>
        <Text className="mb-8 text-center text-base leading-relaxed" style={{ color: t.textTertiary }}>
          {error || 'An unexpected error occurred. Please try again.'}
        </Text>
        <View className="w-full">
          <Pressable
            onPress={handleRetry}
            className="mb-3 rounded-2xl py-4"
            style={{ backgroundColor: t.accent }}
            android_ripple={{ color: t.accentPressed }}
          >
            <Text className="text-center text-base font-bold" style={{ color: t.textOnAccent }}>Try Again</Text>
          </Pressable>
          <Pressable
            onPress={handleEndSession}
            className="rounded-2xl py-4"
            style={{
              borderWidth: 2,
              borderColor: t.border,
              // bgSurface2 (paper[300] in light) is distinct enough from
              // bgBase (paper[100]) that this outline button stays visible
              // on near-white screens. Static object-form style — the
              // function-form `({ pressed }) => …` was being dropped by
              // NativeWind v4 when combined with `className`, so the
              // background fell through to the parent View's surface color
              // (white on light, black on dark). Replaced with object +
              // android_ripple for press feedback.
              backgroundColor: t.bgSurface2,
            }}
            android_ripple={{ color: t.bgBase }}
          >
            <Text className="text-center text-base font-semibold" style={{ color: t.textSecondary }}>Go Back</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // -------------------------------------------------------------------------
  // Session complete state
  // -------------------------------------------------------------------------
  if (sessionPhase === 'session_complete') {
    const total = stats.correct + stats.incorrect;
    const percentage = total > 0 ? Math.round((stats.correct / total) * 100) : 0;

    return (
      <View className="flex-1 px-6 pt-20" style={{ backgroundColor: t.bgBase }}>
        {/* Top illustration */}
        <View className="items-center">
          <View
            className="mb-5 items-center justify-center rounded-full"
            style={{ height: 96, width: 96, backgroundColor: t.successSoft }}
          >
            <Text className="text-center text-4xl font-bold" style={{ color: t.successText }}>{'✓'}</Text>
          </View>
          <Text className="mb-1 text-center text-2xl font-bold" style={{ color: t.textPrimary }}>
            Session Complete
          </Text>
          <Text className="mb-8 text-center text-base" style={{ color: t.textTertiary }}>
            {selectedDeck}
          </Text>
        </View>

        {/* Stats card */}
        <View
          className="rounded-2xl p-5"
          style={{ borderWidth: 1, borderColor: t.border, backgroundColor: t.bgSurface1 }}
        >
          {/* Accuracy ring placeholder */}
          <View className="mb-5 items-center">
            <View
              className="items-center justify-center rounded-full"
              style={{
                height: 96, width: 96,
                borderWidth: 4, borderColor: t.accent,
                backgroundColor: t.accentSoft,
              }}
            >
              <Text className="text-2xl font-bold" style={{ color: t.accent }}>{percentage}%</Text>
            </View>
            <Text className="mt-2 text-sm font-medium" style={{ color: t.textTertiary }}>Accuracy</Text>
          </View>

          <View className="flex-row justify-around">
            <View className="items-center">
              <Text className="text-2xl font-bold" style={{ color: t.textPrimary }}>{total}</Text>
              <Text className="text-xs font-medium" style={{ color: t.textTertiary }}>Reviewed</Text>
            </View>
            <View className="items-center">
              <Text className="text-2xl font-bold" style={{ color: t.successText }}>{stats.correct}</Text>
              <Text className="text-xs font-medium" style={{ color: t.successText }}>Correct</Text>
            </View>
            <View className="items-center">
              <Text className="text-2xl font-bold" style={{ color: t.errorText }}>{stats.incorrect}</Text>
              <Text className="text-xs font-medium" style={{ color: t.errorText }}>Incorrect</Text>
            </View>
          </View>
        </View>

        {/* Done button */}
        <View className="mt-auto pb-8 pt-6">
          <Pressable
            onPress={handleEndSession}
            className="rounded-2xl py-4"
            style={{ backgroundColor: t.accent }}
            android_ripple={{ color: t.accentPressed }}
          >
            <Text className="text-center text-base font-bold" style={{ color: t.textOnAccent }}>Done</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // -------------------------------------------------------------------------
  // Paused state
  // -------------------------------------------------------------------------
  if (sessionPhase === 'paused') {
    const total = stats.correct + stats.incorrect;
    const isNetworkLoss = connectionState === 'reconnecting' || connectionState === 'failed';

    return (
      <View className="flex-1 items-center justify-center px-8" style={{ backgroundColor: t.bgBase }}>
        <View
          className="mb-5 items-center justify-center rounded-full"
          style={{
            height: 80, width: 80,
            backgroundColor: isNetworkLoss ? t.errorSoft : t.amberSoft,
          }}
        >
          {isNetworkLoss ? (
            <Text className="text-3xl font-bold" style={{ color: t.errorText }}>{'!'}</Text>
          ) : (
            <Text className="text-3xl font-bold" style={{ color: t.amberText }}>{'| |'}</Text>
          )}
        </View>
        <Text className="mb-1 text-center text-2xl font-bold" style={{ color: t.textPrimary }}>
          {isNetworkLoss ? 'Connection Lost' : 'Session Paused'}
        </Text>
        <Text className="mb-3 text-center text-sm" style={{ color: t.textTertiary }}>
          {isNetworkLoss
            ? 'Your network connection was interrupted. The session will resume automatically when the connection is restored.'
            : selectedDeck}
        </Text>

        {/* Connection badge when network lost */}
        {isNetworkLoss && (
          <View className="mb-4">
            <ConnectionBadge />
          </View>
        )}

        {/* Mini stats */}
        {total > 0 && (
          <View className="mb-8 flex-row items-center">
            <View className="mr-6 flex-row items-center">
              <View
                className="mr-1.5 rounded-full"
                style={{ height: 12, width: 12, backgroundColor: t.success }}
              />
              <Text className="text-sm font-semibold" style={{ color: t.textSecondary }}>{stats.correct} correct</Text>
            </View>
            <View className="flex-row items-center">
              <View
                className="mr-1.5 rounded-full"
                style={{ height: 12, width: 12, backgroundColor: t.error }}
              />
              <Text className="text-sm font-semibold" style={{ color: t.textSecondary }}>{stats.incorrect} incorrect</Text>
            </View>
          </View>
        )}

        <View className="w-full">
          {!isNetworkLoss && (
            <Pressable
              onPress={() => sessionManager.resume()}
              className="mb-3 rounded-2xl py-4"
              style={{ backgroundColor: t.accent }}
              android_ripple={{ color: t.accentPressed }}
            >
              <Text className="text-center text-base font-bold" style={{ color: t.textOnAccent }}>Resume Session</Text>
            </Pressable>
          )}
          <Pressable
            onPress={handleEndSession}
            className="rounded-2xl py-4"
            style={
              isNetworkLoss
                ? {
                    // Secondary action — "Cancel reconnect". Outline style.
                    borderWidth: 2,
                    borderColor: t.border,
                    backgroundColor: t.bgSurface2,
                  }
                : {
                    // Destructive action — solid red fill. Matches the active-
                    // session End Session button so the affordance is visually
                    // consistent across screens.
                    backgroundColor: t.error,
                  }
            }
            android_ripple={{ color: isNetworkLoss ? t.bgBase : t.errorPressed }}
          >
            <Text
              className="text-center text-base font-semibold"
              style={{ color: isNetworkLoss ? t.textSecondary : t.textOnAccent }}
            >
              End Session
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // -------------------------------------------------------------------------
  // Reconnecting state (overlay-style)
  // -------------------------------------------------------------------------
  if (sessionPhase === 'reconnecting') {
    return (
      <View className="flex-1 items-center justify-center px-8" style={{ backgroundColor: t.bgBase }}>
        <View
          className="mb-5 items-center justify-center rounded-full"
          style={{ height: 80, width: 80, backgroundColor: t.amberSoft }}
        >
          <ActivityIndicator size="large" color={t.accent} />
        </View>
        <Text className="mb-1 text-center text-xl font-bold" style={{ color: t.textPrimary }}>
          Reconnecting...
        </Text>
        <Text className="mb-8 text-center text-sm" style={{ color: t.textTertiary }}>
          Attempting to restore your session
        </Text>
        <Pressable
          onPress={handleEndSession}
          className="rounded-2xl px-8 py-3"
          style={{
            borderWidth: 2,
            borderColor: t.border,
            backgroundColor: t.bgSurface2,
          }}
          android_ripple={{ color: t.bgBase }}
        >
          <Text className="text-center text-sm font-semibold" style={{ color: t.textSecondary }}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  // -------------------------------------------------------------------------
  // Active session UI
  // -------------------------------------------------------------------------
  const phaseVisual = getPhaseVisual(sessionPhase);

  return (
    <View className="flex-1" style={{ backgroundColor: t.bgBase }}>
      {/* Top bar */}
      <View className="px-5 pb-3 pt-14" style={{ backgroundColor: t.bgSurface1 }}>
        <View className="flex-row items-center justify-between">
          <View className="flex-1 mr-3">
            <Text className="text-lg font-bold" style={{ color: t.textPrimary }} numberOfLines={1}>
              {selectedDeck}
            </Text>
          </View>
          <ConnectionBadge />
        </View>
      </View>

      {/* Progress + stats strip.
        * Denominator is the deck's true due-card count at session start
        * (snapshotted in sessionManager.startSession). The previous
        * denominator — `cards.length` from the in-memory cache — became
        * useless after BUG 5 v3b: the cache now starts at 1 and grows
        * lazily, so the bar always showed "0 / 1" (SESSION-FLOW §4.BUG 11).
        * Fallback to cards.length if the snapshot didn't land (failed
        * getDeckInfo call) so the UI is never blank.
        */}
      <ProgressHeader
        currentIndex={currentIndex}
        totalCards={totalDueAtStart > 0 ? totalDueAtStart : cards.length}
        stats={stats}
      />

      {/* Evaluation banner (correct/incorrect) */}
      <EvaluationBanner />

      {/* Main content */}
      <View className="flex-1 px-5 pt-4">
        {/* Question card */}
        {currentCard && (
          <Animated.View
            style={[
              {
                opacity: cardFade,
                marginBottom: 16,
                borderRadius: 16,
                borderWidth: 1,
                borderColor: t.border,
                backgroundColor: t.bgSurface1,
                padding: 20,
              },
              Platform.OS === 'android' ? { elevation: 1 } : {},
            ]}
          >
            <Text
              className="mb-2 text-xs font-semibold uppercase tracking-widest"
              style={{ color: t.accent }}
            >
              Question
            </Text>
            <Text
              className="text-xl font-bold leading-relaxed"
              style={{ color: t.textPrimary }}
            >
              {currentCard.front}
            </Text>
          </Animated.View>
        )}

        {/* Phase indicator */}
        <View className="mb-4 flex-row items-center">
          <View className="mr-4">
            <PulsingIndicator
              active={sessionPhase === 'awaiting_answer' || sessionPhase === 'asking_question'}
              color={phaseVisual.color}
            />
          </View>
          <View>
            <Text className="text-base font-bold" style={{ color: t.textPrimary }}>
              {phaseVisual.label}
            </Text>
            <Text className="text-xs" style={{ color: t.textTertiary }}>
              {phaseVisual.hint}
            </Text>
          </View>
        </View>

        {/* Audio debug meter */}
        <View className="mb-4">
          <AudioLevelMeter />
        </View>
      </View>

      {/* Bottom controls */}
      <View
        className="px-5 pb-6 pt-3"
        style={[
          { backgroundColor: t.bgSurface1 },
          Platform.OS === 'android' ? { elevation: 2 } : {},
        ]}
      >
        <View className="flex-row">
          <Pressable
            onPress={() => sessionManager.pause()}
            className="mr-3 flex-1 rounded-2xl py-3.5"
            style={{
              borderWidth: 2,
              borderColor: t.border,
              backgroundColor: t.bgSurface3,
            }}
            android_ripple={{ color: t.bgBase }}
          >
            <Text className="text-center text-sm font-bold" style={{ color: t.textSecondary }}>Pause</Text>
          </Pressable>
          <Pressable
            onPress={handleEndSession}
            className="flex-1 rounded-2xl py-3.5"
            style={{ backgroundColor: t.error }}
            android_ripple={{ color: t.errorPressed }}
          >
            <Text className="text-center text-sm font-bold" style={{ color: t.textOnAccent }}>End Session</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PhaseVisual {
  label: string;
  hint: string;
  color: string;
}

function getPhaseVisual(phase: string): PhaseVisual {
  switch (phase) {
    case 'ready':
      return { label: 'Getting Ready', hint: 'Session is starting...', color: 'gray' };
    case 'asking_question':
      return { label: 'Asking Question', hint: 'Listen carefully...', color: 'blue' };
    case 'awaiting_answer':
      return { label: 'Your Turn', hint: 'Speak your answer now', color: 'green' };
    case 'evaluating':
      return { label: 'Evaluating', hint: 'Checking your answer...', color: 'amber' };
    case 'giving_feedback':
      return { label: 'Feedback', hint: 'Listen to the feedback', color: 'blue' };
    case 'advancing':
      return { label: 'Next Card', hint: 'Moving to the next card...', color: 'gray' };
    default:
      return { label: 'Studying', hint: 'Session in progress', color: 'blue' };
  }
}
