import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface SettingsStore {
  selectedDeck: string | null;
  onboardingCompleted: boolean;
  alwaysReadBack: boolean;
  darkMode: boolean;
  deckInstructions: Record<string, string>;
  setSelectedDeck: (deck: string | null) => void;
  setOnboardingCompleted: (completed: boolean) => void;
  setAlwaysReadBack: (value: boolean) => void;
  toggleDarkMode: () => void;
  setDeckInstructions: (deckName: string, instructions: string) => void;
}

export const useSettingsStore = create(
  persist<SettingsStore>(
    (set) => ({
      selectedDeck: null,
      onboardingCompleted: false,
      alwaysReadBack: false,
      darkMode: true,
      deckInstructions: {},

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
    }),
    {
      name: 'settings-storage',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
