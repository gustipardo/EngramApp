/**
 * Resolved screen theme — the flat, screen-facing shape derived from the
 * Engram palette (see `colors.ts`). Extracted from `deck-select.tsx` so every
 * screen that honors the live dark/light toggle (deck-select, settings, ...)
 * reads ONE definition instead of re-declaring the mapping. Values are
 * verbatim from the original deck-select maps.
 *
 * Note: `paywall.tsx` / `trial-started.tsx` still consume the semantic
 * `light`/`dark` objects from `colors.ts` directly (they're light-only); this
 * map is the variant used where the user's `darkMode` setting must apply.
 */
import { palette } from "./colors";

export interface Theme {
  bg: string;
  surface: string;
  text: string;
  textSecondary: string;
  textDimmed: string;
  textOnAccent: string;
  border: string;
  accent: string;
  success: string;
  error: string;
  info: string;
  pressHighlight: string;
  switchTrackOff: string;
  switchTrackOn: string;
  switchThumbOff: string;
  switchThumbOn: string;
  errorCircleBg: string;
  warnCircleBg: string;
  trialBannerBg: string;
  trialBannerText: string;
  statusBar: "light-content" | "dark-content";
}

export const darkTheme: Theme = {
  bg: palette.navy[900],
  surface: palette.navy[850],
  text: palette.navy[50],
  textSecondary: palette.navy[200],
  textDimmed: palette.navy[400],
  textOnAccent: palette.navy[900],
  border: palette.navy[700],
  accent: palette.amber[500],
  success: palette.sage[500],
  error: palette.terracota[500],
  info: palette.slate[500],
  pressHighlight: palette.navy[700],
  switchTrackOff: palette.navy[400],
  switchTrackOn: palette.amber[700],
  switchThumbOff: palette.navy[200],
  switchThumbOn: palette.amber[300],
  errorCircleBg: "rgba(198, 123, 92, 0.18)",
  warnCircleBg: "rgba(228, 161, 63, 0.18)",
  trialBannerBg: "rgba(228, 161, 63, 0.12)",
  trialBannerText: palette.amber[300],
  statusBar: "light-content",
};

export const lightTheme: Theme = {
  bg: palette.paper[100],
  surface: palette.paper[50],
  text: palette.navy[850],
  textSecondary: palette.navy[600],
  textDimmed: palette.navy[300],
  textOnAccent: palette.paper[100],
  border: palette.paper[500],
  accent: palette.amber[700],
  success: palette.sage[700],
  error: palette.terracota[700],
  info: palette.slate[700],
  pressHighlight: palette.paper[300],
  switchTrackOff: palette.paper[500],
  switchTrackOn: palette.amber[300],
  switchThumbOff: palette.paper[50],
  switchThumbOn: palette.amber[700],
  errorCircleBg: "rgba(165, 90, 61, 0.14)",
  warnCircleBg: "rgba(184, 120, 38, 0.14)",
  trialBannerBg: "rgba(184, 120, 38, 0.10)",
  trialBannerText: palette.amber[800],
  statusBar: "dark-content",
};

/** Pick the resolved theme for the current mode. */
export function appTheme(darkMode: boolean): Theme {
  return darkMode ? darkTheme : lightTheme;
}
