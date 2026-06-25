// Stub for static asset imports under Jest. Metro/Expo turn `require('./x.mp3')`
// into an opaque asset descriptor at build time; Jest with babel-jest has no
// such transform. Mapping all binary asset extensions here keeps `require()`
// from blowing up when a test pulls in a module that references SFX/images.
module.exports = 1;
