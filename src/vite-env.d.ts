/// <reference types="vite/client" />

export type RickyArtifact = {
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
    | "progress";
  content: string;
  language?: string;
  fullscreen?: boolean;
};

export type RickyToolSpec = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type RickyToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type RickyToolResult = {
  ok: boolean;
  artifact?: RickyArtifact;
  mode?: "display" | "computer";
  message?: string;
  error?: string;
  [key: string]: unknown;
};

export type RickyRemoteCodexTask = {
  id: string;
  project: string;
  status: "running" | "completed" | "needs_input" | "failed" | "timed_out" | "cancelled";
  lastAction: string;
  finalMessage: string;
  threadId: string;
  attempts: number;
  [key: string]: unknown;
};

export type RickyRemoteCodexEvent = {
  kind: "started" | "progress" | "retrying" | "completed" | "attention" | "failed" | "timed_out" | "cancelled";
  at: string;
  task: RickyRemoteCodexTask;
  artifact: RickyArtifact;
  announcement: string;
};

declare global {
  interface Window {
    ricky?: {
      createRealtimeToken: () => Promise<{ value: string; expiresAt: number | null }>;
      executeTool: (toolCall: RickyToolCall) => Promise<RickyToolResult>;
      getToolSpecs: () => Promise<RickyToolSpec[]>;
      onRemoteCodexEvent: (callback: (event: RickyRemoteCodexEvent) => void) => () => void;
    };
  }
}
