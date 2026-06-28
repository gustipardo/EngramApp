const appJson = require("./app.json");

module.exports = {
  ...appJson.expo,
  extra: {
    geminiApiKey: process.env.GEMINI_API_KEY ?? null,
    appMode: process.env.APP_MODE ?? null,
    // Google Sign-In: OAuth 2.0 "Web client" id from the Firebase project
    // (Authentication → Sign-in method → Google, or GCP Credentials). Read by
    // _layout.tsx → configureGoogleSignIn. Required for real auth to work.
    googleWebClientId: process.env.GOOGLE_WEB_CLIENT_ID ?? null,
    // Dev-only: deck name to autostart with. The autostart only fires when
    // AUTO_START_ENABLED is also "true" OR the launch deep link carries
    // `?autostart=1`. See AUTO_START_DECK / AUTO_START_ENABLED in .env.
    autoStartDeck: process.env.AUTO_START_DECK ?? null,
    autoStartEnabled: process.env.AUTO_START_ENABLED === "true",
    // Dev-only: when true, index.tsx marks onboarding as completed and
    // redirects straight to deck-select. Needed for test-flow.sh after pm
    // clear wipes AsyncStorage (including the persisted onboardingCompleted
    // flag). See SKIP_ONBOARDING in .env.
    skipOnboarding: process.env.SKIP_ONBOARDING === "true",
    // Dev-only gate overrides. In a dev binary these force the auth / payment
    // flow ON so the screens can be developed; default OFF (bypassed) so you
    // jump straight to the study core. IMPOSSIBLE to honor in a release build —
    // see the hard `__DEV__` guard in src/config/env.ts.
    authRequired: process.env.AUTH_REQUIRED === "true",
    paymentRequired: process.env.PAYMENT_REQUIRED === "true",
    // Verbose flag is read directly from process.env in sessionDebugLogger.ts
    // — Metro inlines EXPO_PUBLIC_* so no expo-config extra mapping needed.
  },
};
