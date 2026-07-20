import type {
  AppLifecycleCapability,
  RealtimeCredential,
  VoiceSessionCapability,
  VectorArtifact,
  VectorPlatform,
  VectorToolCall,
  VectorToolResult,
  VectorToolSpec,
} from "./types";
import iosToolSpecAllowlist from "../../shared/ios-tool-specs.json";
import {
  mobileDataLimits,
  stableJSONStringify,
  isSecureHTTPSImage,
  validateMobileStore,
  validateMobileRecords,
  validateMobileItemId,
  validateNoteCreateInput,
  validateNoteUpdateInput,
  validateRecordCreateInput,
  validateRecordSearchInput,
  validateRecordUpdateInput,
  validateSavableArtifact,
  type VectorMobileStore,
} from "../mobile/data";

export type IOSSecureStorageBridge = {
  get: () => Promise<{ value?: unknown }>;
  delete: () => Promise<void>;
};

export type IOSVectorPlatformDependencies = {
  backendBaseUrl: string;
  secureStorage: IOSSecureStorageBridge;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  appLifecycle?: AppLifecycleCapability;
  openExternalUrl?: (url: string) => Promise<void>;
  voiceSession?: VoiceSessionCapability;
  mobileData?: {
    list: () => Promise<unknown>;
    confirmDeletion: (input: { kind: string; summary: string }) => Promise<{ confirmed?: unknown }>;
    createNote: (input: { text: string; tags?: string[] }) => Promise<unknown>;
    updateNote: (input: { id: string; text?: string; tags?: string[] }) => Promise<unknown>;
    deleteNote: (input: { id: string }) => Promise<unknown>;
    createRecord: (input: { collection: string; title: string; data?: Record<string, unknown> }) => Promise<unknown>;
    searchRecords: (input: { collection: string; query?: string; limit?: number }) => Promise<unknown>;
    updateRecord: (input: { id: string; title?: string; data?: Record<string, unknown> }) => Promise<unknown>;
    deleteRecord: (input: { id: string }) => Promise<unknown>;
    saveArtifact: (input: { id?: string; title: string; kind: string; content: string; language?: string }) => Promise<unknown>;
    deleteArtifact: (input: { id: string }) => Promise<unknown>;
  };
  nativeShare?: {
    share: (input: { title: string; text?: string; url?: string; filename?: string }) => Promise<{ completed?: unknown }>;
  };
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

export const iosToolSpecs = iosToolSpecAllowlist as VectorToolSpec[];

class SafeIOSPlatformError extends Error {}

export function createIOSVectorPlatform(dependencies: IOSVectorPlatformDependencies): VectorPlatform {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const timeoutMs = normalizeTimeout(dependencies.timeoutMs);
  const mobileDataListeners = new Set<(store: VectorMobileStore) => void>();

  function validated(result: Promise<unknown>): Promise<VectorMobileStore> {
    return result.then(validateMobileStore).catch((error) => {
      if (error instanceof Error && error.message.length <= 180) throw error;
      throw new SafeIOSPlatformError("The local library is unavailable.");
    });
  }

  async function validatedMutation(result: Promise<unknown>): Promise<VectorMobileStore> {
    const store = await validated(result);
    notifyMobileDataListeners(store);
    return store;
  }

  function notifyMobileDataListeners(store: VectorMobileStore): void {
    for (const listener of mobileDataListeners) {
      try {
        listener(store);
      } catch {
        // A view subscriber must not turn a completed native mutation into a failed tool call.
      }
    }
  }

  async function validatedCreatedMutation(result: Promise<unknown>): Promise<{ store: VectorMobileStore; itemId: string }> {
    const response = await result;
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new SafeIOSPlatformError("The local library returned malformed data.");
    }
    const envelope = response as Record<string, unknown>;
    const store = validateMobileStore(envelope.store);
    const itemId = validateMobileItemId(envelope.itemId as string);
    notifyMobileDataListeners(store);
    return { store, itemId };
  }

  const mobileData = dependencies.mobileData
      ? {
        list: () => validated(dependencies.mobileData!.list()),
        subscribe: (callback: (store: VectorMobileStore) => void) => {
          mobileDataListeners.add(callback);
          return () => mobileDataListeners.delete(callback);
        },
        confirmDeletion: async (input: { kind: "note" | "record" | "saved artifact"; summary: string }) => {
          const result = await dependencies.mobileData!.confirmDeletion({
            kind: input.kind,
            summary: requiredString(input.summary, 240),
          });
          return result?.confirmed === true;
        },
        createNote: async (input: { text: string; tags?: string[] }) =>
          validatedCreatedMutation(dependencies.mobileData!.createNote(validateNoteCreateInput(input))),
        updateNote: async (input: { id: string; text?: string; tags?: string[] }) =>
          validatedMutation(dependencies.mobileData!.updateNote(validateNoteUpdateInput(input))),
        deleteNote: async (id: string) => validatedMutation(dependencies.mobileData!.deleteNote({ id: validateMobileItemId(id) })),
        createRecord: async (input: { collection: string; title: string; data?: Record<string, unknown> }) =>
          validatedCreatedMutation(dependencies.mobileData!.createRecord(validateRecordCreateInput(input))),
        searchRecords: async (input: { collection: string; query?: string; limit?: number }) => {
          const result = await dependencies.mobileData!.searchRecords(validateRecordSearchInput(input));
          const record = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {};
          return validateMobileRecords(record.records);
        },
        updateRecord: async (input: { id: string; title?: string; data?: Record<string, unknown> }) =>
          validatedMutation(dependencies.mobileData!.updateRecord(validateRecordUpdateInput(input))),
        deleteRecord: async (id: string) => validatedMutation(dependencies.mobileData!.deleteRecord({ id: validateMobileItemId(id) })),
        saveArtifact: async (artifact: VectorArtifact, id?: string) =>
          validatedCreatedMutation(dependencies.mobileData!.saveArtifact({
            ...validateSavableArtifact(artifact),
            ...(id ? { id: validateMobileItemId(id) } : {}),
          })),
        deleteArtifact: async (id: string) => validatedMutation(dependencies.mobileData!.deleteArtifact({ id: validateMobileItemId(id) })),
      }
    : undefined;

  return {
    presentation: "native-mobile",
    createRealtimeCredential: (options) =>
      requestRealtimeCredential({
        backendBaseUrl: dependencies.backendBaseUrl,
        secureStorage: dependencies.secureStorage,
        fetchImpl,
        timeoutMs,
        signal: options?.signal,
      }),
    executeTool: (toolCall) => executeIOSTool(toolCall, mobileData),
    listToolSpecs: async () => iosToolSpecs.map((spec) => ({ ...spec })),
    ...(dependencies.appLifecycle ? { appLifecycle: dependencies.appLifecycle } : {}),
    ...(dependencies.voiceSession ? { voiceSession: dependencies.voiceSession } : {}),
    ...(mobileData ? { mobileData } : {}),
    ...(dependencies.nativeShare
      ? {
          nativeShare: {
            share: async (payload: { title: string; text?: string; url?: string; filename?: string }) => {
              const result = await dependencies.nativeShare?.share(payload);
              return { completed: result?.completed === true };
            },
          },
        }
      : {}),
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
  signal,
}: Required<Pick<IOSVectorPlatformDependencies, "backendBaseUrl" | "secureStorage" | "fetchImpl" | "timeoutMs">> & {
  signal?: AbortSignal;
}): Promise<RealtimeCredential> {
  const endpoint = realtimeSessionEndpoint(backendBaseUrl);
  let bootstrapCredential: string | null = null;

  try {
    if (signal?.aborted) {
      throw new SafeIOSPlatformError("Realtime session request was cancelled.");
    }
    let stored: { value?: unknown };
    try {
      stored = await secureStorage.get();
    } catch {
      throw new SafeIOSPlatformError("Secure credential storage is unavailable.");
    }

    if (typeof stored.value !== "string" || stored.value.length === 0) {
      throw new SafeIOSPlatformError("No bootstrap session credential is stored in Keychain.");
    }
    if (signal?.aborted) {
      throw new SafeIOSPlatformError("Realtime session request was cancelled.");
    }
    bootstrapCredential = stored.value;

    const controller = new AbortController();
    const cancelRequest = () => controller.abort();
    if (signal?.aborted) cancelRequest();
    signal?.addEventListener("abort", cancelRequest, { once: true });
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
      signal?.removeEventListener("abort", cancelRequest);
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

async function executeIOSTool(
  toolCall: VectorToolCall,
  mobileData: VectorPlatform["mobileData"],
): Promise<VectorToolResult> {
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
          "# Vector on iOS\n\n- Realtime conversation through the secure backend\n- Local notes and records\n- Explicitly saved text, Markdown, code, tables, notes, Mermaid, and secure HTTPS image artifacts\n- Native sharing of safe saved content\n\nDesktop computer control, local files, Remote Codex, image generation, and web search are not available on iOS.",
      },
    };
  }

  if (toolCall.name === "artifact_show") {
    const artifact = parseIOSArtifact(toolCall.arguments);
    return artifact ? { ok: true, artifact } : unsupportedTool("That artifact is not available on iOS.");
  }

  if (!mobileData && isMobileDataTool(toolCall.name)) {
    return unsupportedTool("Local mobile data is unavailable.");
  }

  try {
    if (toolCall.name === "note_add") {
      const { store, itemId } = await mobileData!.createNote({
        text: requiredContent(toolCall.arguments.text, mobileDataLimits.maxTextLength),
        tags: optionalStringArray(toolCall.arguments.tags, mobileDataLimits.maxTags, mobileDataLimits.maxTagLength),
      });
      const note = store.notes.find((item) => item.id === itemId);
      if (!note) throw new Error("The created note could not be read back safely.");
      return { ok: true, note, artifact: notesArtifact(store.notes) };
    }
    if (toolCall.name === "note_list") {
      const store = await mobileData!.list();
      return { ok: true, notes: noteSummaries(store.notes), artifact: notesArtifact(store.notes) };
    }
    if (toolCall.name === "note_update") {
      const store = await mobileData!.updateNote({
        id: requiredString(toolCall.arguments.id, 80),
        ...(typeof toolCall.arguments.text === "string" ? { text: requiredContent(toolCall.arguments.text, mobileDataLimits.maxTextLength) } : {}),
        ...(Array.isArray(toolCall.arguments.tags)
          ? { tags: optionalStringArray(toolCall.arguments.tags, mobileDataLimits.maxTags, mobileDataLimits.maxTagLength) }
          : {}),
      });
      return { ok: true, note: store.notes.find((note) => note.id === toolCall.arguments.id), artifact: notesArtifact(store.notes) };
    }
    if (toolCall.name === "note_delete") {
      if (toolCall.arguments.confirmed !== true) return confirmationRequired("note");
      const id = requiredString(toolCall.arguments.id, 80);
      const note = (await mobileData!.list()).notes.find((item) => item.id === id);
      if (!note) throw new Error("The selected note was not found.");
      if (!await mobileData!.confirmDeletion({ kind: "note", summary: excerpt(note.text, 180) })) return deletionCancelled("note");
      const store = await mobileData!.deleteNote(id);
      return { ok: true, deleted: true, artifact: notesArtifact(store.notes) };
    }
    if (toolCall.name === "records_create") {
      const { store, itemId } = await mobileData!.createRecord({
        collection: requiredString(toolCall.arguments.collection, mobileDataLimits.maxCollectionLength),
        title: requiredString(toolCall.arguments.title, mobileDataLimits.maxTitleLength),
        data: plainRecord(toolCall.arguments.data ?? toolCall.arguments.fields),
      });
      const record = store.records.find((item) => item.id === itemId);
      if (!record) throw new Error("The created record could not be read back safely.");
      return { ok: true, record, artifact: recordsArtifact([record], record.collection) };
    }
    if (toolCall.name === "records_search") {
      const collection = requiredString(toolCall.arguments.collection, mobileDataLimits.maxCollectionLength);
      const query = typeof toolCall.arguments.query === "string" ? requiredString(toolCall.arguments.query, mobileDataLimits.maxSearchLength, true) : "";
      const records = await mobileData!.searchRecords({ collection, query, limit: 20 });
      return { ok: true, records: recordSummaries(records), artifact: recordsArtifact(records, collection) };
    }
    if (toolCall.name === "records_update") {
      const id = requiredString(toolCall.arguments.id, 80);
      const store = await mobileData!.updateRecord({
        id,
        ...(typeof toolCall.arguments.title === "string" ? { title: requiredString(toolCall.arguments.title, mobileDataLimits.maxTitleLength) } : {}),
        ...((toolCall.arguments.data ?? toolCall.arguments.fields) !== undefined
          ? { data: plainRecord(toolCall.arguments.data ?? toolCall.arguments.fields) }
          : {}),
      });
      const record = store.records.find((item) => item.id === id);
      return { ok: true, record, artifact: recordsArtifact(record ? [record] : [], record?.collection ?? "Records") };
    }
    if (toolCall.name === "records_delete") {
      if (toolCall.arguments.confirmed !== true) return confirmationRequired("record");
      const id = requiredString(toolCall.arguments.id, 80);
      const record = (await mobileData!.list()).records.find((item) => item.id === id);
      if (!record) throw new Error("The selected record was not found.");
      if (!await mobileData!.confirmDeletion({ kind: "record", summary: `${record.collection}: ${record.title}` })) return deletionCancelled("record");
      const store = await mobileData!.deleteRecord(id);
      return { ok: true, deleted: true, artifact: recordsArtifact(store.records.slice(0, 20), "Records") };
    }
    if (toolCall.name === "artifact_save") {
      const artifact = parseIOSArtifact(toolCall.arguments);
      if (!artifact) return unsupportedTool("That artifact cannot be saved on iOS.");
      const { store, itemId } = await mobileData!.saveArtifact(artifact);
      const savedArtifact = store.artifacts.find((item) => item.id === itemId);
      if (!savedArtifact) throw new Error("The saved artifact could not be read back safely.");
      return { ok: true, savedArtifact: savedArtifactSummary(savedArtifact), artifact: savedArtifactsArtifact(store.artifacts) };
    }
    if (toolCall.name === "artifact_library_list") {
      const store = await mobileData!.list();
      return { ok: true, savedArtifacts: savedArtifactSummaries(store.artifacts), artifact: savedArtifactsArtifact(store.artifacts) };
    }
    if (toolCall.name === "artifact_unsave") {
      if (toolCall.arguments.confirmed !== true) return confirmationRequired("saved artifact");
      const id = requiredString(toolCall.arguments.id, 80);
      const savedArtifact = (await mobileData!.list()).artifacts.find((item) => item.id === id);
      if (!savedArtifact) throw new Error("The selected saved artifact was not found.");
      if (!await mobileData!.confirmDeletion({ kind: "saved artifact", summary: savedArtifact.title })) return deletionCancelled("saved artifact");
      const store = await mobileData!.deleteArtifact(id);
      return { ok: true, deleted: true, artifact: savedArtifactsArtifact(store.artifacts) };
    }
  } catch (error) {
    return { ok: false, error: safeDataError(error) };
  }

  return unsupportedTool("That desktop tool is not available on iOS.");
}

function notesArtifact(notes: VectorMobileStore["notes"]): VectorArtifact {
  return { title: "Notes", kind: "notes", content: JSON.stringify(noteSummaries(notes), null, 2) };
}

function recordsArtifact(records: VectorMobileStore["records"], collection: string): VectorArtifact {
  return { title: collection || "Records", kind: "table", content: JSON.stringify(recordSummaries(records), null, 2) };
}

function savedArtifactsArtifact(artifacts: VectorMobileStore["artifacts"]): VectorArtifact {
  return { title: "Saved artifacts", kind: "table", content: JSON.stringify(savedArtifactSummaries(artifacts), null, 2) };
}

function deletionCancelled(kind: string): VectorToolResult {
  return { ok: false, error: `The ${kind} was not deleted because native confirmation was cancelled.` };
}

function noteSummaries(notes: VectorMobileStore["notes"]): Array<Record<string, unknown>> {
  return notes.slice(0, 20).map((note) => ({
    ...note,
    text: excerpt(note.text, 1_000),
    ...(note.text.length > 1_000 ? { textTruncated: true } : {}),
  }));
}

function recordSummaries(records: VectorMobileStore["records"]): Array<Record<string, unknown>> {
  return records.slice(0, 10).map((record) => {
    const data = stableJSONStringify(record.data);
    return {
      id: record.id,
      collection: record.collection,
      title: record.title,
      dataPreview: excerpt(data, 4_000),
      ...(data.length > 4_000 ? { dataTruncated: true } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  });
}

function savedArtifactSummary(artifact: VectorMobileStore["artifacts"][number]): Record<string, unknown> {
  return {
    id: artifact.id,
    title: artifact.title,
    kind: artifact.kind,
    ...(artifact.language ? { language: artifact.language } : {}),
    contentPreview: excerpt(artifact.content, 500),
    ...(artifact.content.length > 500 ? { contentTruncated: true } : {}),
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

function savedArtifactSummaries(artifacts: VectorMobileStore["artifacts"]): Array<Record<string, unknown>> {
  return artifacts.slice(0, 20).map(savedArtifactSummary);
}

function excerpt(value: string, maximum: number): string {
  return value.length > maximum ? `${value.slice(0, maximum)}…` : value;
}

function confirmationRequired(item: string): VectorToolResult {
  return { ok: false, requiresConfirmation: true, message: `Explicit confirmation is required before deleting this ${item}.` };
}

function isMobileDataTool(name: string): boolean {
  return ["note_add", "note_list", "note_update", "note_delete", "records_create", "records_search", "records_update", "records_delete", "artifact_save", "artifact_library_list", "artifact_unsave"].includes(name);
}

function requiredString(value: unknown, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new Error("A required field is missing.");
  const text = value.trim();
  if ((!allowEmpty && !text) || text.length > maximum) throw new Error("A field is empty or exceeds the iOS size limit.");
  return text;
}

function requiredContent(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) {
    throw new Error("Content is empty or exceeds the iOS size limit.");
  }
  return value;
}

function optionalStringArray(value: unknown, count: number, maximum: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > count) throw new Error("Tags exceed the iOS limit.");
  return value.map((item) => requiredString(item, maximum));
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Record data must be an object.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Record data must be a plain object.");
  const serialized = stableJSONStringify(value);
  if (new TextEncoder().encode(serialized).byteLength > mobileDataLimits.maxRecordDataBytes) throw new Error("Record data exceeds the iOS size limit.");
  if (/"(?:__proto__|prototype|constructor)"\s*:/.test(serialized)) throw new Error("Record data contains a reserved field.");
  return value as Record<string, unknown>;
}

function safeDataError(error: unknown): string {
  return error instanceof Error && error.message.length <= 180 ? error.message : "The local library operation failed safely.";
}

function parseIOSArtifact(argumentsValue: Record<string, unknown>): VectorArtifact | null {
  const { title, kind, content, language, fullscreen } = argumentsValue;
  if (
    typeof title !== "string" ||
    title.trim().length === 0 ||
    title.length > mobileDataLimits.maxTitleLength ||
    typeof kind !== "string" ||
    !supportedArtifactKinds.has(kind as VectorArtifact["kind"]) ||
    typeof content !== "string" ||
    content.length > mobileDataLimits.maxArtifactContentLength ||
    (typeof language === "string" && language.length > 32)
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
  return isSecureHTTPSImage(value);
}

function unsupportedTool(error: string): VectorToolResult {
  return { ok: false, error };
}

function normalizeTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return defaultTimeoutMs;
  return Math.min(30_000, Math.max(10, Math.trunc(value as number)));
}
