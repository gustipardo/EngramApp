import '../../global.css';
import { useEffect } from 'react';
import { Slot } from 'expo-router';
import { isDev } from '../config/env';
import { initAnalytics, AnalyticsEvents } from '../services/analytics';
import { initBilling } from '../services/billingService';
import { configureGoogleSignIn } from '../services/authService';
import { installTestHarness } from '../test-harness/bootstrap';

// PostHog config — replace with your actual project key and host
const POSTHOG_API_KEY = 'YOUR_POSTHOG_API_KEY';
const POSTHOG_HOST = 'https://us.i.posthog.com';

// Google Sign-In web client ID from Firebase Console
const GOOGLE_WEB_CLIENT_ID = 'YOUR_GOOGLE_WEB_CLIENT_ID';

export default function RootLayout() {
  useEffect(() => {
    // Test harness — swaps mic to fakeMicSource when APP_MODE=test.
    // No-op otherwise. Must run before any session can start.
    installTestHarness();

    // Initialize analytics
    initAnalytics(POSTHOG_API_KEY, POSTHOG_HOST);
    AnalyticsEvents.appOpened();

    // Production-only init
    if (!isDev()) {
      configureGoogleSignIn(GOOGLE_WEB_CLIENT_ID);
      initBilling().catch((err) =>
        console.warn('Billing init failed:', err)
      );
    }
  }, []);

  return <Slot />;
}
