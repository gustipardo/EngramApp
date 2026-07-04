import ExpoForegroundAudioModule from "expo-foreground-audio";
import { getLiveCredential, LiveCredential } from "./tokenService";
import { micSource } from "./micSource";
import { useConnectionStore } from "../stores/useConnectionStore";
import { sessionLog } from "./sessionDebugLogger";

const GEMINI_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_ATTEMPT_TIMEOUT_MS = 30000;

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
  // True between `stopCurrentAudio()` and the next `connect()`. While set,
  // incoming `serverContent.modelTurn.parts` audio chunks are dropped
  // instead of forwarded to the AudioTrack — prevents trailing TTS after
  // End Session / Pause when the WS keeps streaming during teardown
  // (SESSION-FLOW.md BUG 6).
  private playbackHalted = false;

  // Latest server-issued session-resumption handle (Gemini `sessionResumptionUpdate`).
  // Persisted across an unintended drop so `updateSession` can replay it in the
  // reconnect `setup` and have the server restore the real conversation context
  // — the native fix for BUG 15 (resume-of-context used to fail). Cleared on a
  // fresh session (`connect()` when not reconnecting) and on full `disconnect()`
  // so a stale handle never leaks into a new session. See GEMINI-API.md §16.
  private sessionResumptionHandle: string | null = null;

  // Audio stats tracking (for level meter + debugging)
  private audioBytesSent = 0;
  private audioPacketsSent = 0;
  private audioChunksReceived = 0;

  onConnectionDropped: (() => void) | null = null;

  // -------------------------------------------------------------------------
  // API key & WebSocket URL
  // -------------------------------------------------------------------------

  // Build the Live WebSocket URL from a credential (token broker, blocker #1).
  //  - ephemeral token: v1alpha `BidiGenerateContentConstrained` + `?access_token=`.
  //    The plain `BidiGenerateContent` method rejects ephemeral tokens with
  //    1008 "unregistered callers" — tokens only work on the Constrained RPC
  //    (which enforces the token's liveConnectConstraints).
  //  - raw dev key: legacy v1beta endpoint + `?key=` (dev bypass only).
  private buildWsUrl(cred: LiveCredential): string {
    const base =
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage";
    if (cred.kind === "token") {
      return `${base}.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${cred.value}`;
    }
    return `${base}.v1beta.GenerativeService.BidiGenerateContent?key=${cred.value}`;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  async connect(): Promise<boolean> {
    const setConnectionState = useConnectionStore.getState().setConnectionState;

    try {
      setConnectionState("connecting");
      this.isInitialConnect = true;
      this.playbackHalted = false;

      // A fresh session (not a reconnect) must not carry a resumption handle
      // from a previous session. `reconnect()` sets `isReconnecting` before
      // calling us, so this only clears on a genuine new-session connect.
      if (!this.isReconnecting) {
        this.sessionResumptionHandle = null;
      }

      // 1. Open WebSocket
      await this.openWebSocket();
      sessionLog.info("Gemini", "WebSocket opened");

      // 2. Init audio output player
      await ExpoForegroundAudioModule.initAudioPlayer(OUTPUT_SAMPLE_RATE);
      sessionLog.info("Gemini", "audio player initialised", {
        sampleRate: OUTPUT_SAMPLE_RATE,
      });

      // 3. Start mic capture (muted initially — chunks won't be sent).
      //    Goes through `micSource` so test mode can substitute a
      //    pre-recorded PCM stream without touching this code path.
      await micSource.startCapture(INPUT_SAMPLE_RATE);
      this.setupAudioDataListener();
      sessionLog.info("Gemini", "mic capture started", {
        sampleRate: INPUT_SAMPLE_RATE,
      });

      this.isInitialConnect = false;
      setConnectionState("connected");
      return true;
    } catch (error: any) {
      sessionLog.error("Gemini", "connection failed", {
        message: error?.message,
      });
      this.isInitialConnect = false;
      setConnectionState("failed");
      this.cleanupConnection();
      throw error;
    }
  }

  async reconnect(): Promise<boolean> {
    if (this.isReconnecting) {
      sessionLog.warn("Gemini", "reconnect already in progress");
      return false;
    }

    this.isReconnecting = true;
    const connStore = useConnectionStore.getState();
    connStore.setConnectionState("reconnecting");
    connStore.resetReconnectAttempts();

    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
      useConnectionStore.getState().incrementReconnectAttempts();
      const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      sessionLog.info(
        "Gemini",
        `reconnect attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS}`,
        { delay_ms: delay },
      );

      await this.sleep(delay);
      this.cleanupConnection();

      try {
        // Bound the whole attempt. connect() has an internal 15 s WS
        // timeout, but the credential fetch (mintLiveToken callable) runs
        // BEFORE it and can hang far longer on a flapping network — run
        // 20260704-165928 sat inside attempt 1 indefinitely, so attempts
        // 2/3 and the failure path never ran. A timed-out attempt counts
        // as failed and falls through to the next one.
        await Promise.race([
          this.connect(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("reconnect attempt timed out")),
              RECONNECT_ATTEMPT_TIMEOUT_MS,
            ),
          ),
        ]);
        useConnectionStore.getState().resetReconnectAttempts();
        this.isReconnecting = false;
        sessionLog.info("Gemini", `reconnected on attempt ${attempt}`);
        return true;
      } catch (error: any) {
        sessionLog.warn("Gemini", `reconnect attempt ${attempt} failed`, {
          message: error?.message,
        });
      }
    }

    sessionLog.error("Gemini", "all reconnect attempts failed");
    useConnectionStore.getState().setConnectionState("failed");
    this.isReconnecting = false;
    return false;
  }

  disconnect(): void {
    const setConnectionState = useConnectionStore.getState().setConnectionState;
    this.onConnectionDropped = null;
    this.isReconnecting = false;
    this.cleanup();
    setConnectionState("disconnected");
    sessionLog.info("Gemini", "disconnected");
  }

  // -------------------------------------------------------------------------
  // WebSocket management
  // -------------------------------------------------------------------------

  private async openWebSocket(): Promise<void> {
    // Fetch the credential first (ephemeral token from the broker, or the raw
    // dev key when the payment gate is bypassed). Network call in the token
    // case — do it before entering the connection Promise.
    const cred = await getLiveCredential();
    const url = this.buildWsUrl(cred);

    return new Promise((resolve, reject) => {
      sessionLog.debug("Gemini", "opening WebSocket", {
        url: url.replace(/(access_token|key)=[^&]+/, "$1=***"),
      });
      this.ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        reject(new Error("WebSocket connection timeout"));
      }, 15000);

      this.ws.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };

      this.ws.onerror = (error: any) => {
        clearTimeout(timeout);
        sessionLog.error("Gemini", "WebSocket error", {
          message: error?.message || String(error),
        });
        // Only reject if we're still in the initial connect handshake
        if (this.isInitialConnect) {
          reject(new Error("WebSocket connection error"));
        }
      };

      this.ws.onmessage = (event: any) => {
        this.handleMessage(event.data);
      };

      this.ws.onclose = (event: any) => {
        const code = event?.code;
        const reason = event?.reason || "(no reason)";
        sessionLog.warn("Gemini", "WebSocket closed", { code, reason });

        // Emit a close event so pending waiters (e.g. updateSession) can
        // fail fast instead of waiting for their 15 s timeout.
        this.emitEvent("ws.closed", { code, reason });

        const currentState = useConnectionStore.getState().connectionState;
        if (currentState === "connected" && !this.isReconnecting) {
          useConnectionStore.getState().setConnectionState("failed");
          useConnectionStore.getState().setNetworkStatus("offline");
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
    this.audioDataSubscription = micSource.addListener(
      (event: { data: string }) => {
        this.audioChunksReceived++;
        // Sparse heartbeat — only when verbose. Otherwise mic activity is
        // visible via the level meter + speech_started/transcript events.
        if (this.audioChunksReceived % 200 === 1) {
          sessionLog.debug("Gemini", "mic heartbeat", {
            chunk: this.audioChunksReceived,
            len: event.data?.length ?? 0,
            muted: this.isMuted,
            ws: this.ws?.readyState,
            setup: this.isSetupDone,
          });
        }
        if (
          !this.isMuted &&
          this.ws &&
          this.ws.readyState === WebSocket.OPEN &&
          this.isSetupDone
        ) {
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
  // Incoming message handler — translates Gemini wire events into the app's internal event names
  // -------------------------------------------------------------------------

  private async handleMessage(rawData: string | object): Promise<void> {
    let msg: any;
    try {
      let text: string;
      if (typeof rawData === "string") {
        text = rawData;
      } else if (typeof (rawData as any)?.text === "function") {
        // Blob or Blob-like (duck-typed — instanceof Blob can fail in RN polyfills)
        text = await (rawData as any).text();
      } else if (rawData instanceof ArrayBuffer) {
        text = new TextDecoder().decode(rawData);
      } else {
        sessionLog.warn("Gemini", "unexpected ws message type", {
          type: typeof rawData,
          tag: Object.prototype.toString.call(rawData),
        });
        text = JSON.stringify(rawData);
      }
      msg = JSON.parse(text);
    } catch (e: any) {
      sessionLog.error("Gemini", "failed to parse message", {
        message: e?.message,
      });
      return;
    }

    // Verbose-only raw dump. The default stream relies on structured
    // events emitted below (setupComplete, toolCall, transcript, turnComplete)
    // — those are what actually drive the session and they each log themselves.
    if (sessionLog.isVerbose()) {
      const hasAudioOnly =
        msg.serverContent?.modelTurn?.parts?.every((p: any) => p.inlineData) &&
        !msg.serverContent?.turnComplete &&
        !msg.serverContent?.inputTranscription &&
        !msg.serverContent?.outputTranscription;
      if (!hasAudioOnly) {
        sessionLog.debug("Gemini", "msg", { keys: Object.keys(msg) });
        if (!msg.serverContent) {
          sessionLog.debug("Gemini", "msg full", {
            body: JSON.stringify(msg).slice(0, 500),
          });
        }
      }
    }

    // --- error → log and propagate ---
    if (msg.error) {
      sessionLog.error("Gemini", "server error", { error: msg.error });
      this.emitEvent("error", msg.error);
      return;
    }

    // --- sessionResumptionUpdate → cache the latest resumable handle ---
    // The server periodically sends a new handle that represents the current
    // session state. We keep only the most recent resumable one; on a drop,
    // `updateSession` replays it in the reconnect setup (BUG 15 fix).
    if (msg.sessionResumptionUpdate) {
      const { newHandle, resumable } = msg.sessionResumptionUpdate;
      if (resumable && newHandle) {
        this.sessionResumptionHandle = newHandle;
        sessionLog.debug("Gemini", "session resumption handle updated");
      }
      this.emitEvent("session.resumption_update", { resumable: !!resumable });
      return;
    }

    // --- goAway → server is about to close this connection ---
    // Sent with `timeLeft` before the server terminates (e.g. session age /
    // maintenance). We log it and emit an event; the existing onclose →
    // onConnectionDropped path drives the reconnect, which now resumes via the
    // cached handle above. (GEMINI-API.md §9 / §17)
    if (msg.goAway) {
      sessionLog.warn("Gemini", "server goAway", {
        time_left: msg.goAway.timeLeft,
      });
      this.emitEvent("ws.goAway", { timeLeft: msg.goAway.timeLeft });
      return;
    }

    // --- setupComplete → session.updated ---
    if (msg.setupComplete !== undefined) {
      sessionLog.event("Gemini", "setupComplete");
      this.emitEvent("session.updated", {});
      return;
    }

    // --- toolCall → response.output_item.added + response.function_call_arguments.done ---
    if (msg.toolCall) {
      const functionCalls = msg.toolCall.functionCalls || [];
      for (const fc of functionCalls) {
        const callId =
          fc.id || `fc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const name = fc.name;
        const args = fc.args || {};

        sessionLog.event("Gemini", "toolCall received", {
          name,
          call_id: callId,
          args,
        });
        this.toolCallNames.set(callId, name);

        // Emit output_item.added so sessionManager can track the tool name
        this.emitEvent("response.output_item.added", {
          item: { type: "function_call", call_id: callId, name },
        });

        // Emit function_call_arguments.done with serialised args
        this.emitEvent("response.function_call_arguments.done", {
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
      // (Transcript content is logged in sessionManager's handler — keep this branch silent here.)
      if (sc.inputTranscription?.text) {
        this.emitEvent(
          "conversation.item.input_audio_transcription.completed",
          {
            transcript: sc.inputTranscription.text,
          },
        );
      }

      // Output transcription (AI speech)
      if (sc.outputTranscription?.text) {
        this.emitEvent("response.audio_transcript.done", {
          transcript: sc.outputTranscription.text,
        });
      }

      // Model turn parts — audio and text
      if (sc.modelTurn?.parts) {
        for (const part of sc.modelTurn.parts) {
          if (part.inlineData?.data) {
            // Emit response.audio.delta so sessionManager can transition phases
            this.emitEvent("response.audio.delta", {});
            // Skip playback if the user just hit End/Pause — the WS may
            // still stream a few chunks during teardown and we don't
            // want them to land in the AudioTrack after flush.
            if (this.playbackHalted) continue;
            // Play the audio chunk through native AudioTrack
            ExpoForegroundAudioModule.playAudioChunk(
              part.inlineData.data,
            ).catch((e: any) => {
              sessionLog.error("Gemini", "audio playback error", {
                message: e?.message,
              });
            });
          }
          if (part.text) {
            sessionLog.event("AI", "text part", { text: part.text });
          }
        }
      }

      // Turn complete → response.done
      if (sc.turnComplete) {
        sessionLog.event("Gemini", "turnComplete → response.done");
        this.emitEvent("response.done", {});
      }
    }
  }

  // -------------------------------------------------------------------------
  // Session configuration (setup message)
  // -------------------------------------------------------------------------

  /**
   * First call: sends the Gemini setup message (model, system instruction,
   * tools, voice config, transcriptions, context-window compression, and
   * session resumption — replaying a cached handle when reconnecting) and
   * waits for setupComplete.
   * Subsequent calls: no-op (Gemini config is immutable after setup).
   */
  async updateSession(config: {
    instructions?: string;
    tools?: any[];
    modalities?: string[];
    turn_detection?: any;
    // BCP-47 (e.g. 'es-ES'). Accepted on the request shape so callers
    // don't have to special-case the call site, but currently **dropped**
    // before reaching the wire — see the comment inside this method.
    languageCode?: string;
  }): Promise<void> {
    if (!this.isSetupDone) {
      // Build Gemini setup payload.
      // NOTE: `speechConfig.languageCode` is intentionally NOT forwarded —
      // the `gemini-2.5-flash-native-audio-preview-*` model rejects the
      // field at setup with WebSocket close code 1007 (`Unsupported
      // language code 'es-ES' for model …`). Per Google's docs, the
      // languageCode parameter only applies to half-cascade (text→TTS)
      // models; the native-audio model auto-detects language from the
      // system instruction + user audio. We therefore steer language
      // entirely via the prompt's "Language: X ONLY" directive (see
      // `src/config/prompts.ts`). Keep the param shape so we can re-enable
      // forwarding if we ever switch back to a half-cascade model.
      // See SESSION-FLOW.md §4.BUG 16.
      void config.languageCode;
      const setup: any = {
        model: `models/${GEMINI_MODEL}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: "Kore" },
            },
          },
        },
        outputAudioTranscription: {},
        inputAudioTranscription: {},
        // Tune Gemini's server-side VAD. Without this block, defaults apply
        // and we observed multi-minute stalls between user speech and the
        // toolCall, only unblocked by the user manually pausing/resuming
        // (which mute-pulses the mic and forces buffer commit). Symptoms in
        // logs: empty `serverContent.turnComplete` events with no audio or
        // function call. HIGH end-of-speech sensitivity + a tighter silence
        // window makes Gemini commit the user turn promptly when they stop
        // talking.
        //
        // `prefixPaddingMs` MUST stay out of this block. Setting it (even to
        // the modest 300 ms we used to send) silently breaks speech detection
        // on this model: the server stops emitting `inputTranscription` and
        // never commits user turns — the session looks deaf. Verified against
        // the live API 2026-07-01 by bisecting this exact config field by
        // field ({prefixPaddingMs: 300} alone → input dead; the remaining
        // three fields → input fine). This was the reason re-answering a
        // wedged session (BUG 9) never worked: after the first turn, VAD
        // re-armed with the padding requirement and went permanently deaf.
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
            endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
            silenceDurationMs: 800,
          },
        },
        // Sliding-window context compression. Without it, a native-audio
        // session hits a hard ~15-minute cap and the server terminates the
        // connection; with it, the context window is trimmed automatically
        // and the session can run effectively unbounded. (GEMINI-API.md §16)
        contextWindowCompression: {
          slidingWindow: {},
        },
        // Enable session resumption. Empty `{}` on a fresh session tells the
        // server to start issuing `sessionResumptionUpdate` handles; on a
        // reconnect we replay the last handle so the server restores the real
        // conversation context instead of starting cold (the native fix for
        // BUG 15). `sessionResumptionHandle` is only set after a drop — a
        // fresh connect clears it (see `connect()`).
        sessionResumption: this.sessionResumptionHandle
          ? { handle: this.sessionResumptionHandle }
          : {},
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
      sessionLog.info("Gemini", "sending setup", {
        model: setup.model,
        tools: !!setup.tools,
        systemInstruction: !!setup.systemInstruction,
        resuming: !!this.sessionResumptionHandle,
        payload_len: setupPayload.length,
        ws_state: this.ws?.readyState,
      });
      sessionLog.debug("Gemini", "setup payload (1000)", {
        body: setupPayload.slice(0, 1000),
      });
      this.ws?.send(setupPayload);

      // Wait for setupComplete (emitted as session.updated), error, or WS close
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeout);
          this.off("session.updated", handler);
          this.off("error", errorHandler);
          this.off("ws.closed", closeHandler);
        };

        const timeout = setTimeout(() => {
          cleanup();
          reject(
            new Error(
              "Gemini setup timeout — no setupComplete received within 15s",
            ),
          );
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
          reject(
            new Error(
              `Gemini WebSocket closed during setup: code=${event.code}, reason=${event.reason}`,
            ),
          );
        };

        this.on("session.updated", handler);
        this.on("error", errorHandler);
        this.on("ws.closed", closeHandler);
      });

      this.isSetupDone = true;
      return;
    }

    // Subsequent calls are no-ops — emit session.updated so waiters resolve
    this.emitEvent("session.updated", {});
  }

  // -------------------------------------------------------------------------
  // Tool format conversion (internal tool shape → Gemini)
  // -------------------------------------------------------------------------

  private convertTool(tool: any): any {
    return {
      name: tool.name,
      description: tool.description,
      ...(tool.parameters
        ? { parameters: this.convertSchemaTypes(tool.parameters) }
        : {}),
    };
  }

  private convertSchemaTypes(schema: any): any {
    if (!schema || typeof schema !== "object") return schema;
    if (Array.isArray(schema)) return schema;

    const result: any = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === "type" && typeof value === "string") {
        result.type = (value as string).toUpperCase();
      } else if (
        key === "properties" &&
        typeof value === "object" &&
        value !== null
      ) {
        result.properties = {};
        for (const [propName, propSchema] of Object.entries(
          value as Record<string, any>,
        )) {
          result.properties[propName] = this.convertSchemaTypes(propSchema);
        }
      } else if (key === "items" && typeof value === "object") {
        result.items = this.convertSchemaTypes(value);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  /**
   * No-op for legacy data-channel events the internal vocabulary emits but Gemini ignores (e.g. input_audio_buffer.clear).
   */
  sendEvent(_event: any): void {
    // Gemini doesn't use these events
  }

  async sendTextMessage(text: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      sessionLog.warn("Gemini", "WebSocket not open — cannot send text");
      return;
    }

    this.ws.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text }] }],
          turnComplete: true,
        },
      }),
    );

    // Emit immediately — Gemini doesn't send an explicit confirmation
    this.emitEvent("conversation.item.created", {});
  }

  sendToolResult(callId: string, result: any): void {
    const name = this.toolCallNames.get(callId) || "";

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      sessionLog.warn("Gemini", "WebSocket not open — cannot send tool result");
      return;
    }

    sessionLog.event("Gemini", "sending toolResponse", {
      name,
      call_id: callId,
    });

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

  /**
   * Drop the cached session-resumption handle so the NEXT reconnect starts
   * with a cold context instead of restoring the previous conversation.
   *
   * Used by the BUG 9 wedge recovery: when the model enters a control-token
   * loop (silent turns of literal `<ctrl46>` transcripts, no audio, no tool
   * call), resuming with the handle restores the poisoned context and the
   * very next evaluation wedges again (verified against the live API
   * 2026-07-01: handle-resume → wedge reproduced; cold resume + app-level
   * resume message → recovered, 2/2). sessionManager rebuilds the context
   * app-side via getResumeMessage after the cold reconnect.
   */
  clearSessionResumptionHandle(): void {
    this.sessionResumptionHandle = null;
  }

  waitForNextResponseDone(): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        this.off("response.done", handler);
        this.off("ws.closed", closeHandler);
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for response.done"));
      }, 30000);

      const handler = () => {
        cleanup();
        resolve();
      };

      const closeHandler = (event: any) => {
        cleanup();
        reject(
          new Error(
            `Gemini WebSocket closed while waiting for response: code=${event.code}, reason=${event.reason}`,
          ),
        );
      };

      this.on("response.done", handler);
      this.on("ws.closed", closeHandler);
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

    const allHandlers = this.eventHandlers.get("all") || [];
    allHandlers.forEach((handler) => handler({ ...event, type: eventType }));
  }

  // -------------------------------------------------------------------------
  // Microphone control
  // -------------------------------------------------------------------------

  setMicrophoneMuted(muted: boolean): void {
    if (this.isMuted === muted) return;
    this.isMuted = muted;
    sessionLog.event("mic", muted ? "muted" : "unmuted");
  }

  // -------------------------------------------------------------------------
  // Status / debug helpers
  // -------------------------------------------------------------------------

  isConnected(): boolean {
    return useConnectionStore.getState().connectionState === "connected";
  }

  async getAudioStats(): Promise<{
    bytesSent: number;
    packetsSent: number;
  } | null> {
    return {
      bytesSent: this.audioBytesSent,
      packetsSent: this.audioPacketsSent,
    };
  }

  async debugAudioTrackState(label: string): Promise<void> {
    sessionLog.debug("Gemini", `audio track state — ${label}`, {
      ws: this.ws?.readyState ?? "null",
      muted: this.isMuted,
      setup: this.isSetupDone,
    });
  }

  // -------------------------------------------------------------------------
  // Audio control
  // -------------------------------------------------------------------------

  /**
   * Immediately silence the audio player without disconnecting.
   * Call on Pause/End Session so the tutor stops speaking right away.
   * AudioTrack.MODE_STREAM stop() drains the buffer first — this flushes it.
   *
   * Also sets `playbackHalted` so any audio chunks that arrive between
   * the flush and the eventual WS close are dropped instead of refilling
   * the AudioTrack. Without this guard the tutor's voice resumes a
   * fraction of a second later as late chunks land (BUG 6).
   */
  stopCurrentAudio(): void {
    this.playbackHalted = true;
    // Synchronous native flag flip — makes queued playAudioChunk calls
    // no-op immediately, draining the AsyncFunction backlog without
    // each chunk blocking on AudioTrack.write(). Without this, the
    // flushAudioPlayer() below waits for ~8 seconds behind the queue
    // and the user hears the tutor finish their sentence (BUG 6).
    try {
      ExpoForegroundAudioModule.haltAudioPlayer(true);
    } catch (_e) {
      /* native may not be loaded in unit tests */
    }
    sessionLog.event("Audio", "playback halted");
    ExpoForegroundAudioModule.flushAudioPlayer().catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  private cleanupConnection(): void {
    micSource.stopCapture().catch(() => {});
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
    this.playbackHalted = false;
  }

  private cleanup(): void {
    this.cleanupConnection();
    this.eventHandlers.clear();
    this.toolCallNames.clear();
    // Full teardown is a session boundary — drop the resumption handle so the
    // next session starts cold rather than trying to resume a dead session.
    this.sessionResumptionHandle = null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Export singleton
export const geminiManager = new GeminiManager();
