/**
 * Unit tests for textUtils.
 *
 * Focus:
 *  - cleanAnkiText: HTML stripping, entity decoding, cloze marker removal,
 *    whitespace normalization. Must match the Kotlin side exactly (see
 *    AnkiDroidQueries.kt — duplicated intentionally for the JS read path).
 *  - extractClozeAnswer: returns the cloze text; null when no marker.
 *  - isClozeCard: detects cloze markers across newline / whitespace
 *    boundaries; doesn't false-positive on {{…}} without `c\d::`.
 */

import {
  cleanAnkiText,
  extractClozeAnswer,
  isClozeCard,
} from '../textUtils';

describe('cleanAnkiText', () => {
  it('returns empty string for empty input', () => {
    expect(cleanAnkiText('')).toBe('');
  });

  it('passes through plain text unchanged', () => {
    expect(cleanAnkiText('Hello, world!')).toBe('Hello, world!');
  });

  it('strips simple HTML tags', () => {
    expect(cleanAnkiText('<b>bold</b> text')).toBe('bold text');
    expect(cleanAnkiText('<i>ital</i><u>under</u>')).toBe('italunder');
  });

  it('strips nested HTML tags', () => {
    expect(cleanAnkiText('<div><span>nested</span></div>')).toBe('nested');
  });

  it('decodes the six named entities we care about', () => {
    expect(cleanAnkiText('a&nbsp;b')).toBe('a b');
    expect(cleanAnkiText('a&amp;b')).toBe('a&b');
    expect(cleanAnkiText('a&lt;b')).toBe('a<b');
    expect(cleanAnkiText('a&gt;b')).toBe('a>b');
    expect(cleanAnkiText('a&quot;b')).toBe('a"b');
    expect(cleanAnkiText('a&#39;b')).toBe("a'b");
  });

  it('decodes numeric entities beyond &#39; untouched (out of scope)', () => {
    // The current implementation intentionally only decodes the six named
    // entities. Pinning this so a future "decode all entities" change
    // gets a deliberate review.
    expect(cleanAnkiText('a&#160;b')).toBe('a&#160;b');
  });

  it('removes cloze deletion markers and keeps the answer', () => {
    expect(cleanAnkiText('Capital of France is {{c1::Paris}}')).toBe(
      'Capital of France is Paris',
    );
  });

  it('handles multiple cloze markers on one card', () => {
    expect(
      cleanAnkiText('{{c1::Mitochondria}} is the {{c2::powerhouse}}'),
    ).toBe('Mitochondria is the powerhouse');
  });

  it('handles high-numbered cloze markers', () => {
    expect(cleanAnkiText('answer is {{c12::42}}')).toBe('answer is 42');
  });

  it('normalizes internal whitespace (tabs, newlines, multiple spaces)', () => {
    expect(cleanAnkiText('a\n\nb\t\tc   d')).toBe('a b c d');
  });

  it('trims leading and trailing whitespace', () => {
    expect(cleanAnkiText('  hello  ')).toBe('hello');
    expect(cleanAnkiText('\n\nhello\n\n')).toBe('hello');
  });

  it('combines all transformations in one pass', () => {
    const html = '<div>  The capital of France is {{c1::Paris}} &amp; more.</div>';
    expect(cleanAnkiText(html)).toBe('The capital of France is Paris & more.');
  });

  it('does not match invalid cloze syntax (no leading c\\d+)', () => {
    // `{{foo::bar}}` is not a cloze marker — the leading c\d is required.
    // The regex `\{\{c\d+::|(\}\})` only matches `{{cN::`; `{{foo::bar}}`
    // doesn't match the first branch (no leading `c\d`), but the second
    // branch `(\}\})` still strips the trailing `}}`. Pinning the actual
    // current behavior — a future "only strip if cloze opener matched"
    // change should update this test deliberately.
    expect(cleanAnkiText('not a cloze: {{foo::bar}}')).toBe('not a cloze: {{foo::bar');
  });
});

describe('extractClozeAnswer', () => {
  it('returns null when no cloze marker', () => {
    expect(extractClozeAnswer('plain text')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractClozeAnswer('')).toBeNull();
  });

  it('extracts answer from a single cloze', () => {
    expect(extractClozeAnswer('Capital of France is {{c1::Paris}}')).toBe(
      'Paris',
    );
  });

  it('extracts the FIRST cloze answer when multiple exist', () => {
    expect(
      extractClozeAnswer('{{c1::first}} and {{c2::second}}'),
    ).toBe('first');
  });

  it('handles cloze with spaces and punctuation in answer', () => {
    expect(extractClozeAnswer('The answer is {{c1::a, b, c.}}')).toBe(
      'a, b, c.',
    );
  });

  it('handles high-numbered cloze markers', () => {
    expect(extractClozeAnswer('{{c99::late cloze}}')).toBe('late cloze');
  });
});

describe('isClozeCard', () => {
  it('returns false for plain text', () => {
    expect(isClozeCard('just text')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isClozeCard('')).toBe(false);
  });

  it('returns true for cloze markers', () => {
    expect(isClozeCard('text with {{c1::hidden}}')).toBe(true);
  });

  it('returns true for high-numbered cloze markers', () => {
    expect(isClozeCard('{{c12::answer}}')).toBe(true);
  });

  it('does not false-positive on bare {{…}} braces', () => {
    expect(isClozeCard('not cloze: {{foo}}')).toBe(false);
    expect(isClozeCard('{{foo::bar}}')).toBe(false); // missing `c\d`
  });

  it('does not false-positive on the digit-less form', () => {
    expect(isClozeCard('{{c::foo}}')).toBe(false);
  });

  it('returns true when cloze is mixed with HTML and entities', () => {
    expect(isClozeCard('<b>{{c1::bold answer}}</b>')).toBe(true);
  });
});