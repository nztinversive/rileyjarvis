const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const iosToolSpecAllowlist = require("../shared/ios-tool-specs.json");

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
    ["set_mode", "artifact_show", "show_menu"],
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
  loaded._compile(output, filename);
  return loaded.exports;
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
