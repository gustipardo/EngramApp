# Testing accounts

Seeded test accounts at fixed subscription tiers, for exercising the trial /
paywall / Pro flows **without paying anything**. Tiers are just fields in the
Firestore `users/{uid}` doc that `computeTrialStatus` (`functions/src/index.ts`)
reads — no Google Play purchase, no charge, ever.

Firebase project: **engram-3392a** · region **us-central1**.

## The accounts

| Account                       | Tier               | uid                            | What the app shows                     |
| ----------------------------- | ------------------ | ------------------------------ | -------------------------------------- |
| `gusm2003@gmail.com`          | Full access        | `eWuZ8rcTmsekEYNztSVf07LOuy32` | Engram Pro · **Yearly**, unlimited     |
| `sandbox17201@gmail.com`      | Free tier (trial)  | `yVIYuLpZCobnP7b8fAagc3OMs5R2` | Free trial · 7 days / 10 sessions left |
| `gustavomaralvarez@gmail.com` | Monthly subscriber | `HgQHol0Sfqd9UztjRxzCfhFCbPi1` | Engram Pro · **Monthly**, unlimited    |

Field values written per tier:

- **Full access** — `subscriptionStatus:"active"`, `subscriptionProductId: com.engram.app.yearly`. `computeTrialStatus` → `subscriptionActive:true`, `plan:"yearly"`. Effectively unlimited.
- **Monthly** — `subscriptionStatus:"active"`, `subscriptionProductId: com.engram.app.monthly` → `plan:"monthly"`, unlimited.
- **Free tier** — `subscriptionStatus:"none"`, fresh `trialStart` (now), `sessionCount:0` → `isActive:true`, 7 days / 10 sessions remaining. This is the only account that can hit the paywall.

> "Full access" and "Monthly" differ only by plan label (yearly vs monthly). Both are active subscriptions = unlimited. The yearly one stands in for a comp/owner "full access" account.

## How to sign in on the device

These accounts use Google Sign-In. On the device, sign in with the matching
Google account. `gusm2003` and `sandbox17201` already existed in Firebase Auth
(signed in during testing); `gustavomaralvarez` was created server-side with
`emailVerified:true`, so the first Google sign-in **links to the same uid**
(Firebase default "one account per email"). The seeded tier therefore applies on
first login.

Fresh-install test recipe (per `.claude/context/06-status.md`):

```bash
adb -s <serial> shell pm clear com.anonymous.RealtimeApiOnMobile
adb -s <serial> shell pm reset-permissions com.anonymous.RealtimeApiOnMobile
# open app → AnkiDroid permission → deck → sign in with the target account
```

## Re-seeding / resetting

Re-run any time (e.g. to reset the free-tier account after its trial is used up,
or after wiping data). Idempotent — looks up by email, creates the Auth user if
missing, merges the tier fields.

```bash
cd App/functions
firebase login        # once, if not already logged in
node scripts/seed-test-accounts.js
```

The script (`functions/scripts/seed-test-accounts.js`) authenticates with the
Firebase CLI's stored OAuth refresh token (no service-account key needed) and
prints each account's uid + resulting status summary.

## Important caveats

- **No real Play subscription backs the active accounts.** "Restore purchases"
  finds nothing; "Manage subscription" opens Google Play but there's no
  subscription there. That's expected — the entitlement lives only in Firestore.
- **Free-tier quota actually ticks.** `recordSession` increments `sessionCount`
  for `sandbox17201` on each session start; after 10 sessions or 7 days it flips
  to `trial_expired` and the paywall appears. Re-run the seeder to reset.
- **Active subscribers don't tick.** `recordSession` is a server-side no-op when
  `subscriptionStatus:"active"`, so the full/monthly accounts stay unlimited.
- **Buying still can't be completed on a sideloaded build** (see the paywall note
  in the session log): Play has no products configured for this APK. Use the
  free-tier account to _see_ the paywall; you can't complete a purchase locally.
- **`verifyPurchase` is still a security stub** (trusts the client) — unrelated
  pre-launch blocker, see `.claude/context/06-status.md`.
