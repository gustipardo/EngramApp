/**
 * Mock implementation of geminiManager for replay-based testing.
 *
 * Mirrors the public surface that sessionManager (and other consumers)
 * expect from `realtimeManager`, but every method is either:
 *   - a no-op stub that resolves immediately, or
 *   - a recording call that captures arguments for later assertion.
 *
 * Plus a set of `__simulate*` helpers used by `scriptRunner` to drive
 * synthetic events into the registered handlers, mimicking what the
 * real Gemini Live WebSocket would emit.
 */

type EventHandler = (event: any) => void;

export class MockGeminiManager {
  private handlers = new Map<string, EventHandler[]>();

  // -------------------------------------------------------------------------
  // Recorded interactions (for assertions)
  // -------------------------------------------------------------------------
  sentToolResults: Array<{ callId: string; result: any }> = [];
  sentTextMessages: string[] = [];
  sentEvents: any[] = [];
  micMutedStates: boolean[] = [];
  updateSessionCalls: any[] = [];
  connectCount = 0;
  disconnectCount = 0;
  reconnectCount = 0;

  // Mutable property — sessionManager assigns onConnectionDropped on it.
  onConnectionDropped: (() => void) | null = null;

  // -------------------------------------------------------------------------
  // Real-shaped interface
  // -------------------------------------------------------------------------

  on(eventType: string, handler: EventHandler): void {
    const arr = this.handlers.get(eventType) ?? [];
    arr.push(handler);
    this.handlers.set(eventType, arr);
  }

  off(eventType: string, handler: EventHandler): void {
    const arr = this.handlers.get(eventType) ?? [];
    const idx = arr.indexOf(handler);
    if (idx >= 0) arr.splice(idx, 1);
  }

  offAll(eventType: string): void {
    this.handlers.delete(eventType);
  }

  async connect(): Promise<boolean> {
    this.connectCount++;
    return true;
  }

  /**
   * reconnect() — returns false if `_reconnectWillFail` is set (via
   * `__setReconnectWillFail(true)`). Tests can simulate a connection
   * drop + reconnect failure to drive the `error: reconnect_failed`
   * branch in sessionManager.
   */
  async reconnect(): Promise<boolean> {
    this.reconnectCount++;
    if (this._reconnectWillFail) return false;
    return true;
  }

  private _reconnectWillFail = false;

  disconnect(): void {
    this.disconnectCount++;
  }

  async updateSession(config: any): Promise<void> {
    this.updateSessionCalls.push(config);
  }

  async sendTextMessage(text: string): Promise<void> {
    this.sentTextMessages.push(text);
  }

  sendToolResult(callId: string, result: any): void {
    this.sentToolResults.push({ callId, result });
  }

  sendEvent(event: any): void {
    this.sentEvents.push(event);
  }

  setMicrophoneMuted(muted: boolean): void {
    this.micMutedStates.push(muted);
  }

  async waitForNextResponseDone(): Promise<void> {
    // Resolve immediately so startSession completes without needing to
    // pump events. Tests that want to gate on response.done can drive
    // it manually via __simulateAiResponseDone().
  }

  async getAudioStats() {
    return { bytesSent: 0, packetsSent: 0 };
  }

  async debugAudioTrackState(_label: string): Promise<void> {
    /* no-op */
  }

  isConnected(): boolean {
    return true;
  }

  // -------------------------------------------------------------------------
  // Test helpers — drive synthetic events into registered handlers.
  // Naming: __simulate* so the test surface is obviously not part of
  // the real geminiManager interface.
  // -------------------------------------------------------------------------

  __emit(eventType: string, payload: any = {}): void {
    const arr = this.handlers.get(eventType) ?? [];
    for (const h of [...arr]) h(payload);
  }

  __simulateUserTranscript(transcript: string): void {
    this.__emit('conversation.item.input_audio_transcription.completed', { transcript });
  }

  __simulateAiAudioDelta(): void {
    this.__emit('response.audio.delta', {});
  }

  __simulateAiResponseDone(): void {
    this.__emit('response.done', {});
  }

  /**
   * Simulate the AI calling a tool. Emits the same two-event sequence
   * that the real geminiManager produces from a Gemini `toolCall`:
   * `response.output_item.added` (registers the name) and
   * `response.function_call_arguments.done` (delivers args).
   */
  __simulateAiToolCall(name: string, args: any, callId?: string): string {
    const id = callId ?? `mock_call_${Math.random().toString(36).slice(2, 10)}`;
    this.__emit('response.output_item.added', {
      item: { type: 'function_call', call_id: id, name },
    });
    this.__emit('response.function_call_arguments.done', {
      call_id: id,
      arguments: JSON.stringify(args),
    });
    return id;
  }

  /**
   * Simulate the WebSocket connection dropping mid-session. Fires the
   * `onConnectionDropped` callback that sessionManager installed via
   * `installConnectionDropHandler`. The callback then triggers the
   * full reconnect + resume flow.
   *
   * Returns true if a handler was registered and fired. Tests should
   * check this to verify the wiring is in place; `false` means
   * sessionManager hasn't installed a drop handler yet (e.g. the
   * fixture called this before startSession).
   */
  __simulateConnectionDropped(): boolean {
    if (!this.onConnectionDropped) return false;
    this.onConnectionDropped();
    return true;
  }

  /**
   * Simulate a reconnect FAILURE (reconnect() returns false).
   * Use this to test the `error: reconnect_failed` branch.
   */
  __setReconnectWillFail(willFail: boolean): void {
    this._reconnectWillFail = willFail;
  }

  /**
   * Reset all recorded state and registered handlers. Call between
   * scenarios to start fresh without re-instantiating.
   */
  __reset(): void {
    this.handlers.clear();
    this.sentToolResults = [];
    this.sentTextMessages = [];
    this.sentEvents = [];
    this.micMutedStates = [];
    this.updateSessionCalls = [];
    this.connectCount = 0;
    this.disconnectCount = 0;
    this.reconnectCount = 0;
    this.onConnectionDropped = null;
  }
}

// Singleton — matches the real `realtimeManager` export shape so module
// mocks can swap one for the other without touching consumer code.
export const mockGeminiManager = new MockGeminiManager();
