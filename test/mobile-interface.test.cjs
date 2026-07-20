const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const {
  connectionControlPresentation,
  mobileNavigationReducer,
  mobileTabs,
} = loadTypeScriptModule("../src/mobile/navigation.ts");
const { VectorRealtimeClient } = loadTypeScriptModule("../src/lib/realtime.ts");

test("native mobile navigation exposes the three intentional primary destinations", () => {
  assert.deepEqual(
    mobileTabs.map((tab) => [tab.id, tab.label]),
    [
      ["talk", "Talk"],
      ["artifacts", "Artifacts"],
      ["activity", "Activity"],
    ],
  );

  const initial = { activeTab: "talk" };
  const artifacts = mobileNavigationReducer(initial, { type: "select", tab: "artifacts" });
  const activity = mobileNavigationReducer(artifacts, { type: "select", tab: "activity" });

  assert.deepEqual(artifacts, { activeTab: "artifacts" });
  assert.deepEqual(activity, { activeTab: "activity" });
  assert.equal(mobileNavigationReducer(activity, { type: "select", tab: "activity" }), activity);
});

test("the mobile conversation control names every connection and listening state", () => {
  assert.deepEqual(connectionControlPresentation("idle", "idle"), {
    action: "connect",
    label: "Start conversation",
    detail: "Voice connects when you are ready",
    disabled: false,
    tone: "idle",
  });
  assert.equal(connectionControlPresentation("connecting", "thinking").label, "Connecting…");
  assert.equal(connectionControlPresentation("connecting", "thinking").disabled, true);
  assert.equal(connectionControlPresentation("connected", "idle").label, "Disconnect");
  assert.equal(connectionControlPresentation("connected", "listening").label, "Listening");
  assert.equal(connectionControlPresentation("connected", "listening").detail, "Tap to disconnect");
  assert.equal(connectionControlPresentation("error", "error").label, "Try again");
  assert.equal(connectionControlPresentation("error", "error").detail, "Connection failed");
});

test("typed prompts stay intact until a conversation is connected", () => {
  const app = read("src/App.tsx");
  const mobile = read("src/components/MobileAppShell.tsx");

  assert.match(app, /if \(connectionState !== "connected" \|\| !clientRef\.current\)/);
  assert.ok(app.indexOf('setStatus(message)') < app.indexOf('clientRef.current.sendText(trimmed)'));
  assert.ok(app.indexOf('clientRef.current.sendText(trimmed)') < app.indexOf('setTextPrompt("")'));
  assert.match(mobile, /disabled=\{connectionState !== "connected" \|\| !textPrompt\.trim\(\)\}/);
  assert.match(mobile, /Connect a conversation before sending a message/);
});

test("Realtime connection failures remain in an explicit error state until retry or disconnect", async () => {
  const states = [];
  const moods = [];
  const statuses = [];
  const client = new VectorRealtimeClient(
    {
      presentation: "native-mobile",
      async createRealtimeCredential() {
        throw new Error("No bootstrap session credential is stored in Keychain.");
      },
      async executeTool() {
        return { ok: true };
      },
      async listToolSpecs() {
        return [];
      },
    },
    {
      onConnectionState: (state) => states.push(state),
      onMood: (mood) => moods.push(mood),
      onMouthShape() {},
      onTranscript() {},
      onArtifact() {},
      onMode() {},
      onStatus: (status) => statuses.push(status),
      onThumbnailReady() {},
    },
  );

  await client.connect();
  assert.deepEqual(states, ["connecting", "error"]);
  assert.equal(moods.at(-1), "error");
  assert.match(statuses.at(-1), /No bootstrap session credential/);

  client.disconnect();
  assert.equal(states.at(-1), "idle");
  assert.equal(moods.at(-1), "idle");
});

test("native presentation selection is capability-driven and desktop-only modes stay out of mobile UI", () => {
  const app = read("src/App.tsx");
  const mobile = read("src/components/MobileAppShell.tsx");
  const ios = read("src/platform/ios.ts");
  const electron = read("src/platform/electron.ts");
  const sourceFiles = [app, mobile, ios, electron].join("\n");

  assert.match(app, /vectorPlatform\?\.presentation === "native-mobile"/);
  assert.match(ios, /presentation: "native-mobile"/);
  assert.match(electron, /presentation: "desktop"/);
  assert.ok(app.indexOf("if (isNativeMobile)") < app.indexOf('if (mode === "computer")'));
  assert.doesNotMatch(mobile, /MonitorCog|remoteCodex|Computer use|Computer mode/);
  assert.doesNotMatch(sourceFiles, /navigator\.userAgent|userAgentData/);
});

test("mobile markup and responsive styles preserve accessibility and iPhone layout contracts", () => {
  const mobile = read("src/components/MobileAppShell.tsx");
  const styles = read("src/styles.css");
  const html = read("index.html");

  assert.match(mobile, /<nav className="mobile-tab-bar" aria-label="Primary">/);
  assert.match(mobile, /role="tablist"/);
  assert.match(mobile, /aria-selected=\{selected\}/);
  assert.match(mobile, /aria-live="polite"/);
  assert.match(mobile, /aria-label=\{`\$\{control\.label\}\. \$\{control\.detail\}`\}/);
  assert.match(mobile, /headingRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(mobile, /const input = event\.currentTarget[\s\S]*?input\.scrollIntoView/);
  assert.doesNotMatch(mobile, /setTimeout\(\(\) => \{[\s\S]*?event\.currentTarget\.scrollIntoView/);
  assert.match(mobile, /disabled=\{connectionState !== "connected" \|\| !textPrompt\.trim\(\)\}/);
  assert.match(styles, /env\(safe-area-inset-top\)/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(styles, /height: 100dvh/);
  assert.match(styles, /min-height: 44px/);
  assert.match(styles, /\.mobile-shell \.vector-orb[\s\S]*?width: var\(--orb-size\)[\s\S]*?height: var\(--orb-size\)/);
  assert.match(styles, /\.mobile-page-scroll[\s\S]*?overflow-x: hidden/);
  assert.match(styles, /@media \(max-height: 700px\) and \(orientation: portrait\)/);
  assert.match(styles, /@media \(orientation: landscape\) and \(max-height: 520px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /interactive-widget=resizes-content/);
});

test("the mobile artifact presentation keeps content bounded and delegates secure links", () => {
  const mobile = read("src/components/MobileAppShell.tsx");
  const artifact = read("src/components/ArtifactPanel.tsx");
  const styles = read("src/styles.css");

  assert.match(mobile, /presentation="mobile"/);
  assert.match(mobile, /onOpenExternalUrl=\{onOpenExternalUrl\}/);
  assert.match(artifact, /presentation === "mobile"/);
  assert.match(styles, /\.artifact-panel-mobile \.artifact-body[\s\S]*?overflow-x: hidden/);
  assert.match(styles, /\.artifact-panel-mobile \.table-wrap[\s\S]*?overflow-x: auto/);
  assert.match(styles, /\.artifact-panel-mobile \.artifact-image[\s\S]*?max-width: 100%/);
});

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

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
