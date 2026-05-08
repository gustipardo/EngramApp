import type { AnkiCard } from '../../types/anki';
import { awsExamSaCards } from './aws-exam-sa';

/**
 * A turn in a replay script.
 *
 * - `answer`: user answers the current card; AI grades it via
 *   evaluate_and_move_next; harness asserts the AnkiDroid write.
 * - `override`: user objects to the previous evaluation; AI calls
 *   override_evaluation; harness asserts the corrective AnkiDroid write.
 * - `endRequested`: user asks to end; AI calls end_session.
 * - `silentGrade`: AI verbalises a verdict ("correct" / "incorrect")
 *   but never calls evaluate_and_move_next. The card must NOT advance,
 *   stats must NOT change, no popup state, no AnkiDroid write. This
 *   pins the contract: a verdict without a tool call has zero side
 *   effects on session state.
 * - `toolCallNoAudio`: AI calls evaluate_and_move_next but never speaks
 *   afterward — no `response.audio.delta` ever fires. Currently the
 *   session sticks in `evaluating` and the visual card never advances.
 *   The fixture documents that stuck state so any future recovery
 *   mechanism (timeout, force-advance) flips the assertion deliberately.
 */
export type Turn =
  | {
      kind: 'answer';
      userSaid: string;
      aiGraded: 'correct' | 'incorrect' | 'skipped';
      feedbackText?: string;
      expectWriteback?: { cardId: number; pass: boolean } | null;
    }
  | {
      kind: 'override';
      userSaid: string;
      to: 'correct' | 'incorrect';
      expectWriteback?: { cardId: number; pass: boolean } | null;
      expectStatus?: 'success' | 'no_change';
    }
  | {
      kind: 'endRequested';
      userSaid: string;
    }
  | {
      kind: 'silentGrade';
      userSaid: string;
      /** What the AI's audio claimed. Documentation only — never grades. */
      aiSaid: string;
    }
  | {
      kind: 'toolCallNoAudio';
      userSaid: string;
      aiGraded: 'correct' | 'incorrect' | 'skipped';
      feedbackText?: string;
    };

export interface Fixture {
  name: string;
  cards: AnkiCard[];
  turns: Turn[];
  expectedFinalStats?: { correct: number; incorrect: number };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const happyPath: Fixture = {
  name: 'happy-path-all-correct',
  cards: awsExamSaCards.slice(0, 3),
  turns: [
    {
      kind: 'answer',
      userSaid: 'subnet level',
      aiGraded: 'correct',
      expectWriteback: { cardId: awsExamSaCards[0].cardId, pass: true },
    },
    {
      kind: 'answer',
      userSaid: 'automated backups of EBS snapshots',
      aiGraded: 'correct',
      expectWriteback: { cardId: awsExamSaCards[1].cardId, pass: true },
    },
    {
      kind: 'answer',
      userSaid: 'only with NLB and elastic IPs',
      aiGraded: 'correct',
      expectWriteback: { cardId: awsExamSaCards[2].cardId, pass: true },
    },
  ],
  expectedFinalStats: { correct: 3, incorrect: 0 },
};

export const mixedResults: Fixture = {
  name: 'mixed-correct-incorrect-skip',
  cards: awsExamSaCards.slice(0, 4),
  turns: [
    {
      kind: 'answer',
      userSaid: 'subnet level',
      aiGraded: 'correct',
      expectWriteback: { cardId: awsExamSaCards[0].cardId, pass: true },
    },
    {
      kind: 'answer',
      userSaid: 'I have no idea',
      aiGraded: 'incorrect',
      expectWriteback: { cardId: awsExamSaCards[1].cardId, pass: false },
    },
    {
      kind: 'answer',
      userSaid: 'skip',
      aiGraded: 'skipped',
      expectWriteback: null,
    },
    {
      kind: 'answer',
      userSaid: 'a threat detection service',
      aiGraded: 'correct',
      expectWriteback: { cardId: awsExamSaCards[3].cardId, pass: true },
    },
  ],
  expectedFinalStats: { correct: 2, incorrect: 1 },
};

/**
 * User answers card 1 wrong, then immediately objects:
 *   "actually that was correct, mark it correct"
 * Expects override_evaluation to flip + write back ease=4 (pass).
 */
export const overrideIncorrectToCorrect: Fixture = {
  name: 'override-incorrect-to-correct',
  cards: awsExamSaCards.slice(0, 2),
  turns: [
    {
      kind: 'answer',
      userSaid: 'wrong-sounding answer',
      aiGraded: 'incorrect',
      expectWriteback: { cardId: awsExamSaCards[0].cardId, pass: false },
    },
    {
      kind: 'override',
      userSaid: 'actually that was correct, mark it correct',
      to: 'correct',
      expectWriteback: { cardId: awsExamSaCards[0].cardId, pass: true },
      expectStatus: 'success',
    },
    {
      kind: 'answer',
      userSaid: 'EBS snapshot backups',
      aiGraded: 'correct',
      expectWriteback: { cardId: awsExamSaCards[1].cardId, pass: true },
    },
  ],
  expectedFinalStats: { correct: 2, incorrect: 0 },
};

/**
 * User answers card 1 right, then objects:
 *   "actually that was wrong, mark it incorrect"
 * Tests the new bidirectional override.
 */
export const overrideCorrectToIncorrect: Fixture = {
  name: 'override-correct-to-incorrect',
  cards: awsExamSaCards.slice(0, 2),
  turns: [
    {
      kind: 'answer',
      userSaid: 'subnet level',
      aiGraded: 'correct',
      expectWriteback: { cardId: awsExamSaCards[0].cardId, pass: true },
    },
    {
      kind: 'override',
      userSaid: 'actually I was wrong, mark it incorrect',
      to: 'incorrect',
      expectWriteback: { cardId: awsExamSaCards[0].cardId, pass: false },
      expectStatus: 'success',
    },
    {
      kind: 'answer',
      userSaid: 'EBS snapshot backups',
      aiGraded: 'correct',
      expectWriteback: { cardId: awsExamSaCards[1].cardId, pass: true },
    },
  ],
  expectedFinalStats: { correct: 1, incorrect: 1 },
};

export const overrideNoChange: Fixture = {
  name: 'override-with-nothing-to-flip',
  cards: awsExamSaCards.slice(0, 1),
  turns: [
    // Right out of the gate, user calls override before any answer recorded.
    {
      kind: 'override',
      userSaid: 'mark the previous one correct',
      to: 'correct',
      expectWriteback: null,
      expectStatus: 'no_change',
    },
  ],
};

/**
 * AI says "correct" out loud but never calls evaluate_and_move_next.
 * Contract: verdict without tool call has zero side effects — no write,
 * no stat change, no popup state, card stays. Catches the user-reported
 * "tutor mentions correct/incorrect but no popup shows" bug at the JS
 * layer (the AI-behavior side is the Layer 3 catchment).
 */
export const silentGradeNoToolCall: Fixture = {
  name: 'silent-grade-no-tool-call',
  cards: awsExamSaCards.slice(0, 2),
  turns: [
    {
      kind: 'silentGrade',
      userSaid: 'subnet level',
      aiSaid: '"Correct! Moving on…" — but never fires evaluate_and_move_next',
    },
  ],
};

/**
 * AI silent-grades, then on the next turn does grade properly. Verifies
 * the session can recover and continues to write only the genuinely
 * graded card.
 */
export const silentGradeThenRealGrade: Fixture = {
  name: 'silent-grade-then-real-grade',
  cards: awsExamSaCards.slice(0, 2),
  turns: [
    {
      kind: 'silentGrade',
      userSaid: 'subnet level',
      aiSaid: 'mumbles ambiguously',
    },
    {
      kind: 'answer',
      userSaid: 'subnet level',
      aiGraded: 'correct',
      expectWriteback: { cardId: awsExamSaCards[0].cardId, pass: true },
    },
  ],
};

/**
 * AI calls the tool but never speaks afterward — no audio.delta, no
 * second response.done. Session sticks in `evaluating`, visual card
 * never advances despite the tool result + write being correct.
 * Pins the current stuck-state behavior so any future recovery
 * mechanism (timeout, fallback advance) explicitly breaks this fixture
 * and forces an intentional update.
 */
export const toolCallNoAudio: Fixture = {
  name: 'tool-call-no-audio-stuck',
  cards: awsExamSaCards.slice(0, 2),
  turns: [
    {
      kind: 'toolCallNoAudio',
      userSaid: 'subnet level',
      aiGraded: 'correct',
    },
  ],
};

export const allFixtures = {
  happyPath,
  mixedResults,
  overrideIncorrectToCorrect,
  overrideCorrectToIncorrect,
  overrideNoChange,
  silentGradeNoToolCall,
  silentGradeThenRealGrade,
  toolCallNoAudio,
};
