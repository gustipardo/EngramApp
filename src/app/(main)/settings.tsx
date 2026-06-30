import { useState, useEffect } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Switch,
  StatusBar,
  Platform,
  Alert,
  ActivityIndicator,
  Linking,
} from "react-native";
import { useRouter } from "expo-router";
import Constants from "expo-constants";
import Svg, { Path } from "react-native-svg";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useTrialStore } from "../../stores/useTrialStore";
import { useAuthStore } from "../../stores/useAuthStore";
import { signOut } from "../../services/authService";
import {
  restorePurchases,
  openManageSubscriptions,
  type SubscriptionSku,
} from "../../services/billingService";
import { AnalyticsEvents } from "../../services/analytics";
import { paymentBypassed, authBypassed } from "../../config/env";
import { derivePlanState } from "../../utils/planState";
import { appTheme, type Theme } from "../../theme/appTheme";
import { TERMS_URL, PRIVACY_URL, SUPPORT_EMAIL } from "../../config/links";

// Mirror of the server trial knobs (functions/src/index.ts) — used only to
// draw the "remaining out of total" meters. If the server numbers change,
// update these too (they're cosmetic; the server stays the source of truth).
const TRIAL_DAYS = 7;
const TRIAL_MAX_SESSIONS = 10;

export default function SettingsScreen() {
  const router = useRouter();

  const darkMode = useSettingsStore((s) => s.darkMode);
  const toggleDarkMode = useSettingsStore((s) => s.toggleDarkMode);
  const alwaysReadBack = useSettingsStore((s) => s.alwaysReadBack);
  const setAlwaysReadBack = useSettingsStore((s) => s.setAlwaysReadBack);

  const trialStatus = useTrialStore((s) => s.status);
  const trialError = useTrialStore((s) => s.error);
  const trialChecking = useTrialStore((s) => s.isChecking);
  const refreshTrialStatus = useTrialStore((s) => s.refresh);
  const user = useAuthStore((s) => s.user);

  const [restoring, setRestoring] = useState(false);

  const t = appTheme(darkMode);
  const dev = paymentBypassed();
  const planState = derivePlanState(trialStatus, dev);
  const isDevBuild = paymentBypassed() || authBypassed();
  const showSignOut = !authBypassed() && !!user;
  // Auth is enforced but nobody is signed in (e.g. browsing decks signed-out
  // and opening Account before tapping a deck). Offer a way in.
  const showSignIn = !authBypassed() && !user;

  // Pull a fresh status whenever a signed-in user opens Account and we don't
  // already have one (e.g. the post-login refresh failed). Without this the
  // plan card can sit on "Checking your plan…" forever.
  useEffect(() => {
    if (!dev && !!user && !trialStatus && !trialChecking) {
      refreshTrialStatus();
    }
  }, [dev, user, trialStatus, trialChecking, refreshTrialStatus]);

  const accountInitial = (user?.displayName || user?.email || "?")
    .trim()
    .charAt(0)
    .toUpperCase();

  function handleBack() {
    if (router.canGoBack()) router.back();
    else router.replace("/(main)/deck-select");
  }

  function handleSubscribe() {
    AnalyticsEvents.paywallShown("settings");
    router.push("/(main)/paywall");
  }

  function handleSignIn() {
    router.push("/(onboarding)/sign-in");
  }

  async function handleManage() {
    const sku: SubscriptionSku | undefined =
      trialStatus?.plan === "yearly"
        ? "yearly_3999"
        : trialStatus?.plan === "monthly"
          ? "monthly_499"
          : undefined;
    try {
      await openManageSubscriptions(sku);
    } catch (err) {
      console.error("[Settings] open manage subscriptions failed:", err);
    }
  }

  async function handleRestore() {
    if (restoring) return;
    setRestoring(true);
    try {
      const restored = await restorePurchases();
      await refreshTrialStatus();
      Alert.alert(
        restored ? "Purchases restored" : "Nothing to restore",
        restored
          ? "Your subscription is active on this device."
          : "We didn't find an active subscription for this account.",
      );
    } catch (err) {
      console.error("[Settings] restore failed:", err);
      Alert.alert("Restore failed", "Please try again in a moment.");
    } finally {
      setRestoring(false);
    }
  }

  function handleSignOut() {
    Alert.alert("Sign out", "Sign out of your Engram account?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: async () => {
          try {
            await signOut();
            // Trial status belongs to the signed-out user — clear it.
            useTrialStore.setState({ status: null });
            router.replace("/(onboarding)/sign-in");
          } catch (err) {
            console.error("[Settings] sign-out failed:", err);
          }
        },
      },
    ]);
  }

  const openURL = (url: string) =>
    Linking.openURL(url).catch((err) =>
      console.warn("[Settings] openURL failed:", url, err),
    );

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <StatusBar barStyle={t.statusBar} backgroundColor={t.surface} />

      {/* Header */}
      <View
        style={{
          backgroundColor: t.surface,
          paddingHorizontal: 12,
          paddingBottom: 12,
          paddingTop:
            Platform.OS === "android"
              ? (StatusBar.currentHeight ?? 0) + 12
              : 56,
          borderBottomWidth: 1,
          borderBottomColor: t.border,
          flexDirection: "row",
          alignItems: "center",
        }}
      >
        <Pressable
          onPress={handleBack}
          hitSlop={10}
          android_ripple={{
            color: t.pressHighlight,
            borderless: true,
            radius: 22,
          }}
          accessibilityLabel="Back"
          style={{ padding: 8, borderRadius: 8 }}
        >
          <Svg width={24} height={24} viewBox="0 0 24 24">
            <Path
              fill="none"
              stroke={t.text}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15 18l-6-6 6-6"
            />
          </Svg>
        </Pressable>
        <Text
          style={{
            marginLeft: 4,
            fontSize: 18,
            fontWeight: "700",
            color: t.text,
          }}
        >
          Account
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Identity */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            backgroundColor: t.surface,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: t.border,
            padding: 16,
          }}
        >
          <View
            style={{
              width: 48,
              height: 48,
              borderRadius: 24,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: t.accent,
              marginRight: 14,
            }}
          >
            <Text
              style={{ color: t.textOnAccent, fontSize: 20, fontWeight: "700" }}
            >
              {accountInitial}
            </Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
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
                {user?.displayName ??
                  (isDevBuild ? "Developer" : "Not signed in")}
              </Text>
              {isDevBuild && (
                <View
                  style={{
                    flexShrink: 0,
                    paddingHorizontal: 8,
                    paddingVertical: 2,
                    borderRadius: 999,
                    backgroundColor: t.warnCircleBg,
                  }}
                >
                  <Text
                    style={{ fontSize: 10, fontWeight: "700", color: t.accent }}
                  >
                    DEV
                  </Text>
                </View>
              )}
            </View>
            {!!user?.email && (
              <Text
                style={{ fontSize: 13, color: t.textSecondary, marginTop: 2 }}
                numberOfLines={1}
              >
                {user.email}
              </Text>
            )}
          </View>
        </View>

        {/* Plan */}
        <View
          style={{
            marginTop: 12,
            backgroundColor: t.surface,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: t.border,
            padding: 16,
          }}
        >
          {showSignIn ? (
            <>
              <PlanLabel color={t.accent}>Free trial</PlanLabel>
              <Text style={{ fontSize: 14, color: t.text, marginBottom: 14 }}>
                Sign in to start your 7-day free trial and study with the AI
                voice tutor.
              </Text>
              <PrimaryButton
                label="Sign in with Google"
                onPress={handleSignIn}
                t={t}
              />
            </>
          ) : trialError && !trialStatus ? (
            <>
              <PlanLabel color={t.error}>Couldn’t load your plan</PlanLabel>
              <Text
                style={{
                  fontSize: 14,
                  color: t.textSecondary,
                  marginBottom: 14,
                }}
              >
                We couldn’t reach the server to check your plan. Check your
                connection and try again.
              </Text>
              <PrimaryButton
                label={trialChecking ? "Retrying…" : "Retry"}
                onPress={() => {
                  if (!trialChecking) refreshTrialStatus();
                }}
                t={t}
              />
            </>
          ) : (
            <PlanCardBody
              planState={planState}
              daysRemaining={trialStatus?.daysRemaining ?? 0}
              sessionsRemaining={trialStatus?.sessionsRemaining ?? 0}
              plan={trialStatus?.plan ?? null}
              onSubscribe={handleSubscribe}
              onManage={handleManage}
              t={t}
            />
          )}
        </View>

        {/* Billing actions (hidden in dev-bypass and when signed out — no
            real billing / no account to restore against) */}
        {!dev && !showSignIn && (
          <Pressable
            onPress={handleRestore}
            disabled={restoring}
            android_ripple={{ color: t.pressHighlight }}
            style={{
              marginTop: 10,
              borderRadius: 10,
              paddingVertical: 12,
              alignItems: "center",
              overflow: "hidden",
            }}
          >
            {restoring ? (
              <ActivityIndicator size="small" color={t.textSecondary} />
            ) : (
              <Text
                style={{
                  fontSize: 14,
                  fontWeight: "600",
                  color: t.textSecondary,
                }}
              >
                Restore purchases
              </Text>
            )}
          </Pressable>
        )}

        {/* Preferences */}
        <SectionLabel t={t}>Preferences</SectionLabel>
        <View
          style={{
            backgroundColor: t.surface,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: t.border,
            overflow: "hidden",
          }}
        >
          <ToggleRow
            testID="toggle-dark"
            title="Dark mode"
            subtitle="Use the dark theme across the app"
            value={darkMode}
            onValueChange={() => {
              toggleDarkMode();
              AnalyticsEvents.settingsChanged("dark_mode", !darkMode);
            }}
            t={t}
          />
          <Divider t={t} />
          <ToggleRow
            testID="toggle-readback"
            title="Always read answer"
            subtitle="Read the back of the card after every answer"
            value={alwaysReadBack}
            onValueChange={(v) => {
              setAlwaysReadBack(v);
              AnalyticsEvents.settingsChanged("always_read_back", v);
            }}
            t={t}
          />
        </View>

        {/* About */}
        <SectionLabel t={t}>About</SectionLabel>
        <View
          style={{
            backgroundColor: t.surface,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: t.border,
            overflow: "hidden",
          }}
        >
          <LinkRow
            label="Terms of Use"
            onPress={() => openURL(TERMS_URL)}
            t={t}
          />
          <Divider t={t} />
          <LinkRow
            label="Privacy Policy"
            onPress={() => openURL(PRIVACY_URL)}
            t={t}
          />
          <Divider t={t} />
          <LinkRow
            label="Contact support"
            onPress={() => openURL(`mailto:${SUPPORT_EMAIL}`)}
            t={t}
          />
          <Divider t={t} />
          <View style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
            <Text style={{ fontSize: 13, color: t.textDimmed }}>
              Version {Constants.expoConfig?.version ?? "1.0.0"}
            </Text>
          </View>
        </View>

        {/* Sign out */}
        {showSignOut && (
          <Pressable
            onPress={handleSignOut}
            android_ripple={{ color: t.pressHighlight }}
            style={{
              marginTop: 20,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: t.border,
              paddingVertical: 14,
              alignItems: "center",
              overflow: "hidden",
            }}
          >
            <Text style={{ fontSize: 15, fontWeight: "700", color: t.error }}>
              Sign out
            </Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Plan card body — one branch per PlanState (see utils/planState.ts)
// ---------------------------------------------------------------------------
function PlanCardBody({
  planState,
  daysRemaining,
  sessionsRemaining,
  plan,
  onSubscribe,
  onManage,
  t,
}: {
  planState: ReturnType<typeof derivePlanState>;
  daysRemaining: number;
  sessionsRemaining: number;
  plan: "monthly" | "yearly" | null;
  onSubscribe: () => void;
  onManage: () => void;
  t: Theme;
}) {
  if (planState === "unknown") {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <ActivityIndicator size="small" color={t.textSecondary} />
        <Text style={{ fontSize: 14, color: t.textSecondary }}>
          Checking your plan…
        </Text>
      </View>
    );
  }

  if (planState === "dev_unlocked") {
    return (
      <>
        <PlanLabel color={t.info}>Developer access</PlanLabel>
        <Text style={{ fontSize: 14, color: t.textSecondary, lineHeight: 20 }}>
          Billing is bypassed in this build. No real subscription is active.
        </Text>
      </>
    );
  }

  if (planState === "subscribed") {
    const planLabel =
      plan === "yearly" ? "Yearly" : plan === "monthly" ? "Monthly" : null;
    return (
      <>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <PlanLabel color={t.accent}>Engram Pro</PlanLabel>
          {planLabel && (
            <View
              style={{
                paddingHorizontal: 10,
                paddingVertical: 3,
                borderRadius: 999,
                backgroundColor: t.pressHighlight,
              }}
            >
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: "700",
                  color: t.textSecondary,
                }}
              >
                {planLabel}
              </Text>
            </View>
          )}
        </View>
        <Text
          style={{ fontSize: 14, color: t.textSecondary, marginBottom: 14 }}
        >
          Active · Managed in Google Play
        </Text>
        <SecondaryButton label="Manage subscription" onPress={onManage} t={t} />
      </>
    );
  }

  if (planState === "trial_expired") {
    return (
      <>
        <PlanLabel color={t.error}>Trial ended</PlanLabel>
        <Text
          style={{ fontSize: 14, color: t.textSecondary, marginBottom: 14 }}
        >
          Subscribe to keep studying with the AI voice tutor.
        </Text>
        <PrimaryButton label="See plans" onPress={onSubscribe} t={t} />
      </>
    );
  }

  // trial_active
  return (
    <>
      <PlanLabel color={t.accent}>Free trial</PlanLabel>
      <Text style={{ fontSize: 14, color: t.text, marginBottom: 12 }}>
        {daysRemaining} day{daysRemaining === 1 ? "" : "s"} ·{" "}
        {sessionsRemaining} session{sessionsRemaining === 1 ? "" : "s"} left
      </Text>
      <Meter label="Days" remaining={daysRemaining} total={TRIAL_DAYS} t={t} />
      <View style={{ height: 8 }} />
      <Meter
        label="Sessions"
        remaining={sessionsRemaining}
        total={TRIAL_MAX_SESSIONS}
        t={t}
      />
      <View style={{ height: 16 }} />
      <PrimaryButton label="Subscribe" onPress={onSubscribe} t={t} />
    </>
  );
}

function PlanLabel({
  children,
  color,
}: {
  children: React.ReactNode;
  color: string;
}) {
  return (
    <Text
      style={{
        fontSize: 12,
        fontWeight: "800",
        letterSpacing: 0.6,
        textTransform: "uppercase",
        color,
        marginBottom: 6,
      }}
    >
      {children}
    </Text>
  );
}

function Meter({
  label,
  remaining,
  total,
  t,
}: {
  label: string;
  remaining: number;
  total: number;
  t: Theme;
}) {
  const pct = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
  return (
    <View>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          marginBottom: 4,
        }}
      >
        <Text style={{ fontSize: 11, color: t.textSecondary }}>{label}</Text>
        <Text style={{ fontSize: 11, color: t.textDimmed }}>
          {remaining}/{total}
        </Text>
      </View>
      <View
        style={{
          height: 6,
          borderRadius: 3,
          backgroundColor: t.border,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            height: "100%",
            width: `${pct * 100}%`,
            borderRadius: 3,
            backgroundColor: t.accent,
          }}
        />
      </View>
    </View>
  );
}

function PrimaryButton({
  label,
  onPress,
  t,
}: {
  label: string;
  onPress: () => void;
  t: Theme;
}) {
  return (
    <View
      style={{
        borderRadius: 12,
        overflow: "hidden",
        backgroundColor: t.accent,
      }}
    >
      <Pressable
        onPress={onPress}
        android_ripple={{ color: t.pressHighlight }}
        style={{ paddingVertical: 14, alignItems: "center" }}
      >
        <Text
          style={{ fontSize: 15, fontWeight: "700", color: t.textOnAccent }}
        >
          {label}
        </Text>
      </Pressable>
    </View>
  );
}

function SecondaryButton({
  label,
  onPress,
  t,
}: {
  label: string;
  onPress: () => void;
  t: Theme;
}) {
  return (
    <View
      style={{
        borderRadius: 12,
        overflow: "hidden",
        borderWidth: 1,
        borderColor: t.border,
      }}
    >
      <Pressable
        onPress={onPress}
        android_ripple={{ color: t.pressHighlight }}
        style={{ paddingVertical: 13, alignItems: "center" }}
      >
        <Text style={{ fontSize: 15, fontWeight: "700", color: t.text }}>
          {label}
        </Text>
      </Pressable>
    </View>
  );
}

function SectionLabel({
  children,
  t,
}: {
  children: React.ReactNode;
  t: Theme;
}) {
  return (
    <Text
      style={{
        fontSize: 12,
        fontWeight: "700",
        letterSpacing: 0.6,
        textTransform: "uppercase",
        color: t.textDimmed,
        marginTop: 24,
        marginBottom: 8,
        marginLeft: 4,
      }}
    >
      {children}
    </Text>
  );
}

function Divider({ t }: { t: Theme }) {
  return <View style={{ height: 1, backgroundColor: t.border }} />;
}

function ToggleRow({
  title,
  subtitle,
  value,
  onValueChange,
  testID,
  t,
}: {
  title: string;
  subtitle: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  testID?: string;
  t: Theme;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: 16,
        paddingVertical: 12,
      }}
    >
      <View style={{ flex: 1, marginRight: 12 }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: t.text }}>
          {title}
        </Text>
        <Text style={{ fontSize: 11, color: t.textSecondary, marginTop: 1 }}>
          {subtitle}
        </Text>
      </View>
      <Switch
        testID={testID}
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: t.switchTrackOff, true: t.switchTrackOn }}
        thumbColor={value ? t.switchThumbOn : t.switchThumbOff}
      />
    </View>
  );
}

function LinkRow({
  label,
  onPress,
  t,
}: {
  label: string;
  onPress: () => void;
  t: Theme;
}) {
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: t.pressHighlight }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: 16,
        paddingVertical: 14,
      }}
    >
      <Text style={{ fontSize: 14, fontWeight: "600", color: t.text }}>
        {label}
      </Text>
      <Svg width={18} height={18} viewBox="0 0 24 24">
        <Path
          fill="none"
          stroke={t.textDimmed}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 18l6-6-6-6"
        />
      </Svg>
    </Pressable>
  );
}
