const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const iosToolSpecAllowlist = require("../shared/ios-tool-specs.json");

require.extensions[".ts"] = function compileTypeScript(module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      resolveJsonModule: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const { createElectronVectorPlatform } = loadTypeScriptModule("../src/platform/electron.ts");
const { createIOSVectorPlatform } = loadTypeScriptModule("../src/platform/ios.ts");
const { resolveVectorPlatform } = loadTypeScriptModule("../src/platform/resolver.ts");
const { createEntryId, prepareRealtimeSession, realtimeConnectedStatus, VectorRealtimeClient } =
  loadTypeScriptModule("../src/lib/realtime.ts");

test("the Electron adapter maps the legacy preload bridge to VectorPlatform", async () => {
  const calls = [];
  let lifecycleCallback;
  const bridge = {
    async createRealtimeToken() {
      calls.push("credential");
      return { value: "client-secret", expiresAt: 123 };
    },
    async executeTool(toolCall) {
      calls.push(["execute", toolCall]);
      return { ok: true, message: "done" };
    },
    async getToolSpecs() {
      calls.push("specs");
      return [{ type: "function", name: "show_menu", description: "Show the menu.", parameters: {} }];
    },
    onRemoteCodexEvent(callback) {
      lifecycleCallback = callback;
      calls.push("subscribe");
      return () => calls.push("unsubscribe");
    },
  };

  const platform = createElectronVectorPlatform(bridge);
  assert.equal(platform.presentation, "desktop");
  assert.deepEqual(await platform.createRealtimeCredential(), { value: "client-secret", expiresAt: 123 });
  assert.equal((await platform.listToolSpecs())[0].name, "show_menu");
  assert.deepEqual(await platform.executeTool({ name: "show_menu", arguments: {} }), { ok: true, message: "done" });

  const events = [];
  const unsubscribe = platform.remoteCodex.subscribeToLifecycle((event) => events.push(event));
  lifecycleCallback({ kind: "started" });
  unsubscribe();

  assert.deepEqual(events, [{ kind: "started" }]);
  assert.deepEqual(calls, [
    "credential",
    "specs",
    ["execute", { name: "show_menu", arguments: {} }],
    "subscribe",
    "unsubscribe",
  ]);
});

test("the Electron adapter omits Remote Codex when the preload bridge does not expose it", () => {
  const platform = createElectronVectorPlatform({
    createRealtimeToken: async () => ({ value: "client-secret", expiresAt: null }),
    executeTool: async () => ({ ok: true }),
    getToolSpecs: async () => [],
  });

  assert.equal(platform.remoteCodex, undefined);
});

test("the resolver selects native iOS before Electron and falls back safely", () => {
  const ios = { name: "ios" };
  const electron = { name: "electron" };

  assert.equal(resolveVectorPlatform(ios, electron), ios);
  assert.equal(resolveVectorPlatform(null, electron), electron);
  assert.equal(resolveVectorPlatform(null, null), null);
});

test("the iOS adapter sends the exact backend session request and returns only credential fields", async () => {
  const calls = [];
  const platform = createIOSVectorPlatform({
    backendBaseUrl: "https://vector.example",
    secureStorage: {
      async get() {
        calls.push(["keychain", "get"]);
        return { value: "bootstrap-credential" };
      },
      async set(options) {
        calls.push(["keychain", "set", options]);
      },
      async delete() {
        calls.push(["keychain", "delete"]);
      },
    },
    async fetchImpl(url, init) {
      calls.push(["fetch", url, init]);
      return new Response(JSON.stringify({ value: "ephemeral-value", expiresAt: 1234, ignored: "field" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  assert.equal(platform.presentation, "native-mobile");
  assert.deepEqual(await platform.createRealtimeCredential(), { value: "ephemeral-value", expiresAt: 1234 });
  assert.deepEqual(calls[0], ["keychain", "get"]);
  assert.equal(calls[1][0], "fetch");
  assert.equal(calls[1][1], "https://vector.example/api/realtime/session");
  assert.equal(calls[1][2].method, "POST");
  assert.equal(calls[1][2].body, "{}");
  assert.deepEqual(calls[1][2].headers, {
    Authorization: "Bearer bootstrap-credential",
    "Content-Type": "application/json",
  });
  assert.ok(calls[1][2].signal instanceof AbortSignal);
});

test("the iOS adapter rejects missing backend URL before reading secure storage", async () => {
  let reads = 0;
  const platform = createIOSVectorPlatform({
    backendBaseUrl: "",
    secureStorage: {
      async get() {
        reads += 1;
        return { value: "bootstrap-credential" };
      },
      async set() {},
      async delete() {},
    },
    async fetchImpl() {
      throw new Error("must not fetch");
    },
  });

  await assert.rejects(platform.createRealtimeCredential(), /Set VITE_VECTOR_BACKEND_URL/);
  assert.equal(reads, 0);
});

test("the iOS adapter rejects a missing Keychain bootstrap credential without fetching", async () => {
  let fetches = 0;
  const platform = createIOSVectorPlatform({
    backendBaseUrl: "https://vector.example",
    secureStorage: {
      async get() {
        return {};
      },
      async set() {},
      async delete() {},
    },
    async fetchImpl() {
      fetches += 1;
      throw new Error("must not fetch");
    },
  });

  await assert.rejects(platform.createRealtimeCredential(), /No bootstrap session credential is stored in Keychain/);
  assert.equal(fetches, 0);
});

test("the iOS adapter rejects malformed credential responses", async () => {
  const platform = createIOSVectorPlatform({
    backendBaseUrl: "https://vector.example",
    secureStorage: secureStorageWith("bootstrap-credential"),
    async fetchImpl() {
      return new Response(JSON.stringify({ value: "ephemeral-value", expiresAt: "later" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  await assert.rejects(platform.createRealtimeCredential(), /malformed credential/);
});

test("the iOS adapter bounds requests and never exposes underlying error or token text", async () => {
  const platform = createIOSVectorPlatform({
    backendBaseUrl: "https://vector.example",
    secureStorage: secureStorageWith("never-print-bootstrap-token"),
    timeoutMs: 10,
    fetchImpl(_url, init) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("never-print-bootstrap-token transport detail")));
      });
    },
  });

  const error = await platform.createRealtimeCredential().then(
    () => null,
    (value) => value,
  );
  assert.match(error.message, /timed out/);
  assert.doesNotMatch(error.message, /never-print|transport detail/);
});

test("the iOS adapter propagates stale-attempt cancellation into the backend request", async () => {
  const caller = new AbortController();
  let requestSignal;
  const platform = createIOSVectorPlatform({
    backendBaseUrl: "https://vector.example",
    secureStorage: secureStorageWith("never-print-bootstrap-token"),
    fetchImpl(_url, init) {
      requestSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("private cancelled request detail")));
      });
    },
  });

  const request = platform.createRealtimeCredential({ signal: caller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  caller.abort();
  const error = await request.then(
    () => null,
    (value) => value,
  );

  assert.equal(requestSignal.aborted, true);
  assert.doesNotMatch(error.message, /never-print|private cancelled/);
});

test("the iOS adapter exposes only mobile tools and safely rejects desktop tools and local images", async () => {
  const platform = createIOSVectorPlatform({
    backendBaseUrl: "https://vector.example",
    secureStorage: secureStorageWith("bootstrap-credential"),
    async fetchImpl() {
      throw new Error("not used");
    },
  });
  const specs = await platform.listToolSpecs();

  assert.deepEqual(
    specs.map((tool) => tool.name),
    [
      "set_mode", "note_add", "note_list", "note_update", "note_delete",
      "records_create", "records_search", "records_update", "records_delete",
      "artifact_save", "artifact_library_list", "artifact_unsave", "artifact_show", "show_menu",
    ],
  );
  assert.deepEqual(specs, iosToolSpecAllowlist);
  assert.equal(specs.some((tool) => tool.name.startsWith("remote_codex")), false);
  assert.deepEqual(await platform.executeTool({ name: "remote_codex_start", arguments: {} }), {
    ok: false,
    error: "That desktop tool is not available on iOS.",
  });
  assert.deepEqual(await platform.executeTool({ name: "set_mode", arguments: { mode: "computer" } }), {
    ok: false,
    error: "Computer-use mode is not available on iOS.",
  });
  assert.deepEqual(
    await platform.executeTool({
      name: "artifact_show",
      arguments: { title: "Local image", kind: "image", content: "/Users/example/secret.png" },
    }),
    { ok: false, error: "That artifact is not available on iOS." },
  );
  assert.deepEqual(
    await platform.executeTool({
      name: "artifact_show",
      arguments: { title: "Credentialed image", kind: "image", content: "https://token@example.com/private.png" },
    }),
    { ok: false, error: "That artifact is not available on iOS." },
  );
  assert.deepEqual(
    await platform.executeTool({
      name: "artifact_show",
      arguments: { title: "Oversized", kind: "text", content: "x".repeat(64_001) },
    }),
    { ok: false, error: "That artifact is not available on iOS." },
  );
});

test("the iOS adapter opens only HTTPS links through its native browser boundary", async () => {
  const opened = [];
  const platform = createIOSVectorPlatform({
    backendBaseUrl: "https://vector.example",
    secureStorage: secureStorageWith("bootstrap-credential"),
    async fetchImpl() {
      throw new Error("not used");
    },
    async openExternalUrl(url) {
      opened.push(url);
    },
  });

  await platform.openExternalUrl("https://example.com/path");
  await assert.rejects(platform.openExternalUrl("file:///Users/example/secret"), /secure web links/);
  assert.deepEqual(opened, ["https://example.com/path"]);
});

test("the iOS adapter selects typed mobile data and share capabilities with bounded confirmation-gated tools", async () => {
  let store = { version: 1, notes: [], records: [], artifacts: [] };
  let deletes = 0;
  let updates = 0;
  let nativeConfirmation = false;
  const confirmationRequests = [];
  const now = "2026-07-20T12:00:00Z";
  const mobileData = {
    async list() { return structuredClone(store); },
    async confirmDeletion(input) { confirmationRequests.push(input); return { confirmed: nativeConfirmation }; },
    async createNote(input) {
      store.notes.push(
        { id: "note-rival", text: "Concurrent note", tags: [], createdAt: now, updatedAt: now },
        { id: "note-0001", text: input.text, tags: input.tags || [], createdAt: now, updatedAt: now },
      );
      return { store: structuredClone(store), itemId: "note-0001" };
    },
    async updateNote() { updates += 1; return structuredClone(store); },
    async deleteNote({ id }) { deletes += 1; store.notes = store.notes.filter((item) => item.id !== id); return structuredClone(store); },
    async createRecord(input) {
      store.records.push(
        { id: "record-rival", collection: input.collection, title: "Concurrent record", data: {}, createdAt: now, updatedAt: now },
        { id: "record-0001", collection: input.collection, title: input.title, data: input.data || {}, createdAt: now, updatedAt: now },
      );
      return { store: structuredClone(store), itemId: "record-0001" };
    },
    async searchRecords({ collection, query = "", limit = 20 }) {
      return { records: structuredClone(store.records.filter((item) => item.collection === collection && item.title.toLowerCase().includes(query.toLowerCase())).slice(0, limit)) };
    },
    async updateRecord() { updates += 1; return structuredClone(store); },
    async deleteRecord() { return structuredClone(store); },
    async saveArtifact(input) {
      store.artifacts.push(
        { id: "artifact-rival", title: "Concurrent artifact", kind: "text", content: "Other", createdAt: now, updatedAt: now },
        { id: "artifact-0001", ...input, createdAt: now, updatedAt: now },
      );
      return { store: structuredClone(store), itemId: "artifact-0001" };
    },
    async deleteArtifact() { return structuredClone(store); },
  };
  const shared = [];
  const platform = createIOSVectorPlatform({
    backendBaseUrl: "https://vector.example",
    secureStorage: secureStorageWith("bootstrap-credential"),
    mobileData,
    nativeShare: { async share(payload) { shared.push(payload); return { completed: false }; } },
    async fetchImpl() { throw new Error("not used"); },
  });

  assert.ok(platform.mobileData);
  assert.ok(platform.nativeShare);
  const observedStores = [];
  const unsubscribeMobileData = platform.mobileData.subscribe((nextStore) => observedStores.push(nextStore));
  assert.equal((await platform.executeTool({ name: "note_add", arguments: { text: "Remember", tags: ["work"] } })).note.id, "note-0001");
  assert.equal(observedStores.at(-1).notes[0].text, "Remember");
  unsubscribeMobileData();
  assert.equal((await platform.executeTool({ name: "records_create", arguments: { collection: "tasks", title: "Ship", data: { done: false } } })).record.id, "record-0001");
  assert.equal(observedStores.length, 1);
  assert.equal((await platform.executeTool({ name: "records_search", arguments: { collection: "tasks", query: "ship" } })).records.length, 1);
  assert.equal((await platform.executeTool({ name: "artifact_save", arguments: { title: "Plan", kind: "markdown", content: "# Plan" } })).savedArtifact.id, "artifact-0001");
  assert.equal((await platform.executeTool({ name: "note_delete", arguments: { id: "note-0001", confirmed: false } })).requiresConfirmation, true);
  assert.equal(deletes, 0);
  assert.equal((await platform.executeTool({ name: "note_delete", arguments: { id: "note-0001", confirmed: true } })).ok, false);
  assert.equal(deletes, 0);
  nativeConfirmation = true;
  assert.equal((await platform.executeTool({ name: "note_delete", arguments: { id: "note-0001", confirmed: true } })).ok, true);
  assert.equal(deletes, 1);
  assert.deepEqual(confirmationRequests, [
    { kind: "note", summary: "Remember" },
    { kind: "note", summary: "Remember" },
  ]);
  assert.deepEqual(await platform.nativeShare.share({ title: "Plan", text: "# Plan" }), { completed: false });
  assert.deepEqual(shared, [{ title: "Plan", text: "# Plan" }]);

  assert.match(
    (await platform.executeTool({ name: "note_update", arguments: { id: "note-0001" } })).error,
    /must include text or tags/,
  );
  assert.match(
    (await platform.executeTool({ name: "records_update", arguments: { id: "record-0001" } })).error,
    /must include a title or structured data/,
  );
  assert.equal(updates, 0);

  const noteCount = store.notes.length;
  await assert.rejects(
    platform.mobileData.createNote({ text: "Should not persist", tags: ["x".repeat(49)] }),
    /between 1 and 48 characters/,
  );
  assert.equal(store.notes.length, noteCount);

  store.artifacts = Array.from({ length: 20 }, (_, index) => ({
    id: `artifact-${String(index).padStart(4, "0")}`,
    title: `Large ${index}`,
    kind: "text",
    content: "private-content-" + "x".repeat(63_000),
    createdAt: now,
    updatedAt: now,
  }));
  const libraryResult = await platform.executeTool({ name: "artifact_library_list", arguments: {} });
  assert.equal(libraryResult.savedArtifacts.length, 20);
  assert.ok(JSON.stringify(libraryResult).length < 40_000);
  assert.equal(JSON.stringify(libraryResult).includes("x".repeat(1_000)), false);
});

test("the iOS adapter exposes the injected native voice-session lifecycle without widening desktop capabilities", async () => {
  const events = [];
  const voiceSession = {
    async prepare() {
      return { route: "built-in speaker" };
    },
    async deactivate() {},
    subscribe(callback) {
      events.push(callback);
      return () => events.push("unsubscribed");
    },
  };
  const platform = createIOSVectorPlatform({
    backendBaseUrl: "https://vector.example",
    secureStorage: secureStorageWith("bootstrap-credential"),
    voiceSession,
    async fetchImpl() {
      throw new Error("not used");
    },
  });

  assert.equal(platform.voiceSession, voiceSession);
  assert.equal(platform.remoteCodex, undefined);
});

test("shared renderer modules do not access the legacy Electron bridge directly", () => {
  for (const relativePath of ["../src/App.tsx", "../src/lib/realtime.ts"]) {
    const source = fs.readFileSync(path.resolve(__dirname, relativePath), "utf8");
    assert.doesNotMatch(source, /window\.ricky/);
    assert.doesNotMatch(source, /\bRicky[A-Z]/);
  }
});

test("Realtime preparation succeeds without the Remote Codex start tool", async () => {
  const session = await prepareRealtimeSession({
    createRealtimeCredential: async () => ({ value: "mobile-secret", expiresAt: null }),
    executeTool: async () => ({ ok: true }),
    listToolSpecs: async () => [{ type: "function", name: "show_menu", description: "Show the menu.", parameters: {} }],
  });

  assert.equal(session.credential.value, "mobile-secret");
  assert.equal(session.remoteCodexAvailable, false);
  assert.equal(realtimeConnectedStatus(session.remoteCodexAvailable), "Vector is live.");
});

test("Realtime preserves the Remote Codex ready message when the desktop tool is present", async () => {
  const session = await prepareRealtimeSession({
    createRealtimeCredential: async () => ({ value: "desktop-secret", expiresAt: null }),
    executeTool: async () => ({ ok: true }),
    listToolSpecs: async () => [{ type: "function", name: "remote_codex_start", description: "Start Codex.", parameters: {} }],
  });

  assert.equal(session.remoteCodexAvailable, true);
  assert.equal(realtimeConnectedStatus(session.remoteCodexAvailable), "Vector is live. Remote Codex is ready.");
});

test("transcript IDs fall back to Web Crypto available on early iOS 15", () => {
  const id = createEntryId({
    getRandomValues(bytes) {
      bytes.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      return bytes;
    },
  });

  assert.equal(id, "00010203-0405-4607-8809-0a0b0c0d0e0f");
});

test("mode failures retain platform-specific artifacts", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/App.tsx"), "utf8");
  const artifactHandling = source.indexOf("if (result.artifact)");
  const failureHandling = source.indexOf("if (!result.ok)", artifactHandling);

  assert.notEqual(artifactHandling, -1);
  assert.ok(failureHandling > artifactHandling);
  assert.match(source.slice(artifactHandling, failureHandling), /setArtifactVisible\(true\)/);
});

test("disconnecting an in-flight session prevents native setup from continuing", async () => {
  let resolveCredential;
  let peerConnections = 0;
  const originalPeerConnection = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = class {
    constructor() {
      peerConnections += 1;
    }
  };

  try {
    const states = [];
    const client = new VectorRealtimeClient(
      {
        createRealtimeCredential: () =>
          new Promise((resolve) => {
            resolveCredential = resolve;
          }),
        executeTool: async () => ({ ok: true }),
        listToolSpecs: async () => [],
      },
      {
        onConnectionState: (state) => states.push(state),
        onMood() {},
        onMouthShape() {},
        onTranscript() {},
        onArtifact() {},
        onMode() {},
        onStatus() {},
        onThumbnailReady() {},
      },
    );

    const connecting = client.connect();
    await new Promise((resolve) => setImmediate(resolve));
    client.disconnect();
    resolveCredential({ value: "ephemeral-value", expiresAt: 1234 });
    await connecting;

    assert.equal(peerConnections, 0);
    assert.deepEqual(states, ["connecting", "idle"]);
  } finally {
    globalThis.RTCPeerConnection = originalPeerConnection;
  }
});

function loadTypeScriptModule(relativePath) {
  const previous = Module._extensions[".ts"];
  Module._extensions[".ts"] = (loaded, filename) => {
    const source = fs.readFileSync(filename, "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: filename,
    }).outputText;
    loaded._compile(output, filename);
  };
  const filename = path.resolve(__dirname, relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  try {
    loaded._compile(output, filename);
    return loaded.exports;
  } finally {
    if (previous) Module._extensions[".ts"] = previous;
    else delete Module._extensions[".ts"];
  }
}

function secureStorageWith(value) {
  return {
    async get() {
      return { value };
    },
    async set() {},
    async delete() {},
  };
}
