import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";

// UI language of the app itself ("system" = follow the device locale).
// Independent from the per-deck TUTOR language (deckLanguages below).
export type AppLanguage = "system" | "en" | "es";

export interface SettingsStore {
  selectedDeck: string | null;
  onboardingCompleted: boolean;
  darkMode: boolean;
  appLanguage: AppLanguage;
  // "Always read the back aloud after every answer", per deck. Decks without
  // an entry fall back to false (read-back on incorrect answers only). Stored
  // per-deck because the right behavior depends on the deck: cloze/recall decks
  // want it off, while explanation-heavy decks want the back read every time.
  deckReadBack: Record<string, boolean>;
  deckInstructions: Record<string, string>;
  // BCP-47 language code per deck (e.g. 'en-US', 'es-ES', 'fr-FR').
  // Drives the system prompt's "Language: X ONLY" line only — the
  // native-audio Gemini model rejects `speechConfig.languageCode`, so
  // geminiManager drops it before the wire (BUG 16). Decks without an
  // entry fall back to 'en-US'.
  deckLanguages: Record<string, string>;
  setSelectedDeck: (deck: string | null) => void;
  setOnboardingCompleted: (completed: boolean) => void;
  setAppLanguage: (language: AppLanguage) => void;
  setDeckReadBack: (deckName: string, value: boolean) => void;
  toggleDarkMode: () => void;
  setDeckInstructions: (deckName: string, instructions: string) => void;
  setDeckLanguage: (deckName: string, languageCode: string) => void;
}

export const DEFAULT_DECK_LANGUAGE = "en-US";

export const useSettingsStore = create(
  persist<SettingsStore>(
    (set) => ({
      selectedDeck: null,
      onboardingCompleted: false,
      darkMode: false,
      appLanguage: "system",
      deckReadBack: {},
      deckInstructions: {},
      deckLanguages: {},

      setSelectedDeck: (selectedDeck) => set({ selectedDeck }),
      setOnboardingCompleted: (onboardingCompleted) =>
        set({ onboardingCompleted }),
      setAppLanguage: (appLanguage) => set({ appLanguage }),
      setDeckReadBack: (deckName, value) =>
        set((state) => {
          // Only persist the non-default (true) state. false → drop the entry
          // so the deck falls back to the default rather than storing a
          // redundant explicit `false`. Mirrors deckLanguages/deckInstructions.
          if (value) {
            return {
              deckReadBack: { ...state.deckReadBack, [deckName]: true },
            };
          }
          const next = { ...state.deckReadBack };
          delete next[deckName];
          return { deckReadBack: next };
        }),
      toggleDarkMode: () => set((state) => ({ darkMode: !state.darkMode })),
      setDeckInstructions: (deckName, instructions) =>
        set((state) => {
          const trimmed = instructions.trim();
          if (trimmed) {
            return {
              deckInstructions: {
                ...state.deckInstructions,
                [deckName]: trimmed,
              },
            };
          }
          // Empty input → drop the entry so the deck falls back to the
          // default no-instructions state rather than persisting an
          // explicit empty string. Object spread is NOT used here because
          // `...state.deckInstructions` would reintroduce the entry before
          // the filtered set had a chance to remove it.
          const next = { ...state.deckInstructions };
          delete next[deckName];
          return { deckInstructions: next };
        }),
      setDeckLanguage: (deckName, languageCode) =>
        set((state) => {
          // Empty / default → drop the entry so the deck falls back to
          // DEFAULT_DECK_LANGUAGE rather than persisting an explicit
          // override that matches the default.
          if (languageCode && languageCode !== DEFAULT_DECK_LANGUAGE) {
            return {
              deckLanguages: {
                ...state.deckLanguages,
                [deckName]: languageCode,
              },
            };
          }
          const next = { ...state.deckLanguages };
          delete next[deckName];
          return { deckLanguages: next };
        }),
    }),
    {
      name: "settings-storage",
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
