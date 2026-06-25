/**
 * Layer 3 — real Gemini API, text-mode test.
 *
 * Skipped unless TEST_REAL_GEMINI=1 is set. Costs real API money
 * (a few cents per run). Validates that the system prompt + tool
 * definitions still elicit the right grading behavior end-to-end.
 *
 * Run:
 *   TEST_REAL_GEMINI=1 GEMINI_API_KEY=... npx jest realGemini.text
 */

jest.mock('expo-foreground-audio', () => ({
  __esModule: true,
  default: { addListener: jest.fn().mockReturnValue({ remove: jest.fn() }) },
}));

import { runFixtureAgainstRealGemini } from '../realGeminiTextRunner';
import {
  happyPath,
  mixedResults,
  overrideIncorrectToCorrect,
  overrideCorrectToIncorrect,
  endSessionToolMidDeck,
} from '../fixtures/scripts';

const SHOULD_RUN = process.env.TEST_REAL_GEMINI === '1';
const API_KEY = process.env.GEMINI_API_KEY ?? '';

const describeIfReal = SHOULD_RUN ? describe : describe.skip;

describeIfReal('Layer 3 — real Gemini text mode', () => {
  jest.setTimeout(120000);

  function checkKey() {
    if (!API_KEY) {
      throw new Error('GEMINI_API_KEY missing — set in env to run real-API tests');
    }
  }

  it('happy-path: grades clearly-correct answers correctly', async () => {
    checkKey();
    const result = await runFixtureAgainstRealGemini(happyPath, API_KEY, {
      logEvents: !!process.env.TEST_REAL_GEMINI_VERBOSE,
    });
    const matched = result.perTurn.filter((p) => p.matched).length;
    const total = result.perTurn.length;
    console.log(
      `[L3 happyPath] ${matched}/${total} turns matched, observed:`,
      result.observedFinalStats,
    );
    // 3/3 confident-correct answers — strict assertion.
    expect(matched).toBe(total);
  });

  it('mixed-results: handles correct, incorrect, and skipped in one session', async () => {
    checkKey();
    const result = await runFixtureAgainstRealGemini(mixedResults, API_KEY, {
      logEvents: !!process.env.TEST_REAL_GEMINI_VERBOSE,
    });
    const matched = result.perTurn.filter((p) => p.matched).length;
    const total = result.perTurn.length;
    console.log(
      `[L3 mixedResults] ${matched}/${total} turns matched, observed:`,
      result.observedFinalStats,
    );
    // Lenient — semantic grading is fuzzy. 3/4 is acceptable; 4/4 is ideal.
    expect(matched).toBeGreaterThanOrEqual(Math.ceil(total * 0.75));
  });

  it('override-incorrect-to-correct: AI calls override_evaluation when asked', async () => {
    checkKey();
    const result = await runFixtureAgainstRealGemini(
      overrideIncorrectToCorrect,
      API_KEY,
      { logEvents: !!process.env.TEST_REAL_GEMINI_VERBOSE },
    );
    // The AI should call override_evaluation (matched=true) on turn 1.
    const overrideTurn = result.perTurn.find((p) => p.turn.kind === 'override');
    console.log(
      `[L3 overrideIncorrect→Correct] override matched:`,
      overrideTurn?.matched,
      'observed tool:',
      overrideTurn?.observedGrade,
    );
    expect(overrideTurn?.matched).toBe(true);
  });

  it('override-correct-to-incorrect: AI calls override_evaluation when asked', async () => {
    checkKey();
    const result = await runFixtureAgainstRealGemini(
      overrideCorrectToIncorrect,
      API_KEY,
      { logEvents: !!process.env.TEST_REAL_GEMINI_VERBOSE },
    );
    const overrideTurn = result.perTurn.find((p) => p.turn.kind === 'override');
    console.log(
      `[L3 overrideCorrect→Incorrect] override matched:`,
      overrideTurn?.matched,
      'observed tool:',
      overrideTurn?.observedGrade,
    );
    expect(overrideTurn?.matched).toBe(true);
  });

  it('end-session: AI calls end_session when user asks to stop', async () => {
    checkKey();
    const result = await runFixtureAgainstRealGemini(
      endSessionToolMidDeck,
      API_KEY,
      { logEvents: !!process.env.TEST_REAL_GEMINI_VERBOSE },
    );
    const endTurn = result.perTurn.find((p) => p.turn.kind === 'endRequested');
    console.log(
      `[L3 endSession] end matched:`,
      endTurn?.matched,
      'observed tool:',
      endTurn?.observedGrade,
    );
    expect(endTurn?.matched).toBe(true);
  });
});

if (!SHOULD_RUN) {
  // Surface a clear hint so a curious dev knows the suite exists.
  // eslint-disable-next-line jest/no-export
  describe('Layer 3 — real Gemini text mode (gated)', () => {
    it.skip('set TEST_REAL_GEMINI=1 + GEMINI_API_KEY to run', () => {});
  });
}
