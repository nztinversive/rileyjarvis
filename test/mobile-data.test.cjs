const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const {
  emptyMobileStore,
  mobileLibraryReducer,
  recordCollectionNames,
  recordMatchesSearch,
  savedItemSharePayload,
  artifactSharePayload,
  validateNoteCreateInput,
  validateNoteUpdateInput,
  validateRecordCreateInput,
  validateRecordSearchInput,
  validateRecordUpdateInput,
  validateMobileStore,
  validateSavableArtifact,
} = loadTypeScriptModule("../src/mobile/data.ts");

test("the shared mobile store validates version, deterministic ordering, duplicate ids, and prototype-shaped data", () => {
  const store = validateMobileStore({
    version: 1,
    notes: [note("note-old", "2026-07-20T01:00:00.000Z"), note("note-new", "2026-07-20T02:00:00.000Z")],
    records: [],
    artifacts: [],
  });
  assert.deepEqual(store.notes.map((item) => item.id), ["note-new", "note-old"]);
  assert.throws(() => validateMobileStore({ ...store, version: 2 }), /unsupported data version/);
  assert.throws(() => validateMobileStore({ ...store, records: [{ ...record("note-new"), data: {} }] }), /duplicate item ids/);
  assert.throws(
    () => validateMobileStore({ ...store, records: [{ ...record("record-1"), data: JSON.parse('{"__proto__":{"secret":true}}') }] }),
    /reserved field/,
  );
});

test("record collections are discoverable and search stays stable and collection scoped", () => {
  assert.deepEqual(recordCollectionNames([
    record("record-0001"),
    { ...record("record-0002"), collection: "ideas" },
    { ...record("record-0003"), collection: "tasks" },
  ]), ["ideas", "tasks"]);
  const left = { ...record("record-1"), data: { beta: 2, alpha: "Needle" } };
  const right = { ...record("record-2"), data: { alpha: "Needle", beta: 2 } };
  assert.equal(recordMatchesSearch(left, "tasks", "needle"), true);
  assert.equal(recordMatchesSearch(right, "tasks", "needle"), true);
  assert.equal(recordMatchesSearch(left, "other", "needle"), false);
});

test("native mutation inputs are bounded before they can reach persistent storage", () => {
  assert.deepEqual(validateNoteCreateInput({ text: "  Keep spacing\n", tags: ["work"] }), {
    text: "  Keep spacing\n",
    tags: ["work"],
  });
  assert.throws(
    () => validateNoteCreateInput({ text: "Keep", tags: ["x".repeat(49)] }),
    /between 1 and 48 characters/,
  );
  assert.throws(
    () => validateRecordCreateInput({ collection: "tasks", title: "Large", data: { value: "x".repeat(16_384) } }),
    /exceeds the local size limit/,
  );
  assert.deepEqual(validateRecordSearchInput({ collection: "tasks" }), {
    collection: "tasks",
    query: "",
    limit: 20,
  });
  assert.throws(() => validateRecordSearchInput({ collection: "tasks", limit: 101 }), /between 1 and 100/);
  assert.throws(() => validateNoteUpdateInput({ id: "note-0001" }), /must include text or tags/);
  assert.throws(() => validateRecordUpdateInput({ id: "record-0001" }), /must include a title or structured data/);
});

test("only bounded supported artifacts and credential-free HTTPS image links can be saved or shared", () => {
  assert.deepEqual(validateSavableArtifact({ title: "Plan", kind: "markdown", content: "# Plan" }), {
    title: "Plan", kind: "markdown", content: "# Plan",
  });
  assert.equal(validateSavableArtifact({ title: "Code", kind: "code", content: "  let value = 1\n" }).content, "  let value = 1\n");
  assert.throws(() => validateSavableArtifact({ title: "Loading", kind: "imageLoading", content: "wait" }), /cannot be saved/);
  assert.throws(() => validateSavableArtifact({ title: "Local", kind: "image", content: "file:///private/image.png" }), /secure HTTPS/);
  assert.throws(() => validateSavableArtifact({ title: "Auth", kind: "image", content: "https://token@example.com/image.png" }), /secure HTTPS/);
  assert.throws(() => validateSavableArtifact({ title: "Signed", kind: "image", content: "https://example.com/image.png?token=secret" }), /secure HTTPS/);
  assert.throws(() => validateSavableArtifact({ title: "Fragment", kind: "image", content: "https://example.com/image.png#secret" }), /secure HTTPS/);
  assert.deepEqual(savedItemSharePayload({ ...artifact("artifact-1"), kind: "image", content: "https://example.com/image.png" }), {
    title: "Saved", url: "https://example.com/image.png",
  });
  assert.deepEqual(artifactSharePayload({ title: "Q3 Plan", kind: "markdown", content: "# Plan" }), {
    title: "Q3 Plan",
    text: "# Plan",
    filename: "q3-plan.md",
  });
  assert.doesNotMatch(
    savedItemSharePayload({ ...record("internal-record-id"), title: "Launch", data: { owner: "Noah" } }).text,
    /internal-record-id/,
  );
});

test("the library reducer preserves an actionable initial-load error state", () => {
  const initial = { status: "loading", store: emptyMobileStore, error: null };
  const loaded = mobileLibraryReducer(initial, { type: "loaded", store: { ...emptyMobileStore, notes: [note("note-0001", "2026-07-20T01:00:00.000Z")] } });
  assert.equal(loaded.status, "ready");
  assert.equal(loaded.store.notes.length, 1);
  const failed = mobileLibraryReducer(loaded, { type: "failed", error: "A protected recovery copy was preserved." });
  assert.equal(failed.status, "error");
  assert.match(failed.error, /recovery copy/);
});

test("native contracts use Application Support, serialization, atomic protection, quarantine, and no preferences fallback", () => {
  const core = read("ios/App/VectorMobileDataCore/Sources/VectorMobileDataCore/VectorMobileDataCore.swift");
  const plugin = read("ios/App/App/VectorMobileDataPlugin.swift");
  const share = read("ios/App/App/VectorSharePlugin.swift");
  const bridge = read("ios/App/App/VectorBridgeViewController.swift");
  const project = read("ios/App/App.xcodeproj/project.pbxproj");
  const library = read("src/components/MobileLibrary.tsx");

  assert.match(plugin, /applicationSupportDirectory/);
  assert.match(plugin, /operationQueue = DispatchQueue\(label: "com\.rileyjarvis\.vector\.mobile-data-plugin"/);
  assert.match(plugin, /try self\.ensureReadyForMutation\(\)[\s\S]*?self\.store\.addNote/);
  assert.match(plugin, /mutationResult\(itemId: note\.id\)/);
  assert.match(plugin, /mutationResult\(itemId: record\.id\)/);
  assert.match(plugin, /mutationResult\(itemId: artifact\.id\)/);
  assert.match(plugin, /CAPPluginMethod\(name: "searchRecords"/);
  assert.match(plugin, /searchRecords\([\s\S]*?snapshot\(\)\.recoveredCorruptStore[\s\S]*?corruptStorePreserved/);
  assert.match(core, /DispatchQueue\(label: "com\.rileyjarvis\.vector\.mobile-data"\)/);
  assert.match(core, /options: \[\.atomic, \.completeFileProtection\]/);
  assert.match(core, /FileProtectionType\.complete/);
  assert.match(core, /corrupt-/);
  assert.match(core, /maxFileBytes/);
  assert.doesNotMatch(`${core}\n${plugin}`, /UserDefaults|Preferences|localStorage/);
  assert.match(share, /UIActivityViewController/);
  assert.match(share, /completed/);
  assert.match(share, /presentedViewController == nil/);
  assert.match(share, /components\.query == nil/);
  assert.match(bridge, /registerPluginInstance\(VectorMobileDataPlugin\(\)\)/);
  assert.match(bridge, /registerPluginInstance\(VectorSharePlugin\(\)\)/);
  assert.match(project, /VectorMobileDataCore\.swift in Sources/);
  assert.match(library, /if \(mutationInFlight\.current \|\| !libraryReady\) return false/);
  assert.match(library, /catch \(error\) \{\s*setMutationError\(safeMessage\(error\)\);\s*return false;/);
  assert.doesNotMatch(library, /catch \(error\) \{\s*dispatch\(\{ type: "failed", error: safeMessage\(error\) \}\);\s*return false;/);
  assert.match(library, /The local change was not saved/);
  assert.match(library, /aria-busy=\{mutating\}/);
  assert.match(library, /\{section === "current"/);
  assert.match(library, /disabled=\{!canSave \|\| pending/);
  assert.match(library, /mode !== "new" && !draftTouched && collections\.length/);
  assert.match(library, /setDraftTouched\(true\)/);
});

function note(id, timestamp) { return { id, text: "Note", tags: [], createdAt: timestamp, updatedAt: timestamp }; }
function record(id) { return { id, collection: "tasks", title: "Record", data: {}, createdAt: "2026-07-20T01:00:00.000Z", updatedAt: "2026-07-20T01:00:00.000Z" }; }
function artifact(id) { return { id, title: "Saved", kind: "text", content: "Safe", createdAt: "2026-07-20T01:00:00.000Z", updatedAt: "2026-07-20T01:00:00.000Z" }; }
function read(relativePath) { return fs.readFileSync(path.join(root, relativePath), "utf8"); }

function loadTypeScriptModule(relativePath) {
  const previous = Module._extensions[".ts"];
  Module._extensions[".ts"] = (loaded, filename) => {
    const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename }).outputText;
    loaded._compile(output, filename);
  };
  const filename = path.resolve(__dirname, relativePath);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  try {
    Module._extensions[".ts"](loaded, filename);
    return loaded.exports;
  } finally {
    if (previous) Module._extensions[".ts"] = previous;
    else delete Module._extensions[".ts"];
  }
}
