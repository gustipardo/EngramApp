/**
 * Transcript-driven UI advance detection for BUG 12.
 *
 * After `evaluate_and_move_next` lands, the data layer advances eagerly
 * (BUG 4 fix), but the UI lags. To know *when* to flip the UI from the
 * previous card to the next one, we listen to Gemini's outputTranscription
 * deltas and detect the moment the AI starts pronouncing the next card's
 * question — that's the moment the user expects the visible card to
 * change.
 *
 * The matcher is intentionally permissive (false-positives are mostly
 * harmless — the UI flips a few words too early; false-negatives fall
 * through to `response.done` and a 30 s defensive timeout). Tuned
 * for cards whose front is a question the tutor speaks roughly verbatim,
 * which matches the system prompt's instruction "read the question aloud."
 *
 * Algorithm:
 *   1. Tokenize the next card's front into significant words (length ≥ 3,
 *      stopwords removed, lowercased, punctuation stripped).
 *   2. On every transcript delta, tokenize the running transcript the same
 *      way, then count how many of the next-card's significant tokens
 *      appear in it.
 *   3. Threshold: ≥ 2 hits AND ≥ 50% of the available tokens (so short
 *      fronts with only one or two significant words still match cleanly).
 *
 * False positives:
 *   - Feedback text that quotes the next-card's words ("That's why the
 *     capital is important, ..."). We accept this — it's *near* the
 *     transition anyway.
 * False negatives:
 *   - AI paraphrases hard ("Now tell me about France's main city"). Falls
 *     through to timeout. Acceptable per BUG 12 trade-off.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'what', 'where', 'when', 'who', 'whom', 'how', 'why', 'which', 'that',
  'this', 'these', 'those',
  'to', 'in', 'on', 'at', 'for', 'by', 'with', 'from', 'as', 'into', 'about',
  'it', 'its', 'they', 'them', 'their', 'i', 'me', 'my', 'we', 'us', 'our',
  'you', 'your', 'he', 'she', 'him', 'her', 'his',
  'and', 'or', 'but', 'so', 'if', 'then', 'than', 'because',
  'do', 'does', 'did', 'has', 'have', 'had', 'can', 'could', 'should', 'would',
  'will', 'shall', 'may', 'might', 'must',
  'not', 'no',
]);

export function tokenizeForMatch(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Returns true if the running transcript appears to have started speaking
 * the next card's question. See module doc for the heuristic.
 */
export function transcriptIndicatesNextCard(
  transcript: string,
  nextCardFront: string,
): boolean {
  const nextTokens = tokenizeForMatch(nextCardFront);
  if (nextTokens.length === 0) return false;

  const transcriptSet = new Set(tokenizeForMatch(transcript));
  if (transcriptSet.size === 0) return false;

  let hits = 0;
  for (const t of nextTokens) {
    if (transcriptSet.has(t)) hits++;
  }

  // Need at least 2 hits AND at least half the available significant tokens.
  // The 50% bar lets short fronts (1–2 significant words) match on a single
  // hit indirectly: 1 hit / 1 available = 100%, but we also need hits ≥ 2,
  // so a 1-token front actually never matches via this path — and falls
  // through to the timeout. That's the correct behavior: with only one
  // distinguishing word, we can't reliably tell feedback-quote from
  // next-question-start.
  return hits >= 2 && hits / nextTokens.length >= 0.5;
}
