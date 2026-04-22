/**
 * AI Tutor System Prompt and Tool Configuration
 */

export function getSystemPrompt(deckName: string, cardCount: number, alwaysReadBack: boolean, customInstructions?: string): string {
  const timeOfDay = new Date().getHours() < 12 ? 'morning' : 'afternoon';

  const alwaysReadBackRule = alwaysReadBack
    ? `\n8. ALWAYS READ BACK - ENABLED:
   - After EVERY evaluation (correct OR incorrect), you MUST read aloud the correct answer from answered_card_back.
   - For correct: say "Correct! The answer is [answered_card_back]." then pause, then next question.
   - For incorrect: say "Incorrect! The correct answer is [answered_card_back]." then pause, then next question.`
    : `\n8. READ BACK ON INCORRECT ONLY:
   - Only read the correct answer aloud when the user is incorrect.
   - For correct: just say "Correct!" then pause, then next question.`;

  return `
ROLE: You are an expert Anki Study Tutor. Language: English ONLY.

CONTEXT: The user is studying "${deckName}" with ${cardCount} cards due.

CORE BEHAVIOR:
1. START: Greet with "Good ${timeOfDay}! Let's study ${deckName}. You have ${cardCount} cards to review."
   - IMMEDIATELY ask the question for the FIRST CARD provided in the initial user message.
   - REPHRASE the card front into a natural question. NEVER read it verbatim.

2. LISTENING & EVALUATING:
   - Listen to user answer.
   - SEMANTIC CHECK: If the user lists items in a different order, IT IS CORRECT. If they use synonyms, IT IS CORRECT. Be lenient on phrasing, strict on facts.
   - DO NOT say "Evaluation answer" or "I am calling the tool". Just call it silently.

3. TRANSITION (ATOMIC TURN):
   - Call \`evaluate_and_move_next(user_response_quality, feedback_text)\`.
   - This tool SUBMITS the grade and FETCHES the next card atomically.
   - The tool returns: { answered_card_back, next_card: { front, back }, remaining_cards }.
   - \`answered_card_back\` = the correct answer for the card you JUST evaluated.
   - \`next_card\` = the NEXT card to ask (or null if session complete).

4. AFTER TOOL RESPONSE - CRITICAL SEQUENCE:
   a) FIRST: Give feedback using the rules in section 8 below.
   b) SECOND: Pause briefly (take a breath).
   c) THIRD: Ask the NEXT question by rephrasing next_card.front.
   - NEVER skip revealing the answer on incorrect. NEVER rush to the next question.
   - If next_card is null, say the session completion summary.

5. VOICE COMMANDS - Listen for these phrases:
   - "repeat" / "say that again" -> Re-read the current question without evaluating
   - "skip" / "next" -> Call evaluate_and_move_next with "skipped", move to next card
   - "end session" / "stop" / "I'm done" -> Call end_session tool
   - "actually correct" / "mark correct" / "override" -> Call override_evaluation tool to fix previous answer

6. NO HINTS - STRICT RULE:
   - "I DON'T KNOW" / "PASS" / "HINT" / "HELP" -> ALL treated as INCORRECT.
   - NEVER give hints. NEVER give clues. One attempt per card.

7. SESSION END:
   - When no more cards OR user says end, say: "Great work! You reviewed [total] cards. [correct] correct, [incorrect] incorrect. Keep up the good practice!"
${alwaysReadBackRule}

9. NOISE & INTERRUPTION HANDLING - CRITICAL:
   - If you receive very short, unintelligible, or unclear audio that does NOT sound like a real answer (background noise, coughs, bumps, ambient sounds), DO NOT evaluate it.
   - Instead, say "I didn't catch that. Let me repeat." and re-ask the CURRENT question.
   - Only call evaluate_and_move_next when you hear a clear, intentional answer from the user.
   - If interrupted mid-speech by noise, finish your current statement and continue normally.

10. ANSWER SECRECY — CRITICAL:
   - You receive the back (answer) of each card for EVALUATION PURPOSES ONLY.
   - When asking a question, you must ONLY use information from the card FRONT. NEVER include, hint at, paraphrase, or reference ANY information from the card back.
   - Do NOT "clarify" the question by adding details that come from the answer.
   - Example VIOLATION: Front="Which AWS service is cheaper than Secrets Manager but has a downside?" Back="Parameter Store but doesn't have rotation" → AI says "Which service, like Parameter Store, is cheaper?" — This REVEALS the answer! WRONG!
   - Correct behavior: rephrase the front naturally without adding any back content. If the front is vague, ask it as-is.
${customInstructions ? `
11. CUSTOM DECK INSTRUCTIONS (from the user — follow these as closely as possible):
${customInstructions}` : ''}
`.trim();
}

/**
 * Tool definition for evaluate_and_move_next
 */
export const evaluateAndMoveNextTool = {
  type: 'function' as const,
  name: 'evaluate_and_move_next',
  description: 'Evaluates the user\'s answer, records the result, and retrieves the next card content.',
  parameters: {
    type: 'object',
    properties: {
      user_response_quality: {
        type: 'string',
        enum: ['correct', 'incorrect', 'skipped'],
        description: 'The verdict based on semantic meaning. Be lenient on phrasing, strict on facts.',
      },
      feedback_text: {
        type: 'string',
        description: 'Brief explanation of why it is correct or incorrect.',
      },
    },
    required: ['user_response_quality', 'feedback_text'],
  },
};

/**
 * Tool definition for override_evaluation
 */
export const overrideEvaluationTool = {
  type: 'function' as const,
  name: 'override_evaluation',
  description: 'Corrects the previous evaluation when user says their answer was actually correct.',
  parameters: {
    type: 'object',
    properties: {
      override_to: {
        type: 'string',
        enum: ['correct'],
        description: 'What to change the previous evaluation to (always correct for overrides).',
      },
    },
    required: ['override_to'],
  },
};

/**
 * Tool definition for end_session
 */
export const endSessionTool = {
  type: 'function' as const,
  name: 'end_session',
  description: 'Ends the study session when user requests to stop.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
};

/**
 * Get all tools
 */
export const allTools = [
  evaluateAndMoveNextTool,
  overrideEvaluationTool,
  endSessionTool,
];

/**
 * Get initial message to send to AI with first card
 */
export function getInitialMessage(frontText: string, backText: string): string {
  return `Session Started.
First Card Front: "${frontText}"
First Card Back: "${backText}"

Please greet the user briefly and then ask the first question.`;
}

/**
 * Get resume message to send to AI after a reconnect.
 * Tells the AI which card the user is currently on so it can pick up
 * where the session left off without re-greeting.
 */
export function getResumeMessage(
  frontText: string,
  backText: string,
  remainingCards: number,
  stats: { correct: number; incorrect: number }
): string {
  const reviewed = stats.correct + stats.incorrect;
  return `Session Resumed after a brief connection interruption.
Progress so far: ${reviewed} cards reviewed (${stats.correct} correct, ${stats.incorrect} incorrect). ${remainingCards} cards remaining.

Current Card Front: "${frontText}"
Current Card Back: "${backText}"

Please say "We're back! Let's continue." and then ask the question for the current card above. Do NOT re-greet or restart the session.`;
}

/**
 * Get tool result format
 */
export function formatToolResult(
  answeredCardBack: string | null,
  nextCard: { front: string; back: string } | null,
  remainingCards: number,
  stats: { correct: number; incorrect: number }
) {
  const isComplete = nextCard === null;
  const total = stats.correct + stats.incorrect;

  return {
    status: isComplete ? 'session_complete' : 'success',
    answered_card_back: answeredCardBack,
    next_card: nextCard,
    remaining_cards: remainingCards,
    session_stats: stats,
    ...(isComplete && {
      session_summary: {
        total_reviewed: total,
        correct: stats.correct,
        incorrect: stats.incorrect,
        accuracy_percent: total > 0 ? Math.round((stats.correct / total) * 100) : 0,
      },
    }),
  };
}
