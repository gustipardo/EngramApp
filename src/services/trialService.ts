import functions from "@react-native-firebase/functions";
import { requiresPayment } from "../config/env";

export interface TrialStatus {
  isActive: boolean;
  daysRemaining: number;
  sessionsRemaining: number;
  subscriptionActive: boolean;
  /**
   * Which plan an active subscriber is on, derived server-side from the
   * stored Play product id. `null`/absent when not subscribed. Optional so the
   * dev "unlocked" shape and older server responses stay valid.
   */
  plan?: "monthly" | "yearly" | null;
}

/**
 * The "fully unlocked" status returned when the payment gate is bypassed
 * (dev). Used by both checkTrialStatus and recordSession so the dev
 * experience never has to think about quota.
 */
function unlockedTrialStatus(): TrialStatus {
  return {
    isActive: true,
    daysRemaining: 99,
    sessionsRemaining: 99,
    subscriptionActive: true,
  };
}

/**
 * Check the user's trial/subscription status.
 * When payment is bypassed (dev), returns a fully-unlocked status so all
 * subscription-gated UI behaves as if the user has access.
 * Otherwise calls the cloud function to check Firestore.
 */
export async function checkTrialStatus(): Promise<TrialStatus> {
  if (!requiresPayment()) {
    return unlockedTrialStatus();
  }

  const callable = functions().httpsCallable("checkTrialStatus");
  const result = await callable();
  return result.data as TrialStatus;
}

/**
 * Consume one trial session and return the updated status. Called by the
 * client when a session is about to start (after the audio socket has
 * connected) so the trial cost is counted at the moment it's incurred.
 *
 *   - Payment bypassed (dev): no-op, returns the unlocked status without
 *     touching the network. Matches checkTrialStatus's bypass.
 *   - Payment required: calls the `recordSession` Cloud Function, which
 *     atomically increments sessionCount and returns the post-increment
 *     status. Subscribed users are no-ops server-side; the client still
 *     gets a TrialStatus back so the caller doesn't branch on the result.
 *
 * The function is best-effort: if it fails (network blip, function
 * unreachable), the session still proceeds — the worst case is that the
 * user gets one extra session beyond the cap before the next record
 * succeeds. We log the error rather than throwing, so the session start
 * is never blocked on a quota write.
 */
export async function recordSession(): Promise<TrialStatus> {
  if (!requiresPayment()) {
    return unlockedTrialStatus();
  }

  try {
    const callable = functions().httpsCallable("recordSession");
    const result = await callable();
    return result.data as TrialStatus;
  } catch (err) {
    console.warn(
      "[trial] recordSession failed — quota not consumed this turn",
      err,
    );
    // Best-effort: still report the status we can compute locally so the
    // UI doesn't crash. Return the unlocked shape so the session is never
    // blocked on a quota write; the server will catch up on the next call.
    return unlockedTrialStatus();
  }
}
