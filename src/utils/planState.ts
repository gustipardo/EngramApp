import type { TrialStatus } from "../services/trialService";

/**
 * The single user-facing plan state, derived from the server-provided
 * `TrialStatus` plus the dev payment-bypass flag. Centralizes the branching
 * so screens (settings, paywall, deck-select) render off one value instead of
 * each re-deriving `isActive && !subscriptionActive` ad hoc.
 *
 *  - dev_unlocked : the payment gate is bypassed in this dev binary — there is
 *                   no real entitlement and no billing UI to show. Impossible
 *                   in a release build (see `config/env.ts` layer 1).
 *  - unknown      : status not loaded yet (still fetching) — render a neutral
 *                   placeholder, never a billing decision.
 *  - subscribed   : an active paid subscription (overrides the trial).
 *  - trial_active : inside the free trial (days + sessions remaining).
 *  - trial_expired: trial used up and no subscription → paywall.
 */
export type PlanState =
  "dev_unlocked" | "subscribed" | "trial_active" | "trial_expired" | "unknown";

/**
 * Pure. `paymentBypassed` is checked first on purpose: in a bypassed dev binary
 * `trialService` hands back a fully-unlocked status (`subscriptionActive:true`),
 * so reading the status first would mislabel a dev run as a real subscriber.
 */
export function derivePlanState(
  status: TrialStatus | null,
  paymentBypassed: boolean,
): PlanState {
  if (paymentBypassed) return "dev_unlocked";
  if (!status) return "unknown";
  if (status.subscriptionActive) return "subscribed";
  if (status.isActive) return "trial_active";
  return "trial_expired";
}
