import type { Translations } from "./en";

/**
 * Spanish UI strings. Mirrors `en.ts` key-for-key (enforced by the
 * `Translations` type). Tone: editorial, tuteo, no exclamation marks, no
 * EdTech fluff — same voice rules as the landing (Web/src/i18n/es.json).
 */
export const es: Translations = {
  common: {
    tryAgain: "Reintentar",
    cancel: "Cancelar",
    save: "Guardar",
    retry: "Reintentar",
    retrying: "Reintentando…",
    done: "Listo",
    goBack: "Volver",
    continue: "Continuar",
    refresh: "Actualizar",
    subscribe: "Suscribirse",
    restorePurchases: "Restaurar compras",
    signInWithGoogle: "Iniciar sesión con Google",
    termsOfUse: "Términos de uso",
    privacyPolicy: "Política de privacidad",
  },

  deckSelect: {
    loadingDecks: "Cargando mazos...",
    connectingToAnkiDroid: "Conectando con AnkiDroid",
    cannotLoadTitle: "No se pudieron cargar los mazos",
    cannotLoadBody:
      "No se pudo conectar con AnkiDroid. Verificá que AnkiDroid esté instalado, abierto y con permisos otorgados.",
    noDecksTitle: "No hay mazos",
    noDecksBody:
      "AnkiDroid todavía no tiene mazos. Creá o importá mazos en AnkiDroid y volvé.",
    sync: "Sincronizar",
    syncing: "Sincronizando…",
    cardsDue: {
      one: "1 tarjeta pendiente",
      other: "%{count} tarjetas pendientes",
    },
    deckCount: {
      one: "1 mazo",
      other: "%{count} mazos",
    },
    trialBanner: {
      one: "Prueba gratis: queda 1 día",
      other: "Prueba gratis: quedan %{count} días",
    },
    manage: "Administrar ›",
    noDecksAvailable: "No hay mazos disponibles",
    gearHint:
      "Tocá el engranaje para configurar idioma, lectura e instrucciones del mazo",
    syncA11y: "Sincronizar mazos con AnkiDroid",
    accountA11y: "Cuenta y configuración",
    deckSettingsA11y: "Configuración de %{deck}",
    modal: {
      title: "Configuración del mazo",
      tutorLanguage: "Idioma del tutor",
      tutorLanguageHint:
        "Controla la voz del tutor y el idioma en que habla. Elegí el que coincida con el contenido del mazo.",
      alwaysRead: "Leer siempre la respuesta",
      alwaysReadHint:
        "Lee el reverso de la tarjeta en voz alta después de cada respuesta, no solo en las incorrectas.",
      instructions: "Instrucciones para el tutor",
      instructionsHint:
        "Opcional. Indicaciones en texto libre que el tutor sigue solo para este mazo.",
      instructionsPlaceholder:
        "Ej.: El reverso tiene una Respuesta Central y una Respuesta Conceptual. Evaluame solo la Central, pero leé en voz alta la Conceptual después de cada tarjeta.",
    },
  },

  settings: {
    title: "Cuenta",
    backA11y: "Volver",
    developer: "Desarrollador",
    notSignedIn: "Sin sesión iniciada",
    freeTrial: "Prueba gratis",
    signInPitch:
      "Iniciá sesión para empezar tu prueba gratis de 7 días y estudiar con el tutor de voz con IA.",
    planLoadFailedTitle: "No se pudo cargar tu plan",
    planLoadFailedBody:
      "No pudimos conectar con el servidor para verificar tu plan. Revisá tu conexión y reintentá.",
    checkingPlan: "Verificando tu plan…",
    devAccess: "Acceso de desarrollador",
    devAccessBody:
      "La facturación está desactivada en esta build. No hay una suscripción real activa.",
    engramPro: "Engram Pro",
    planMonthly: "Mensual",
    planYearly: "Anual",
    activeManaged: "Activa · Se administra en Google Play",
    manageSubscription: "Administrar suscripción",
    trialEnded: "Prueba finalizada",
    trialEndedBody: "Suscribite para seguir estudiando con el tutor de voz.",
    daysLeft: {
      one: "Queda 1 día",
      other: "Quedan %{count} días",
    },
    daysMeterLabel: "Días",
    seePlans: "Ver planes",
    preferences: "Preferencias",
    darkMode: "Modo oscuro",
    darkModeHint: "Usar el tema oscuro en toda la app",
    appLanguage: "Idioma de la app",
    appLanguageHint: "Idioma de la interfaz",
    languageSystem: "Auto",
    about: "Acerca de",
    contactSupport: "Contactar soporte",
    version: "Versión %{version}",
    signOut: "Cerrar sesión",
    signOutConfirmTitle: "Cerrar sesión",
    signOutConfirmBody: "¿Cerrar sesión de tu cuenta de Engram?",
    restoredTitle: "Compras restauradas",
    restoredBody: "Tu suscripción está activa en este dispositivo.",
    nothingToRestoreTitle: "Nada para restaurar",
    nothingToRestoreBody:
      "No encontramos una suscripción activa para esta cuenta.",
    restoreFailedTitle: "No se pudo restaurar",
    restoreFailedBody: "Reintentá en un momento.",
  },

  paywall: {
    title: "Tu prueba gratis terminó",
    subtitle: "Suscribite para seguir estudiando con tu tutor de voz con IA",
    yearly: "Anual",
    monthly: "Mensual",
    perMonth: "%{price}/mes",
    perYear: "%{price}/año",
    yearlyFallback: "US$39,99/año (US$3,33/mes)",
    monthlyFallback: "US$4,99/mes",
    saveBadge: "Ahorrá 33%",
    purchaseFailed: "La compra falló. Reintentá.",
    noSubscriptionFound:
      "No se encontró una suscripción activa para restaurar.",
    restoreFailed: "No se pudo restaurar. Reintentá.",
    maybeLater: "Quizás más tarde",
  },

  session: {
    connectingTitle: "Conectando con el tutor de IA",
    connectingHint: "Preparando tu sesión de voz...",
    loadingCardsTitle: "Cargando tarjetas",
    loadingCardsHint: "Trayendo tarjetas de %{deck}...",
    errorTitle: "Algo salió mal",
    errorFallback: "Ocurrió un error inesperado. Reintentá.",
    startFailed: "No se pudo iniciar la sesión",
    completeTitle: "Sesión completada",
    accuracy: "Precisión",
    reviewed: "Repasadas",
    correct: "Correctas",
    incorrect: "Incorrectas",
    correctBanner: "Correcto",
    incorrectBanner: "Incorrecto",
    pausedTitle: "Sesión en pausa",
    connectionLostTitle: "Conexión perdida",
    connectionLostBody:
      "Se interrumpió tu conexión de red. La sesión se reanuda sola cuando vuelva la conexión.",
    resumeSession: "Reanudar sesión",
    endSession: "Terminar sesión",
    reconnectingTitle: "Reconectando...",
    reconnectingHint: "Intentando restaurar tu sesión",
    pause: "Pausa",
    question: "Pregunta",
    cardsProgress: "%{current} / %{total} tarjetas",
    correctCount: "%{count} correctas",
    incorrectCount: "%{count} incorrectas",
    connected: "Conectado",
    offline: "Sin conexión",
    reconnectingBadge: "Reconectando...",
    disconnected: "Desconectado",
    phase: {
      readyLabel: "Preparando",
      readyHint: "La sesión está por empezar...",
      askingLabel: "Haciendo la pregunta",
      askingHint: "Escuchá con atención...",
      answerLabel: "Tu turno",
      answerHint: "Decí tu respuesta ahora",
      evaluatingLabel: "Evaluando",
      evaluatingHint: "Revisando tu respuesta...",
      feedbackLabel: "Devolución",
      feedbackHint: "Escuchá la devolución",
      studyingLabel: "Estudiando",
      studyingHint: "Sesión en curso",
    },
    mic: {
      silent: "Silencio",
      noData: "Sin señal de micrófono",
      ok: "Audio OK",
      quiet: "Bajo",
    },
  },

  onboarding: {
    detect: {
      checking: "Buscando AnkiDroid...",
      detectedTitle: "AnkiDroid detectado",
      detectedBody:
        "AnkiDroid está instalado en tu dispositivo. Configurá la conexión para estudiar tus tarjetas por voz.",
      requiredTitle: "Se necesita AnkiDroid",
      requiredBody:
        "Engram funciona sobre AnkiDroid para estudiar tus tarjetas por voz. Instalá AnkiDroid primero y volvé.",
      install: "Instalar AnkiDroid",
      installed: "Ya lo instalé",
    },
    permissions: {
      title: "Conectar AnkiDroid",
      body: "Engram lee tus mazos directamente de AnkiDroid. Otorgá el acceso para cargar tus mazos. Podés iniciar sesión más tarde, cuando empieces a estudiar.",
      cardTitle: "Acceso a AnkiDroid",
      cardBody:
        "Permite que Engram lea tus mazos y tarjetas pendientes de AnkiDroid.",
      grant: "Otorgar %{permission}",
      granted: "Otorgado",
      pending: "Pendiente",
      blockedTitle: "Permiso bloqueado permanentemente",
      blockedBody:
        "Android ya no muestra el diálogo. Abrí Configuración → Aplicaciones → Engram → Permisos y activá el acceso a AnkiDroid manualmente.",
      openSettings: "Abrir Configuración",
      seeDecks: "Ver mis mazos",
      grantToContinue: "Otorgá acceso a AnkiDroid para continuar",
    },
    signIn: {
      tagline:
        "Estudiá tus tarjetas con un tutor de voz que se adapta a cómo respondés de verdad.",
      trialNote: "Iniciá sesión para empezar tu prueba gratis de 7 días",
      signingIn: "Iniciando sesión…",
      playServicesUnavailable:
        "Google Play Services no está disponible o está desactualizado.",
      failed: "No se pudo iniciar sesión. Revisá tu conexión y reintentá.",
      legal:
        "Al continuar aceptás nuestros Términos y la Política de privacidad.",
    },
    trialStarted: {
      allSetTitle: "Todo listo",
      allSetBody:
        "Tu suscripción está activa. Entrá y empezá a estudiar por voz.",
      trialTitle: "Tu prueba gratis empezó",
      trialBody: {
        one: "Tenés 1 día de acceso completo. Estudiá cualquier mazo por voz con el tutor de IA.",
        other:
          "Tenés %{count} días de acceso completo. Estudiá cualquier mazo por voz con el tutor de IA.",
      },
      startStudying: "Empezar a estudiar",
    },
  },
};
