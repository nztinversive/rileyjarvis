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

export type MobileDataCapability = {
  list: () => Promise<import("../mobile/data").VectorMobileStore>;
  subscribe: (callback: (store: import("../mobile/data").VectorMobileStore) => void) => () => void;
  confirmDeletion: (input: { kind: "note" | "record" | "saved artifact"; id: string }) => Promise<import("../mobile/data").VectorMobileStore | null>;
  createNote: (input: { text: string; tags?: string[] }) => Promise<{
    store: import("../mobile/data").VectorMobileStore;
    itemId: string;
  }>;
  updateNote: (input: { id: string; text?: string; tags?: string[]; expectedUpdatedAt?: string }) => Promise<import("../mobile/data").VectorMobileStore>;
  deleteNote: (id: string) => Promise<import("../mobile/data").VectorMobileStore>;
  createRecord: (input: { collection: string; title: string; data?: Record<string, unknown> }) => Promise<{
    store: import("../mobile/data").VectorMobileStore;
    itemId: string;
  }>;
  searchRecords: (input: { collection: string; query?: string; limit?: number }) => Promise<import("../mobile/data").VectorMobileRecord[]>;
  updateRecord: (input: { id: string; title?: string; data?: Record<string, unknown> }) => Promise<import("../mobile/data").VectorMobileStore>;
  deleteRecord: (id: string) => Promise<import("../mobile/data").VectorMobileStore>;
  saveArtifact: (artifact: VectorArtifact, id?: string) => Promise<{
    store: import("../mobile/data").VectorMobileStore;
    itemId: string;
  }>;
  deleteArtifact: (id: string) => Promise<import("../mobile/data").VectorMobileStore>;
};

export type NativeShareCapability = {
  share: (payload: { title: string; text?: string; url?: string; filename?: string }) => Promise<{ completed: boolean }>;
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
  mobileData?: MobileDataCapability;
  nativeShare?: NativeShareCapability;
};
