import { useEffect, useRef } from 'react';
import { View, Text, Animated } from 'react-native';
import { useSessionStore } from '../stores/useSessionStore';
import { useCardCacheStore } from '../stores/useCardCacheStore';
import { dark as t } from '../theme/colors';

export function CardDisplay() {
  const phase = useSessionStore((s) => s.phase);
  const lastEvaluation = useSessionStore((s) => s.lastEvaluation);
  const cards = useCardCacheStore((s) => s.cards);
  const currentIndex = useCardCacheStore((s) => s.currentIndex);
  const currentCard = cards[currentIndex];

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.9)).current;

  const showEvaluationBadge =
    lastEvaluation !== null &&
    (phase === 'evaluating' || phase === 'giving_feedback');

  const showCorrectAnswer =
    lastEvaluation === 'incorrect' && phase === 'giving_feedback';

  useEffect(() => {
    if (showEvaluationBadge) {
      fadeAnim.setValue(0);
      scaleAnim.setValue(0.9);
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.spring(scaleAnim, {
          toValue: 1,
          friction: 6,
          tension: 120,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [showEvaluationBadge, lastEvaluation]);

  if (!showEvaluationBadge && !showCorrectAnswer) {
    return null;
  }

  const isCorrect = lastEvaluation === 'correct';
  const palette = isCorrect ? t.success : t.error;

  return (
    <Animated.View
      style={{
        opacity: fadeAnim,
        transform: [{ scale: scaleAnim }],
        width: '100%',
        borderRadius: 16,
        borderWidth: 1,
        padding: 20,
        borderColor: palette.default,
        backgroundColor: palette.subtleBg,
      }}
    >
      {showEvaluationBadge && (
        <View style={{ marginBottom: 8, flexDirection: 'row', alignItems: 'center' }}>
          <View
            style={{
              height: 32,
              width: 32,
              borderRadius: 16,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: palette.default,
            }}
          >
            <Text style={{ fontSize: 15, fontWeight: '700', color: t.text.onAccent }}>
              {isCorrect ? '✓' : '✗'}
            </Text>
          </View>
          <Text
            style={{
              marginLeft: 12,
              fontSize: 18,
              fontWeight: '700',
              color: palette.text,
            }}
          >
            {isCorrect ? 'Correct' : 'Incorrect'}
          </Text>
        </View>
      )}

      {showCorrectAnswer && currentCard && (
        <View style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: t.border.subtle, paddingTop: 12 }}>
          <Text style={{ marginBottom: 4, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1.5, color: t.error.text }}>
            Correct Answer
          </Text>
          <Text style={{ fontSize: 17, fontWeight: '600', lineHeight: 24, color: t.text.primary }}>
            {currentCard.back}
          </Text>
        </View>
      )}
    </Animated.View>
  );
}
