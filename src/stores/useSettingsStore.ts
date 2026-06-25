import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface SettingsStore {
  selectedDeck: string | null;
  onboardingCompleted: boolean;
  alwaysReadBack: boolean;
  darkMode: boolean;
  deckInstructions: Record<string, string>;
  // BCP-47 language code per deck (e.g. 'en-US', 'es-ES', 'fr-FR').
  // Drives both the system prompt's "Language: X ONLY" line and
  // Gemini Live's `speechConfig.languageCode`. Decks without an entry
  // fall back to 'en-US'.
  deckLanguages: Record<string, string>;
  setSelectedDeck: (deck: string | null) => void;
  setOnboardingCompleted: (completed: boolean) => void;
  setAlwaysReadBack: (value: boolean) => void;
  toggleDarkMode: () => void;
  setDeckInstructions: (deckName: string, instructions: string) => void;
  setDeckLanguage: (deckName: string, languageCode: string) => void;
}

export const DEFAULT_DECK_LANGUAGE = 'en-US';

export const useSettingsStore = create(
  persist<SettingsStore>(
    (set) => ({
      selectedDeck: null,
      onboardingCompleted: false,
      alwaysReadBack: false,
      darkMode: true,
      deckInstructions: {},
      deckLanguages: {},

      setSelectedDeck: (selectedDeck) => set({ selectedDeck }),
      setOnboardingCompleted: (onboardingCompleted) => set({ onboardingCompleted }),
      setAlwaysReadBack: (alwaysReadBack) => set({ alwaysReadBack }),
      toggleDarkMode: () => set((state) => ({ darkMode: !state.darkMode })),
      setDeckInstructions: (deckName, instructions) =>
        set((state) => {
          const trimmed = instructions.trim();
          if (trimmed) {
            return {
              deckInstructions: { ...state.deckInstructions, [deckName]: trimmed },
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
              deckLanguages: { ...state.deckLanguages, [deckName]: languageCode },
            };
          }
          const next = { ...state.deckLanguages };
          delete next[deckName];
          return { deckLanguages: next };
        }),
    }),
    {
      name: 'settings-storage',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
