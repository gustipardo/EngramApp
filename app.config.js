const appJson = require("./app.json");

// Guard rail for the release recipe (scripts/build-release.sh): any config
// evaluation that would bake the raw key into `extra` gets a loud warning.
// Expected (and harmless) on every dev run; if you see it during a RELEASE
// build, stop — you forgot APP_MODE=production and the key would ship in
// the APK bundle.
if (process.env.APP_MODE !== "production" && process.env.GEMINI_API_KEY) {
  console.warn(
    "[app.config] GEMINI_API_KEY is being baked into extra.geminiApiKey " +
      "(APP_MODE != production). Fine for dev; NEVER build a release this " +
      "way — use scripts/build-release.sh.",
  );
}

module.exports = {
  ...appJson.expo,
  extra: {
    // The raw Gemini key must NEVER ship in a production/release binary — the
    // app fetches a short-lived ephemeral token from the `mintLiveToken` Cloud
    // Function instead (token broker, pre-launch blocker #1). It's only baked in
    // for dev/test builds, where tokenService falls back to it when the payment
    // gate is bypassed. Release builds MUST set APP_MODE=production so this is
    // null in the APK.
    geminiApiKey:
      process.env.APP_MODE === "production"
        ? null
        : (process.env.GEMINI_API_KEY ?? null),
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
