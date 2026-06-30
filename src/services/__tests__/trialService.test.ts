/**
 * Tests for trialService — the dev-bypass + cloud-call contract that
 * gates the entire paywall / quota flow. The single invariant the suite
 * pins: a dev binary (PAYMENT_REQUIRED unset) must NEVER call the
 * Cloud Functions, even if a stray `paymentRequired` extra leaked in.
 *
 * Mirrors the existing pattern in authService.test.ts.
 */

const mockCallable = jest.fn();
const mockRequiresPayment = jest.fn();
const mockExtra: { current: Record<string, unknown> } = { current: {} };

jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return { extra: mockExtra.current };
    },
  },
}));

jest.mock("../../config/env", () => ({
  requiresPayment: (...a: unknown[]) => mockRequiresPayment(...a),
}));

jest.mock("@react-native-firebase/functions", () => ({
  __esModule: true,
  default: () => ({
    httpsCallable: (name: string) => {
      // The call we make; tests assert which function was called by name.
      const fn = (...args: unknown[]) => mockCallable(name, ...args);
      return fn;
    },
  }),
}));

import { checkTrialStatus, recordSession } from "../trialService";

beforeEach(() => {
  mockCallable.mockReset();
  mockRequiresPayment.mockReset();
  // Default: payment required (production). Individual tests flip to
  // bypass mode.
  mockRequiresPayment.mockReturnValue(true);
  mockExtra.current = { paymentRequired: true };
});

describe("trialService — production mode (requiresPayment === true)", () => {
  it("checkTrialStatus calls the checkTrialStatus Cloud Function", async () => {
    mockCallable.mockResolvedValueOnce({
      data: {
        isActive: true,
        daysRemaining: 5,
        sessionsRemaining: 7,
        subscriptionActive: false,
      },
    });

    const status = await checkTrialStatus();

    expect(mockCallable).toHaveBeenCalledWith("checkTrialStatus");
    expect(mockCallable).toHaveBeenCalledTimes(1);
    expect(status).toEqual({
      isActive: true,
      daysRemaining: 5,
      sessionsRemaining: 7,
      subscriptionActive: false,
    });
  });

  it("recordSession calls the recordSession Cloud Function", async () => {
    mockCallable.mockResolvedValueOnce({
      data: {
        isActive: true,
        daysRemaining: 5,
        sessionsRemaining: 6, // decremented from 7
        subscriptionActive: false,
      },
    });

    const status = await recordSession();

    expect(mockCallable).toHaveBeenCalledWith("recordSession");
    expect(mockCallable).toHaveBeenCalledTimes(1);
    expect(status.sessionsRemaining).toBe(6);
  });

  it("recordSession swallows network errors and returns the unlocked shape", async () => {
    // Best-effort on the client: a transient blip must NOT block the
    // session. The function will catch up on the next checkTrialStatus.
    mockCallable.mockRejectedValueOnce(
      new Error("functions/network-unavailable"),
    );
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    const status = await recordSession();

    expect(status.isActive).toBe(true);
    expect(status.subscriptionActive).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("checkTrialStatus passes the server `plan` field through untouched", async () => {
    mockCallable.mockResolvedValueOnce({
      data: {
        isActive: true,
        daysRemaining: 0,
        sessionsRemaining: 0,
        subscriptionActive: true,
        plan: "yearly",
      },
    });

    const status = await checkTrialStatus();
    expect(status.plan).toBe("yearly");
  });
});

describe("trialService — dev bypass (requiresPayment === false)", () => {
  beforeEach(() => mockRequiresPayment.mockReturnValue(false));

  it("checkTrialStatus returns the unlocked shape without calling the function", async () => {
    const status = await checkTrialStatus();

    expect(mockCallable).not.toHaveBeenCalled();
    expect(status).toEqual({
      isActive: true,
      daysRemaining: 99,
      sessionsRemaining: 99,
      subscriptionActive: true,
    });
  });

  it("recordSession returns the unlocked shape without calling the function", async () => {
    const status = await recordSession();

    expect(mockCallable).not.toHaveBeenCalled();
    expect(status.isActive).toBe(true);
    expect(status.subscriptionActive).toBe(true);
  });

  it("the unlocked shape returned by both functions is identical", async () => {
    // Defensive — the two functions are used as drop-in replacements in
    // the dev path; if one returned a different shape the deck-select
    // banner would render different text mid-session.
    const a = await checkTrialStatus();
    const b = await recordSession();
    expect(a).toEqual(b);
  });
});
