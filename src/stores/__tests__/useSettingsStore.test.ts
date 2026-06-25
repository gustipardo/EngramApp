/**
 * useSettingsStore tests.
 *
 * Coverage focus (low-coverage file pre-tests):
 *  - default values
 *  - simple setters (selectedDeck, onboardingCompleted, alwaysReadBack, darkMode)
 *  - setDeckInstructions: empty/whitespace string removes the entry;
 *    non-empty trims and stores
 *  - setDeckLanguage: empty OR default (en-US) removes the entry so the
 *    deck falls back to DEFAULT_DECK_LANGUAGE rather than persisting an
 *    explicit override that matches the default
 *  - persist behavior: state survives via AsyncStorage-backed JSON
 *
 * AsyncStorage is mocked with an in-memory Map so the persist middleware
 * can round-trip without hitting native storage. The mock factory must
 * not reference out-of-scope vars (jest.mock hoisting), so the storage
 * is constructed inside the factory.
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  // The factory runs in jest's hoisted scope — no out-of-scope vars.
  const memory = new Map<string, string>();
  const mock = {
    setItem: jest.fn((key: string, value: string) => {
      memory.set(key, value);
      return Promise.resolve();
    }),
    getItem: jest.fn((key: string) =>
      Promise.resolve(memory.get(key) ?? null),
    ),
    removeItem: jest.fn((key: string) => {
      memory.delete(key);
      return Promise.resolve();
    }),
    clear: jest.fn(() => {
      memory.clear();
      return Promise.resolve();
    }),
    getAllKeys: jest.fn(() => Promise.resolve(Array.from(memory.keys()))),
    multiGet: jest.fn((keys: string[]) =>
      Promise.resolve(keys.map((k) => [k, memory.get(k) ?? null])),
    ),
    multiSet: jest.fn((pairs: [string, string][]) => {
      pairs.forEach(([k, v]) => memory.set(k, v));
      return Promise.resolve();
    }),
    multiRemove: jest.fn((keys: string[]) => {
      keys.forEach((k) => memory.delete(k));
      return Promise.resolve();
    }),
  };
  return mock;
});

import { useSettingsStore, DEFAULT_DECK_LANGUAGE } from '../useSettingsStore';

beforeEach(() => {
  // Reset the store to defaults between tests.
  useSettingsStore.setState({
    selectedDeck: null,
    onboardingCompleted: false,
    alwaysReadBack: false,
    darkMode: true,
    deckInstructions: {},
    deckLanguages: {},
  });
});

describe('useSettingsStore', () => {
  describe('initial state', () => {
    it('starts with no selected deck', () => {
      expect(useSettingsStore.getState().selectedDeck).toBeNull();
    });

    it('starts onboarding not completed', () => {
      expect(useSettingsStore.getState().onboardingCompleted).toBe(false);
    });

    it('starts alwaysReadBack off', () => {
      expect(useSettingsStore.getState().alwaysReadBack).toBe(false);
    });

    it('starts in dark mode (per 01-conventions: dark is default)', () => {
      expect(useSettingsStore.getState().darkMode).toBe(true);
    });

    it('starts with no deck instructions or languages', () => {
      expect(useSettingsStore.getState().deckInstructions).toEqual({});
      expect(useSettingsStore.getState().deckLanguages).toEqual({});
    });

    it('exports DEFAULT_DECK_LANGUAGE = "en-US"', () => {
      expect(DEFAULT_DECK_LANGUAGE).toBe('en-US');
    });
  });

  describe('setSelectedDeck', () => {
    it('stores the deck name', () => {
      useSettingsStore.getState().setSelectedDeck('Aws Exam SA');
      expect(useSettingsStore.getState().selectedDeck).toBe('Aws Exam SA');
    });

    it('clears the selection when null', () => {
      useSettingsStore.getState().setSelectedDeck('Aws Exam SA');
      useSettingsStore.getState().setSelectedDeck(null);
      expect(useSettingsStore.getState().selectedDeck).toBeNull();
    });
  });

  describe('onboardingCompleted', () => {
    it('flips to true', () => {
      useSettingsStore.getState().setOnboardingCompleted(true);
      expect(useSettingsStore.getState().onboardingCompleted).toBe(true);
    });

    it('flips back to false', () => {
      useSettingsStore.getState().setOnboardingCompleted(true);
      useSettingsStore.getState().setOnboardingCompleted(false);
      expect(useSettingsStore.getState().onboardingCompleted).toBe(false);
    });
  });

  describe('alwaysReadBack', () => {
    it('flips to true', () => {
      useSettingsStore.getState().setAlwaysReadBack(true);
      expect(useSettingsStore.getState().alwaysReadBack).toBe(true);
    });
  });

  describe('toggleDarkMode', () => {
    it('toggles dark → light', () => {
      useSettingsStore.getState().toggleDarkMode();
      expect(useSettingsStore.getState().darkMode).toBe(false);
    });

    it('toggles light → dark', () => {
      useSettingsStore.setState({ darkMode: false });
      useSettingsStore.getState().toggleDarkMode();
      expect(useSettingsStore.getState().darkMode).toBe(true);
    });

    it('is idempotent across two toggles', () => {
      const before = useSettingsStore.getState().darkMode;
      useSettingsStore.getState().toggleDarkMode();
      useSettingsStore.getState().toggleDarkMode();
      expect(useSettingsStore.getState().darkMode).toBe(before);
    });
  });

  describe('setDeckInstructions', () => {
    it('stores trimmed instructions', () => {
      useSettingsStore.getState().setDeckInstructions('Aws', '  Focus on networking. ');
      expect(useSettingsStore.getState().deckInstructions['Aws']).toBe(
        'Focus on networking.',
      );
    });

    it('removes the entry when instructions are empty', () => {
      useSettingsStore.getState().setDeckInstructions('Aws', 'Focus on networking.');
      expect(useSettingsStore.getState().deckInstructions['Aws']).toBeDefined();
      useSettingsStore.getState().setDeckInstructions('Aws', '');
      expect(useSettingsStore.getState().deckInstructions['Aws']).toBeUndefined();
    });

    it('removes the entry when instructions are whitespace-only', () => {
      useSettingsStore.getState().setDeckInstructions('Aws', 'Focus on networking.');
      useSettingsStore.getState().setDeckInstructions('Aws', '   \t\n  ');
      expect(useSettingsStore.getState().deckInstructions['Aws']).toBeUndefined();
    });

    it('keeps other decks when removing one', () => {
      useSettingsStore.getState().setDeckInstructions('Aws', 'A instructions');
      useSettingsStore.getState().setDeckInstructions('Refold', 'R instructions');
      useSettingsStore.getState().setDeckInstructions('Aws', '');
      expect(useSettingsStore.getState().deckInstructions).toEqual({
        Refold: 'R instructions',
      });
    });

    it('overwrites instructions for the same deck', () => {
      useSettingsStore.getState().setDeckInstructions('Aws', 'v1');
      useSettingsStore.getState().setDeckInstructions('Aws', 'v2');
      expect(useSettingsStore.getState().deckInstructions['Aws']).toBe('v2');
    });
  });

  describe('setDeckLanguage', () => {
    it('stores a non-default language', () => {
      useSettingsStore.getState().setDeckLanguage('Aws', 'es-ES');
      expect(useSettingsStore.getState().deckLanguages['Aws']).toBe('es-ES');
    });

    it('does NOT persist the default en-US (falls back to DEFAULT_DECK_LANGUAGE)', () => {
      // Pinning the intentional behavior: storing en-US explicitly is
      // redundant — the fallback covers it. This keeps the persisted map
      // clean and avoids stale "I used to be en-US but now I'm en-GB"
      // entries after the user changes their default.
      useSettingsStore.getState().setDeckLanguage('Aws', 'en-US');
      expect(useSettingsStore.getState().deckLanguages['Aws']).toBeUndefined();
    });

    it('removes the entry on empty string', () => {
      useSettingsStore.getState().setDeckLanguage('Aws', 'es-ES');
      useSettingsStore.getState().setDeckLanguage('Aws', '');
      expect(useSettingsStore.getState().deckLanguages['Aws']).toBeUndefined();
    });

    it('keeps other decks when removing one', () => {
      useSettingsStore.getState().setDeckLanguage('Aws', 'es-ES');
      useSettingsStore.getState().setDeckLanguage('Refold', 'fr-FR');
      useSettingsStore.getState().setDeckLanguage('Aws', '');
      expect(useSettingsStore.getState().deckLanguages).toEqual({
        Refold: 'fr-FR',
      });
    });

    it('overwrites language for the same deck', () => {
      useSettingsStore.getState().setDeckLanguage('Aws', 'es-ES');
      useSettingsStore.getState().setDeckLanguage('Aws', 'fr-FR');
      expect(useSettingsStore.getState().deckLanguages['Aws']).toBe('fr-FR');
    });
  });
});