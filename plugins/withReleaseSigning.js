// Config plugin: release signing + R8, surviving `expo prebuild --clean`.
//
// The android/ directory is gitignored (CNG) — any hand edit to build.gradle
// is wiped on the next prebuild, so signing MUST be injected here.
//
// Reads keystore config from <project-root>/../keystore/keystore.properties
// (i.e. the `keystore/` folder next to App/, OUTSIDE the git repo):
//   storeFile=/abs/path/engram-release.jks
//   storePassword=...
//   keyAlias=engram
//   keyPassword=...
// If that file is missing (fresh clone, CI without secrets) release builds
// fall back to the debug keystore so dev workflows keep working.

const {
  withAppBuildGradle,
  withGradleProperties,
} = require("expo/config-plugins");

const SIGNING_GRADLE = `
    def engramKsPropsFile = rootProject.file("../../keystore/keystore.properties")
    def engramKsProps = new Properties()
    if (engramKsPropsFile.exists()) {
        engramKsPropsFile.withInputStream { engramKsProps.load(it) }
    }
`;

function patchBuildGradle(contents) {
  if (contents.includes("engramKsProps")) return contents; // idempotent

  // Load keystore.properties just inside the android { } block.
  contents = contents.replace(/android \{/, `android {\n${SIGNING_GRADLE}`);

  // Add the release signing config next to the template's debug one.
  contents = contents.replace(
    /signingConfigs \{\n(\s*)debug \{/,
    (_m, indent) =>
      `signingConfigs {\n` +
      `${indent}release {\n` +
      `${indent}    if (engramKsPropsFile.exists()) {\n` +
      `${indent}        storeFile file(engramKsProps['storeFile'])\n` +
      `${indent}        storePassword engramKsProps['storePassword']\n` +
      `${indent}        keyAlias engramKsProps['keyAlias']\n` +
      `${indent}        keyPassword engramKsProps['keyPassword']\n` +
      `${indent}    }\n` +
      `${indent}}\n` +
      `${indent}debug {`,
  );

  // Point the release buildType at it (falling back to debug when no keystore).
  contents = contents.replace(
    /(buildTypes \{[\s\S]*?release \{[^}]*?)signingConfig signingConfigs\.debug/,
    `$1signingConfig engramKsPropsFile.exists() ? signingConfigs.release : signingConfigs.debug`,
  );

  return contents;
}

module.exports = function withReleaseSigning(config) {
  config = withAppBuildGradle(config, (c) => {
    if (c.modResults.language !== "groovy") {
      throw new Error("withReleaseSigning: expected a groovy build.gradle");
    }
    c.modResults.contents = patchBuildGradle(c.modResults.contents);
    return c;
  });

  // R8/minify + resource shrinking — the Expo template's release buildType
  // already reads these two properties; we just flip them on.
  config = withGradleProperties(config, (c) => {
    const set = (key, value) => {
      const existing = c.modResults.find(
        (p) => p.type === "property" && p.key === key,
      );
      if (existing) existing.value = value;
      else c.modResults.push({ type: "property", key, value });
    };
    set("android.enableProguardInReleaseBuilds", "true");
    set("android.enableShrinkResourcesInReleaseBuilds", "true");
    return c;
  });

  return config;
};
