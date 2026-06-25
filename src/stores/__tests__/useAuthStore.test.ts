// useAuthStore tests.
//
// authService is mocked at the module level so we control onAuthStateChanged.
// Each test re-imports the store fresh (jest.resetModules) because the store
// starts its listener at module load time; stale module state would bleed.

const mockOnAuthStateChanged = jest.fn();
const mockAuthBypassed = jest.fn();

jest.mock("../../services/authService", () => ({
  onAuthStateChanged: (...args: any[]) => mockOnAuthStateChanged(...args),
  FAKE_DEV_USER: {
    uid: "dev-user",
    email: "dev@engram.local",
    displayName: "Dev User",
    photoURL: null,
  },
}));

jest.mock("../../config/env", () => ({
  authBypassed: () => mockAuthBypassed(),
}));

function loadFreshStore() {
  jest.resetModules();
  // Re-apply mocks after module reset
  jest.mock("../../services/authService", () => ({
    onAuthStateChanged: (...args: any[]) => mockOnAuthStateChanged(...args),
    FAKE_DEV_USER: {
      uid: "dev-user",
      email: "dev@engram.local",
      displayName: "Dev User",
      photoURL: null,
    },
  }));
  jest.mock("../../config/env", () => ({
    authBypassed: () => mockAuthBypassed(),
  }));
  return require("../useAuthStore").useAuthStore;
}

describe("useAuthStore", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("bypass mode (dev default)", () => {
    it("starts authenticated with the fake dev user synchronously", () => {
      mockAuthBypassed.mockReturnValue(true);

      // In bypass, onAuthStateChanged fires the callback synchronously
      mockOnAuthStateChanged.mockImplementation((cb: (u: any) => void) => {
        cb({
          uid: "dev-user",
          email: "dev@engram.local",
          displayName: "Dev User",
          photoURL: null,
        });
        return () => {};
      });

      const useAuthStore = loadFreshStore();
      const state = useAuthStore.getState();

      expect(state.isAuthenticated).toBe(true);
      expect(state.isLoading).toBe(false);
      expect(state.user?.uid).toBe("dev-user");
    });

    it("isLoading starts false in bypass mode", () => {
      mockAuthBypassed.mockReturnValue(true);
      mockOnAuthStateChanged.mockImplementation((cb: (u: any) => void) => {
        cb({
          uid: "dev-user",
          email: "dev@engram.local",
          displayName: "Dev User",
          photoURL: null,
        });
        return () => {};
      });

      const useAuthStore = loadFreshStore();
      expect(useAuthStore.getState().isLoading).toBe(false);
    });
  });

  describe("real auth mode", () => {
    it("starts as loading+unauthenticated before Firebase fires", () => {
      mockAuthBypassed.mockReturnValue(false);
      // Simulate Firebase not having fired yet (async)
      mockOnAuthStateChanged.mockImplementation(() => () => {});

      const useAuthStore = loadFreshStore();
      const state = useAuthStore.getState();

      expect(state.isLoading).toBe(true);
      expect(state.isAuthenticated).toBe(false);
      expect(state.user).toBeNull();
    });

    it("becomes authenticated when Firebase fires with a user", () => {
      mockAuthBypassed.mockReturnValue(false);

      let captured: ((u: any) => void) | null = null;
      mockOnAuthStateChanged.mockImplementation((cb: (u: any) => void) => {
        captured = cb;
        return () => {};
      });

      const useAuthStore = loadFreshStore();
      expect(useAuthStore.getState().isAuthenticated).toBe(false);

      // Simulate Firebase resolving
      captured!({
        uid: "real-uid",
        email: "user@example.com",
        displayName: "Real User",
        photoURL: null,
      });

      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(true);
      expect(state.isLoading).toBe(false);
      expect(state.user?.uid).toBe("real-uid");
    });

    it("sets unauthenticated when Firebase fires with null (signed out)", () => {
      mockAuthBypassed.mockReturnValue(false);

      let captured: ((u: any) => void) | null = null;
      mockOnAuthStateChanged.mockImplementation((cb: (u: any) => void) => {
        captured = cb;
        return () => {};
      });

      const useAuthStore = loadFreshStore();
      // First sign in
      captured!({
        uid: "real-uid",
        email: "user@example.com",
        displayName: "Real User",
        photoURL: null,
      });
      expect(useAuthStore.getState().isAuthenticated).toBe(true);

      // Then sign out
      captured!(null);
      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(false);
      expect(state.user).toBeNull();
      expect(state.isLoading).toBe(false);
    });
  });
});
