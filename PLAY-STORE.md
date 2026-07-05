# Play Store deployment — policy & compliance notes

> Read before preparing a Google Play release or answering "is X allowed on Play?".
> Audience: future agents + the dev. Verdicts here reflect Google Play policy as of
> 2026-06-24; Play review is partly discretionary, so treat the "review risks"
> section as "what review will look at", not guarantees.

## TL;DR verdict

**The cross-app native modules are allowed.** Nothing about reading/writing AnkiDroid
or running a microphone foreground service is inherently against policy. The app does
**not** "interfere with other apps" in the policy sense. The things that actually
decide the review outcome are paperwork (a foreground-service declaration, an accurate
Data Safety disclosure) and one permanent config fix (the package id — done: `com.engram.app`)
— not the architecture.

## Why the AnkiDroid module is allowed (and is NOT "interference")

The `anki-droid` module talks to AnkiDroid through **AnkiDroid's own public, documented
ContentProvider API** (`FlashCardsContract`, authority `com.ichi2.anki.flashcards`),
which AnkiDroid publishes specifically for third-party apps. Access is gated by
AnkiDroid's custom permission `com.ichi2.anki.permission.READ_WRITE_DATABASE`, which the
**user must grant at runtime**.

Google Play's "interfering with other apps" rule (Device & Network Abuse policy) targets
apps that **modify, disrupt, hijack, or overlay** other apps **without consent**
(injection, unauthorized changes, click-jacking). Using another app's documented API,
with an explicit user-granted permission, is the opposite of that. There is no policy
problem with the bidirectional read/write integration itself.

Writing a grade back = `contentResolver.update(SCHEDULE_URI)` records a **review**
(Again/Easy → FSRS reschedule) in AnkiDroid's **local** collection. It does not edit
card content and does not push to AnkiWeb (sync is a separate, user-initiated action).
See `SESSION-FLOW.md` and the tool-call walkthrough for the data path.

## Current compliant state (verified in the repo, 2026-06-24)

These are already correct — do not "fix" them:

- `modules/anki-droid/android/src/main/AndroidManifest.xml`
  - declares `<uses-permission android:name="com.ichi2.anki.permission.READ_WRITE_DATABASE" />`
  - declares a **narrowly-scoped** `<queries><package android:name="com.ichi2.anki"/></queries>`
    — this is the Android 11+ package-visibility requirement done the right way.
- **Crucially NOT using `QUERY_ALL_PACKAGES`.** That permission is _restricted_, forces a
  Play Console declaration, and is frequently rejected. The scoped `<queries>` avoids it.
- Microphone foreground service is set up per Android 14 requirements:
  - `withForegroundAudioService.js` injects `FOREGROUND_SERVICE` +
    `FOREGROUND_SERVICE_MICROPHONE` and sets `android:foregroundServiceType="microphone"`.
  - `ForegroundAudioService.kt` calls `startForeground(..., FOREGROUND_SERVICE_TYPE_MICROPHONE)`.
- The app degrades when AnkiDroid is absent (`ankiBridge.isInstalled()` /
  `hasApiPermission()` guards) — avoids a crash-on-missing-dependency quality rejection.
- `CAMERA` and `SYSTEM_ALERT_WINDOW` were already removed from `app.json`
  (SYSTEM_ALERT_WINDOW "draw over other apps" is among the most-scrutinized permissions).

## Review risks, ranked (what to actually prepare)

### 1. Microphone foreground service + background audio — the real hurdle

The technical setup is compliant, but Play's **Foreground Service policy** still requires a
**Play Console declaration at submission** justifying the `microphone` FGS type, and
continuous mic access (especially screen-off) is high-scrutiny. A real-time voice tutor is
a legitimate, allowed use case. Expect to:

- fill the FGS declaration, and
- likely attach a **demo video** showing the in-session call-style notification and that
  recording happens **only during an active session**.
  The session-scoped capture + persistent notification are exactly the evidence reviewers want.

### 2. Data Safety form must disclose audio → Google Gemini (third party)

Audio streams to **Google Gemini**, a third party, even though it is never stored. The Play
**Data Safety** section must disclose: _Audio → collected, shared with a third party, for
app functionality_, and the **privacy policy must match**.

⚠️ **Wording trap:** marketing says "your audio never touches our backend." That is true
(no Engram server in the path) but the audio **does** go to Google/Gemini. The privacy
policy + Data Safety must say "processed by Google Gemini." A store disclosure that implies
_no one_ receives the audio is a **misrepresentation** flag. Keep the two consistent.

### 3. applicationId — DONE 2026-07-04

Renamed to **`com.engram.app`** (slug `engram`, scheme `engram://`) together with the Firebase
re-registration (new Android app `1:866005886684:android:18d4ab42615b4bc9d3f619`, debug+release
SHA-1s registered, fresh `google-services.json`). The applicationId is **immutable after the
first upload** — it is final.

### 4. Permissions hygiene

- ⚠️ `android.permission.BLUETOOTH` is still in `app.json`. Legacy `BLUETOOTH` is
  `maxSdkVersion=30`; on Android 12+ the equivalent is `BLUETOOTH_CONNECT`. If it's only for
  routing audio to BT headphones, the system typically handles routing without it — confirm
  it's actually needed or drop it. Unused/over-broad permissions draw review questions.
- Re-check the merged manifest before release for permissions injected by plugins
  (historically `READ/WRITE_EXTERNAL_STORAGE` can sneak in via a dependency).

### 5. Anki trademark in the store listing — legal + Play IP policy

"Anki"/"AnkiDroid" are trademarks (also an inviolable project constraint). Keep **Engram**
as the brand. **Factual/nominative** use in the description ("works with AnkiDroid", "studies
your AnkiDroid decks") is generally fine; do **not** use "Anki" in the **app title, icon, or
in any way implying endorsement/affiliation** — Play's Impersonation/IP policy can pull a
listing for that.

## Pre-submission checklist

- [x] Rename applicationId → `com.engram.app` (done 2026-07-04, before first upload).
- [ ] Prepare the **Foreground Service (microphone) declaration** + a demo video.
- [ ] Complete **Data Safety**: Audio = collected + shared with third party (Google Gemini),
      not stored; ensure the **privacy policy** matches and doesn't imply "no third party."
- [ ] Resolve `BLUETOOTH`: confirm it's needed (BT audio routing) or remove it; verify no
      stray storage permissions in the merged manifest.
- [ ] Store listing: Engram-branded, only nominative references to AnkiDroid, no "Anki" in
      title/icon.
- [ ] (Separate security blockers, not Play-policy but release-blocking — see
      `.claude/context/06-status.md` "Pre-launch blockers"): API key out of the APK, real
      signing keystore + R8, `firestore.rules`, `verifyPurchase` hardening.

## Not a concern (so nobody re-litigates it)

- The bidirectional AnkiDroid read/write module. It's a consented, documented integration.
- The `<queries>` declaration — already correct and minimal.
- "Interfering with other apps" — the app only touches AnkiDroid, via AnkiDroid's API, with
  permission; it does not modify, disrupt, or degrade any other app.
