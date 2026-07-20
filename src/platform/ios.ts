import type {
  AppLifecycleCapability,
  RealtimeCredential,
  VectorArtifact,
  VectorPlatform,
  VectorToolCall,
  VectorToolResult,
  VectorToolSpec,
} from "./types";

export type IOSSecureStorageBridge = {
  get: () => Promise<{ value?: unknown }>;
  set: (options: { value: string }) => Promise<void>;
  delete: () => Promise<void>;
};

export type IOSVectorPlatformDependencies = {
  backendBaseUrl: string;
  secureStorage: IOSSecureStorageBridge;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  appLifecycle?: AppLifecycleCapability;
  openExternalUrl?: (url: string) => Promise<void>;
};

const sessionPath = "/api/realtime/session";
const defaultTimeoutMs = 10_000;
const supportedArtifactKinds = new Set<VectorArtifact["kind"]>([
  "text",
  "markdown",
  "code",
  "table",
  "notes",
  "mermaid",
  "image",
  "imageLoading",
  "progress",
]);

export const iosToolSpecs: VectorToolSpec[] = [
  {
    type: "function",
    name: "set_mode",
    description: "Keep Vector in its supported iOS display mode.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["display"] },
      },
      required: ["mode"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "artifact_show",
    description: "Show iOS-safe text, Markdown, code, table, note, Mermaid, image, or progress content in the artifact panel.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        kind: {
          type: "string",
          enum: ["text", "markdown", "code", "table", "notes", "mermaid", "image", "imageLoading", "progress"],
        },
        content: { type: "string" },
        language: { type: "string" },
        fullscreen: { type: "boolean" },
      },
      required: ["title", "kind", "content"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "show_menu",
    description: "Show the capabilities currently available in the Vector iOS shell.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

class SafeIOSPlatformError extends Error {}

export function createIOSVectorPlatform(dependencies: IOSVectorPlatformDependencies): VectorPlatform {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const timeoutMs = normalizeTimeout(dependencies.timeoutMs);

  return {
    createRealtimeCredential: () =>
      requestRealtimeCredential({
        backendBaseUrl: dependencies.backendBaseUrl,
        secureStorage: dependencies.secureStorage,
        fetchImpl,
        timeoutMs,
      }),
    executeTool: executeIOSTool,
    listToolSpecs: async () => iosToolSpecs.map((spec) => ({ ...spec })),
    ...(dependencies.appLifecycle ? { appLifecycle: dependencies.appLifecycle } : {}),
    ...(dependencies.openExternalUrl
      ? {
          openExternalUrl: async (url: string) => {
            const safeUrl = requireHTTPSUrl(url, "Vector can only open secure web links on iOS.");
            await dependencies.openExternalUrl?.(safeUrl.toString());
          },
        }
      : {}),
  };
}

async function requestRealtimeCredential({
  backendBaseUrl,
  secureStorage,
  fetchImpl,
  timeoutMs,
}: Required<Pick<IOSVectorPlatformDependencies, "backendBaseUrl" | "secureStorage" | "fetchImpl" | "timeoutMs">>): Promise<RealtimeCredential> {
  const endpoint = realtimeSessionEndpoint(backendBaseUrl);
  let bootstrapCredential: string | null = null;

  try {
    let stored: { value?: unknown };
    try {
      stored = await secureStorage.get();
    } catch {
      throw new SafeIOSPlatformError("Secure credential storage is unavailable.");
    }

    if (typeof stored.value !== "string" || stored.value.length === 0) {
      throw new SafeIOSPlatformError("No bootstrap session credential is stored in Keychain.");
    }
    bootstrapCredential = stored.value;

    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          body: "{}",
          headers: {
            Authorization: `Bearer ${bootstrapCredential}`,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) {
          throw new SafeIOSPlatformError("Realtime session request timed out.");
        }
        throw new SafeIOSPlatformError("Unable to reach the Realtime session service.");
      }

      if (!response.ok) {
        throw new SafeIOSPlatformError("The Realtime session service rejected the request.");
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (controller.signal.aborted) {
          throw new SafeIOSPlatformError("Realtime session request timed out.");
        }
        throw new SafeIOSPlatformError("The Realtime session service returned a malformed credential.");
      }
      return validateCredential(payload);
    } finally {
      globalThis.clearTimeout(timeout);
    }
  } catch (error) {
    if (error instanceof SafeIOSPlatformError) throw error;
    throw new SafeIOSPlatformError("Unable to create a Realtime session.");
  } finally {
    bootstrapCredential = null;
  }
}

function realtimeSessionEndpoint(value: string): string {
  const base = requireHTTPSUrl(value, "Set VITE_VECTOR_BACKEND_URL to the secure Vector backend origin.");
  if (base.username || base.password || base.search || base.hash || (base.pathname !== "/" && base.pathname !== "")) {
    throw new SafeIOSPlatformError("VITE_VECTOR_BACKEND_URL must be an HTTPS origin without credentials, a path, query, or fragment.");
  }
  return new URL(sessionPath, base).toString();
}

function requireHTTPSUrl(value: string, message: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SafeIOSPlatformError(message);
  }
  if (url.protocol !== "https:") throw new SafeIOSPlatformError(message);
  return url;
}

function validateCredential(payload: unknown): RealtimeCredential {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SafeIOSPlatformError("The Realtime session service returned a malformed credential.");
  }
  const record = payload as Record<string, unknown>;
  if (
    typeof record.value !== "string" ||
    record.value.length === 0 ||
    typeof record.expiresAt !== "number" ||
    !Number.isFinite(record.expiresAt) ||
    !Number.isInteger(record.expiresAt) ||
    record.expiresAt <= 0
  ) {
    throw new SafeIOSPlatformError("The Realtime session service returned a malformed credential.");
  }
  return { value: record.value, expiresAt: record.expiresAt };
}

async function executeIOSTool(toolCall: VectorToolCall): Promise<VectorToolResult> {
  if (toolCall.name === "set_mode") {
    if (toolCall.arguments.mode === "display") {
      return { ok: true, mode: "display", message: "Vector is in display mode." };
    }
    return unsupportedTool("Computer-use mode is not available on iOS.");
  }

  if (toolCall.name === "show_menu") {
    return {
      ok: true,
      artifact: {
        title: "Vector on iOS",
        kind: "markdown",
        content:
          "# Vector on iOS\n\n- Realtime session startup through the secure backend\n- Voice and microphone groundwork for later physical-device proof\n- Text, Markdown, code, tables, notes, Mermaid, images, and progress artifacts\n\nDesktop computer control, local files, Remote Codex, and remote tool execution are not available on iOS.",
      },
    };
  }

  if (toolCall.name === "artifact_show") {
    const artifact = parseIOSArtifact(toolCall.arguments);
    return artifact ? { ok: true, artifact } : unsupportedTool("That artifact is not available on iOS.");
  }

  return unsupportedTool("That desktop tool is not available on iOS.");
}

function parseIOSArtifact(argumentsValue: Record<string, unknown>): VectorArtifact | null {
  const { title, kind, content, language, fullscreen } = argumentsValue;
  if (
    typeof title !== "string" ||
    title.length === 0 ||
    typeof kind !== "string" ||
    !supportedArtifactKinds.has(kind as VectorArtifact["kind"]) ||
    typeof content !== "string"
  ) {
    return null;
  }
  if (kind === "image" && !isIOSSafeImageSource(content)) return null;

  return {
    title,
    kind: kind as VectorArtifact["kind"],
    content,
    ...(typeof language === "string" ? { language } : {}),
    ...(typeof fullscreen === "boolean" ? { fullscreen } : {}),
  };
}

function isIOSSafeImageSource(value: string): boolean {
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(value)) return true;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function unsupportedTool(error: string): VectorToolResult {
  return { ok: false, error };
}

function normalizeTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return defaultTimeoutMs;
  return Math.min(30_000, Math.max(10, Math.trunc(value as number)));
}
