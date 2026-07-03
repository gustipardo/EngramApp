/**
 * App-UI localization (separate concern from the per-deck TUTOR language,
 * which steers the AI voice via the system prompt — see prompts.ts).
 *
 * Resolution order: explicit user choice in Account → device locale →
 * English. `appLanguage` lives in useSettingsStore ("system" | "en" | "es"),
 * so any component that calls `useT()` re-renders when the user changes it.
 */
import { I18n } from "i18n-js";
import { getLocales } from "expo-localization";
import { useSettingsStore, type AppLanguage } from "../stores/useSettingsStore";
import { en } from "./en";
import { es } from "./es";

export const SUPPORTED_LANGUAGES = ["en", "es"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const i18n = new I18n({ en, es });
i18n.defaultLocale = "en";
i18n.enableFallback = true;

/** Device UI language, collapsed to a supported app language. */
export function deviceLanguage(): SupportedLanguage {
  const code = getLocales()[0]?.languageCode;
  return code === "es" ? "es" : "en";
}

export function resolveLanguage(pref: AppLanguage): SupportedLanguage {
  return pref === "system" ? deviceLanguage() : pref;
}

export type TFunction = (
  key: string,
  options?: Record<string, unknown>,
) => string;

/**
 * Reactive translate function. Subscribes to the persisted `appLanguage`
 * setting, so a language change re-renders every screen that uses it.
 */
export function useT(): TFunction {
  const pref = useSettingsStore((s) => s.appLanguage);
  i18n.locale = resolveLanguage(pref);
  return (key, options) => i18n.t(key, options);
}

/**
 * Non-hook accessor for code outside the React tree (Alert bodies built in
 * plain handlers are fine with useT; this is for services/singletons).
 */
export function t(key: string, options?: Record<string, unknown>): string {
  i18n.locale = resolveLanguage(useSettingsStore.getState().appLanguage);
  return i18n.t(key, options);
}
