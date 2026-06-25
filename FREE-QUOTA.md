# Free quota / trial — design & implementation plan

> Status (2026-06-24): **designed, not yet built.** Auth backend = Firebase Auth +
> Google Sign-In (decided). This doc is the handoff for implementing the trial so a
> newly-logged-in user can try the app before purchase is required.

## Goal

A new user signs in (Google → Firebase Auth) and gets a **free trial**. When the trial
is exhausted, the paywall is required. Usage must be tracked **server-side** so the
client can't extend its own quota.

## Trial model

Trial = **7 days OR 10 sessions, whichever runs out first**, then paywall. An active
subscription overrides the trial (unlimited).

These numbers already exist as constants in `functions/src/index.ts`
(`TRIAL_DAYS = 7`, `TRIAL_MAX_SESSIONS = 10`) — they're product knobs, change freely.

**Why session-count (not just time):** each voice session has real Gemini audio-token
cost (the #1 economic risk in `docs/`). A session cap bounds trial cost directly; the
7-day window stops a dormant trial from living forever.

## Data model — Firestore `users/{uid}`

```
{
  createdAt:           Timestamp,   // first login
  trialStart:          Timestamp,   // when the trial clock starts (= first status check)
  sessionCount:        number,      // trial sessions consumed (server-incremented)
  subscriptionStatus:  'none' | 'active',
  subscriptionProductId?:    string,
  subscriptionPurchaseToken?: string,
  subscriptionUpdatedAt?:    Timestamp,
}
```

`TrialStatus` returned to the client (already the shape in `trialService.ts`):
`{ isActive, daysRemaining, sessionsRemaining, subscriptionActive }`.

## Enforcement points

- **On app open / before showing decks:** `checkTrialStatus()` → if `!isActive`, route to paywall.
- **On session start** (`sessionManager.startSession`, after a successful connect): call
  `recordSession()` to consume one trial session. Count on **start**, not completion —
  the cost is incurred when the socket opens, and counting on start prevents gaming by
  abandoning sessions. Skipped/no-ops when subscribed or when payment is bypassed (dev).

## Gaps in the CURRENT Cloud Functions (this is the work)

`functions/src/index.ts` today has `checkTrialStatus` + `verifyPurchase`, but the trial
is **not actually functional**:

1. **No user doc is ever created on first login.** `checkTrialStatus` returns the default
   for a missing doc but never writes one, so `trialStart` is never set → **the trial
   clock never starts** and `daysRemaining` never counts down.
2. **`sessionCount` is never incremented** anywhere → `sessionsRemaining` never decreases
   → **the quota is never enforced.**
3. **`verifyPurchase` uses `.update()`**, which throws if the doc doesn't exist (it won't,
   per gap 1) → should be `.set(..., { merge: true })`.

## Implementation plan (ordered)

1. **`functions/src/index.ts`:**
   - Extract `computeTrialStatus(userData)` + constants into a shared helper.
   - `checkTrialStatus`: **create-on-read** — in a transaction, if `users/{uid}` is
     missing, create it with `createdAt`, `trialStart = now`, `sessionCount = 0`,
     `subscriptionStatus = 'none'`; then compute from the (now-existing) doc. This starts
     the trial clock at first status check and guarantees the doc exists for later calls.
   - **New `recordSession` callable:** in a transaction, ensure the doc; if subscribed →
     no-op (return active); else `sessionCount += 1` via `FieldValue.increment(1)`; return
     the updated `TrialStatus`.
   - `verifyPurchase`: switch `.update()` → `.set(..., { merge: true })`.
2. **`firestore.rules`** (currently MISSING — also a pre-launch blocker): `users/{uid}`
   readable by `request.auth.uid == uid`; **writes only via Cloud Functions** (deny direct
   client writes to `sessionCount`/`subscriptionStatus` so quota can't be cheated).
3. **Client `trialService.ts`:** add `recordSession(): Promise<TrialStatus>` calling the
   new callable; bypass path (`!requiresPayment()`) returns the unlocked status (no call),
   matching `checkTrialStatus`'s existing bypass.
4. **Wire `recordSession()` into `sessionManager.startSession`** (after successful connect).
5. **Paywall gating in `deck-select`:** block "start session" when `!isActive`, route to
   `paywall.tsx`. (This is auth/payment **M2** — see `06-status.md` Session 7.)

## Dev bypass (already done — M0)

In a dev binary with payment bypassed (default), `trialService.checkTrialStatus()` returns
a fully-unlocked status and `recordSession()` should no-op — no Firestore, no quota. Set
`PAYMENT_REQUIRED=true` to exercise the real trial flow. See `src/config/env.ts`.

## Tests to add

- Cloud Functions: `checkTrialStatus` create-on-read sets `trialStart` once; `recordSession`
  increments and is subscription-aware; `verifyPurchase` set-merge on missing doc. (No
  functions test harness exists yet — may need to scaffold one.)
- App jest: `trialService.recordSession()` bypass path returns unlocked without calling the
  function (mirrors the existing `checkTrialStatus` pattern).
