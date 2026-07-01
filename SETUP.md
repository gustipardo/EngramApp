# Setup Guide

This guide explains how to set up **Engram** (project slug: `RealtimeApiOnMobile` — pending rename, see `TODOLIST.md` P1) from scratch.

## Prerequisites

- **Node.js** (LTS version recommended)
- **npm** (bundled with Node.js)
- **Android Studio** with Android SDK and Emulator configured
- **Git**

## Installation Steps

1.  **Clone the Repository:**

    ```bash
    git clone <repository_url>
    cd RealtimeApiOnMobile   # current on-disk slug; rename pending
    ```

2.  **Install Dependencies:**

    Install the project dependencies using `npm`. Due to peer dependency conflicts between some Expo and React Native libraries, you may need to use the `--legacy-peer-deps` flag.

    ```bash
    npm install --legacy-peer-deps
    ```

3.  **Manual Linking of Local Modules:**

    The project relies on local modules located in the `modules/` directory: `anki-droid` and `expo-foreground-audio`. If automatic linking fails during installation, you must manually link them.

    Create symbolic links in `node_modules`:

    ```bash
    # Create links if they don't exist
    ln -s ../../modules/expo-foreground-audio node_modules/expo-foreground-audio
    ln -s ../../modules/anki-droid node_modules/anki-droid
    ```

    _Note: Verify that `node_modules/expo-foreground-audio` and `node_modules/anki-droid` point to the correct directories._

4.  **Environment variables:**

    The app uses Gemini Live as its single realtime backend. Env vars live in a dotenv file at the project root, read by `app.config.js` into `expoConfig.extra`:

    | Variable                                 | Required       | Purpose                                                                                                                                                                                                                              |
    | ---------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
    | `GEMINI_API_KEY`                         | dev builds     | Raw Gemini key for the dev bypass path (payment gate off). Production never reads it — release builds fetch ephemeral tokens from the `mintLiveToken` Cloud Function, and `app.config.js` nulls this key when `APP_MODE=production`. |
    | `APP_MODE`                               | release builds | `dev` / `production` / `test`. Unset → follows `__DEV__`. `production` is mandatory for releases (enforced by `scripts/build-release.sh`); `test` swaps the mic for `fakeMicSource`.                                                 |
    | `GOOGLE_WEB_CLIENT_ID`                   | real-auth runs | OAuth 2.0 "Web client" id from the Firebase project; consumed by `_layout.tsx` → `configureGoogleSignIn`. Falls back to the project's hardcoded web client id when unset.                                                            |
    | `AUTH_REQUIRED` / `PAYMENT_REQUIRED`     | optional (dev) | `true` forces the real auth / paywall flow in a dev binary (gates are bypassed by default). Impossible to bypass in release — see `src/config/env.ts`. Pass inline on the run command; no rebuild needed.                            |
    | `AUTO_START_DECK` + `AUTO_START_ENABLED` | optional (dev) | Autostart a session for the named deck on launch (test tooling; see `DEBUGGING.md`).                                                                                                                                                 |
    | `SKIP_ONBOARDING`                        | optional (dev) | Marks onboarding complete on first mount (used by `test-flow.sh` after `pm clear`).                                                                                                                                                  |
    | `EXPO_PUBLIC_SESSION_DEBUG_VERBOSE`      | optional (dev) | Verbose session logging (`sessionDebugLogger.ts`; inlined by Metro).                                                                                                                                                                 |

    Backend deploy (Cloud Functions): `cd functions && npm install && firebase deploy --only functions`. The Gemini key lives server-side in Cloud Secret Manager — set it once with `firebase functions:secrets:set GEMINI_API_KEY`.

5.  **Run the Android App:**

    Start the Metro bundler and launch the app on your connected Android emulator or device.

    ```bash
    npm run android
    ```

## Release builds

Always build releases through the wrapper script — never a bare `--variant release`:

```bash
scripts/build-release.sh
```

It exports `APP_MODE=production`, which makes `app.config.js` null out `extra.geminiApiKey` so the raw Gemini key never lands in the APK bundle (release runtime uses the `mintLiveToken` token broker instead). A bare `npx expo run:android --variant release` without the flag bakes the key in. `app.config.js` also prints a warning whenever a non-production config evaluation would embed the key.

## Troubleshooting

- **Dependency Conflicts:** If `npm install` fails, try deleting `node_modules` and `package-lock.json` and running `npm install --legacy-peer-deps` again.
- **Module Resolution Errors:** If the build fails with "Unable to resolve module", ensure the symlinks in step 3 are correctly set up.
- **Gradle Build Issues:** Clean the android build directory if you encounter strange build errors:
  ```bash
  cd android && ./gradlew clean && cd ..
  ```
