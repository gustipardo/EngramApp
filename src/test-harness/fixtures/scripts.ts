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
    }
  | {
      /** Synthetic — fires `webrtcManager.onConnectionDropped` to drive
       *  the reconnect path. No user transcript, no tool call. The
       *  runner awaits the reconnect flow before the next turn. */
      kind: 'connectionDropped';
      /** Optional: simulate the reconnect() call returning false.
       *  Default: reconnect succeeds. */
      reconnectFails?: boolean;
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

/**
 * Answer the LAST card in the deck → session should end cleanly:
 *   - phase transitions to `session_complete`
 *   - onSessionComplete runs (clears state, fires Analytics)
 *   - stopForegroundService is called
 *   - No further cards advance (no tool call fired because Gemini knows
 *     it's the last one and should call end_session or signal completion)
 *
 * The runner verifies the phase + foreground-service cleanup.
 */
export const endOfDeck: Fixture = {
  name: 'end-of-deck',
  cards: awsExamSaCards.slice(0, 2),
  turns: [
    {
      kind: 'answer',
      userSaid: 'subnet level',
      aiGraded: 'correct',
      expectWriteback: { cardId: awsExamSaCards[0].cardId, pass: true },
    },
    {
      // Last card answered → next card is null → session_complete.
      kind: 'answer',
      userSaid: 'EBS snapshot backups',
      aiGraded: 'correct',
      expectWriteback: { cardId: awsExamSaCards[1].cardId, pass: true },
    },
  ],
  expectedFinalStats: { correct: 2, incorrect: 0 },
};

/**
 * User invokes `end_session` MID-DECK (after card 1 of 2). Validates:
 *   - AI calls end_session tool
 *   - Phase transitions to session_complete
 *   - Only the cards answered before end_session got written back
 *   - The remaining cards were NOT written (no phantom grade)
 */
export const endSessionToolMidDeck: Fixture = {
  name: 'end-session-tool-mid-deck',
  cards: awsExamSaCards.slice(0, 3),
  turns: [
    {
      kind: 'answer',
      userSaid: 'subnet level',
      aiGraded: 'correct',
      expectWriteback: { cardId: awsExamSaCards[0].cardId, pass: true },
    },
    {
      // User says "I'm done" → AI calls end_session
      kind: 'endRequested',
      userSaid: "I'm done for today",
    },
    // The remaining card (awsExamSaCards[1], awsExamSaCards[2]) must NOT
    // be written. The runner verifies ankiWrites stays at length 1.
  ],
  expectedFinalStats: { correct: 1, incorrect: 0 },
};

/**
 * Connection drops mid-session (after card 1 of 2). Validates:
 *   - onConnectionDropped handler fires
 *   - sessionManager transitions to `reconnecting`
 *   - reconnect() is called
 *   - Resume message is sent (proves session context was replayed)
 *   - User can answer card 2 normally after the reconnect
 *
 * Critical: a successful reconnect must NOT double-write the already-
 * answered card (proves the resume replays from current state, not from
 * the start).
 */
export const reconnectMidSession: Fixture = {
  name: 'reconnect-mid-session',
  cards: awsExamSaCards.slice(0, 2),
  turns: [
    {
      kind: 'answer',
      userSaid: 'subnet level',
      aiGraded: 'correct',
      expectWriteback: { cardId: awsExamSaCards[0].cardId, pass: true },
    },
    {
      kind: 'connectionDropped',
      // Synthetic event — no transcript. The runner fires onConnectionDropped.
    },
    // After reconnect, the session should be back to a usable state.
    // The runner fires one more "post-reconnect answer" to verify the
    // session is fully functional.
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
 * Connection drops AND reconnect FAILS. Validates:
 *   - Phase transitions to `error: reconnect_failed`
 *   - onSessionComplete cleanup is NOT called (session is dead, not done)
 *   - The recovery path doesn't keep retrying in the background
 */
export const reconnectFailure: Fixture = {
  name: 'reconnect-failure',
  cards: awsExamSaCards.slice(0, 2),
  turns: [
    {
      kind: 'answer',
      userSaid: 'subnet level',
      aiGraded: 'correct',
      expectWriteback: { cardId: awsExamSaCards[0].cardId, pass: true },
    },
    {
      kind: 'connectionDropped',
    },
  ],
};

/**
 * Validates the foreground audio service lifecycle:
 *   - startForegroundService called BEFORE sendFirstCard
 *   - updateForegroundNotification called on each card advance (with
 *     correct N-of-M display)
 *   - stopForegroundService called on session_complete
 *
 * The fixture answers 3 cards normally so the runner can verify the
 * 3 updateForegroundNotification calls happened with the right counts.
 */
export const notificationLifecycle: Fixture = {
  name: 'notification-lifecycle',
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
      userSaid: 'EBS snapshot backups',
      aiGraded: 'correct',
      expectWriteback: { cardId: awsExamSaCards[1].cardId, pass: true },
    },
    {
      kind: 'answer',
      userSaid: 'NLB and elastic IPs',
      aiGraded: 'correct',
      expectWriteback: { cardId: awsExamSaCards[2].cardId, pass: true },
    },
  ],
  expectedFinalStats: { correct: 3, incorrect: 0 },
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
  endOfDeck,
  endSessionToolMidDeck,
  reconnectMidSession,
  reconnectFailure,
  notificationLifecycle,
};
