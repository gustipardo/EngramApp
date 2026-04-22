import Constants from 'expo-constants';
import ExpoForegroundAudioModule from 'expo-foreground-audio';
import { useConnectionStore } from '../stores/useConnectionStore';

const GEMINI_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 1000;

type DataChannelEventHandler = (event: any) => void;

class GeminiManager {
  private ws: WebSocket | null = null;
  private eventHandlers: Map<string, DataChannelEventHandler[]> = new Map();
  private isMuted = true;
  private isSetupDone = false;
  private toolCallNames: Map<string, string> = new Map();
  private audioDataSubscription: any = null;
  private isReconnecting = false;
  private isInitialConnect = false;

  // Audio stats tracking (for level meter + debugging)
  private audioBytesSent = 0;
  private audioPacketsSent = 0;
  private audioChunksReceived = 0;

  onConnectionDropped: (() => void) | null = null;

  // -------------------------------------------------------------------------
  // API key & WebSocket URL
  // -------------------------------------------------------------------------

  private getApiKey(): string {
    const key = Constants.expoConfig?.extra?.geminiApiKey;
    if (!key) throw new Error('GEMINI_API_KEY not found in app config');
    return key;
  }

  private getWsUrl(): string {
    const apiKey = this.getApiKey();
    return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  async connect(): Promise<boolean> {
    const setConnectionState = useConnectionStore.getState().setConnectionState;

    try {
      setConnectionState('connecting');
      this.isInitialConnect = true;

      // 1. Open WebSocket
      await this.openWebSocket();
      console.log('[Gemini] Step 1 done: WebSocket opened');

      // 2. Init audio output player
      await ExpoForegroundAudioModule.initAudioPlayer(OUTPUT_SAMPLE_RATE);
      console.log('[Gemini] Step 2 done: Audio player initialized');

      // 3. Start mic capture (muted initially — chunks won't be sent)
      await ExpoForegroundAudioModule.startMicCapture(INPUT_SAMPLE_RATE);
      this.setupAudioDataListener();
      console.log('[Gemini] Step 3 done: Mic capture started');

      this.isInitialConnect = false;
      setConnectionState('connected');
      console.log('[Gemini] Connected');
      return true;
    } catch (error) {
      console.error('[Gemini] Connection failed:', error);
      this.isInitialConnect = false;
      setConnectionState('failed');
      this.cleanupConnection();
      throw error;
    }
  }

  async reconnect(): Promise<boolean> {
    if (this.isReconnecting) {
      console.warn('[Gemini] Reconnect already in progress');
      return false;
    }

    this.isReconnecting = true;
    const connStore = useConnectionStore.getState();
    connStore.setConnectionState('reconnecting');
    connStore.resetReconnectAttempts();

    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
      useConnectionStore.getState().incrementReconnectAttempts();
      const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`[Gemini] Reconnect attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);

      await this.sleep(delay);
      this.cleanupConnection();

      try {
        await this.connect();
        useConnectionStore.getState().resetReconnectAttempts();
        this.isReconnecting = false;
        console.log(`[Gemini] Reconnected on attempt ${attempt}`);
        return true;
      } catch (error) {
        console.warn(`[Gemini] Reconnect attempt ${attempt} failed:`, error);
      }
    }

    console.error('[Gemini] All reconnect attempts failed');
    useConnectionStore.getState().setConnectionState('failed');
    this.isReconnecting = false;
    return false;
  }

  disconnect(): void {
    const setConnectionState = useConnectionStore.getState().setConnectionState;
    this.onConnectionDropped = null;
    this.isReconnecting = false;
    this.cleanup();
    setConnectionState('disconnected');
    console.log('[Gemini] Disconnected');
  }

  // -------------------------------------------------------------------------
  // WebSocket management
  // -------------------------------------------------------------------------

  private openWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.getWsUrl();
      console.log('[Gemini] Opening WebSocket...');
      this.ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
      }, 15000);

      this.ws.onopen = () => {
        clearTimeout(timeout);
        console.log('[Gemini] WebSocket opened');
        resolve();
      };

      this.ws.onerror = (error: any) => {
        clearTimeout(timeout);
        console.error('[Gemini] WebSocket error:', error.message || error);
        // Only reject if we're still in the initial connect handshake
        if (this.isInitialConnect) {
          reject(new Error('WebSocket connection error'));
        }
      };

      this.ws.onmessage = (event: any) => {
        this.handleMessage(event.data);
      };

      this.ws.onclose = (event: any) => {
        const code = event?.code;
        const reason = event?.reason || '(no reason)';
        console.log(`[Gemini] WebSocket closed: code=${code}, reason=${reason}`);

        // Emit a close event so pending waiters (e.g. updateSession) can
        // fail fast instead of waiting for their 15 s timeout.
        this.emitEvent('ws.closed', { code, reason });

        const currentState = useConnectionStore.getState().connectionState;
        if (currentState === 'connected' && !this.isReconnecting) {
          useConnectionStore.getState().setConnectionState('failed');
          useConnectionStore.getState().setNetworkStatus('offline');
          if (this.onConnectionDropped) {
            this.onConnectionDropped();
          }
        }
      };
    });
  }

  // -------------------------------------------------------------------------
  // Audio I/O
  // -------------------------------------------------------------------------

  private setupAudioDataListener(): void {
    this.removeAudioDataListener();
    this.audioDataSubscription = ExpoForegroundAudioModule.addListener(
      'onAudioData',
      (event: { data: string }) => {
        this.audioChunksReceived++;
        // Log every 100th chunk (~every 10s) to verify events are arriving
        if (this.audioChunksReceived % 100 === 1) {
          console.log(
            `[Gemini] Audio chunk #${this.audioChunksReceived}, len=${event.data?.length ?? 0}, ` +
            `muted=${this.isMuted}, ws=${this.ws?.readyState}, setup=${this.isSetupDone}`,
          );
        }
        if (!this.isMuted && this.ws && this.ws.readyState === WebSocket.OPEN && this.isSetupDone) {
          const dataLen = event.data?.length ?? 0;
          this.audioBytesSent += dataLen;
          this.audioPacketsSent += 1;
          this.ws.send(
            JSON.stringify({
              realtimeInput: {
                audio: {
                  data: event.data,
                  mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
                },
              },
            }),
          );
        }
      },
    );
  }

  private removeAudioDataListener(): void {
    if (this.audioDataSubscription) {
      this.audioDataSubscription.remove();
      this.audioDataSubscription = null;
    }
  }

  // -------------------------------------------------------------------------
  // Incoming message handler — translates Gemini events to OpenAI-style events
  // -------------------------------------------------------------------------

  private async handleMessage(rawData: string | object): Promise<void> {
    let msg: any;
    try {
      let text: string;
      if (typeof rawData === 'string') {
        text = rawData;
      } else if (typeof (rawData as any)?.text === 'function') {
        // Blob or Blob-like (duck-typed — instanceof Blob can fail in RN polyfills)
        text = await (rawData as any).text();
      } else if (rawData instanceof ArrayBuffer) {
        text = new TextDecoder().decode(rawData);
      } else {
        console.warn('[Gemini] Unexpected message type:', typeof rawData, Object.prototype.toString.call(rawData));
        text = JSON.stringify(rawData);
      }
      msg = JSON.parse(text);
    } catch (e) {
      console.error('[Gemini] Failed to parse message:', e);
      return;
    }

    // Log message keys (skip noisy audio-only messages)
    const keys = Object.keys(msg);
    const hasAudioOnly =
      msg.serverContent?.modelTurn?.parts?.every((p: any) => p.inlineData) &&
      !msg.serverContent?.turnComplete &&
      !msg.serverContent?.inputTranscription &&
      !msg.serverContent?.outputTranscription;
    if (!hasAudioOnly) {
      console.log('[Gemini] MSG keys:', JSON.stringify(keys));
      // Log full message for non-audio messages (helps debug setup issues)
      if (!msg.serverContent) {
        console.log('[Gemini] MSG full:', JSON.stringify(msg).substring(0, 500));
      }
    }

    // --- error → log and propagate ---
    if (msg.error) {
      console.error('[Gemini] Server error:', JSON.stringify(msg.error));
      this.emitEvent('error', msg.error);
      return;
    }

    // --- setupComplete → session.updated ---
    if (msg.setupComplete !== undefined) {
      console.log('[Gemini] Setup complete');
      this.emitEvent('session.updated', {});
      return;
    }

    // --- toolCall → response.output_item.added + response.function_call_arguments.done ---
    if (msg.toolCall) {
      const functionCalls = msg.toolCall.functionCalls || [];
      for (const fc of functionCalls) {
        const callId = fc.id || `fc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const name = fc.name;
        const args = fc.args || {};

        this.toolCallNames.set(callId, name);

        // Emit output_item.added so sessionManager can track the tool name
        this.emitEvent('response.output_item.added', {
          item: { type: 'function_call', call_id: callId, name },
        });

        // Emit function_call_arguments.done with serialised args
        this.emitEvent('response.function_call_arguments.done', {
          call_id: callId,
          arguments: JSON.stringify(args),
        });
      }
      return;
    }

    // --- serverContent → audio deltas, transcriptions, turnComplete ---
    if (msg.serverContent) {
      const sc = msg.serverContent;

      // Input transcription (user speech → evaluating transition)
      if (sc.inputTranscription?.text) {
        console.log('[User]:', sc.inputTranscription.text);
        this.emitEvent('conversation.item.input_audio_transcription.completed', {
          transcript: sc.inputTranscription.text,
        });
      }

      // Output transcription (AI speech)
      if (sc.outputTranscription?.text) {
        console.log('[AI]:', sc.outputTranscription.text);
        this.emitEvent('response.audio_transcript.done', {
          transcript: sc.outputTranscription.text,
        });
      }

      // Model turn parts — audio and text
      if (sc.modelTurn?.parts) {
        for (const part of sc.modelTurn.parts) {
          if (part.inlineData?.data) {
            // Emit response.audio.delta so sessionManager can transition phases
            this.emitEvent('response.audio.delta', {});
            // Play the audio chunk through native AudioTrack
            ExpoForegroundAudioModule.playAudioChunk(part.inlineData.data).catch((e: any) => {
              console.error('[Gemini] Audio playback error:', e);
            });
          }
          if (part.text) {
            console.log('[Gemini] Text part:', part.text);
          }
        }
      }

      // Turn complete → response.done
      if (sc.turnComplete) {
        console.log('[Gemini] Turn complete');
        this.emitEvent('response.done', {});
      }
    }
  }

  // -------------------------------------------------------------------------
  // Session configuration (setup message)
  // -------------------------------------------------------------------------

  /**
   * First call: sends the Gemini setup message (model, system instruction,
   * tools, voice config, transcriptions) and waits for setupComplete.
   * Subsequent calls: no-op (Gemini config is immutable after setup).
   */
  async updateSession(config: {
    instructions?: string;
    tools?: any[];
    modalities?: string[];
    turn_detection?: any;
  }): Promise<void> {
    if (!this.isSetupDone) {
      // Build Gemini setup payload
      const setup: any = {
        model: `models/${GEMINI_MODEL}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Kore' },
            },
          },
        },
        outputAudioTranscription: {},
        inputAudioTranscription: {},
      };

      if (config.instructions) {
        setup.systemInstruction = {
          parts: [{ text: config.instructions }],
        };
      }

      if (config.tools && config.tools.length > 0) {
        setup.tools = [
          {
            functionDeclarations: config.tools.map((t) => this.convertTool(t)),
          },
        ];
      }

      const setupPayload = JSON.stringify({ setup });
      console.log('[Gemini] Sending setup, payload length:', setupPayload.length);
      console.log('[Gemini] Setup model:', setup.model);
      console.log('[Gemini] Setup has tools:', !!(setup.tools));
      console.log('[Gemini] Setup has systemInstruction:', !!(setup.systemInstruction));
      console.log('[Gemini] Setup payload (first 1000 chars):', setupPayload.substring(0, 1000));
      console.log('[Gemini] WS readyState:', this.ws?.readyState);
      this.ws?.send(setupPayload);

      // Wait for setupComplete (emitted as session.updated), error, or WS close
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeout);
          this.off('session.updated', handler);
          this.off('error', errorHandler);
          this.off('ws.closed', closeHandler);
        };

        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error('Gemini setup timeout — no setupComplete received within 15s'));
        }, 15000);

        const handler = () => {
          cleanup();
          resolve();
        };

        const errorHandler = (error: any) => {
          cleanup();
          reject(new Error(`Gemini setup error: ${JSON.stringify(error)}`));
        };

        const closeHandler = (event: any) => {
          cleanup();
          reject(new Error(
            `Gemini WebSocket closed during setup: code=${event.code}, reason=${event.reason}`
          ));
        };

        this.on('session.updated', handler);
        this.on('error', errorHandler);
        this.on('ws.closed', closeHandler);
      });

      this.isSetupDone = true;
      return;
    }

    // Subsequent calls are no-ops — emit session.updated so waiters resolve
    this.emitEvent('session.updated', {});
  }

  // -------------------------------------------------------------------------
  // Tool format conversion (OpenAI → Gemini)
  // -------------------------------------------------------------------------

  private convertTool(openaiTool: any): any {
    return {
      name: openaiTool.name,
      description: openaiTool.description,
      ...(openaiTool.parameters
        ? { parameters: this.convertSchemaTypes(openaiTool.parameters) }
        : {}),
    };
  }

  private convertSchemaTypes(schema: any): any {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema;

    const result: any = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'type' && typeof value === 'string') {
        result.type = (value as string).toUpperCase();
      } else if (key === 'properties' && typeof value === 'object' && value !== null) {
        result.properties = {};
        for (const [propName, propSchema] of Object.entries(value as Record<string, any>)) {
          result.properties[propName] = this.convertSchemaTypes(propSchema);
        }
      } else if (key === 'items' && typeof value === 'object') {
        result.items = this.convertSchemaTypes(value);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Messaging — same interface as webrtcManager
  // -------------------------------------------------------------------------

  /**
   * No-op for OpenAI-specific data channel events (input_audio_buffer.clear etc.)
   */
  sendEvent(_event: any): void {
    // Gemini doesn't use these events
  }

  async sendTextMessage(text: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[Gemini] WebSocket not open, cannot send text');
      return;
    }

    this.ws.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text }] }],
          turnComplete: true,
        },
      }),
    );

    // Emit immediately — Gemini doesn't send an explicit confirmation
    this.emitEvent('conversation.item.created', {});
  }

  sendToolResult(callId: string, result: any): void {
    const name = this.toolCallNames.get(callId) || '';

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[Gemini] WebSocket not open, cannot send tool result');
      return;
    }

    console.log(`[Gemini] Sending tool result for ${name} (${callId})`);

    this.ws.send(
      JSON.stringify({
        toolResponse: {
          functionResponses: [
            {
              id: callId,
              name,
              response: result,
            },
          ],
        },
      }),
    );
  }

  waitForNextResponseDone(): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        this.off('response.done', handler);
        this.off('ws.closed', closeHandler);
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for response.done'));
      }, 30000);

      const handler = () => {
        cleanup();
        resolve();
      };

      const closeHandler = (event: any) => {
        cleanup();
        reject(new Error(
          `Gemini WebSocket closed while waiting for response: code=${event.code}, reason=${event.reason}`
        ));
      };

      this.on('response.done', handler);
      this.on('ws.closed', closeHandler);
    });
  }

  // -------------------------------------------------------------------------
  // Event bus
  // -------------------------------------------------------------------------

  on(eventType: string, handler: DataChannelEventHandler): void {
    const handlers = this.eventHandlers.get(eventType) || [];
    handlers.push(handler);
    this.eventHandlers.set(eventType, handlers);
  }

  off(eventType: string, handler: DataChannelEventHandler): void {
    const handlers = this.eventHandlers.get(eventType) || [];
    const index = handlers.indexOf(handler);
    if (index > -1) {
      handlers.splice(index, 1);
      this.eventHandlers.set(eventType, handlers);
    }
  }

  offAll(eventType: string): void {
    this.eventHandlers.delete(eventType);
  }

  private emitEvent(eventType: string, event: any): void {
    const handlers = this.eventHandlers.get(eventType) || [];
    handlers.forEach((handler) => handler(event));

    const allHandlers = this.eventHandlers.get('all') || [];
    allHandlers.forEach((handler) => handler({ ...event, type: eventType }));
  }

  // -------------------------------------------------------------------------
  // Microphone control
  // -------------------------------------------------------------------------

  setMicrophoneMuted(muted: boolean): void {
    this.isMuted = muted;
    console.log(`[Gemini] Microphone ${muted ? 'muted' : 'unmuted'}`);
  }

  // -------------------------------------------------------------------------
  // Status / debug helpers
  // -------------------------------------------------------------------------

  isConnected(): boolean {
    return useConnectionStore.getState().connectionState === 'connected';
  }

  async getAudioStats(): Promise<{ bytesSent: number; packetsSent: number } | null> {
    return {
      bytesSent: this.audioBytesSent,
      packetsSent: this.audioPacketsSent,
    };
  }

  async debugAudioTrackState(label: string): Promise<void> {
    console.log(
      `[Gemini] ${label} — ws=${this.ws?.readyState ?? 'null'}, muted=${this.isMuted}, setup=${this.isSetupDone}`,
    );
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  private cleanupConnection(): void {
    ExpoForegroundAudioModule.stopMicCapture().catch(() => {});
    this.removeAudioDataListener();
    ExpoForegroundAudioModule.stopAudioPlayer().catch(() => {});

    if (this.ws) {
      try {
        this.ws.close();
      } catch (_e) {
        /* ignore */
      }
      this.ws = null;
    }

    this.isSetupDone = false;
    this.audioBytesSent = 0;
    this.audioPacketsSent = 0;
    this.audioChunksReceived = 0;
  }

  private cleanup(): void {
    this.cleanupConnection();
    this.eventHandlers.clear();
    this.toolCallNames.clear();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Export singleton — same pattern as webrtcManager
export const geminiManager = new GeminiManager();
