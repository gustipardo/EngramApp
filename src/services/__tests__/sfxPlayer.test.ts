/**
 * Unit tests for sfxPlayer.
 *
 * Focus:
 *  - preload creates exactly two AudioPlayer instances and is idempotent
 *  - play('correct') / play('incorrect') routes to the right player
 *  - play('skipped') is silent (no createAudioPlayer/seekTo/play calls)
 *  - back-to-back plays seekTo(0) before play (replay from start)
 *  - stop() pauses both players
 *  - errors from the native side are swallowed (SFX is non-critical)
 */

const fakePlayer = () => ({
  play: jest.fn(),
  pause: jest.fn(),
  seekTo: jest.fn(),
  remove: jest.fn(),
  isLoaded: true,
});

let createdPlayers: ReturnType<typeof fakePlayer>[] = [];
const mockCreateAudioPlayer = jest.fn(() => {
  const p = fakePlayer();
  createdPlayers.push(p);
  return p;
});

jest.mock('expo-audio', () => ({
  __esModule: true,
  createAudioPlayer: (...args: any[]) => mockCreateAudioPlayer(...args),
}));

jest.mock('../sessionDebugLogger', () => ({
  sessionLog: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const loadFreshModule = () => {
  jest.resetModules();
  createdPlayers = [];
  mockCreateAudioPlayer.mockClear();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../sfxPlayer').sfxPlayer as typeof import('../sfxPlayer').sfxPlayer;
};

describe('sfxPlayer.preload', () => {
  it('creates two AudioPlayer instances (correct + incorrect)', () => {
    const sfx = loadFreshModule();
    sfx.preload();
    expect(mockCreateAudioPlayer).toHaveBeenCalledTimes(2);
    expect(createdPlayers).toHaveLength(2);
  });

  it('is idempotent — calling preload twice does not double-create players', () => {
    const sfx = loadFreshModule();
    sfx.preload();
    sfx.preload();
    sfx.preload();
    expect(mockCreateAudioPlayer).toHaveBeenCalledTimes(2);
  });
});

describe('sfxPlayer.play', () => {
  it("plays the first player when quality is 'correct'", () => {
    const sfx = loadFreshModule();
    sfx.preload();
    const [correctP, incorrectP] = createdPlayers;
    sfx.play('correct');
    expect(correctP.seekTo).toHaveBeenCalledWith(0);
    expect(correctP.play).toHaveBeenCalledTimes(1);
    expect(incorrectP.play).not.toHaveBeenCalled();
  });

  it("plays the second player when quality is 'incorrect'", () => {
    const sfx = loadFreshModule();
    sfx.preload();
    const [correctP, incorrectP] = createdPlayers;
    sfx.play('incorrect');
    expect(incorrectP.seekTo).toHaveBeenCalledWith(0);
    expect(incorrectP.play).toHaveBeenCalledTimes(1);
    expect(correctP.play).not.toHaveBeenCalled();
  });

  it("is silent when quality is 'skipped'", () => {
    const sfx = loadFreshModule();
    sfx.preload();
    const [correctP, incorrectP] = createdPlayers;
    sfx.play('skipped');
    expect(correctP.play).not.toHaveBeenCalled();
    expect(incorrectP.play).not.toHaveBeenCalled();
    expect(correctP.seekTo).not.toHaveBeenCalled();
    expect(incorrectP.seekTo).not.toHaveBeenCalled();
  });

  it('lazily preloads on first play() if preload was never called', () => {
    const sfx = loadFreshModule();
    sfx.play('correct');
    expect(mockCreateAudioPlayer).toHaveBeenCalledTimes(2);
  });

  it('seeks to 0 before each play so back-to-back chimes replay from start', () => {
    const sfx = loadFreshModule();
    sfx.preload();
    const [correctP] = createdPlayers;
    sfx.play('correct');
    sfx.play('correct');
    expect(correctP.seekTo).toHaveBeenCalledTimes(2);
    expect(correctP.seekTo).toHaveBeenNthCalledWith(1, 0);
    expect(correctP.seekTo).toHaveBeenNthCalledWith(2, 0);
    expect(correctP.play).toHaveBeenCalledTimes(2);
  });

  it('swallows errors from the native player (SFX must never throw)', () => {
    const sfx = loadFreshModule();
    sfx.preload();
    const [correctP] = createdPlayers;
    correctP.play.mockImplementation(() => { throw new Error('native crash'); });
    expect(() => sfx.play('correct')).not.toThrow();
  });
});

describe('sfxPlayer.isPlayingRecently (audio-focus-loss filter)', () => {
  it('returns false before any play() call', () => {
    const sfx = loadFreshModule();
    expect(sfx.isPlayingRecently()).toBe(false);
  });

  it('returns true immediately after a play() call', () => {
    const sfx = loadFreshModule();
    sfx.play('correct');
    expect(sfx.isPlayingRecently()).toBe(true);
  });

  it('returns false again after the ignore window elapses', () => {
    const sfx = loadFreshModule();
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      sfx.play('correct');
      expect(sfx.isPlayingRecently()).toBe(true);
      now += 2_500; // beyond the 2000 ms window
      expect(sfx.isPlayingRecently()).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  it("does NOT extend the window when play('skipped') is called", () => {
    const sfx = loadFreshModule();
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      // Skipped is a no-op — should never set lastPlayAt.
      sfx.play('skipped');
      expect(sfx.isPlayingRecently()).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('sfxPlayer.stop', () => {
  it('pauses both players', () => {
    const sfx = loadFreshModule();
    sfx.preload();
    const [correctP, incorrectP] = createdPlayers;
    sfx.stop();
    expect(correctP.pause).toHaveBeenCalledTimes(1);
    expect(incorrectP.pause).toHaveBeenCalledTimes(1);
  });

  it('is safe to call before preload (no-op)', () => {
    const sfx = loadFreshModule();
    expect(() => sfx.stop()).not.toThrow();
    expect(mockCreateAudioPlayer).not.toHaveBeenCalled();
  });

  it('swallows pause errors', () => {
    const sfx = loadFreshModule();
    sfx.preload();
    const [correctP] = createdPlayers;
    correctP.pause.mockImplementation(() => { throw new Error('bad state'); });
    expect(() => sfx.stop()).not.toThrow();
  });
});

describe('sfxPlayer.play — BUG 13 isLoaded guard (reverted)', () => {
  // The v1 fix added a `!player.isLoaded` guard that blocked every play()
  // after the first one because expo-audio flips isLoaded back to false after
  // each playback completes (BUG 13 regression). The guard is removed; play()
  // always calls through regardless of isLoaded state.

  it('plays even when isLoaded is false (no guard)', () => {
    const sfx = loadFreshModule();
    sfx.preload();
    const [correctP] = createdPlayers;
    correctP.isLoaded = false;
    sfx.play('correct');
    expect(correctP.seekTo).toHaveBeenCalledWith(0);
    expect(correctP.play).toHaveBeenCalledTimes(1);
  });

  it('isPlayingRecently is true even after a play with isLoaded=false', () => {
    const sfx = loadFreshModule();
    sfx.preload();
    const [correctP] = createdPlayers;
    correctP.isLoaded = false;
    sfx.play('correct');
    expect(sfx.isPlayingRecently()).toBe(true);
  });

  it('plays on every call regardless of isLoaded toggling between calls', () => {
    const sfx = loadFreshModule();
    sfx.preload();
    const [correctP] = createdPlayers;
    correctP.isLoaded = true;
    sfx.play('correct');
    correctP.isLoaded = false; // simulates expo-audio flipping back after play ends
    sfx.play('correct');
    expect(correctP.play).toHaveBeenCalledTimes(2);
  });
});

describe('sfxPlayer.preloadAsync — BUG 13 load polling', () => {
  it('resolves once both players report isLoaded', async () => {
    const sfx = loadFreshModule();
    const promise = sfx.preloadAsync();
    // Both players start `isLoaded: true` per fakePlayer default →
    // poll's first check succeeds and resolves immediately.
    await expect(promise).resolves.toBeUndefined();
    expect(mockCreateAudioPlayer).toHaveBeenCalledTimes(2);
  });

  it('resolves after the load eventually completes', async () => {
    const sfx = loadFreshModule();
    // Construct players manually with isLoaded=false to simulate a slow load.
    mockCreateAudioPlayer.mockImplementationOnce(() => {
      const p = fakePlayer();
      p.isLoaded = false;
      createdPlayers.push(p);
      return p;
    });
    mockCreateAudioPlayer.mockImplementationOnce(() => {
      const p = fakePlayer();
      p.isLoaded = false;
      createdPlayers.push(p);
      return p;
    });

    const promise = sfx.preloadAsync();
    // Flip both players to loaded after a short delay (simulating real
    // expo-audio decode completion).
    setTimeout(() => {
      createdPlayers.forEach((p) => { p.isLoaded = true; });
    }, 80);

    await expect(promise).resolves.toBeUndefined();
  });
});

describe('sfxPlayer.release', () => {
  it('releases both players and resets initialized state', () => {
    const sfx = loadFreshModule();
    sfx.preload();
    const [correctP, incorrectP] = createdPlayers;
    sfx.release();
    expect(correctP.remove).toHaveBeenCalledTimes(1);
    expect(incorrectP.remove).toHaveBeenCalledTimes(1);
    // Next preload should re-create players (initialized was reset).
    sfx.preload();
    expect(mockCreateAudioPlayer).toHaveBeenCalledTimes(4);
  });
});
