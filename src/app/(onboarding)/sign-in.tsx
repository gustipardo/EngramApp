import { useState } from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { signInWithGoogle } from '../../services/authService';
import { AnalyticsEvents } from '../../services/analytics';
import { dark as t } from '../../theme/colors';
import { EngramWordmark } from '../../components/EngramWordmark';

export default function SignInScreen() {
  const router = useRouter();
  const setOnboardingCompleted = useSettingsStore((s) => s.setOnboardingCompleted);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGoogleSignIn() {
    setIsSigningIn(true);
    setError(null);
    AnalyticsEvents.signupStarted();

    try {
      await signInWithGoogle();
      AnalyticsEvents.signupCompleted('google');
      setOnboardingCompleted(true);
      router.replace('/(main)/deck-select');
    } catch (err: any) {
      console.error('Sign-in failed:', err);
      setError(err.message || 'Sign-in failed. Please try again.');
    } finally {
      setIsSigningIn(false);
    }
  }

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg.base, paddingHorizontal: 24 }}>
      <View style={{ marginBottom: 40, alignItems: 'center' }}>
        <EngramWordmark width={200} style={{ marginBottom: 24 }} />
        <Text style={{ marginBottom: 8, textAlign: 'center', fontSize: 16, color: t.text.secondary, lineHeight: 24, maxWidth: 320 }}>
          Study your flashcards with a voice tutor that adapts to how you actually answer.
        </Text>
        <Text style={{ marginTop: 8, textAlign: 'center', fontSize: 13, color: t.text.tertiary }}>
          Sign in to start your 7-day free trial
        </Text>
      </View>

      {error && (
        <View style={{ marginBottom: 16, width: '100%', borderRadius: 10, padding: 12, backgroundColor: t.error.subtleBg }}>
          <Text style={{ textAlign: 'center', fontSize: 13, color: t.error.text }}>{error}</Text>
        </View>
      )}

      <Pressable
        onPress={handleGoogleSignIn}
        disabled={isSigningIn}
        style={({ pressed }) => ({
          width: '100%',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 12,
          paddingHorizontal: 24,
          paddingVertical: 16,
          backgroundColor: isSigningIn
            ? t.bg.surface3
            : pressed
            ? t.accent.pressed
            : t.accent.default,
        })}
      >
        {isSigningIn ? (
          <ActivityIndicator size="small" color={t.text.onAccent} />
        ) : (
          <Text style={{ textAlign: 'center', fontSize: 16, fontWeight: '700', color: t.text.onAccent }}>
            Sign in with Google
          </Text>
        )}
      </Pressable>
    </View>
  );
}
