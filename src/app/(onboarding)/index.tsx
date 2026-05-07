import { useEffect, useState } from 'react';
import { View, Text, Pressable, Linking, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { ankiBridge } from '../../native/ankiBridge';
import { dark as t } from '../../theme/colors';
import { EngramWordmark } from '../../components/EngramWordmark';

const ANKIDROID_PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.ichi2.anki';

type DetectionState = 'checking' | 'installed' | 'not-installed';

export default function AnkiDroidDetectionScreen() {
  const router = useRouter();
  const [detectionState, setDetectionState] = useState<DetectionState>('checking');

  useEffect(() => {
    checkAnkiDroidInstallation();
  }, []);

  async function checkAnkiDroidInstallation() {
    setDetectionState('checking');
    const t0 = Date.now();
    const isInstalled = await ankiBridge.isInstalled();
    console.log(`[onboarding] ankiBridge.isInstalled() took ${Date.now() - t0}ms → ${isInstalled}`);
    setDetectionState(isInstalled ? 'installed' : 'not-installed');
  }

  function handleContinue() {
    router.push('/(onboarding)/permissions');
  }

  function handleOpenPlayStore() {
    Linking.openURL(ANKIDROID_PLAY_STORE_URL);
  }

  if (detectionState === 'checking') {
    return (
      <View style={S.center}>
        <EngramWordmark width={140} style={{ marginBottom: 32, opacity: 0.85 }} />
        <ActivityIndicator size="large" color={t.accent.default} />
        <Text style={{ marginTop: 16, fontSize: 16, color: t.text.secondary }}>
          Checking for AnkiDroid...
        </Text>
      </View>
    );
  }

  if (detectionState === 'installed') {
    return (
      <View style={S.center}>
        <EngramWordmark width={160} style={{ marginBottom: 40 }} />
        <View style={[S.statusCircle, { backgroundColor: t.success.subtleBg }]}>
          <Text style={{ fontSize: 44, color: t.success.text }}>✓</Text>
        </View>
        <Text style={S.title}>AnkiDroid Detected</Text>
        <Text style={S.body}>
          Great. AnkiDroid is installed on your device. Set up the connection so you can study your cards with voice.
        </Text>
        <Pressable onPress={handleContinue} style={S.primaryBtn}>
          <Text style={S.primaryBtnText}>Continue</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={S.center}>
      <EngramWordmark width={160} style={{ marginBottom: 40 }} />
      <View style={[S.statusCircle, { backgroundColor: t.accent.subtleBg }]}>
        <Text style={{ fontSize: 36, color: t.accent.default }}>!</Text>
      </View>
      <Text style={S.title}>AnkiDroid Required</Text>
      <Text style={S.body}>
        Engram works on top of AnkiDroid to study your flashcards through voice. Install AnkiDroid first, then come back.
      </Text>
      <Pressable onPress={handleOpenPlayStore} style={[S.primaryBtn, { marginBottom: 12 }]}>
        <Text style={S.primaryBtnText}>Install AnkiDroid</Text>
      </Pressable>
      <Pressable onPress={checkAnkiDroidInstallation} style={S.secondaryBtn}>
        <Text style={S.secondaryBtnText}>I've installed it</Text>
      </Pressable>
    </View>
  );
}

const S = {
  center: {
    flex: 1,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    backgroundColor: t.bg.base,
    paddingHorizontal: 24,
  },
  statusCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    marginBottom: 24,
  },
  title: {
    marginBottom: 8,
    textAlign: 'center' as const,
    fontSize: 26,
    fontWeight: '700' as const,
    color: t.text.primary,
    letterSpacing: -0.4,
  },
  body: {
    marginBottom: 32,
    textAlign: 'center' as const,
    fontSize: 15,
    color: t.text.secondary,
    lineHeight: 22,
  },
  primaryBtn: {
    width: '100%' as const,
    borderRadius: 12,
    paddingHorizontal: 24,
    paddingVertical: 16,
    backgroundColor: t.accent.default,
  },
  primaryBtnText: {
    textAlign: 'center' as const,
    fontSize: 16,
    fontWeight: '700' as const,
    color: t.text.onAccent,
  },
  secondaryBtn: {
    width: '100%' as const,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: t.border.strong,
    paddingHorizontal: 24,
    paddingVertical: 16,
  },
  secondaryBtnText: {
    textAlign: 'center' as const,
    fontSize: 16,
    fontWeight: '600' as const,
    color: t.text.primary,
  },
} as const;
