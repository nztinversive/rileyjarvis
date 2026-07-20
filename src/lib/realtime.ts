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

export type RealtimeConnectionErrorCode =
  | "audio_session"
  | "microphone_denied"
  | "microphone_missing"
  | "microphone_unavailable"
  | "credential"
  | "credential_expired"
  | "sdp_rejected"
  | "sdp_timeout"
  | "sdp_transport"
  | "peer_connection"
  | "network_offline";

export class RealtimeConnectionError extends Error {
  readonly code: RealtimeConnectionErrorCode;

  constructor(code: RealtimeConnectionErrorCode, message: string) {
    super(message);
    this.name = "RealtimeConnectionError";
    this.code = code;
  }
}

export type RealtimeClientDependencies = {
  createPeerConnection?: () => RTCPeerConnection;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  fetchImpl?: typeof fetch;
  createAudioElement?: () => HTMLAudioElement;
  createAudioContext?: () => AudioContext;
  createMediaStream?: (tracks: MediaStreamTrack[]) => MediaStream;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
  onlineEvents?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  isOnline?: () => boolean;
  now?: () => number;
  sdpTimeoutMs?: number;
  connectionTimeoutMs?: number;
};

export async function prepareRealtimeSession(
  platform: VectorPlatform,
  options?: { signal?: AbortSignal },
): Promise<PreparedRealtimeSession> {
  const toolSpecs = await platform.listToolSpecs();
  const credential = await platform.createRealtimeCredential(options);
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
  private connectionState: VectorConnectionState = "idle";
  private setupAbortController: AbortController | null = null;
  private sdpAbortController: AbortController | null = null;
  private connectionDeadline: ReturnType<typeof globalThis.setTimeout> | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private listenerCleanups: Array<() => void> = [];
  private closingResources = false;
  private voiceSessionPrepared = false;
  private dependencies: RealtimeClientDependencies;

  constructor(platform: VectorPlatform, callbacks: RealtimeCallbacks, dependencies: RealtimeClientDependencies = {}) {
    this.platform = platform;
    this.callbacks = callbacks;
    this.dependencies = dependencies;
  }

  async connect(): Promise<void> {
    if (this.connectionState === "connecting") {
      this.callbacks.onStatus("A Realtime connection attempt is already in progress.");
      return;
    }
    if (this.connectionState === "connected" || this.pc) {
      this.callbacks.onStatus("Vector is already connected.");
      return;
    }

    const connectionAttempt = ++this.connectionAttempt;
    const setupController = new AbortController();
    this.setupAbortController = setupController;
    let credentialToClear: RealtimeCredential | null = null;
    this.setConnectionState("connecting");
    this.callbacks.onMood("thinking");
    this.callbacks.onStatus("Preparing microphone access.");

    try {
      await this.prepareNativeAudioSession(connectionAttempt);
      if (!this.isCurrentConnectionAttempt(connectionAttempt)) return;

      // Preserve Electron's existing credential-first behavior. Native iOS
      // acquires microphone permission before minting so the short-lived
      // credential is not consumed while system permission UI is open.
      let session: PreparedRealtimeSession | null = null;
      if (this.platform.presentation === "desktop" || !this.canAcquireMicrophone()) {
        this.callbacks.onStatus("Creating a secure Realtime session.");
        session = await this.prepareSession(setupController.signal);
        credentialToClear = session.credential;
        if (!this.isCurrentConnectionAttempt(connectionAttempt)) return;
      }

      const micStream = await this.acquireMicrophone();
      if (!this.isCurrentConnectionAttempt(connectionAttempt)) {
        stopStream(micStream);
        return;
      }
      const micTrack = micStream.getAudioTracks()[0];
      if (!micTrack || micTrack.readyState === "ended") {
        stopStream(micStream);
        throw new RealtimeConnectionError(
          "microphone_missing",
          "No microphone input is available. Check the current audio route and try again.",
        );
      }
      this.micStream = micStream;

      this.callbacks.onStatus("Creating a secure Realtime session.");
      session ??= await this.prepareSession(setupController.signal);
      credentialToClear = session.credential;
      if (!this.isCurrentConnectionAttempt(connectionAttempt)) return;
      if (this.setupAbortController === setupController) this.setupAbortController = null;
      this.toolSpecs = session.toolSpecs;
      this.remoteCodexAvailable = session.remoteCodexAvailable;
      if (isCredentialExpired(session.credential, this.now())) {
        clearCredential(session.credential);
        throw new RealtimeConnectionError(
          "credential_expired",
          "The Realtime session credential expired before use. Try connecting again.",
        );
      }

      const pc = this.createPeerConnection();
      this.pc = pc;
      const audio = this.createRemoteAudioElement();
      this.remoteAudio = audio;
      audio.autoplay = true;
      audio.setAttribute("playsinline", "");
      audio.setAttribute("aria-hidden", "true");
      audio.setAttribute("data-vector-realtime-output", "");
      audio.style.display = "none";
      if (typeof document !== "undefined") document.body?.append(audio);

      this.addListener(pc, "track", (rawEvent) => {
        if (!this.isCurrentConnectionAttempt(connectionAttempt)) return;
        const event = rawEvent as RTCTrackEvent;
        const stream = event.streams[0] ?? this.createMediaStream([event.track]);
        audio.srcObject = stream;
        void audio.play().catch(() => {
          if (this.isCurrentConnectionAttempt(connectionAttempt)) {
            this.failActiveConnection(
              connectionAttempt,
              new RealtimeConnectionError(
                "peer_connection",
                "Remote audio could not start. Check the current output route before reconnecting.",
              ),
            );
          }
        });
        try {
          this.startOutputMeter(stream);
        } catch {
          this.stopOutputMeter();
          this.callbacks.onMouthShape(silentMouthShape());
        }
      });
      this.addListener(pc, "connectionstatechange", () => {
        if (!this.isCurrentConnectionAttempt(connectionAttempt) || this.closingResources) return;
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          this.failActiveConnection(
            connectionAttempt,
            new RealtimeConnectionError(
              "peer_connection",
              "The Realtime connection was lost. Disconnect and start a new conversation.",
            ),
          );
        }
      });
      this.addListener(pc, "iceconnectionstatechange", () => {
        if (!this.isCurrentConnectionAttempt(connectionAttempt) || this.closingResources) return;
        if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
          this.failActiveConnection(
            connectionAttempt,
            new RealtimeConnectionError(
              "peer_connection",
              "The Realtime connection was lost. Disconnect and start a new conversation.",
            ),
          );
        }
      });

      pc.addTrack(micTrack, micStream);
      this.addListener(micTrack, "ended", () => {
        if (!this.isCurrentConnectionAttempt(connectionAttempt) || this.closingResources) return;
        this.failActiveConnection(
          connectionAttempt,
          new RealtimeConnectionError(
            "microphone_unavailable",
            "Microphone input stopped. Check the current audio route before reconnecting.",
          ),
        );
      });

      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      this.addListener(dc, "open", () => {
        if (!this.isCurrentConnectionAttempt(connectionAttempt)) return;
        this.clearConnectionDeadline();
        this.setConnectionState("connected");
        this.callbacks.onMood("idle");
        this.callbacks.onStatus(realtimeConnectedStatus(this.remoteCodexAvailable));
        this.flushRemoteCodexAnnouncements();
      });
      this.addListener(dc, "message", (rawEvent) => {
        const event = rawEvent as MessageEvent;
        if (!this.isCurrentConnectionAttempt(connectionAttempt) || typeof event.data !== "string") return;
        void this.handleServerEvent(event.data);
      });
      this.addListener(dc, "close", () => {
        if (!this.isCurrentConnectionAttempt(connectionAttempt) || this.closingResources) return;
        this.failActiveConnection(
          connectionAttempt,
          new RealtimeConnectionError(
            "peer_connection",
            "The Realtime connection closed unexpectedly. Start a new conversation to reconnect.",
          ),
        );
      });
      this.addListener(dc, "error", () => {
        if (!this.isCurrentConnectionAttempt(connectionAttempt) || this.closingResources) return;
        this.failActiveConnection(
          connectionAttempt,
          new RealtimeConnectionError(
            "peer_connection",
            "The Realtime data channel failed. Start a new conversation to reconnect.",
          ),
        );
      });
      const onlineEvents = this.onlineEvents();
      if (onlineEvents) {
        this.addListener(onlineEvents, "offline", () => {
          if (!this.isCurrentConnectionAttempt(connectionAttempt) || this.closingResources) return;
          this.failActiveConnection(
            connectionAttempt,
            new RealtimeConnectionError(
              "network_offline",
              "The network connection is offline. Reconnect after network access returns.",
            ),
          );
        });
      }

      const offer = await pc.createOffer();
      if (!this.isCurrentConnectionAttempt(connectionAttempt)) return;
      await pc.setLocalDescription(offer);
      if (!this.isCurrentConnectionAttempt(connectionAttempt)) return;

      let credentialValue = session.credential.value;
      clearCredential(session.credential);
      credentialToClear = null;
      const controller = new AbortController();
      this.sdpAbortController = controller;
      const timeout = globalThis.setTimeout(() => controller.abort(), this.sdpTimeoutMs());
      let sdpResponse: Response;
      try {
        sdpResponse = await this.fetchImpl()(realtimeUrl, {
          method: "POST",
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${credentialValue}`,
            "Content-Type": "application/sdp",
          },
          signal: controller.signal,
        });
      } catch {
        globalThis.clearTimeout(timeout);
        if (this.sdpAbortController === controller) this.sdpAbortController = null;
        if (!this.isCurrentConnectionAttempt(connectionAttempt)) return;
        throw controller.signal.aborted
          ? new RealtimeConnectionError("sdp_timeout", "The Realtime connection timed out. Try again.")
          : new RealtimeConnectionError("sdp_transport", "Unable to reach the Realtime service. Check the network and try again.");
      } finally {
        credentialValue = "";
      }
      if (!this.isCurrentConnectionAttempt(connectionAttempt)) {
        globalThis.clearTimeout(timeout);
        if (this.sdpAbortController === controller) this.sdpAbortController = null;
        return;
      }

      if (!sdpResponse.ok) {
        globalThis.clearTimeout(timeout);
        if (this.sdpAbortController === controller) this.sdpAbortController = null;
        throw new RealtimeConnectionError(
          "sdp_rejected",
          `The Realtime service rejected the connection (HTTP ${safeHttpStatus(sdpResponse.status)}). Try again.`,
        );
      }

      let answer: string;
      try {
        answer = await readBoundedSdpResponse(sdpResponse);
      } catch (error) {
        if (!this.isCurrentConnectionAttempt(connectionAttempt)) return;
        if (error instanceof RealtimeConnectionError) throw error;
        throw controller.signal.aborted
          ? new RealtimeConnectionError("sdp_timeout", "The Realtime connection timed out. Try again.")
          : new RealtimeConnectionError("sdp_transport", "Unable to read the Realtime connection response. Try again.");
      } finally {
        globalThis.clearTimeout(timeout);
        if (this.sdpAbortController === controller) this.sdpAbortController = null;
      }
      if (!this.isCurrentConnectionAttempt(connectionAttempt)) return;
      if (controller.signal.aborted) {
        throw new RealtimeConnectionError("sdp_timeout", "The Realtime connection timed out. Try again.");
      }
      if (answer.length === 0) {
        throw new RealtimeConnectionError(
          "peer_connection",
          "The Realtime service returned an unusable connection response. Try again.",
        );
      }
      try {
        await pc.setRemoteDescription({
          type: "answer",
          sdp: answer,
        });
      } catch {
        throw new RealtimeConnectionError(
          "peer_connection",
          "The Realtime service returned an unusable connection response. Try again.",
        );
      }
      if (this.isCurrentConnectionAttempt(connectionAttempt) && !this.isConnected()) {
        this.connectionDeadline = globalThis.setTimeout(() => {
          if (!this.isCurrentConnectionAttempt(connectionAttempt) || this.isConnected()) return;
          this.failActiveConnection(
            connectionAttempt,
            new RealtimeConnectionError(
              "peer_connection",
              "The Realtime connection did not become ready in time. Check the network and try again.",
            ),
          );
        }, this.connectionTimeoutMs());
      }
    } catch (error) {
      if (!this.isCurrentConnectionAttempt(connectionAttempt)) return;
      this.connectionAttempt += 1;
      this.closeRealtimeResources();
      this.setConnectionState("error");
      this.callbacks.onMood("error");
      this.callbacks.onStatus(sanitizeConnectionError(error).message);
    } finally {
      if (credentialToClear) clearCredential(credentialToClear);
      if (this.setupAbortController === setupController) this.setupAbortController = null;
    }
  }

  disconnect(): void {
    this.connectionAttempt += 1;
    this.closeRealtimeResources();
    this.setConnectionState("idle");
    this.callbacks.onMood("idle");
  }

  private closeRealtimeResources(): void {
    this.closingResources = true;
    try {
      this.setupAbortController?.abort();
      this.setupAbortController = null;
      this.sdpAbortController?.abort();
      this.sdpAbortController = null;
      this.clearConnectionDeadline();
      for (const removeListener of this.listenerCleanups.splice(0)) removeListener();
      this.dc?.close();
      this.pc?.close();
      stopStream(this.micStream);
      this.stopOutputMeter();
      if (this.remoteAudio) {
        this.remoteAudio.pause();
        this.remoteAudio.srcObject = null;
        this.remoteAudio.removeAttribute("src");
        this.remoteAudio.load();
        this.remoteAudio.remove();
      }
      this.dc = null;
      this.pc = null;
      this.micStream = null;
      this.remoteAudio = null;
      this.remoteCodexAvailable = false;
      this.responseInProgress = false;
      this.currentAssistantText = "";
      this.callbacks.onMouthShape(silentMouthShape());
      if (this.voiceSessionPrepared) {
        this.voiceSessionPrepared = false;
        void this.platform.voiceSession?.deactivate().catch(() => undefined);
      }
    } finally {
      this.closingResources = false;
    }
  }

  private isCurrentConnectionAttempt(connectionAttempt: number): boolean {
    return connectionAttempt === this.connectionAttempt;
  }

  private setConnectionState(state: VectorConnectionState): void {
    this.connectionState = state;
    this.callbacks.onConnectionState(state);
  }

  private isConnected(): boolean {
    return this.connectionState === "connected";
  }

  private async prepareNativeAudioSession(connectionAttempt: number): Promise<void> {
    if (!this.platform.voiceSession) return;
    try {
      await this.platform.voiceSession.prepare();
    } catch (error) {
      throw sanitizeAudioSessionError(error);
    }
    if (!this.isCurrentConnectionAttempt(connectionAttempt)) {
      void this.platform.voiceSession.deactivate().catch(() => undefined);
      return;
    }
    this.voiceSessionPrepared = true;
  }

  private async acquireMicrophone(): Promise<MediaStream> {
    if (!this.isOnline()) {
      throw new RealtimeConnectionError(
        "network_offline",
        "The network connection is offline. Reconnect after network access returns.",
      );
    }
    try {
      return await this.getUserMedia()({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      throw sanitizeMicrophoneError(error);
    }
  }

  private async prepareSession(signal: AbortSignal): Promise<PreparedRealtimeSession> {
    try {
      return await prepareRealtimeSession(this.platform, { signal });
    } catch (error) {
      throw sanitizeCredentialError(error);
    }
  }

  private failActiveConnection(connectionAttempt: number, error: RealtimeConnectionError): void {
    if (!this.isCurrentConnectionAttempt(connectionAttempt)) return;
    this.connectionAttempt += 1;
    this.closeRealtimeResources();
    this.setConnectionState("error");
    this.callbacks.onMood("error");
    this.callbacks.onStatus(error.message);
  }

  private addListener(
    target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
    type: string,
    listener: EventListener,
  ): void {
    target.addEventListener(type, listener);
    this.listenerCleanups.push(() => target.removeEventListener(type, listener));
  }

  private createPeerConnection(): RTCPeerConnection {
    return this.dependencies.createPeerConnection?.() ?? new RTCPeerConnection();
  }

  private getUserMedia(): (constraints: MediaStreamConstraints) => Promise<MediaStream> {
    return (
      this.dependencies.getUserMedia ??
      ((constraints) => {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new RealtimeConnectionError(
            "microphone_missing",
            "Microphone capture is not supported in this environment.",
          );
        }
        return navigator.mediaDevices.getUserMedia(constraints);
      })
    );
  }

  private canAcquireMicrophone(): boolean {
    return Boolean(
      this.dependencies.getUserMedia ||
        (typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia),
    );
  }

  private fetchImpl(): typeof fetch {
    return this.dependencies.fetchImpl ?? fetch;
  }

  private createRemoteAudioElement(): HTMLAudioElement {
    return this.dependencies.createAudioElement?.() ?? document.createElement("audio");
  }

  private createMediaStream(tracks: MediaStreamTrack[]): MediaStream {
    return this.dependencies.createMediaStream?.(tracks) ?? new MediaStream(tracks);
  }

  private createAudioContext(): AudioContext {
    return this.dependencies.createAudioContext?.() ?? new AudioContext();
  }

  private requestFrame(callback: FrameRequestCallback): number {
    return this.dependencies.requestAnimationFrame?.(callback) ?? window.requestAnimationFrame(callback);
  }

  private cancelFrame(handle: number): void {
    if (this.dependencies.cancelAnimationFrame) {
      this.dependencies.cancelAnimationFrame(handle);
    } else {
      window.cancelAnimationFrame(handle);
    }
  }

  private onlineEvents(): Pick<EventTarget, "addEventListener" | "removeEventListener"> | null {
    if (this.dependencies.onlineEvents) return this.dependencies.onlineEvents;
    return typeof window === "undefined" ? null : window;
  }

  private isOnline(): boolean {
    if (this.dependencies.isOnline) return this.dependencies.isOnline();
    return typeof navigator === "undefined" || navigator.onLine !== false;
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }

  private sdpTimeoutMs(): number {
    const configured = this.dependencies.sdpTimeoutMs;
    return typeof configured === "number" && Number.isFinite(configured) && configured > 0 ? configured : 15_000;
  }

  private connectionTimeoutMs(): number {
    const configured = this.dependencies.connectionTimeoutMs;
    return typeof configured === "number" && Number.isFinite(configured) && configured > 0 ? configured : 15_000;
  }

  private clearConnectionDeadline(): void {
    if (!this.connectionDeadline) return;
    globalThis.clearTimeout(this.connectionDeadline);
    this.connectionDeadline = null;
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
      this.callbacks.onStatus("The Realtime session reported an error. Disconnect and start a new conversation.");
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

    const audioContext = this.createAudioContext();
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
      this.outputMeterFrame = this.requestFrame(tick);
    };
    tick();
  }

  private stopOutputMeter(): void {
    if (this.outputMeterFrame) {
      this.cancelFrame(this.outputMeterFrame);
      this.outputMeterFrame = 0;
    }
    void this.audioContext?.close();
    this.audioContext = null;
    this.outputAnalyser = null;
    this.smoothedMouthShape = silentMouthShape();
  }
}

const safeCredentialMessages = new Set([
  "Set VITE_VECTOR_BACKEND_URL to the secure Vector backend origin.",
  "VITE_VECTOR_BACKEND_URL must be an HTTPS origin without credentials, a path, query, or fragment.",
  "Secure credential storage is unavailable.",
  "No bootstrap session credential is stored in Keychain.",
  "Realtime session request timed out.",
  "Unable to reach the Realtime session service.",
  "The Realtime session service rejected the request.",
  "The Realtime session service returned a malformed credential.",
  "Unable to create a Realtime session.",
  "OPENAI_API_KEY is missing in .env.local",
]);

function sanitizeAudioSessionError(error: unknown): RealtimeConnectionError {
  const name = errorName(error);
  const code = errorCode(error);
  if (
    name === "NotAllowedError" ||
    code === "MICROPHONE_DENIED" ||
    code === "MICROPHONE_RESTRICTED" ||
    code === "MICROPHONE_PERMISSION_DENIED" ||
    code === "MICROPHONE_PERMISSION_RESTRICTED" ||
    code === "permission_denied"
  ) {
    return new RealtimeConnectionError(
      "microphone_denied",
      "Microphone access is denied or restricted. Allow Vector in Settings > Privacy & Security > Microphone, then try again.",
    );
  }
  return new RealtimeConnectionError(
    "audio_session",
    "Unable to prepare the audio session. Check the current input and output route, then try again.",
  );
}

function sanitizeMicrophoneError(error: unknown): RealtimeConnectionError {
  if (error instanceof RealtimeConnectionError) return error;
  switch (errorName(error)) {
    case "NotAllowedError":
    case "SecurityError":
      return new RealtimeConnectionError(
        "microphone_denied",
        "Microphone access is denied or restricted. Allow Vector in Settings > Privacy & Security > Microphone, then try again.",
      );
    case "NotFoundError":
    case "DevicesNotFoundError":
      return new RealtimeConnectionError(
        "microphone_missing",
        "No microphone input is available. Check the current audio route and try again.",
      );
    case "NotReadableError":
    case "TrackStartError":
      return new RealtimeConnectionError(
        "microphone_unavailable",
        "The microphone is busy or unavailable. End other audio sessions and try again.",
      );
    case "AbortError":
      return new RealtimeConnectionError(
        "microphone_unavailable",
        "Microphone startup was interrupted. Check the current audio route and try again.",
      );
    default:
      return new RealtimeConnectionError(
        "microphone_unavailable",
        "Unable to start microphone capture. Check microphone permission and the current audio route.",
      );
  }
}

function sanitizeCredentialError(error: unknown): RealtimeConnectionError {
  const message = error instanceof Error ? error.message : "";
  if (safeCredentialMessages.has(message)) {
    return new RealtimeConnectionError("credential", message);
  }
  return new RealtimeConnectionError(
    "credential",
    "Unable to create a secure Realtime session. Check the backend connection and credential provisioning.",
  );
}

function sanitizeConnectionError(error: unknown): RealtimeConnectionError {
  if (error instanceof RealtimeConnectionError) return error;
  return new RealtimeConnectionError(
    "peer_connection",
    "Unable to establish the Realtime connection. Check microphone access and the network, then try again.",
  );
}

function errorName(error: unknown): string {
  return error && typeof error === "object" && typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name
    : "";
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "";
}

function isCredentialExpired(credential: RealtimeCredential, nowMs: number): boolean {
  return credential.expiresAt !== null && credential.expiresAt * 1000 <= nowMs + 5_000;
}

function clearCredential(credential: RealtimeCredential): void {
  credential.value = "";
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function safeHttpStatus(status: number): number | "unknown" {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : "unknown";
}

async function readBoundedSdpResponse(response: Response, maxBytes = 256_000): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new RealtimeConnectionError(
        "peer_connection",
        "The Realtime service returned an unusable connection response. Try again.",
      );
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new RealtimeConnectionError(
          "peer_connection",
          "The Realtime service returned an unusable connection response. Try again.",
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
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
