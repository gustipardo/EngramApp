/**
 * Outbound links shown in-app (legal + support). Centralized so the settings
 * screen and the paywall reference one definition.
 *
 * The /terms and /privacy routes exist on the marketing site (Astro pages in
 * Web/src/pages, bilingual: ES at the root, EN under /en/). The app UI is
 * English, so we link to the English documents. ES copies live at
 * /terms and /privacy.
 *
 * NOTE: the support inbox must be a real, monitored address before release
 * (a Google Play requirement near a purchase flow).
 */
export const TERMS_URL = "https://engramcards.com/en/terms";
export const PRIVACY_URL = "https://engramcards.com/en/privacy";
export const SUPPORT_EMAIL = "support@engramcards.com";
