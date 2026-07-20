import type { VectorArtifact } from "../platform/types";

export const VECTOR_MOBILE_STORE_VERSION = 1 as const;

export const mobileDataLimits = {
  maxNotes: 200,
  maxRecords: 200,
  maxArtifacts: 100,
  maxTitleLength: 160,
  maxTextLength: 12_000,
  maxTagLength: 48,
  maxTags: 12,
  maxCollectionLength: 64,
  maxRecordDataBytes: 16_384,
  maxArtifactContentLength: 64_000,
  maxSearchLength: 160,
} as const;

export type VectorMobileNote = {
  id: string;
  text: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type VectorMobileRecord = {
  id: string;
  collection: string;
  title: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type VectorSavedArtifact = {
  id: string;
  title: string;
  kind: "text" | "markdown" | "code" | "table" | "notes" | "mermaid" | "image";
  content: string;
  language?: string;
  createdAt: string;
  updatedAt: string;
};

export type VectorMobileStore = {
  version: typeof VECTOR_MOBILE_STORE_VERSION;
  notes: VectorMobileNote[];
  records: VectorMobileRecord[];
  artifacts: VectorSavedArtifact[];
};

export type VectorMobileLibraryState = {
  status: "loading" | "ready" | "error";
  store: VectorMobileStore;
  error: string | null;
};

export type VectorMobileLibraryAction =
  | { type: "loading" }
  | { type: "loaded"; store: VectorMobileStore }
  | { type: "failed"; error: string };

export const emptyMobileStore: VectorMobileStore = {
  version: VECTOR_MOBILE_STORE_VERSION,
  notes: [],
  records: [],
  artifacts: [],
};

export function mobileLibraryReducer(
  state: VectorMobileLibraryState,
  action: VectorMobileLibraryAction,
): VectorMobileLibraryState {
  if (action.type === "loading") return { ...state, status: "loading", error: null };
  if (action.type === "failed") return { ...state, status: "error", error: action.error };
  return { status: "ready", store: validateMobileStore(action.store), error: null };
}

export function validateMobileStore(value: unknown): VectorMobileStore {
  const store = requirePlainObject(value, "The local library returned malformed data.");
  if (store.version !== VECTOR_MOBILE_STORE_VERSION) {
    throw new Error("The local library uses an unsupported data version.");
  }
  const notes = requireArray(store.notes, mobileDataLimits.maxNotes, parseNote);
  const records = requireArray(store.records, mobileDataLimits.maxRecords, parseRecord);
  const artifacts = requireArray(store.artifacts, mobileDataLimits.maxArtifacts, parseSavedArtifact);
  requireUniqueIds([...notes, ...records, ...artifacts]);
  return {
    version: VECTOR_MOBILE_STORE_VERSION,
    notes: sortNewest(notes),
    records: sortNewest(records),
    artifacts: sortNewest(artifacts),
  };
}

export function validateMobileRecords(value: unknown): VectorMobileRecord[] {
  return validateMobileStore({
    version: VECTOR_MOBILE_STORE_VERSION,
    notes: [],
    records: value,
    artifacts: [],
  }).records;
}

export function validateNoteCreateInput(input: { text: string; tags?: string[] }): { text: string; tags: string[] } {
  return {
    text: boundedContent(input.text, "Note text", mobileDataLimits.maxTextLength),
    tags: parseTags(input.tags ?? []),
  };
}

export function validateNoteUpdateInput(input: { id: string; text?: string; tags?: string[]; expectedUpdatedAt?: string }): {
  id: string;
  text?: string;
  tags?: string[];
  expectedUpdatedAt?: string;
} {
  if (input.text === undefined && input.tags === undefined) {
    throw new Error("A note update must include text or tags.");
  }
  return {
    id: requireId(input.id),
    ...(input.text !== undefined
      ? { text: boundedContent(input.text, "Note text", mobileDataLimits.maxTextLength) }
      : {}),
    ...(input.tags !== undefined ? { tags: parseTags(input.tags) } : {}),
    ...(input.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: requireTimestamp(input.expectedUpdatedAt) } : {}),
  };
}

export function validateRecordCreateInput(input: {
  collection: string;
  title: string;
  data?: Record<string, unknown>;
}): { collection: string; title: string; data: Record<string, unknown> } {
  return {
    collection: boundedText(input.collection, "Record collection", 1, mobileDataLimits.maxCollectionLength),
    title: boundedText(input.title, "Record title", 1, mobileDataLimits.maxTitleLength),
    data: validateRecordData(input.data ?? {}),
  };
}

export function validateRecordUpdateInput(input: {
  id: string;
  title?: string;
  data?: Record<string, unknown>;
}): { id: string; title?: string; data?: Record<string, unknown> } {
  if (input.title === undefined && input.data === undefined) {
    throw new Error("A record update must include a title or structured data.");
  }
  return {
    id: requireId(input.id),
    ...(input.title !== undefined
      ? { title: boundedText(input.title, "Record title", 1, mobileDataLimits.maxTitleLength) }
      : {}),
    ...(input.data !== undefined ? { data: validateRecordData(input.data) } : {}),
  };
}

export function validateRecordSearchInput(input: {
  collection: string;
  query?: string;
  limit?: number;
}): { collection: string; query: string; limit: number } {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Record search limit must be between 1 and 100.");
  return {
    collection: boundedText(input.collection, "Record collection", 1, mobileDataLimits.maxCollectionLength),
    query: input.query === undefined
      ? ""
      : boundedText(input.query, "Record search", 0, mobileDataLimits.maxSearchLength),
    limit,
  };
}

export function validateMobileItemId(id: string): string {
  return requireId(id);
}

export function validateSavableArtifact(artifact: VectorArtifact): Omit<VectorSavedArtifact, "id" | "createdAt" | "updatedAt"> {
  if (!isSavedArtifactKind(artifact.kind)) throw new Error("This artifact type cannot be saved on iOS.");
  const title = boundedText(artifact.title, "Artifact title", 1, mobileDataLimits.maxTitleLength);
  const content = boundedContent(artifact.content, "Artifact content", mobileDataLimits.maxArtifactContentLength);
  if (artifact.kind === "image" && !isSecureHTTPSImage(content)) {
    throw new Error("Only secure HTTPS images can be saved on iOS.");
  }
  return {
    title,
    kind: artifact.kind,
    content,
    ...(artifact.language
      ? { language: boundedText(artifact.language, "Artifact language", 1, 32) }
      : {}),
  };
}

export function isSecureHTTPSImage(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function recordMatchesSearch(record: VectorMobileRecord, collection: string, query: string): boolean {
  if (record.collection !== collection) return false;
  const needle = query.trim().toLocaleLowerCase("en-US");
  if (!needle) return true;
  return stableSearchText(record).includes(needle);
}

export function recordCollectionNames(records: VectorMobileRecord[]): string[] {
  return [...new Set(records.map((record) => record.collection))]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export function stableSearchText(record: VectorMobileRecord): string {
  return `${record.title}\n${record.collection}\n${stableJSONStringify(record.data)}`.toLocaleLowerCase("en-US");
}

export function stableJSONStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJSONStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJSONStringify(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function savedItemSharePayload(
  item: VectorSavedArtifact | VectorMobileNote | VectorMobileRecord,
): { title: string; text?: string; url?: string; filename?: string } {
  if ("kind" in item) {
    if (item.kind === "image") return { title: item.title, url: item.content };
    return { title: item.title, text: item.content, filename: exportFilename(item.title, item.kind, item.language) };
  }
  if ("collection" in item) {
    return {
      title: item.title,
      text: stableJSONStringify({ collection: item.collection, title: item.title, data: item.data }),
      filename: exportFilename(item.title, "table"),
    };
  }
  return { title: "Vector note", text: item.text, filename: exportFilename("vector-note", "text") };
}

export function artifactSharePayload(artifact: VectorArtifact): {
  title: string;
  text?: string;
  url?: string;
  filename?: string;
} {
  const safe = validateSavableArtifact(artifact);
  if (safe.kind === "image") return { title: safe.title, url: safe.content };
  return {
    title: safe.title,
    text: safe.content,
    filename: exportFilename(safe.title, safe.kind, safe.language),
  };
}

function exportFilename(title: string, kind: VectorSavedArtifact["kind"], language?: string): string {
  const base =
    title
      .toLocaleLowerCase("en-US")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "vector-export";
  const extension =
    kind === "markdown"
      ? "md"
      : kind === "table" || kind === "notes"
        ? "json"
        : kind === "mermaid"
          ? "mmd"
          : kind === "code" && ["swift", "ts", "js", "json", "py", "html", "css"].includes(language ?? "")
            ? language
            : "txt";
  return `${base}.${extension}`;
}

function parseNote(value: unknown): VectorMobileNote {
  const note = requirePlainObject(value, "A stored note is malformed.");
  return {
    id: requireId(note.id),
    text: boundedContent(note.text, "Note text", mobileDataLimits.maxTextLength),
    tags: parseTags(note.tags),
    createdAt: requireTimestamp(note.createdAt),
    updatedAt: requireTimestamp(note.updatedAt),
  };
}

function parseRecord(value: unknown): VectorMobileRecord {
  const record = requirePlainObject(value, "A stored record is malformed.");
  const data = validateRecordData(record.data);
  return {
    id: requireId(record.id),
    collection: boundedText(record.collection, "Record collection", 1, mobileDataLimits.maxCollectionLength),
    title: boundedText(record.title, "Record title", 1, mobileDataLimits.maxTitleLength),
    data,
    createdAt: requireTimestamp(record.createdAt),
    updatedAt: requireTimestamp(record.updatedAt),
  };
}

function parseSavedArtifact(value: unknown): VectorSavedArtifact {
  const artifact = requirePlainObject(value, "A saved artifact is malformed.");
  if (!isSavedArtifactKind(artifact.kind)) throw new Error("A saved artifact type is unsupported.");
  const content = boundedContent(artifact.content, "Artifact content", mobileDataLimits.maxArtifactContentLength);
  if (artifact.kind === "image" && !isSecureHTTPSImage(content)) throw new Error("A saved image source is unsafe.");
  return {
    id: requireId(artifact.id),
    title: boundedText(artifact.title, "Artifact title", 1, mobileDataLimits.maxTitleLength),
    kind: artifact.kind,
    content,
    ...(typeof artifact.language === "string"
      ? { language: boundedText(artifact.language, "Artifact language", 1, 32) }
      : {}),
    createdAt: requireTimestamp(artifact.createdAt),
    updatedAt: requireTimestamp(artifact.updatedAt),
  };
}

function isSavedArtifactKind(value: unknown): value is VectorSavedArtifact["kind"] {
  return ["text", "markdown", "code", "table", "notes", "mermaid", "image"].includes(String(value));
}

function parseTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > mobileDataLimits.maxTags) throw new Error("Note tags are malformed.");
  return value.map((tag) => boundedText(tag, "Note tag", 1, mobileDataLimits.maxTagLength));
}

function validateRecordData(value: unknown): Record<string, unknown> {
  const data = requireSafeJSON(value, 0);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Record data must be an object.");
  if (new TextEncoder().encode(stableJSONStringify(data)).byteLength > mobileDataLimits.maxRecordDataBytes) {
    throw new Error("Record data exceeds the local size limit.");
  }
  return data as Record<string, unknown>;
}

function requireSafeJSON(value: unknown, depth: number): unknown {
  if (depth > 8) throw new Error("Record data is too deeply nested.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => requireSafeJSON(item, depth + 1));
  const object = requirePlainObject(value, "Record data contains an unsupported value.");
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, item] of Object.entries(object)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Record data contains a reserved field.");
    if (key.length === 0 || key.length > 80) throw new Error("Record data contains an invalid field name.");
    result[key] = requireSafeJSON(item, depth + 1);
  }
  return result;
}

function requirePlainObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(message);
  return value as Record<string, unknown>;
}

function requireArray<T>(value: unknown, limit: number, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error("The local library exceeds its item limit.");
  return value.map(parse);
}

function requireId(value: unknown): string {
  return boundedText(value, "Item id", 8, 80);
}

function requireTimestamp(value: unknown): string {
  const timestamp = boundedText(value, "Timestamp", 20, 32);
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime()) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(timestamp)) {
    throw new Error("A stored timestamp is malformed.");
  }
  return timestamp;
}

function boundedText(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} is required.`);
  const text = value.trim();
  if (text.length < minimum || text.length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) {
    throw new Error(`${label} must be between ${minimum} and ${maximum} characters.`);
  }
  return text;
}

function boundedContent(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} is required.`);
  if (!value.trim() || value.length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) {
    throw new Error(`${label} must contain safe text within ${maximum} characters.`);
  }
  return value;
}

function requireUniqueIds(items: Array<{ id: string }>): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error("The local library contains duplicate item ids.");
    ids.add(item.id);
  }
}

function sortNewest<T extends { id: string; updatedAt: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
}
