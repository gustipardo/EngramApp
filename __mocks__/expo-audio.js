// Stub for expo-audio under Jest. The real package isn't installed when only
// `npm install --legacy-peer-deps` was run against an older lockfile, and we
// don't want unit tests to require a native install. Individual tests that
// need to assert behavior can still `jest.mock('expo-audio', factory)` on top
// of this stub.
const noop = () => {};
const createAudioPlayer = () => ({
  play: noop,
  pause: noop,
  seekTo: noop,
  remove: noop,
});

module.exports = {
  __esModule: true,
  createAudioPlayer,
};
