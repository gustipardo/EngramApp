import { derivePlanState } from "../planState";
import type { TrialStatus } from "../../services/trialService";

const status = (p: Partial<TrialStatus>): TrialStatus => ({
  isActive: false,
  daysRemaining: 0,
  sessionsRemaining: 0,
  subscriptionActive: false,
  ...p,
});

describe("derivePlanState", () => {
  it("dev bypass wins over any status (incl. the unlocked dev shape)", () => {
    expect(derivePlanState(null, true)).toBe("dev_unlocked");
    expect(
      derivePlanState(
        status({ subscriptionActive: true, isActive: true }),
        true,
      ),
    ).toBe("dev_unlocked");
  });

  it("null status (not bypassed) → unknown (still loading)", () => {
    expect(derivePlanState(null, false)).toBe("unknown");
  });

  it("active subscription → subscribed", () => {
    expect(
      derivePlanState(
        status({ subscriptionActive: true, isActive: true }),
        false,
      ),
    ).toBe("subscribed");
  });

  it("trial with days + sessions left → trial_active", () => {
    expect(
      derivePlanState(
        status({ isActive: true, daysRemaining: 5, sessionsRemaining: 8 }),
        false,
      ),
    ).toBe("trial_active");
  });

  it("trial used up, no subscription → trial_expired", () => {
    expect(derivePlanState(status({ isActive: false }), false)).toBe(
      "trial_expired",
    );
  });

  it("subscription takes priority over an expired trial", () => {
    expect(
      derivePlanState(
        status({ isActive: false, subscriptionActive: true }),
        false,
      ),
    ).toBe("subscribed");
  });
});
