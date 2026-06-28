#!/usr/bin/env node
/**
 * grant-full-access.js — give an account permanent full access (no paywall).
 *
 * Sets `users/{uid}.subscriptionStatus = "active"` in Firestore, which
 * `computeTrialStatus` (functions/src/index.ts) reads as unlocked-forever
 * (isActive:true, subscriptionActive:true). No payment, no trial clock.
 *
 * Usage:
 *   node scripts/grant-full-access.js <email-or-uid> [path/to/serviceAccountKey.json]
 *
 * The service-account key is downloaded from the Firebase console:
 *   Project settings → Service accounts → Generate new private key.
 * Either pass its path as the 2nd arg, or set GOOGLE_APPLICATION_CREDENTIALS.
 *
 * Examples:
 *   node scripts/grant-full-access.js gusm2003@gmail.com ./sa-key.json
 *   GOOGLE_APPLICATION_CREDENTIALS=./sa-key.json node scripts/grant-full-access.js <uid>
 *
 * To REVOKE later: re-run with the same target and append `revoke`:
 *   node scripts/grant-full-access.js gusm2003@gmail.com ./sa-key.json revoke
 */

// Resolve firebase-admin from this folder or from functions/node_modules.
let admin;
try {
  admin = require("firebase-admin");
} catch {
  admin = require("../functions/node_modules/firebase-admin");
}

async function main() {
  const target = process.argv[2];
  const keyPathArg =
    process.argv[3] && !/^revoke$/i.test(process.argv[3])
      ? process.argv[3]
      : undefined;
  const revoke = process.argv.includes("revoke");

  if (!target) {
    console.error(
      "Usage: node scripts/grant-full-access.js <email-or-uid> [serviceAccountKey.json] [revoke]",
    );
    process.exit(1);
  }

  // Init admin SDK. Prefer an explicit key file; else GOOGLE_APPLICATION_CREDENTIALS.
  if (keyPathArg) {
    const path = require("path");
    const serviceAccount = require(path.resolve(keyPathArg));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  } else {
    console.error(
      "No credentials. Pass a service-account key path as arg 2, or set " +
        "GOOGLE_APPLICATION_CREDENTIALS to its path.",
    );
    process.exit(1);
  }

  // Resolve the uid: looks like an email? look it up; else treat as a uid.
  let uid = target;
  if (target.includes("@")) {
    const user = await admin.auth().getUserByEmail(target);
    uid = user.uid;
    console.log(`Resolved ${target} → uid ${uid}`);
  }

  const newStatus = revoke ? "none" : "active";
  await admin
    .firestore()
    .collection("users")
    .doc(uid)
    .set({ subscriptionStatus: newStatus }, { merge: true });

  console.log(
    `✓ users/${uid}.subscriptionStatus = "${newStatus}" ` +
      (revoke ? "(full access REVOKED)" : "(FULL ACCESS granted)"),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Failed:", err.message || err);
  process.exit(1);
});
