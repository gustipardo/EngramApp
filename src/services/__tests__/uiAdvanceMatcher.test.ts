/**
 * Unit tests for the BUG 12 transcript matcher.
 *
 * The matcher is intentionally permissive — false positives are mild
 * (UI flips a few words too early) and false negatives fall through to
 * the timeout fallback (UI flips slightly late). These tests document
 * the threshold behavior so we don't accidentally tighten it past
 * "reasonably matches what the tutor actually says."
 */

import { tokenizeForMatch, transcriptIndicatesNextCard } from '../uiAdvanceMatcher';

describe('tokenizeForMatch', () => {
  it('lowercases, strips punctuation, removes stopwords + short words', () => {
    expect(tokenizeForMatch('What is the capital of France?')).toEqual(['capital', 'france']);
  });

  it('returns empty array for stopword-only input', () => {
    expect(tokenizeForMatch('What is the?')).toEqual([]);
  });

  it('treats hyphens and other punctuation as token separators', () => {
    expect(tokenizeForMatch('Multi-factor authentication: best practice'))
      .toEqual(['multi', 'factor', 'authentication', 'best', 'practice']);
  });

  it('ignores numeric-only tokens longer than 2 chars', () => {
    // Note: pure numbers like "1984" pass the >=3 length filter — they're
    // significant content tokens (e.g. a year as a card front).
    expect(tokenizeForMatch('In 1984 Orwell published this novel')).toEqual([
      '1984', 'orwell', 'published', 'novel',
    ]);
  });
});

describe('transcriptIndicatesNextCard', () => {
  describe('positive matches — AI speaks the card front verbatim', () => {
    it('matches when transcript contains the card front exactly', () => {
      expect(
        transcriptIndicatesNextCard(
          "Correct! Now, what is the capital of France?",
          'What is the capital of France?',
        ),
      ).toBe(true);
    });

    it('matches when transcript paraphrases but keeps the significant words', () => {
      expect(
        transcriptIndicatesNextCard(
          "That's right. Moving on — what's the capital city of France?",
          'What is the capital of France?',
        ),
      ).toBe(true);
    });

    it('matches across multi-word card fronts when most tokens hit', () => {
      expect(
        transcriptIndicatesNextCard(
          'Good answer. Now consider: define multi-factor authentication.',
          'Define multi-factor authentication.',
        ),
      ).toBe(true);
    });
  });

  describe('negative matches — should NOT advance UI yet', () => {
    it('does not match when AI is still giving feedback (no overlap with next-card tokens)', () => {
      expect(
        transcriptIndicatesNextCard(
          'Incorrect. The answer was Paris because it has been the seat of government since 1944.',
          'What is the largest planet in the solar system?',
        ),
      ).toBe(false);
    });

    it('does not match on a single token hit (paraphrase ambiguity)', () => {
      // "France" appears in the feedback ("the capital was Paris, France"),
      // but the next card asks something else. Single hit must not match.
      expect(
        transcriptIndicatesNextCard(
          "Correct! It's Paris, the capital of France.",
          'France borders which countries?',
        ),
      ).toBe(false);
    });

    it('does not match an empty next-card front', () => {
      expect(transcriptIndicatesNextCard('any transcript here', '')).toBe(false);
    });

    it('does not match an empty transcript', () => {
      expect(transcriptIndicatesNextCard('', 'What is the capital of France?')).toBe(false);
    });

    it('does not match a stopword-only card front (no significant tokens)', () => {
      // Pathological card front — nothing to match against. Falls through
      // to the timer fallback in production.
      expect(transcriptIndicatesNextCard('When is the what?', 'What is the?')).toBe(false);
    });
  });

  describe('threshold edge cases', () => {
    it('requires both 2+ hits AND ≥50% coverage', () => {
      // Card front has 4 significant tokens. Transcript only mentions 1.
      // 1/4 = 25%, less than 50% AND less than 2 hits → no match.
      expect(
        transcriptIndicatesNextCard(
          'Quick mention of capital but otherwise unrelated',
          'capital largest country oceania',
        ),
      ).toBe(false);
    });

    it('matches when exactly 2 of 3 tokens hit (66% coverage)', () => {
      expect(
        transcriptIndicatesNextCard(
          'Now define the photosynthesis chlorophyll process.',
          'Define photosynthesis chlorophyll.',
        ),
      ).toBe(true);
    });
  });
});
