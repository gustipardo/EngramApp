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
        set((state) => ({
          deckInstructions: {
            ...state.deckInstructions,
            ...(instructions.trim()
              ? { [deckName]: instructions.trim() }
              : Object.fromEntries(
                  Object.entries(state.deckInstructions).filter(([k]) => k !== deckName)
                )),
          },
        })),
      setDeckLanguage: (deckName, languageCode) =>
        set((state) => ({
          deckLanguages: {
            ...state.deckLanguages,
            // Empty / default → drop the entry so the deck falls back to
            // DEFAULT_DECK_LANGUAGE rather than persisting an explicit
            // override that matches the default.
            ...(languageCode && languageCode !== DEFAULT_DECK_LANGUAGE
              ? { [deckName]: languageCode }
              : Object.fromEntries(
                  Object.entries(state.deckLanguages).filter(([k]) => k !== deckName)
                )),
          },
        })),
    }),
    {
      name: 'settings-storage',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
