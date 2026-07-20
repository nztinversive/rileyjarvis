const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const { createElectronVectorPlatform } = loadTypeScriptModule("../src/platform/electron.ts");
const { prepareRealtimeSession, realtimeConnectedStatus } = loadTypeScriptModule("../src/lib/realtime.ts");

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
