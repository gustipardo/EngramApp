/**
 * Real-Gemini text-mode runner — Layer 3.
 *
 * Opens an actual Gemini Live WebSocket, but instead of streaming
 * `realtimeInput.audio` chunks the way `geminiManager` does, sends the
 * user's "answer" as `clientContent.turns[].parts[].text`. Captures
 * tool calls and validates grading decisions.
 *
 * What this catches that Layers 1+2 can't: prompt regressions, tool
 * argument-shape regressions, lenient/strict grading drift in the AI's
 * own behavior. Costs ~$0.005-0.02 per fixture run depending on length.
 *
 * Requires GEMINI_API_KEY in the environment (same key the app uses
 * via .env → app.config.js → expoConfig.extra.geminiApiKey, but here
 * we pull it straight from process.env to avoid bringing in Expo).
 */

import {
  getSystemPrompt,
  allTools,
  getInitialMessage,
  formatToolResult,
} from '../config/prompts';
import type { Fixture, Turn } from './fixtures/scripts';
import type { AnkiCard } from '../types/anki';

// Default to the production model. Text-mode tests against the
// native-audio-only model will time out on setupComplete because that
// model only accepts AUDIO modality. Override via GEMINI_L3_MODEL env.
const DEFAULT_L3_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
// A text-friendly fallback. Known-good for text-mode Live API.
// Set GEMINI_L3_MODEL=gemini-live-2.5-flash-preview to use it.
const L3_MODEL = process.env.GEMINI_L3_MODEL ?? DEFAULT_L3_MODEL;

export interface RunnerResult {
  toolCalls: Array<{ name: string; args: any }>;
  perTurn: Array<{
    turn: Turn;
    expectedGrade?: string;
    observedGrade?: string;
    matched: boolean;
  }>;
  // Final session_stats from the AI's evaluations (not from any local store).
  observedFinalStats: { correct: number; incorrect: number };
}

interface ToolCallEvent {
  callId: string;
  name: string;
  args: any;
}

/**
 * Runs a fixture against the real Gemini API in text mode.
 *
 * @param fixture - The fixture to play through
 * @param apiKey  - Gemini API key (REQUIRED — pass from process.env.GEMINI_API_KEY)
 * @param opts    - Tuning knobs
 * @returns       - Per-turn match results + raw tool call list
 */
export async function runFixtureAgainstRealGemini(
  fixture: Fixture,
  apiKey: string,
  opts: { logEvents?: boolean; turnTimeoutMs?: number } = {},
): Promise<RunnerResult> {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is required for Layer 3 tests');
  }
  const turnTimeoutMs = opts.turnTimeoutMs ?? 30000;
  const log = opts.logEvents ? console.log : () => {};

  const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;

  // Use the global WebSocket (Node 22+ / RN). For older Node, callers
  // can polyfill before invoking this function.
  const WSCtor: any = (globalThis as any).WebSocket;
  if (!WSCtor) {
    throw new Error('Global WebSocket not available — node 22+ or polyfill required');
  }

  const ws: any = new WSCtor(url);
  const toolCalls: ToolCallEvent[] = [];
  const result: RunnerResult = {
    toolCalls: [],
    perTurn: [],
    observedFinalStats: { correct: 0, incorrect: 0 },
  };

  let turnCompleteResolver: (() => void) | null = null;
  let toolCallResolver: ((evt: ToolCallEvent) => void) | null = null;
  let setupComplete = false;
  let setupResolver: (() => void) | null = null;

  ws.onmessage = async (event: any) => {
    let raw = event.data;
    if (typeof raw !== 'string' && typeof raw?.text === 'function') {
      raw = await raw.text();
    } else if (raw instanceof ArrayBuffer) {
      raw = new TextDecoder().decode(raw);
    } else if (typeof raw === 'object' && Buffer && Buffer.isBuffer && Buffer.isBuffer(raw)) {
      raw = raw.toString('utf8');
    }
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    log('[gemini]', JSON.stringify(msg).slice(0, 220));

    if (msg.setupComplete !== undefined) {
      setupComplete = true;
      setupResolver?.();
      return;
    }
    if (msg.toolCall) {
      for (const fc of msg.toolCall.functionCalls || []) {
        const tc: ToolCallEvent = {
          callId: fc.id ?? `tc_${Date.now()}`,
          name: fc.name,
          args: fc.args ?? {},
        };
        toolCalls.push(tc);
        result.toolCalls.push({ name: tc.name, args: tc.args });
        toolCallResolver?.(tc);
        toolCallResolver = null;
      }
      return;
    }
    if (msg.serverContent?.turnComplete) {
      turnCompleteResolver?.();
      turnCompleteResolver = null;
    }
  };

  ws.onerror = (err: any) => {
    log('[gemini-error]', err?.message ?? err);
  };

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    setTimeout(() => reject(new Error('WS open timeout')), 10000);
  });

  // ---- Setup ----
  await new Promise<void>((resolve, reject) => {
    setupResolver = resolve;
    const setup = {
      setup: {
        model: `models/${L3_MODEL}`,
        generationConfig: { responseModalities: ['TEXT'] },
        systemInstruction: {
          parts: [{
            text: getSystemPrompt(
              fixture.cards[0]?.deckName ?? 'Test',
              fixture.cards.length,
              false,
              undefined,
            ),
          }],
        },
        tools: [{ functionDeclarations: allTools.map(convertToolForGemini) }],
      },
    };
    ws.send(JSON.stringify(setup));
    setTimeout(() => {
      if (!setupComplete) reject(new Error('setupComplete timeout'));
    }, 15000);
  });

  // ---- Send first card ----
  sendUserText(ws, getInitialMessage(fixture.cards[0].front, fixture.cards[0].back));
  await waitForTurnComplete();

  // ---- Drive turns ----
  let cardIdx = 0;
  let runningStats = { correct: 0, incorrect: 0 };

  for (const turn of fixture.turns) {
    if (turn.kind === 'silentGrade' || turn.kind === 'toolCallNoAudio' || turn.kind === 'connectionDropped') {
      // These fixture kinds are about runner/UI behavior, not AI behavior.
      // The AI is supposed to ALWAYS tool-call when given a real answer;
      // these fixtures are tested deterministically at Layer 2.
      // Record a placeholder and skip.
      result.perTurn.push({ turn, matched: true });
      continue;
    }

    sendUserText(ws, turn.userSaid);

    // Wait for AI tool call.
    const tc = await waitForToolCall(turnTimeoutMs);
    if (!tc) {
      const expected =
        turn.kind === 'answer'
          ? turn.aiGraded
          : turn.kind === 'override'
          ? 'override_evaluation'
          : 'end_session';
      result.perTurn.push({
        turn,
        expectedGrade: expected,
        observedGrade: '<no_tool_call>',
        matched: false,
      });
      break;
    }

    let matched = false;
    if (turn.kind === 'answer') {
      const grade = tc.args?.user_response_quality;
      matched = grade === turn.aiGraded;
      if (grade === 'correct') runningStats.correct++;
      else if (grade === 'incorrect') runningStats.incorrect++;
      result.perTurn.push({
        turn,
        expectedGrade: turn.aiGraded,
        observedGrade: grade,
        matched,
      });
    } else if (turn.kind === 'override') {
      // For override, we only verify the AI called the right tool —
      // the exact result depends on the AI's reasoning about the
      // previous card.
      matched = tc.name === 'override_evaluation';
      result.perTurn.push({
        turn,
        expectedGrade: `tool=${tc.name}`,
        observedGrade: tc.name,
        matched,
      });
    } else if (turn.kind === 'endRequested') {
      // For end_session, just verify the AI honored the request.
      matched = tc.name === 'end_session';
      result.perTurn.push({
        turn,
        expectedGrade: 'tool=end_session',
        observedGrade: tc.name,
        matched,
      });
      // Don't try to advance — session ends here.
      break;
    }

    // Reply with tool result so the AI can move on to the next card.
    cardIdx++;
    const next: AnkiCard | undefined = fixture.cards[cardIdx];
    sendToolResponse(
      ws,
      tc.callId,
      tc.name,
      formatToolResult(
        fixture.cards[cardIdx - 1]?.back ?? null,
        next ? { front: next.front, back: next.back } : null,
        Math.max(0, fixture.cards.length - cardIdx),
        runningStats,
      ),
    );

    await waitForTurnComplete();
  }

  result.observedFinalStats = runningStats;

  ws.close();
  return result;

  // ---- Helpers ----
  function waitForTurnComplete(): Promise<void> {
    return new Promise((resolve, reject) => {
      turnCompleteResolver = resolve;
      setTimeout(() => {
        if (turnCompleteResolver === resolve) {
          turnCompleteResolver = null;
          reject(new Error('turnComplete timeout'));
        }
      }, turnTimeoutMs);
    });
  }
  function waitForToolCall(timeoutMs: number): Promise<ToolCallEvent | null> {
    return new Promise((resolve) => {
      toolCallResolver = resolve;
      setTimeout(() => {
        if (toolCallResolver === resolve) {
          toolCallResolver = null;
          resolve(null);
        }
      }, timeoutMs);
    });
  }
}

function sendUserText(ws: any, text: string): void {
  ws.send(JSON.stringify({
    clientContent: {
      turns: [{ role: 'user', parts: [{ text }] }],
      turnComplete: true,
    },
  }));
}

function sendToolResponse(ws: any, callId: string, name: string, response: any): void {
  ws.send(JSON.stringify({
    toolResponse: {
      functionResponses: [{ id: callId, name, response }],
    },
  }));
}

function convertToolForGemini(openaiTool: any): any {
  return {
    name: openaiTool.name,
    description: openaiTool.description,
    ...(openaiTool.parameters
      ? { parameters: convertSchemaTypes(openaiTool.parameters) }
      : {}),
  };
}

function convertSchemaTypes(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema;
  const result: any = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'type' && typeof v === 'string') {
      result.type = (v as string).toUpperCase();
    } else if (k === 'properties' && typeof v === 'object' && v !== null) {
      result.properties = {};
      for (const [pk, pv] of Object.entries(v as any)) {
        result.properties[pk] = convertSchemaTypes(pv);
      }
    } else if (k === 'items' && typeof v === 'object') {
      result.items = convertSchemaTypes(v);
    } else {
      result[k] = v;
    }
  }
  return result;
}
