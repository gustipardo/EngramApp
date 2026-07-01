/**
 * Tests for tokenService — the Live-session auth broker (pre-launch blocker #1).
 *
 * Invariants pinned:
 *  - Payment bypassed (dev): use the raw key from config, never hit the network.
 *  - Payment required (release/prod): call `mintLiveToken` and return an
 *    ephemeral token; surface the "trial_expired" rejection to the caller.
 *
 * Mirrors the mocking pattern in trialService.test.ts.
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
      const fn = (...args: unknown[]) => mockCallable(name, ...args);
      return fn;
    },
  }),
}));

import { getLiveCredential } from "../tokenService";

beforeEach(() => {
  mockCallable.mockReset();
  mockRequiresPayment.mockReset();
  mockRequiresPayment.mockReturnValue(true);
  mockExtra.current = { geminiApiKey: "DEV_RAW_KEY" };
});

describe("tokenService — dev bypass (requiresPayment === false)", () => {
  beforeEach(() => mockRequiresPayment.mockReturnValue(false));

  it("returns the raw config key without any Cloud Function call", async () => {
    const cred = await getLiveCredential();
    expect(cred).toEqual({ kind: "key", value: "DEV_RAW_KEY" });
    expect(mockCallable).not.toHaveBeenCalled();
  });

  it("throws when the dev key is missing from config", async () => {
    mockExtra.current = {};
    await expect(getLiveCredential()).rejects.toThrow(/GEMINI_API_KEY/);
  });
});

describe("tokenService — production (requiresPayment === true)", () => {
  it("calls mintLiveToken and returns an ephemeral token", async () => {
    mockCallable.mockResolvedValueOnce({ data: { token: "auth_tokens/xyz" } });

    const cred = await getLiveCredential();

    expect(mockCallable).toHaveBeenCalledWith("mintLiveToken");
    expect(cred).toEqual({ kind: "token", value: "auth_tokens/xyz" });
  });

  it("throws when the function returns no token", async () => {
    mockCallable.mockResolvedValueOnce({ data: {} });
    await expect(getLiveCredential()).rejects.toThrow(/no token/);
  });

  it("propagates the trial_expired rejection from the broker", async () => {
    mockCallable.mockRejectedValueOnce(new Error("trial_expired"));
    await expect(getLiveCredential()).rejects.toThrow(/trial_expired/);
    expect(mockCallable).toHaveBeenCalledWith("mintLiveToken");
  });
});
