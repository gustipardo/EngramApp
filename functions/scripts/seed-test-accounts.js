/**
 * Seed Firestore `users/{uid}` docs for the test accounts at fixed tiers.
 *
 * No payment / Play Billing involved — tiers are just fields the backend
 * (`computeTrialStatus` in functions/src/index.ts) reads. See
 * ../../TESTING-ACCOUNTS.md for the full rationale and per-account expectations.
 *
 * Auth: reuses the Firebase CLI's stored OAuth refresh token (so you don't need
 * a service-account key). You must be logged in: `firebase login`.
 *
 * Run from the functions/ dir:
 *   node scripts/seed-test-accounts.js
 *
 * Re-run any time to reset (e.g. the free-tier account after its trial is
 * consumed). Idempotent: looks up each user by email, creates the Auth user if
 * missing (emailVerified=true so a later Google sign-in links to the same uid),
 * then merges the tier fields.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const PROJECT_ID = "engram-3392a";

// --- Build authorized_user creds from the Firebase CLI token ---------------
// The client_id/secret are the public, well-known firebase-tools OAuth client
// (embedded in the open-source CLI), not a secret.
const ftPath = path.join(
  os.homedir(),
  ".config/configstore/firebase-tools.json",
);
const ft = JSON.parse(fs.readFileSync(ftPath, "utf8"));
const refreshToken = ft.tokens && ft.tokens.refresh_token;
if (!refreshToken) {
  console.error(
    "No refresh token in firebase-tools.json — run `firebase login` first.",
  );
  process.exit(1);
}
const adcPath = path.join(os.tmpdir(), `engram-adc-${process.pid}.json`);
fs.writeFileSync(
  adcPath,
  JSON.stringify({
    type: "authorized_user",
    client_id:
      "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
    refresh_token: refreshToken,
  }),
);
process.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;

const admin = require("firebase-admin");
admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();
const auth = admin.auth();
const FV = admin.firestore.FieldValue;

// Product ids mirror billingService SKU_MAP.
const MONTHLY = "com.engram.app.monthly";
const YEARLY = "com.engram.app.yearly";

const ACCOUNTS = [
  {
    email: "gusm2003@gmail.com",
    displayName: "Gusti (Full access)",
    tier: "full",
    fields: {
      subscriptionStatus: "active",
      subscriptionProductId: YEARLY,
      subscriptionPurchaseToken: "TEST_SEED_FULL",
      sessionCount: 0,
    },
  },
  {
    email: "sandbox17201@gmail.com",
    displayName: "Sandbox (Free tier)",
    tier: "free_trial",
    fields: {
      subscriptionStatus: "none",
      subscriptionProductId: FV.delete(),
      subscriptionPurchaseToken: FV.delete(),
      sessionCount: 0,
      trialStart: FV.serverTimestamp(), // fresh trial clock
    },
  },
  {
    email: "gustavomaralvarez@gmail.com",
    displayName: "Gustavo (Monthly)",
    tier: "monthly",
    fields: {
      subscriptionStatus: "active",
      subscriptionProductId: MONTHLY,
      subscriptionPurchaseToken: "TEST_SEED_MONTHLY",
      sessionCount: 0,
    },
  },
];

// Mirror of functions computeTrialStatus, for a readable summary only.
const TRIAL_DAYS = 7;
const TRIAL_MAX_SESSIONS = 10;
function computeSummary(d) {
  if (d.subscriptionStatus === "active") {
    const plan =
      d.subscriptionProductId === YEARLY
        ? "yearly"
        : d.subscriptionProductId === MONTHLY
          ? "monthly"
          : null;
    return {
      isActive: true,
      subscriptionActive: true,
      plan,
      daysRemaining: 0,
      sessionsRemaining: 0,
    };
  }
  const start =
    d.trialStart && d.trialStart.toDate ? d.trialStart.toDate() : new Date();
  const days = (Date.now() - start.getTime()) / 86400000;
  const daysRemaining = Math.max(0, Math.ceil(TRIAL_DAYS - days));
  const sessionsRemaining = Math.max(
    0,
    TRIAL_MAX_SESSIONS - (d.sessionCount || 0),
  );
  return {
    isActive: daysRemaining > 0 && sessionsRemaining > 0,
    subscriptionActive: false,
    plan: null,
    daysRemaining,
    sessionsRemaining,
  };
}

(async () => {
  for (const acc of ACCOUNTS) {
    let uid,
      created = false;
    try {
      uid = (await auth.getUserByEmail(acc.email)).uid;
    } catch (e) {
      if (e.code === "auth/user-not-found") {
        uid = (
          await auth.createUser({
            email: acc.email,
            emailVerified: true,
            displayName: acc.displayName,
          })
        ).uid;
        created = true;
      } else {
        throw e;
      }
    }

    const ref = db.collection("users").doc(uid);
    const snap = await ref.get();
    const base = {
      createdAt: FV.serverTimestamp(),
      subscriptionUpdatedAt: FV.serverTimestamp(),
    };
    if (!snap.exists && !acc.fields.trialStart)
      base.trialStart = FV.serverTimestamp();

    await ref.set({ ...base, ...acc.fields }, { merge: true });
    const after = (await ref.get()).data();
    console.log(`\n=== ${acc.email} (${acc.tier}) ===`);
    console.log(
      `  uid: ${uid}${created ? "  [auth user CREATED]" : "  [auth user existed]"}`,
    );
    console.log(`  subscriptionStatus: ${after.subscriptionStatus}`);
    console.log(
      `  subscriptionProductId: ${after.subscriptionProductId || "(none)"}`,
    );
    console.log(`  sessionCount: ${after.sessionCount}`);
    console.log(`  summary: ${JSON.stringify(computeSummary(after))}`);
  }
  console.log("\nDone.");
  fs.unlinkSync(adcPath);
  process.exit(0);
})().catch((e) => {
  console.error("SEED FAILED:", e);
  try {
    fs.unlinkSync(adcPath);
  } catch (_) {}
  process.exit(1);
});
