import { useState } from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { purchaseSubscription, SubscriptionSku } from '../../services/billingService';
import { AnalyticsEvents } from '../../services/analytics';
import { dark as t } from '../../theme/colors';

export default function PaywallScreen() {
  const router = useRouter();
  const [purchasing, setPurchasing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<'monthly' | 'yearly'>('yearly');

  async function handlePurchase() {
    setPurchasing(true);
    setError(null);

    try {
      const sku: SubscriptionSku =
        selectedPlan === 'monthly' ? 'monthly_499' : 'yearly_3999';

      await purchaseSubscription(sku);
      AnalyticsEvents.subscriptionStarted(selectedPlan);
      router.replace('/(main)/deck-select');
    } catch (err: any) {
      console.error('Purchase failed:', err);
      setError(err.message || 'Purchase failed. Please try again.');
    } finally {
      setPurchasing(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg.base, paddingHorizontal: 24, paddingTop: 64 }}>
      <View style={{ marginBottom: 32, alignItems: 'center' }}>
        <Text style={{ marginBottom: 8, textAlign: 'center', fontSize: 26, fontWeight: '700', color: t.text.primary, letterSpacing: -0.4 }}>
          Your Free Trial Has Ended
        </Text>
        <Text style={{ textAlign: 'center', fontSize: 15, color: t.text.secondary, lineHeight: 22 }}>
          Subscribe to continue studying with your AI voice tutor
        </Text>
      </View>

      <PlanOption
        label="Yearly"
        price="$39.99/year ($3.33/mo)"
        badge="Save 33%"
        selected={selectedPlan === 'yearly'}
        onPress={() => setSelectedPlan('yearly')}
      />
      <PlanOption
        label="Monthly"
        price="$4.99/month"
        selected={selectedPlan === 'monthly'}
        onPress={() => setSelectedPlan('monthly')}
      />

      {error && (
        <View style={{ marginTop: 8, marginBottom: 8, borderRadius: 10, padding: 12, backgroundColor: t.error.subtleBg }}>
          <Text style={{ textAlign: 'center', fontSize: 13, color: t.error.text }}>{error}</Text>
        </View>
      )}

      <Pressable
        onPress={handlePurchase}
        disabled={purchasing}
        style={({ pressed }) => ({
          marginTop: 16,
          borderRadius: 12,
          paddingHorizontal: 24,
          paddingVertical: 16,
          backgroundColor: purchasing ? t.bg.surface3 : pressed ? t.accent.pressed : t.accent.default,
        })}
      >
        {purchasing ? (
          <ActivityIndicator size="small" color={t.text.onAccent} />
        ) : (
          <Text style={{ textAlign: 'center', fontSize: 16, fontWeight: '700', color: t.text.onAccent }}>
            Subscribe
          </Text>
        )}
      </Pressable>

      <Pressable onPress={() => router.back()} style={{ marginTop: 16, paddingVertical: 12 }}>
        <Text style={{ textAlign: 'center', fontSize: 13, color: t.text.tertiary }}>Maybe later</Text>
      </Pressable>
    </View>
  );
}

function PlanOption({
  label,
  price,
  badge,
  selected,
  onPress,
}: {
  label: string;
  price: string;
  badge?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        marginBottom: 12,
        borderRadius: 16,
        borderWidth: 2,
        padding: 16,
        backgroundColor: selected ? t.accent.subtleBg : t.bg.surface1,
        borderColor: selected ? t.accent.default : t.border.subtle,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View>
          <Text style={{ fontSize: 18, fontWeight: '700', color: t.text.primary }}>{label}</Text>
          <Text style={{ fontSize: 13, color: t.text.secondary, marginTop: 2 }}>{price}</Text>
        </View>
        {badge && (
          <View style={{ borderRadius: 9999, paddingHorizontal: 12, paddingVertical: 4, backgroundColor: t.success.subtleBg }}>
            <Text style={{ fontSize: 11, fontWeight: '600', color: t.success.text }}>{badge}</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}
