// useTrialStore tests.
//
// trialService is mocked so tests run offline.
// The store is re-imported fresh per describe block because it holds
// async state that would bleed between tests otherwise.

const mockCheckTrialStatus = jest.fn();

jest.mock("../../services/trialService", () => ({
  checkTrialStatus: () => mockCheckTrialStatus(),
}));

import { useTrialStore } from "../useTrialStore";

beforeEach(() => {
  jest.clearAllMocks();
  // Reset store to a clean slate between tests
  useTrialStore.setState({ status: null, isChecking: false });
});

const ACTIVE_TRIAL: import("../../services/trialService").TrialStatus = {
  isActive: true,
  daysRemaining: 5,
  sessionsRemaining: 7,
  subscriptionActive: false,
};

const EXPIRED_TRIAL: import("../../services/trialService").TrialStatus = {
  isActive: false,
  daysRemaining: 0,
  sessionsRemaining: 0,
  subscriptionActive: false,
};

const SUBSCRIBED: import("../../services/trialService").TrialStatus = {
  isActive: true,
  daysRemaining: 0,
  sessionsRemaining: 0,
  subscriptionActive: true,
};

describe("useTrialStore", () => {
  describe("initial state", () => {
    it("starts with null status and not checking", () => {
      const state = useTrialStore.getState();
      expect(state.status).toBeNull();
      expect(state.isChecking).toBe(false);
    });
  });

  describe("refresh()", () => {
    it("updates status with the returned trial status", async () => {
      mockCheckTrialStatus.mockResolvedValue(ACTIVE_TRIAL);

      await useTrialStore.getState().refresh();

      const state = useTrialStore.getState();
      expect(state.status).toEqual(ACTIVE_TRIAL);
      expect(state.isChecking).toBe(false);
    });

    it("reflects an expired trial", async () => {
      mockCheckTrialStatus.mockResolvedValue(EXPIRED_TRIAL);

      await useTrialStore.getState().refresh();

      expect(useTrialStore.getState().status).toEqual(EXPIRED_TRIAL);
    });

    it("reflects an active subscription", async () => {
      mockCheckTrialStatus.mockResolvedValue(SUBSCRIBED);

      await useTrialStore.getState().refresh();

      const { status } = useTrialStore.getState();
      expect(status?.subscriptionActive).toBe(true);
    });

    it("clears isChecking on success", async () => {
      mockCheckTrialStatus.mockResolvedValue(ACTIVE_TRIAL);
      await useTrialStore.getState().refresh();
      expect(useTrialStore.getState().isChecking).toBe(false);
    });

    it("clears isChecking even when checkTrialStatus throws", async () => {
      mockCheckTrialStatus.mockRejectedValue(new Error("network"));
      await useTrialStore.getState().refresh();
      expect(useTrialStore.getState().isChecking).toBe(false);
    });

    it("leaves status unchanged when checkTrialStatus throws", async () => {
      // Pre-seed a status
      useTrialStore.setState({ status: ACTIVE_TRIAL });
      mockCheckTrialStatus.mockRejectedValue(new Error("network"));

      await useTrialStore.getState().refresh();

      // Status should be unchanged — don't wipe a good status on a blip
      expect(useTrialStore.getState().status).toEqual(ACTIVE_TRIAL);
    });

    it("overwrites stale status on subsequent successful refresh", async () => {
      mockCheckTrialStatus.mockResolvedValueOnce(ACTIVE_TRIAL);
      await useTrialStore.getState().refresh();
      expect(useTrialStore.getState().status?.daysRemaining).toBe(5);

      mockCheckTrialStatus.mockResolvedValueOnce(EXPIRED_TRIAL);
      await useTrialStore.getState().refresh();
      expect(useTrialStore.getState().status?.isActive).toBe(false);
    });
  });
});
