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

4.  **AI provider key:**

    The app uses Gemini Live as its single realtime backend. Add `GEMINI_API_KEY=...` to a `.env` file at the project root (read by `app.config.js` via `expo-constants`).

5.  **Run the Android App:**

    Start the Metro bundler and launch the app on your connected Android emulator or device.

    ```bash
    npm run android
    ```

## Troubleshooting

- **Dependency Conflicts:** If `npm install` fails, try deleting `node_modules` and `package-lock.json` and running `npm install --legacy-peer-deps` again.
- **Module Resolution Errors:** If the build fails with "Unable to resolve module", ensure the symlinks in step 3 are correctly set up.
- **Gradle Build Issues:** Clean the android build directory if you encounter strange build errors:
  ```bash
  cd android && ./gradlew clean && cd ..
  ```
