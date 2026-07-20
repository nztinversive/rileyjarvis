export type VectorArtifact = {
  title: string;
  kind:
    | "text"
    | "markdown"
    | "code"
    | "table"
    | "notes"
    | "mermaid"
    | "image"
    | "imageLoading"
    | "thumbnailBoard"
    | "projectCockpit"
    | "codexReview"
    | "progress";
  content: string;
  language?: string;
  fullscreen?: boolean;
};

export type VectorToolSpec = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type VectorToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type VectorToolResult = {
  ok: boolean;
  artifact?: VectorArtifact;
  mode?: "display" | "computer";
  message?: string;
  error?: string;
  [key: string]: unknown;
};

export type RealtimeCredential = {
  value: string;
  expiresAt: number | null;
};

export type RemoteCodexTask = {
  id: string;
  project: string;
  status: "running" | "completed" | "needs_input" | "failed" | "timed_out" | "cancelled";
  lastAction: string;
  finalMessage: string;
  threadId: string;
  attempts: number;
  [key: string]: unknown;
};

export type RemoteCodexLifecycleEvent = {
  kind: "started" | "progress" | "retrying" | "completed" | "attention" | "failed" | "timed_out" | "cancelled" | "review";
  at: string;
  task: RemoteCodexTask;
  artifact: VectorArtifact;
  announcement: string;
};

export type RemoteCodexCapability = {
  subscribeToLifecycle: (callback: (event: RemoteCodexLifecycleEvent) => void) => () => void;
};

export type AppLifecycleCapability = {
  subscribe: (callback: (isActive: boolean) => void) => () => void;
};

export type VoiceSessionEvent = {
  type:
    | "interruption"
    | "route-changed"
    | "route-unavailable"
    | "media-services-reset"
    | "protected-data-unavailable";
  route?: string;
  shouldDisconnect: boolean;
};

export type VoiceSessionCapability = {
  prepare: () => Promise<{ route: string }>;
  deactivate: () => Promise<void>;
  subscribe: (callback: (event: VoiceSessionEvent) => void) => () => void;
};

export type VectorPresentation = "desktop" | "native-mobile";

export type VectorPlatform = {
  presentation: VectorPresentation;
  createRealtimeCredential: (options?: { signal?: AbortSignal }) => Promise<RealtimeCredential>;
  executeTool: (toolCall: VectorToolCall) => Promise<VectorToolResult>;
  listToolSpecs: () => Promise<VectorToolSpec[]>;
  appLifecycle?: AppLifecycleCapability;
  openExternalUrl?: (url: string) => Promise<void>;
  remoteCodex?: RemoteCodexCapability;
  voiceSession?: VoiceSessionCapability;
};
