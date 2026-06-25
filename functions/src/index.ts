import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";

admin.initializeApp();
const db = admin.firestore();

const TRIAL_DAYS = 7;
const TRIAL_MAX_SESSIONS = 10;

interface UserData {
  createdAt?: FirebaseFirestore.Timestamp;
  trialStart?: FirebaseFirestore.Timestamp;
  sessionCount?: number;
  subscriptionStatus?: "none" | "active";
  subscriptionProductId?: string;
  subscriptionPurchaseToken?: string;
  subscriptionUpdatedAt?: FirebaseFirestore.Timestamp;
}

export interface TrialStatus {
  isActive: boolean;
  daysRemaining: number;
  sessionsRemaining: number;
  subscriptionActive: boolean;
}

/**
 * Compute the trial status from a user doc. Pure — no I/O, no side effects.
 * Centralized so checkTrialStatus and recordSession return identical shapes
 * and the trial-clock math is defined in one place.
 *
 * Edge cases handled:
 *  - missing fields (first-time user, mid-update) — defaults from constants
 *  - subscription active — always returns active=true, counters 0
 *  - trialStart missing — falls back to now (shouldn't happen post-create-on-read)
 */
export function computeTrialStatus(userData: UserData | undefined): TrialStatus {
  if (userData?.subscriptionStatus === "active") {
    return {
      isActive: true,
      daysRemaining: 0,
      sessionsRemaining: 0,
      subscriptionActive: true,
    };
  }

  const trialStart = userData?.trialStart?.toDate?.() ?? new Date();
  const daysSinceTrial =
    (Date.now() - trialStart.getTime()) / (1000 * 60 * 60 * 24);
  const daysRemaining = Math.max(0, Math.ceil(TRIAL_DAYS - daysSinceTrial));
  const sessionsRemaining = Math.max(
    0,
    TRIAL_MAX_SESSIONS - (userData?.sessionCount ?? 0),
  );
  const isActive = daysRemaining > 0 && sessionsRemaining > 0;

  return {
    isActive,
    daysRemaining,
    sessionsRemaining,
    subscriptionActive: false,
  };
}

// ─── checkTrialStatus ───────────────────────────────────────────────
// Returns trial/subscription status. Create-on-read: if the user doc is
// missing, create it in a transaction with trialStart=now, sessionCount=0,
// subscriptionStatus='none'. This starts the trial clock at first status
// check (idempotent — second call finds the doc and just computes).
export const checkTrialStatus = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in");
  }

  const uid = request.auth.uid;
  const userRef = db.collection("users").doc(uid);

  // Transaction: create doc if missing, then read it back and compute.
  // Using a transaction (not a simple get + set) prevents two concurrent
  // first-time calls from both deciding to create and clobbering each
  // other. Firestore transactions re-read after the write and the
  // existence check inside makes the create a no-op on retry.
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) {
      tx.set(userRef, {
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        trialStart: admin.firestore.FieldValue.serverTimestamp(),
        sessionCount: 0,
        subscriptionStatus: "none",
      });
      // After creating, compute against the just-written defaults.
      // The fields we just set haven't propagated back to `snap` (it's
      // a stale read), so we use the same values directly.
      return computeTrialStatus({
        sessionCount: 0,
        subscriptionStatus: "none",
        trialStart: admin.firestore.Timestamp.now(),
        createdAt: admin.firestore.Timestamp.now(),
      });
    }
    return computeTrialStatus(snap.data() as UserData);
  });

  return result;
});

// ─── recordSession ──────────────────────────────────────────────────
// Atomic, subscription-aware. Called by the client when a session is
// about to start (after connect succeeds) — the trial cost is incurred
// the moment the audio socket opens, so we count on start, not on
// completion. Counting on start also prevents gaming by abandoning
// sessions mid-way.
//
//   - subscribed users: no-op, returns active status unchanged.
//   - trial users: sessionCount += 1 via FieldValue.increment.
//   - missing doc: created in the same transaction (mirrors
//     checkTrialStatus — defense in depth, but checkTrialStatus
//     always runs first in the normal flow).
export const recordSession = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in");
  }

  const uid = request.auth.uid;
  const userRef = db.collection("users").doc(uid);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    let data = snap.exists ? (snap.data() as UserData) : undefined;

    if (!data) {
      // Defense in depth: create the doc if it's somehow missing. In the
      // normal flow checkTrialStatus creates it on first call. The first
      // action after a fresh signup is usually a checkTrialStatus (the
      // deck-select screen), so this branch should be rare in practice.
      const fresh = {
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        trialStart: admin.firestore.FieldValue.serverTimestamp(),
        sessionCount: 0,
        subscriptionStatus: "none",
      };
      tx.set(userRef, fresh);
      data = {
        sessionCount: 0,
        subscriptionStatus: "none",
        trialStart: admin.firestore.Timestamp.now(),
        createdAt: admin.firestore.Timestamp.now(),
      };
    }

    if (data.subscriptionStatus === "active") {
      // Active subscription — no quota consumption, return as-is.
      return computeTrialStatus(data);
    }

    tx.update(userRef, {
      sessionCount: admin.firestore.FieldValue.increment(1),
    });

    // Compute the post-increment status. Re-read not needed for the
    // caller (we already know the rule: 10 - (count+1)); but going
    // through computeTrialStatus keeps the math in one place.
    return computeTrialStatus({
      ...data,
      sessionCount: (data.sessionCount ?? 0) + 1,
    });
  });

  return result;
});

// ─── verifyPurchase ─────────────────────────────────────────────────
// Called after a successful in-app purchase to update subscription status.
// Uses set(merge) instead of update() so the first purchase on a brand-new
// user (where checkTrialStatus hasn't run yet — race) doesn't throw.
//
// TODO: Verify purchase with Google Play Developer API
//   For now, trust the client and update status. See pre-launch blockers
//   in `.claude/context/06-status.md`.
export const verifyPurchase = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in");
  }

  const { purchaseToken, productId } = request.data as {
    purchaseToken: string;
    productId: string;
  };

  if (!purchaseToken || !productId) {
    throw new HttpsError("invalid-argument", "Missing purchaseToken or productId");
  }

  const uid = request.auth.uid;
  await db.collection("users").doc(uid).set(
    {
      subscriptionStatus: "active",
      subscriptionProductId: productId,
      subscriptionPurchaseToken: purchaseToken,
      subscriptionUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return { status: "success" };
});
