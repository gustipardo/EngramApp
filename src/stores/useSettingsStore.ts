import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type AIProvider = 'openai' | 'gemini';

export interface SettingsStore {
  selectedDeck: string | null;
  onboardingCompleted: boolean;
  apiKeyStored: boolean;
  alwaysReadBack: boolean;
  darkMode: boolean;
  aiProvider: AIProvider;
  deckInstructions: Record<string, string>;
  setSelectedDeck: (deck: string | null) => void;
  setOnboardingCompleted: (completed: boolean) => void;
  setApiKeyStored: (stored: boolean) => void;
  setAlwaysReadBack: (value: boolean) => void;
  toggleDarkMode: () => void;
  setAIProvider: (provider: AIProvider) => void;
  setDeckInstructions: (deckName: string, instructions: string) => void;
}

export const useSettingsStore = create(
  persist<SettingsStore>(
    (set) => ({
      selectedDeck: null,
      onboardingCompleted: false,
      apiKeyStored: false,
      alwaysReadBack: false,
      darkMode: true,
      aiProvider: 'openai',
      deckInstructions: {},

      setSelectedDeck: (selectedDeck) => set({ selectedDeck }),
      setOnboardingCompleted: (onboardingCompleted) => set({ onboardingCompleted }),
      setApiKeyStored: (apiKeyStored) => set({ apiKeyStored }),
      setAlwaysReadBack: (alwaysReadBack) => set({ alwaysReadBack }),
      toggleDarkMode: () => set((state) => ({ darkMode: !state.darkMode })),
      setAIProvider: (aiProvider) => set({ aiProvider }),
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
    }),
    {
      name: 'settings-storage',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
