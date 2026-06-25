/**
 * sessionDebugLogger
 *
 * Structured, step-by-step trace of a study session — maps 1:1 to the
 * canonical flow described in `App/SESSION-FLOW.md` §1. Replaces ad-hoc
 * console.log calls scattered across sessionManager / geminiManager so the
 * terminal reads as a numbered checklist instead of a wall of noise.
 *
 * Two verbosity levels:
 *   - Default: step banners + key events + warnings/errors.
 *   - VERBOSE (`EXPO_PUBLIC_SESSION_DEBUG_VERBOSE=1` or `setVerbose(true)`):
 *     also prints raw payloads, message keys, audio-chunk counters.
 */

// Note: deliberately NOT importing expo-constants here. Tests load this
// module via Jest, which doesn't transform Expo's ESM virtual modules.
// Verbose is controlled via `EXPO_PUBLIC_SESSION_DEBUG_VERBOSE` (Metro
// inlines EXPO_PUBLIC_* into process.env at bundle time) or runtime
// `sessionLog.setVerbose(true)`.

const TOTAL_STEPS = 8;

const STEP_TITLES: Record<number, string> = {
  1: 'Connect WebSocket (Gemini Live)',
  2: 'Initialise audio I/O + start mic capture (muted)',
  3: 'Load due cards from AnkiDroid',
  4: 'Send setup message to Gemini (system prompt + tools)',
  5: 'Send first card as user text message',
  6: 'Wait for AI first response to finish',
  7: 'Enable server VAD + unmute mic (study loop active)',
  8: 'Session complete (no more cards or end_session)',
};

// Indirect (computed-key) access bypasses babel-preset-expo's transform of
// `process.env.EXPO_PUBLIC_*` literals into a require of `expo/virtual/env`
// (which is ESM and breaks jest). Metro still inlines via env-injection at
// runtime; jest sees the literal lookup against process.env.
const VERBOSE_KEY = 'EXPO_PUBLIC_SESSION_DEBUG_VERBOSE';
let verbose =
  typeof process !== 'undefined' &&
  (process as any).env?.[VERBOSE_KEY] === '1';

function ts(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function truncate(value: unknown, max = 160): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}… (+${s.length - max} chars)`;
}

function renderPayload(payload?: Record<string, unknown>): string {
  if (!payload) return '';
  const lines: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    lines.push(`     ${k.padEnd(14)} ${truncate(v)}`);
  }
  return lines.length ? '\n' + lines.join('\n') : '';
}

export const sessionLog = {
  setVerbose(v: boolean) {
    verbose = v;
  },
  isVerbose() {
    return verbose;
  },

  /** Top-level milestone in the canonical flow. */
  step(n: number, payload?: Record<string, unknown>) {
    const title = STEP_TITLES[n] ?? `Step ${n}`;
    console.log(
      `\n[${ts()}] ── STEP ${n}/${TOTAL_STEPS} ─ ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}` +
        renderPayload(payload),
    );
  },

  /** Result/summary of the currently active step. */
  stepDone(n: number, payload?: Record<string, unknown>) {
    const title = STEP_TITLES[n] ?? `Step ${n}`;
    console.log(`[${ts()}]    OK  step ${n} (${title})${renderPayload(payload)}`);
  },

  /** Step failure — printed prominently. */
  stepFail(n: number, reason: string, payload?: Record<string, unknown>) {
    const title = STEP_TITLES[n] ?? `Step ${n}`;
    console.error(
      `[${ts()}]  FAIL  step ${n} (${title}) → ${reason}${renderPayload(payload)}`,
    );
  },

  /** Sub-event inside a step (e.g. "tool_call: evaluate_and_move_next"). */
  event(scope: string, name: string, payload?: Record<string, unknown>) {
    console.log(`[${ts()}]   • ${scope} → ${name}${renderPayload(payload)}`);
  },

  /** Phase machine transition. */
  phase(from: string, to: string, reason: string) {
    console.log(`[${ts()}]   ↳ phase  ${from} → ${to}  (${reason})`);
  },

  /** Information that helps interpret a step but is not itself a sub-event. */
  info(scope: string, msg: string, payload?: Record<string, unknown>) {
    console.log(`[${ts()}]     [${scope}] ${msg}${renderPayload(payload)}`);
  },

  warn(scope: string, msg: string, payload?: Record<string, unknown>) {
    console.warn(`[${ts()}]   ! [${scope}] ${msg}${renderPayload(payload)}`);
  },

  error(scope: string, msg: string, payload?: Record<string, unknown>) {
    console.error(`[${ts()}]   x [${scope}] ${msg}${renderPayload(payload)}`);
  },

  /** Only prints when verbose mode is enabled. Use for raw dumps. */
  debug(scope: string, msg: string, payload?: Record<string, unknown>) {
    if (!verbose) return;
    console.log(`[${ts()}]     . [${scope}] ${msg}${renderPayload(payload)}`);
  },

  /** Visual separator between sessions in the terminal. */
  banner(title: string) {
    const bar = '='.repeat(72);
    console.log(`\n${bar}\n  ${title}  (${ts()})\n${bar}`);
  },
};

export type SessionLog = typeof sessionLog;
