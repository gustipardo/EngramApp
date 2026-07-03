/**
 * English UI strings — the source catalog. Keys are grouped by screen.
 * `es.ts` must mirror this shape exactly (TypeScript enforces it via the
 * `Translations` type derived from this object).
 *
 * Copy rules (see _design/01-identidad.md §10 voice + §15 anti-patterns):
 * editorial dev-tool tone; no celebratory EdTech fluff, no emoji.
 */
export const en = {
  common: {
    tryAgain: "Try Again",
    cancel: "Cancel",
    save: "Save",
    retry: "Retry",
    retrying: "Retrying…",
    done: "Done",
    goBack: "Go Back",
    continue: "Continue",
    refresh: "Refresh",
    subscribe: "Subscribe",
    restorePurchases: "Restore purchases",
    signInWithGoogle: "Sign in with Google",
    termsOfUse: "Terms of Use",
    privacyPolicy: "Privacy Policy",
  },

  deckSelect: {
    loadingDecks: "Loading decks...",
    connectingToAnkiDroid: "Connecting to AnkiDroid",
    cannotLoadTitle: "Cannot Load Decks",
    cannotLoadBody:
      "Could not connect to AnkiDroid. Make sure AnkiDroid is installed, running, and permissions are granted.",
    noDecksTitle: "No Decks Found",
    noDecksBody:
      "AnkiDroid does not have any decks yet. Create or import some decks in AnkiDroid, then come back.",
    sync: "Sync",
    syncing: "Syncing…",
    cardsDue: {
      one: "1 card due",
      other: "%{count} cards due",
    },
    deckCount: {
      one: "1 deck",
      other: "%{count} decks",
    },
    trialBanner: {
      one: "Free trial: 1 day remaining",
      other: "Free trial: %{count} days remaining",
    },
    manage: "Manage ›",
    noDecksAvailable: "No decks available",
    gearHint: "Tap the gear to set deck language, read-back and instructions",
    syncA11y: "Sync decks with AnkiDroid",
    accountA11y: "Account and settings",
    deckSettingsA11y: "Settings for %{deck}",
    modal: {
      title: "Deck Settings",
      tutorLanguage: "Tutor language",
      tutorLanguageHint:
        "Controls the tutor's voice and the language it speaks in. Pick whatever matches the deck content.",
      alwaysRead: "Always read answer",
      alwaysReadHint:
        "Read the back of the card aloud after every answer, not just on incorrect ones.",
      instructions: "Tutor instructions",
      instructionsHint:
        "Optional. Free-text guidance the tutor follows for this deck only.",
      instructionsPlaceholder:
        "E.g.: The back has a Core Answer and a Conceptual Answer. Only test me on the Core Answer, but read aloud the Conceptual Answer after each card.",
    },
  },

  settings: {
    title: "Account",
    backA11y: "Back",
    developer: "Developer",
    notSignedIn: "Not signed in",
    freeTrial: "Free trial",
    signInPitch:
      "Sign in to start your 7-day free trial and study with the AI voice tutor.",
    planLoadFailedTitle: "Couldn’t load your plan",
    planLoadFailedBody:
      "We couldn’t reach the server to check your plan. Check your connection and try again.",
    checkingPlan: "Checking your plan…",
    devAccess: "Developer access",
    devAccessBody:
      "Billing is bypassed in this build. No real subscription is active.",
    engramPro: "Engram Pro",
    planMonthly: "Monthly",
    planYearly: "Yearly",
    activeManaged: "Active · Managed in Google Play",
    manageSubscription: "Manage subscription",
    trialEnded: "Trial ended",
    trialEndedBody: "Subscribe to keep studying with the AI voice tutor.",
    daysLeft: {
      one: "1 day left",
      other: "%{count} days left",
    },
    daysMeterLabel: "Days",
    seePlans: "See plans",
    preferences: "Preferences",
    darkMode: "Dark mode",
    darkModeHint: "Use the dark theme across the app",
    appLanguage: "App language",
    appLanguageHint: "Language of the app interface",
    languageSystem: "Auto",
    about: "About",
    contactSupport: "Contact support",
    version: "Version %{version}",
    signOut: "Sign out",
    signOutConfirmTitle: "Sign out",
    signOutConfirmBody: "Sign out of your Engram account?",
    restoredTitle: "Purchases restored",
    restoredBody: "Your subscription is active on this device.",
    nothingToRestoreTitle: "Nothing to restore",
    nothingToRestoreBody:
      "We didn't find an active subscription for this account.",
    restoreFailedTitle: "Restore failed",
    restoreFailedBody: "Please try again in a moment.",
  },

  paywall: {
    title: "Your Free Trial Has Ended",
    subtitle: "Subscribe to continue studying with your AI voice tutor",
    yearly: "Yearly",
    monthly: "Monthly",
    perMonth: "%{price}/month",
    perYear: "%{price}/year",
    yearlyFallback: "$39.99/year ($3.33/mo)",
    monthlyFallback: "$4.99/month",
    saveBadge: "Save 33%",
    purchaseFailed: "Purchase failed. Please try again.",
    noSubscriptionFound: "No active subscription found to restore.",
    restoreFailed: "Restore failed. Please try again.",
    maybeLater: "Maybe later",
  },

  session: {
    connectingTitle: "Connecting to AI Tutor",
    connectingHint: "Setting up your voice session...",
    loadingCardsTitle: "Loading Cards",
    loadingCardsHint: "Fetching cards from %{deck}...",
    errorTitle: "Something Went Wrong",
    errorFallback: "An unexpected error occurred. Please try again.",
    startFailed: "Failed to start session",
    completeTitle: "Session Complete",
    accuracy: "Accuracy",
    reviewed: "Reviewed",
    correct: "Correct",
    incorrect: "Incorrect",
    correctBanner: "Correct",
    incorrectBanner: "Incorrect",
    pausedTitle: "Session Paused",
    connectionLostTitle: "Connection Lost",
    connectionLostBody:
      "Your network connection was interrupted. The session will resume automatically when the connection is restored.",
    resumeSession: "Resume Session",
    endSession: "End Session",
    reconnectingTitle: "Reconnecting...",
    reconnectingHint: "Attempting to restore your session",
    pause: "Pause",
    question: "Question",
    cardsProgress: "%{current} / %{total} cards",
    correctCount: "%{count} correct",
    incorrectCount: "%{count} incorrect",
    connected: "Connected",
    offline: "Offline",
    reconnectingBadge: "Reconnecting...",
    disconnected: "Disconnected",
    phase: {
      readyLabel: "Getting Ready",
      readyHint: "Session is starting...",
      askingLabel: "Asking Question",
      askingHint: "Listen carefully...",
      answerLabel: "Your Turn",
      answerHint: "Speak your answer now",
      evaluatingLabel: "Evaluating",
      evaluatingHint: "Checking your answer...",
      feedbackLabel: "Feedback",
      feedbackHint: "Listen to the feedback",
      studyingLabel: "Studying",
      studyingHint: "Session in progress",
    },
    mic: {
      silent: "Silent",
      noData: "No mic data",
      ok: "Audio OK",
      quiet: "Quiet",
    },
  },

  onboarding: {
    detect: {
      checking: "Checking for AnkiDroid...",
      detectedTitle: "AnkiDroid Detected",
      detectedBody:
        "Great. AnkiDroid is installed on your device. Set up the connection so you can study your cards with voice.",
      requiredTitle: "AnkiDroid Required",
      requiredBody:
        "Engram works on top of AnkiDroid to study your flashcards through voice. Install AnkiDroid first, then come back.",
      install: "Install AnkiDroid",
      installed: "I've installed it",
    },
    permissions: {
      title: "Connect AnkiDroid",
      body: "Engram reads your flashcard decks straight from AnkiDroid. Grant access to load your decks. You can sign in later, when you start studying.",
      cardTitle: "AnkiDroid Access",
      cardBody:
        "Lets Engram read your flashcard decks and due cards from AnkiDroid.",
      grant: "Grant %{permission}",
      granted: "Granted",
      pending: "Pending",
      blockedTitle: "Permission permanently blocked",
      blockedBody:
        "Android won't show the dialog anymore. Open Settings → Apps → Engram → Permissions and enable AnkiDroid access manually.",
      openSettings: "Open Settings",
      seeDecks: "See my decks",
      grantToContinue: "Grant AnkiDroid access to continue",
    },
    signIn: {
      tagline:
        "Study your flashcards with a voice tutor that adapts to how you actually answer.",
      trialNote: "Sign in to start your 7-day free trial",
      signingIn: "Signing in…",
      playServicesUnavailable:
        "Google Play Services is unavailable or out of date.",
      failed: "Could not sign in. Check your connection and try again.",
      legal: "By continuing you agree to our Terms and Privacy Policy.",
    },
    trialStarted: {
      allSetTitle: "You're all set",
      allSetBody:
        "Your subscription is active. Jump in and start studying by voice.",
      trialTitle: "Your free trial has started",
      trialBody: {
        one: "You have 1 day of full access. Study any deck by voice with the AI tutor.",
        other:
          "You have %{count} days of full access. Study any deck by voice with the AI tutor.",
      },
      startStudying: "Start studying",
    },
  },
};

export type Translations = typeof en;
