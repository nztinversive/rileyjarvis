import type {
  RealtimeCredential,
  RemoteCodexLifecycleEvent,
  VectorArtifact,
  VectorPlatform,
  VectorToolCall,
  VectorToolResult,
  VectorToolSpec,
} from "../platform";

export type VectorConnectionState = "idle" | "connecting" | "connected" | "error";
export type VectorMood = "idle" | "listening" | "thinking" | "speaking" | "working" | "error";

export type MouthShape = {
  open: number;
  width: number;
  round: number;
  teeth: number;
};

export type TranscriptEntry = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  at: string;
};

export type RealtimeCallbacks = {
  onConnectionState: (state: VectorConnectionState) => void;
  onMood: (mood: VectorMood) => void;
  onMouthShape: (shape: MouthShape) => void;
  onTranscript: (entry: TranscriptEntry) => void;
  onArtifact: (artifact: VectorArtifact) => void;
  onMode: (mode: "display" | "computer") => void;
  onStatus: (message: string) => void;
  onThumbnailReady: () => void;
};

type ServerEvent = {
  type?: string;
  delta?: string;
  transcript?: string;
  response?: {
    output?: ResponseOutputItem[];
  };
  item?: {
    type?: string;
    role?: string;
    content?: Array<{ transcript?: string; text?: string }>;
  };
  error?: {
    message?: string;
  };
};

type ResponseOutputItem = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  content?: Array<{ transcript?: string; text?: string }>;
};

const realtimeUrl = "https://api.openai.com/v1/realtime/calls";

export type PreparedRealtimeSession = {
  credential: RealtimeCredential;
  toolSpecs: VectorToolSpec[];
  remoteCodexAvailable: boolean;
};

export async function prepareRealtimeSession(platform: VectorPlatform): Promise<PreparedRealtimeSession> {
  const toolSpecs = await platform.listToolSpecs();
  const credential = await platform.createRealtimeCredential();
  return {
    credential,
    toolSpecs,
    remoteCodexAvailable: toolSpecs.some((tool) => tool.name === "remote_codex_start"),
  };
}

export function realtimeConnectedStatus(remoteCodexAvailable: boolean): string {
  return remoteCodexAvailable ? "Vector is live. Remote Codex is ready." : "Vector is live.";
}

export class VectorRealtimeClient {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private micStream: MediaStream | null = null;
  private platform: VectorPlatform;
  private callbacks: RealtimeCallbacks;
  private currentAssistantText = "";
  private toolSpecs: VectorToolSpec[] = [];
  private remoteCodexAvailable = false;
  private toolRunning = false;
  private responseInProgress = false;
  private pendingAnnouncements: string[] = [];
  private audioContext: AudioContext | null = null;
  private outputAnalyser: AnalyserNode | null = null;
  private outputMeterFrame = 0;
  private smoothedMouthShape: MouthShape = silentMouthShape();
  private connectionAttempt = 0;

  constructor(platform: VectorPlatform, callbacks: RealtimeCallbacks) {
    this.platform = platform;
    this.callbacks = callbacks;
  }

  async connect(): Promise<void> {
    if (this.pc) return;
    const connectionAttempt = ++this.connectionAttempt;
    this.callbacks.onConnectionState("connecting");
    this.callbacks.onMood("thinking");
    this.callbacks.onStatus("Minting a Realtime client secret.");

    try {
      const session = await prepareRealtimeSession(this.platform);
      if (!this.isCurrentConnectionAttempt(connectionAttempt)) return;
      this.toolSpecs = session.toolSpecs;
      this.remoteCodexAvailable = session.remoteCodexAvailable;
      const pc = new RTCPeerConnection();
      this.pc = pc;
      const audio = document.createElement("audio");
      audio.autoplay = true;

      pc.ontrack = (event) => {
        if (!this.isCurrentConnectionAttempt(connectionAttempt)) return;
        audio.srcObject = event.streams[0];
        this.startOutputMeter(event.streams[0]);
      };

      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (!this.isCurrentConnectionAttempt(connectionAttempt)) {
        micStream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.micStream = micStream;
      pc.addTrack(micStream.getAudioTracks()[0], micStream);

      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.addEventListener("open", () => {
        if (!this.isCurrentConnectionAttempt(connectionAttempt)) return;
        this.callbacks.onConnectionState("connected");
        this.callbacks.onMood("idle");
        this.callbacks.onStatus(realtimeConnectedStatus(this.remoteCodexAvailable));
        this.flushRemoteCodexAnnouncements();
      });
      dc.addEventListener("message", (event) => {
        void this.handleServerEvent(event.data);
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (!this.isCurrentConnectionAttempt(connectionAttempt)) return;

      const sdpResponse = await fetch(realtimeUrl, {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${session.credential.value}`,
          "Content-Type": "application/sdp",
        },
      });
      if (!this.isCurrentConnectionAttempt(connectionAttempt)) return;

      if (!sdpResponse.ok) {
        throw new Error(`Realtime WebRTC call failed: ${sdpResponse.status} ${await sdpResponse.text()}`);
      }

      const answer = await sdpResponse.text();
      if (!this.isCurrentConnectionAttempt(connectionAttempt)) return;
      await pc.setRemoteDescription({
        type: "answer",
        sdp: answer,
      });
    } catch (error) {
      if (!this.isCurrentConnectionAttempt(connectionAttempt)) return;
      this.callbacks.onConnectionState("error");
      this.callbacks.onMood("error");
      this.callbacks.onStatus(error instanceof Error ? error.message : String(error));
      this.disconnect();
    }
  }

  disconnect(): void {
    this.connectionAttempt += 1;
    this.dc?.close();
    this.pc?.close();
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.stopOutputMeter();
    this.dc = null;
    this.pc = null;
    this.micStream = null;
    this.remoteCodexAvailable = false;
    this.responseInProgress = false;
    this.currentAssistantText = "";
    this.callbacks.onConnectionState("idle");
    this.callbacks.onMood("idle");
    this.callbacks.onMouthShape(silentMouthShape());
  }

  private isCurrentConnectionAttempt(connectionAttempt: number): boolean {
    return connectionAttempt === this.connectionAttempt;
  }

  sendText(text: string): void {
    if (!this.dc || this.dc.readyState !== "open") {
      this.callbacks.onStatus("Connect Vector before sending a text prompt.");
      return;
    }
    this.callbacks.onTranscript(newEntry("user", text));
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.sendEvent({ type: "response.create" });
  }

  announceRemoteCodexEvent(event: RemoteCodexLifecycleEvent): void {
    if (!event.announcement) return;
    this.pendingAnnouncements.push(event.announcement);
    this.flushRemoteCodexAnnouncements();
  }

  private async handleServerEvent(raw: string): Promise<void> {
    const event = safeParseEvent(raw);
    if (!event.type) return;

    if (event.type === "error") {
      this.callbacks.onMood("error");
      this.callbacks.onStatus(event.error?.message || "Realtime API returned an error.");
      return;
    }

    if (event.type === "response.created") {
      this.responseInProgress = true;
      return;
    }

    if (event.type === "input_audio_buffer.speech_started") {
      this.callbacks.onMood("listening");
      return;
    }

    if (event.type === "input_audio_buffer.speech_stopped") {
      this.callbacks.onMood("thinking");
      return;
    }

    if (event.type === "response.audio.delta" || event.type === "response.output_audio.delta") {
      this.callbacks.onMood("speaking");
      return;
    }

    if (event.type === "response.output_audio.done" || event.type === "response.audio.done") {
      if (!this.toolRunning) this.callbacks.onMood("idle");
      return;
    }

    if (
      event.type === "response.audio_transcript.delta" ||
      event.type === "response.output_audio_transcript.delta" ||
      event.type === "response.output_text.delta"
    ) {
      this.currentAssistantText += event.delta || "";
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = event.transcript || collectItemText(event.item);
      if (transcript) this.callbacks.onTranscript(newEntry("user", transcript));
      return;
    }

    if (event.type === "response.done") {
      this.responseInProgress = false;
      const output = event.response?.output || [];
      const spoken = this.currentAssistantText || output.map(collectOutputText).filter(Boolean).join("\n");
      if (spoken) this.callbacks.onTranscript(newEntry("assistant", spoken));
      this.currentAssistantText = "";

      const functionCalls = output.filter((item) => item.type === "function_call" && item.name && item.call_id);
      if (functionCalls.length > 0) {
        await this.executeFunctionCalls(functionCalls);
      } else if (!this.toolRunning) {
        this.callbacks.onMood("idle");
      }
      this.flushRemoteCodexAnnouncements();
    }
  }

  private async executeFunctionCalls(items: ResponseOutputItem[]): Promise<void> {
    this.toolRunning = true;
    this.callbacks.onMood("working");
    let shouldCreateResponse = false;

    for (const item of items) {
      const callId = item.call_id;
      const name = item.name;
      if (!callId || !name) continue;

      const parsedArgs = parseToolArguments(item.arguments || "{}");
      const knownTool = this.toolSpecs.some((tool) => tool.name === name);
      if (!knownTool) {
        await this.returnToolOutput(callId, {
          ok: false,
          error: `Tool is not available: ${name}`,
        });
        shouldCreateResponse = true;
        continue;
      }

      this.callbacks.onTranscript(newEntry("tool", `Running ${name}`));
      if (name === "image_generate") {
        this.callbacks.onArtifact({
          title: "Generating Image",
          kind: "imageLoading",
          content: typeof parsedArgs.prompt === "string" ? parsedArgs.prompt : "Vector is generating an image.",
        });
      }
      if (name === "thumbnail_generate" || name === "thumbnail_edit") {
        const loadingResult = await this.platform.executeTool({
          name: "thumbnail_loading_prepare",
          arguments: {
            ...parsedArgs,
            mode: name === "thumbnail_edit" ? "edit" : "generate",
          },
        } satisfies VectorToolCall);
        if (typeof loadingResult.runId === "string") parsedArgs.runId = loadingResult.runId;
        if (typeof loadingResult.targetId === "string") parsedArgs.targetId = loadingResult.targetId;
        if (loadingResult.artifact) this.callbacks.onArtifact(loadingResult.artifact);
      }
      const result = await this.platform.executeTool({ name, arguments: parsedArgs } satisfies VectorToolCall);
      if (result.mode === "display" || result.mode === "computer") {
        this.callbacks.onMode(result.mode);
      }
      if (result.artifact) this.callbacks.onArtifact(result.artifact);
      if (result.thumbnailReady === true) this.callbacks.onThumbnailReady();
      if (result.silent !== true) shouldCreateResponse = true;
      await this.returnToolOutput(callId, result);
    }

    if (shouldCreateResponse) this.sendEvent({ type: "response.create" });
    this.toolRunning = false;
    this.flushRemoteCodexAnnouncements();
  }

  private async returnToolOutput(callId: string, result: VectorToolResult): Promise<void> {
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(sanitizeToolResult(result)),
      },
    });
  }

  private sendEvent(event: Record<string, unknown>): void {
    if (this.dc?.readyState === "open") {
      if (event.type === "response.create") this.responseInProgress = true;
      this.dc.send(JSON.stringify(event));
    }
  }

  private flushRemoteCodexAnnouncements(): void {
    if (!this.dc || this.dc.readyState !== "open" || this.toolRunning || this.responseInProgress) return;
    const announcement = this.pendingAnnouncements.shift();
    if (!announcement) return;
    this.sendEvent({
      type: "response.create",
      response: {
        instructions: `This is an automatic Remote Codex lifecycle notification. Do not call tools. Briefly tell Noah: ${announcement}`,
      },
    });
  }

  private startOutputMeter(stream: MediaStream): void {
    this.stopOutputMeter();

    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.72;
    source.connect(analyser);

    this.audioContext = audioContext;
    this.outputAnalyser = analyser;

    const samples = new Uint8Array(analyser.fftSize);
    const frequencies = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      analyser.getByteFrequencyData(frequencies);
      let total = 0;
      for (const sample of samples) {
        const centered = (sample - 128) / 128;
        total += centered * centered;
      }
      const rms = Math.sqrt(total / samples.length);
      const energy = clamp01(rms * 10.5);
      const bands = getSpeechBands(frequencies);

      // Simple realtime viseme approximation: low energy rounds the mouth,
      // mid energy opens it, high energy stretches it for consonants/ee sounds.
      const target: MouthShape = {
        open: clamp01(energy * 0.75 + bands.mid * 0.45 - bands.high * 0.16),
        width: clamp01(0.28 + bands.mid * 0.55 + bands.high * 0.74 - bands.low * 0.28),
        round: clamp01(0.08 + bands.low * 0.95 + energy * 0.1 - bands.high * 0.42),
        teeth: clamp01(bands.high * 1.4 + bands.mid * 0.25 - bands.low * 0.35),
      };

      this.smoothedMouthShape = smoothMouthShape(this.smoothedMouthShape, target, 0.36);
      this.callbacks.onMouthShape(this.smoothedMouthShape);
      this.outputMeterFrame = window.requestAnimationFrame(tick);
    };
    tick();
  }

  private stopOutputMeter(): void {
    if (this.outputMeterFrame) {
      window.cancelAnimationFrame(this.outputMeterFrame);
      this.outputMeterFrame = 0;
    }
    void this.audioContext?.close();
    this.audioContext = null;
    this.outputAnalyser = null;
    this.smoothedMouthShape = silentMouthShape();
  }
}

function silentMouthShape(): MouthShape {
  return { open: 0, width: 0.18, round: 0, teeth: 0 };
}

function smoothMouthShape(current: MouthShape, target: MouthShape, amount: number): MouthShape {
  return {
    open: lerp(current.open, target.open, amount),
    width: lerp(current.width, target.width, amount),
    round: lerp(current.round, target.round, amount),
    teeth: lerp(current.teeth, target.teeth, amount),
  };
}

function getSpeechBands(frequencies: Uint8Array): { low: number; mid: number; high: number } {
  const low = averageRange(frequencies, 2, 14) / 255;
  const mid = averageRange(frequencies, 14, 48) / 255;
  const high = averageRange(frequencies, 48, 110) / 255;
  return { low: clamp01(low * 2.2), mid: clamp01(mid * 2.1), high: clamp01(high * 2.8) };
}

function averageRange(values: Uint8Array, start: number, end: number): number {
  const cappedEnd = Math.min(end, values.length);
  if (start >= cappedEnd) return 0;
  let total = 0;
  for (let index = start; index < cappedEnd; index += 1) {
    total += values[index];
  }
  return total / (cappedEnd - start);
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function newEntry(role: TranscriptEntry["role"], text: string): TranscriptEntry {
  return {
    id: createEntryId(),
    role,
    text,
    at: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
  };
}

export function createEntryId(
  cryptoImpl: Pick<Crypto, "getRandomValues"> & Partial<Pick<Crypto, "randomUUID">> = globalThis.crypto,
): string {
  if (typeof cryptoImpl.randomUUID === "function") return cryptoImpl.randomUUID();

  const bytes = cryptoImpl.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeParseEvent(raw: string): ServerEvent {
  try {
    return JSON.parse(raw) as ServerEvent;
  } catch {
    return {};
  }
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sanitizeToolResult(result: VectorToolResult): VectorToolResult {
  if (!result.artifact) return result;

  const { artifact, ...rest } = result;
  return {
    ...rest,
    artifact: {
      title: artifact.title,
      kind: artifact.kind,
      content:
        artifact.kind === "thumbnailBoard"
          ? "Thumbnail board rendered in the UI. Use the compact board field for exact numbers, selected state, and loading state."
          : artifact.kind === "image" || artifact.kind === "imageLoading"
            ? "Image rendered in the UI."
            : artifact.content.length > 1200
              ? `${artifact.content.slice(0, 1200)}...`
              : artifact.content,
      language: artifact.language,
      fullscreen: artifact.fullscreen,
    },
  };
}

function collectItemText(item: ServerEvent["item"]): string {
  return item?.content?.map((part) => part.transcript || part.text || "").filter(Boolean).join("\n") || "";
}

function collectOutputText(item: ResponseOutputItem): string {
  return item.content?.map((part) => part.transcript || part.text || "").filter(Boolean).join("\n") || "";
}
