import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { GoogleGenAI } from "@google/genai";
import { androidpublisher, auth as gAuth } from "@googleapis/androidpublisher";
import { createHash } from "crypto";
import { logger } from "firebase-functions/v2";

admin.initializeApp();
const db = admin.firestore();

const TRIAL_DAYS = 7;
const TRIAL_MAX_SESSIONS = 10;

// Gemini API key lives only on the server now (Cloud Secret Manager). The app
// no longer ships it — it fetches a short-lived ephemeral token from
// mintLiveToken instead. Set with: firebase functions:secrets:set GEMINI_API_KEY
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

// Play product id → plan label. Mirrors SKU_MAP in src/services/billingService.ts.
// Duplicated here on purpose: functions is a standalone package and must not
// import from the app source tree.
const PRODUCT_PLAN: Record<string, "monthly" | "yearly"> = {
  "com.engram.app.monthly": "monthly",
  "com.engram.app.yearly": "yearly",
};

function planFromProductId(
  productId: string | undefined,
): "monthly" | "yearly" | null {
  return (productId && PRODUCT_PLAN[productId]) || null;
}

interface UserData {
  createdAt?: FirebaseFirestore.Timestamp;
  trialStart?: FirebaseFirestore.Timestamp;
  sessionCount?: number;
  subscriptionStatus?: "none" | "active";
  subscriptionProductId?: string;
  subscriptionPurchaseToken?: string;
  subscriptionUpdatedAt?: FirebaseFirestore.Timestamp;
  // From Google's purchases.subscriptions.get response. Absent on seeded
  // test accounts (they bypass verifyPurchase) — treated as non-expiring.
  subscriptionExpiryMillis?: number;
}

export interface TrialStatus {
  isActive: boolean;
  daysRemaining: number;
  sessionsRemaining: number;
  subscriptionActive: boolean;
  // Which plan an active subscriber is on (from subscriptionProductId); null
  // when not subscribed. Lets the client label "Engram Pro · Yearly".
  plan: "monthly" | "yearly" | null;
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
export function computeTrialStatus(
  userData: UserData | undefined,
): TrialStatus {
  const subExpiry = userData?.subscriptionExpiryMillis;
  const subUnexpired = subExpiry === undefined || subExpiry > Date.now();
  if (userData?.subscriptionStatus === "active" && subUnexpired) {
    return {
      isActive: true,
      daysRemaining: 0,
      sessionsRemaining: 0,
      subscriptionActive: true,
      plan: planFromProductId(userData.subscriptionProductId),
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
    plan: null,
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
// Full server-side validation (pre-launch blocker #2, closed 2026-07-04):
//
//   1. productId allow-list (only our Play subscription SKUs).
//   2. purchaseToken validated against Google Play Developer API
//      (purchases.subscriptions.get) using the function's runtime service
//      account via ADC. REQUIRES the service account to be granted access
//      in Play Console → Users and permissions (see FREE-QUOTA.md).
//   3. Idempotency: a purchaseToken is bound to the first uid that verifies
//      it (purchaseTokens/{sha256}); reuse on another account → already-exists.
//   4. Entitlement stored with Google's expiryTimeMillis, not a bare flag;
//      computeTrialStatus treats a past expiry as not subscribed, and the
//      weekly reverifySubscriptions job refreshes/expires it server-side.
//
// Uses set(merge) instead of update() so the first purchase on a brand-new
// user (where checkTrialStatus hasn't run yet — race) doesn't throw.

const PLAY_PACKAGE_NAME = "com.engram.app";

function tokenHash(purchaseToken: string): string {
  return createHash("sha256").update(purchaseToken).digest("hex");
}

/**
 * Validate a subscription purchase token against the Play Developer API.
 * Returns the expiry when the subscription is currently paid/entitled.
 * Throws HttpsError for definitive rejections; lets network/permission
 * errors surface as `internal` with a log (never silently grants).
 */
async function fetchPlaySubscription(
  productId: string,
  purchaseToken: string,
): Promise<{ expiryMillis: number; linkedPurchaseToken?: string }> {
  const auth = new gAuth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
  const publisher = androidpublisher({ version: "v3", auth });

  let sub;
  try {
    const res = await publisher.purchases.subscriptions.get({
      packageName: PLAY_PACKAGE_NAME,
      subscriptionId: productId,
      token: purchaseToken,
    });
    sub = res.data;
  } catch (err: unknown) {
    const code = (err as { code?: number; status?: number }).code ?? 0;
    if (code === 400 || code === 404 || code === 410) {
      // Definitive: token malformed, not found, or gone (refunded/expired
      // long ago). A made-up token lands here.
      throw new HttpsError("invalid-argument", "invalid_purchase_token");
    }
    // 401/403 = service account not linked in Play Console, or API not
    // enabled — a config problem, not a user problem. Don't grant.
    logger.error("Play API subscription lookup failed", {
      productId,
      code,
      err: String(err),
    });
    throw new HttpsError("internal", "purchase_verification_unavailable");
  }

  const expiryMillis = Number(sub.expiryTimeMillis ?? 0);
  if (!expiryMillis || expiryMillis <= Date.now()) {
    throw new HttpsError("failed-precondition", "subscription_expired");
  }
  return {
    expiryMillis,
    linkedPurchaseToken: sub.linkedPurchaseToken ?? undefined,
  };
}

export const verifyPurchase = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in");
  }

  const { purchaseToken, productId } = request.data as {
    purchaseToken: string;
    productId: string;
  };

  if (!purchaseToken || !productId) {
    throw new HttpsError(
      "invalid-argument",
      "Missing purchaseToken or productId",
    );
  }

  // Allow-list: only our own Play subscription products can grant an
  // entitlement. Without this, any signed-in client could flip itself to
  // subscriptionStatus='active' with a made-up productId.
  if (!planFromProductId(productId)) {
    throw new HttpsError("invalid-argument", `Unknown productId: ${productId}`);
  }

  const uid = request.auth.uid;

  // Server-side validation BEFORE any write.
  const { expiryMillis, linkedPurchaseToken } = await fetchPlaySubscription(
    productId,
    purchaseToken,
  );

  // Bind token → uid atomically. Doc id is the token's sha256 (tokens are
  // long and their charset isn't guaranteed doc-id-safe).
  const tokenRef = db
    .collection("purchaseTokens")
    .doc(tokenHash(purchaseToken));
  const userRef = db.collection("users").doc(uid);

  await db.runTransaction(async (tx) => {
    const tokenSnap = await tx.get(tokenRef);
    if (tokenSnap.exists && tokenSnap.data()?.uid !== uid) {
      // Same token already granted an entitlement to a different account.
      throw new HttpsError("already-exists", "purchase_token_already_used");
    }
    tx.set(tokenRef, {
      uid,
      productId,
      // On upgrades/downgrades Play issues a new token linked to the old
      // one; kept for audit/debugging.
      linkedPurchaseToken: linkedPurchaseToken ?? null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.set(
      userRef,
      {
        subscriptionStatus: "active",
        subscriptionProductId: productId,
        subscriptionPurchaseToken: purchaseToken,
        subscriptionExpiryMillis: expiryMillis,
        subscriptionUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });

  return { status: "success", expiryMillis };
});

// ─── reverifySubscriptions ──────────────────────────────────────────
// Weekly server-side re-check of every 'active' subscription against the
// Play Developer API, so lapsed/refunded subs lose access even though the
// client never reports cancellation (Play owns the cancel flow).
//
//   - Renewed: refresh subscriptionExpiryMillis.
//   - Expired/refunded/invalid token: flip subscriptionStatus → 'none'
//     (fields kept for audit; the user falls back to trial math).
//   - Seeded test accounts (TEST_SEED_* tokens, no real Play purchase)
//     are skipped — they exist only in Firestore.
//   - Transient API errors: log and leave the user untouched (grace);
//     the next weekly run retries. computeTrialStatus also hard-stops
//     entitlement at the stored expiry regardless of this job.
export const reverifySubscriptions = onSchedule(
  "every monday 09:00",
  async () => {
    const snap = await db
      .collection("users")
      .where("subscriptionStatus", "==", "active")
      .get();

    for (const doc of snap.docs) {
      const data = doc.data() as UserData;
      const token = data.subscriptionPurchaseToken;
      const productId = data.subscriptionProductId;
      if (!token || !productId || token.startsWith("TEST_SEED_")) continue;
      if (!planFromProductId(productId)) continue;

      try {
        const { expiryMillis } = await fetchPlaySubscription(productId, token);
        await doc.ref.set(
          {
            subscriptionExpiryMillis: expiryMillis,
            subscriptionUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      } catch (err: unknown) {
        const httpsErr = err as HttpsError;
        const definitive =
          httpsErr.code === "invalid-argument" ||
          httpsErr.code === "failed-precondition";
        if (definitive) {
          await doc.ref.set(
            {
              subscriptionStatus: "none",
              subscriptionUpdatedAt:
                admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
          logger.info("Subscription expired/revoked", {
            uid: doc.id,
            productId,
          });
        } else {
          logger.warn("Re-verify transient failure, skipping user", {
            uid: doc.id,
            err: String(err),
          });
        }
      }
    }
  },
);

// ─── mintLiveToken ──────────────────────────────────────────────────
// Token broker (pre-launch blocker #1). Mints a short-lived, single-use
// Gemini ephemeral token so the raw API key never ships in the APK. The
// client opens the Live WebSocket with this token in the `?access_token=`
// query param (v1alpha) instead of `?key=<apiKey>`.
//
// Server-side gate (defense in depth): only signed-in users with an active
// trial or subscription get a token. This makes the broker a second quota
// wall — even a tampered client can't obtain a token once the trial is spent.
//
// The token is single-use, expiring ~30 min out with a ~2 min window to
// start the session.
//
// DELIBERATELY NO `liveConnectConstraints`: when the token carries
// constraints (even model-only), the BidiGenerateContentConstrained
// endpoint replaces the client's whole `setup` with the token's locked
// config — silently dropping `tools`, `systemInstruction` and both
// transcription configs. The tutor then never calls
// evaluate_and_move_next and the session can't advance (verified against
// the live API 2026-07-01: constrained token → no toolCall + empty
// transcripts; unconstrained token → identical behavior to the raw-key
// path). Our setup is dynamic per session (deck prompt, tools), so it
// must come from the client. The single-use + short expiry + auth/trial
// gate remain the abuse controls.
export const mintLiveToken = onCall(
  { secrets: [GEMINI_API_KEY] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be signed in");
    }

    const uid = request.auth.uid;
    const snap = await db.collection("users").doc(uid).get();
    const status = computeTrialStatus(
      snap.exists ? (snap.data() as UserData) : undefined,
    );

    // Gate: active subscription OR live trial. Mirror the client's paywall
    // logic so the token can't be minted for an expired free user.
    if (!status.subscriptionActive && !status.isActive) {
      throw new HttpsError("failed-precondition", "trial_expired");
    }

    const ai = new GoogleGenAI({
      apiKey: GEMINI_API_KEY.value(),
      httpOptions: { apiVersion: "v1alpha" },
    });

    const now = Date.now();
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(now + 2 * 60 * 1000).toISOString(),
        // NO liveConnectConstraints — see the header comment. A constrained
        // token makes the server ignore the client's setup (tools, system
        // prompt, transcriptions), which breaks the entire study loop.
      },
    });

    if (!token.name) {
      throw new HttpsError("internal", "Token mint returned no name");
    }

    return { token: token.name };
  },
);
