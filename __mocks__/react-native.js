// Minimal react-native stub for Jest (node env).
// sessionManager imports PermissionsAndroid + Platform to request/pre-gate the
// mic (and notifications) before the foreground-service call.
// Default: check returns true (permission granted) — the happy path.
// Override per-test with jest.mock('react-native', () => ({ ... })).
module.exports = {
  Platform: {
    OS: "android",
    Version: 34,
    select: (obj) => obj && (obj.android ?? obj.default),
  },
  PermissionsAndroid: {
    PERMISSIONS: {
      RECORD_AUDIO: "android.permission.RECORD_AUDIO",
      POST_NOTIFICATIONS: "android.permission.POST_NOTIFICATIONS",
    },
    RESULTS: {
      GRANTED: "granted",
      DENIED: "denied",
      NEVER_ASK_AGAIN: "never_ask_again",
    },
    check: jest.fn().mockResolvedValue(true),
    request: jest.fn().mockResolvedValue("granted"),
  },
};
