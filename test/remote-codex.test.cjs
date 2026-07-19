const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const {
  buildOperatorPrompt,
  buildRemoteCodexCommand,
  createRemoteCodexManager,
  extractInputRequest,
  isRecoverableRemoteFailure,
  needsUserInput,
  normalizeAccess,
  parseRemoteRepos,
  remoteCodexConfig,
  resolveRemoteRepo,
  shellQuote,
} = require("../electron/remote-codex.cjs");
const { executeRemoteCodexTool, remoteCodexToolSpecs } = require("../electron/remote-codex-tools.cjs");

test("parseRemoteRepos supports structured JSON and aliases", () => {
  const repos = parseRemoteRepos(
    JSON.stringify({
      FactoryIQ: {
        path: "/home/lizardbox/factory iq",
        aliases: ["factory", "fiq"],
      },
    }),
  );

  assert.deepEqual(repos, [
    {
      name: "FactoryIQ",
      aliases: ["factory", "fiq"],
      path: "/home/lizardbox/factory iq",
    },
  ]);
});

test("parseRemoteRepos supports compact semicolon configuration", () => {
  assert.deepEqual(parseRemoteRepos("app=/srv/app;docs=/srv/docs"), [
    { name: "app", aliases: [], path: "/srv/app" },
    { name: "docs", aliases: [], path: "/srv/docs" },
  ]);
});

test("remote config resolves the default repo and clamps timeout", () => {
  const config = remoteCodexConfig({
    VECTOR_CODEX_SSH_TARGET: "lizardbox@lizardbox-OptiPlex-9020",
    VECTOR_CODEX_REPOS: '{"app":"/srv/app"}',
    VECTOR_CODEX_TIMEOUT_MS: "1",
  });
  const resolved = resolveRemoteRepo(config, "");

  assert.equal(config.timeoutMs, 30_000);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.repo.path, "/srv/app");
});

test("remote config resolves aliases without accepting arbitrary paths", () => {
  const config = remoteCodexConfig({
    VECTOR_CODEX_SSH_TARGET: "lizardbox@lizardbox-OptiPlex-9020",
    VECTOR_CODEX_REPOS: '{"app":{"path":"/srv/app","aliases":["production"]}}',
  });

  assert.equal(resolveRemoteRepo(config, "production").ok, true);
  assert.equal(resolveRemoteRepo(config, "/tmp/other").ok, false);
});

test("remote command reads the prompt from stdin and quotes the repo", () => {
  const command = buildRemoteCodexCommand("/home/lizardbox/repo with 'quote'", "full-access");

  assert.match(command, /codex -a never exec --json/);
  assert.match(command, /--sandbox danger-full-access/);
  assert.match(command, / -'$/);
  assert.doesNotMatch(command, /user prompt/);
  assert.match(shellQuote("a'b"), /^'a'"'"'b'$/);
});

test("normalizeAccess keeps the supported execution modes", () => {
  assert.equal(normalizeAccess("read-only"), "read-only");
  assert.equal(normalizeAccess("workspace-write"), "workspace-write");
  assert.equal(normalizeAccess("full-access"), "danger-full-access");
  assert.equal(normalizeAccess(), "danger-full-access");
  assert.equal(normalizeAccess("anything-else"), "danger-full-access");
});

test("the Realtime registration module exposes every Remote Codex tool", () => {
  assert.deepEqual(
    remoteCodexToolSpecs.map((tool) => tool.name),
    [
      "remote_codex_status",
      "remote_codex_start",
      "remote_codex_task",
      "remote_codex_tasks",
      "remote_codex_resume",
      "remote_codex_cancel",
    ],
  );
  const startTool = remoteCodexToolSpecs.find((tool) => tool.name === "remote_codex_start");
  assert.match(startTool.description, /Codex RileyJarvis/);
  assert.equal(startTool.parameters.required.includes("prompt"), true);
  assert.equal(startTool.parameters.properties.access.default, "full-access");
});

test("the packaged Remote Codex skill teaches short voice routing", () => {
  const skill = fs.readFileSync(path.join(__dirname, "..", "electron", "skills", "remote-codex.md"), "utf8");

  assert.match(skill, /Codex RileyJarvis: add a remote test doc/);
  assert.match(skill, /Call `remote_codex_start` immediately/);
  assert.match(skill, /Default access: `full-access`/);
  assert.match(skill, /Commit that/);
  assert.match(skill, /announced automatically/);
  assert.match(skill, /Never substitute `project_cockpit_check`/);
});

test("Electron injects the skill and tool schemas into Realtime sessions", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");

  assert.match(mainSource, /\.\.\.remoteCodexToolSpecs/);
  assert.match(mainSource, /readBundledSkill\("remote-codex\.md"\)/);
  assert.match(mainSource, /tools: toolSpecs/);
  assert.match(mainSource, /executeRemoteCodexTool\(remoteCodex, name, args\)/);
  assert.match(mainSource, /handleRemoteCodexLifecycleEvent/);
  assert.match(mainSource, /remote-codex:event/);
});

test("the renderer refuses to connect without the Remote Codex start tool", () => {
  const realtimeSource = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "realtime.ts"), "utf8");

  assert.match(realtimeSource, /tool\.name === "remote_codex_start"/);
  assert.match(realtimeSource, /Remote Codex is not registered in Vector's local tool bridge/);
  assert.match(realtimeSource, /Vector is live\. Remote Codex is ready\./);
  assert.match(realtimeSource, /announceRemoteCodexEvent/);
  assert.match(realtimeSource, /automatic Remote Codex lifecycle notification/);
});

test("operator prompts guarantee repository context and structured reporting", () => {
  const prompt = buildOperatorPrompt("Fix the build.", { name: "RileyJarvis", path: "/srv/riley" }, "danger-full-access");

  assert.match(prompt, /Read every applicable AGENTS\.md/);
  assert.match(prompt, /current branch, git status, dirty files/);
  assert.match(prompt, /VECTOR_NEEDS_INPUT/);
  assert.match(prompt, /Outcome, Changed files, Verification, Git actions, and Remaining issues/);
  assert.match(prompt, /Fix the build\./);
});

test("needs-input markers and recoverable remote failures are detected", () => {
  assert.equal(needsUserInput("VECTOR_NEEDS_INPUT: Which database?"), true);
  assert.equal(extractInputRequest("Done.\nVECTOR_NEEDS_INPUT: Which database?"), "Which database?");
  assert.equal(isRecoverableRemoteFailure(255, "Connection timed out"), true);
  assert.equal(isRecoverableRemoteFailure(255, "Permission denied (publickey)"), false);
});

test("manager remembers the latest task and emits completion events", async () => {
  const lifecycleEvents = [];
  let promptSeen = "";
  let resolveCompletion;
  const completed = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  const manager = createRemoteCodexManager({
    env: {
      VECTOR_CODEX_SSH_TARGET: "vector-lizardbox",
      VECTOR_CODEX_REPOS: '{"RileyJarvis":"/home/lizardbox/repos/rileyjarvis"}',
      VECTOR_CODEX_DEFAULT_REPO: "RileyJarvis",
    },
    spawnProcess: () =>
      fakeCodexChild(
        [
          { type: "thread.started", thread_id: "thread-123" },
          { type: "item.completed", item: { type: "agent_message", text: "Outcome\nBuild fixed.\nVerification\nTests pass." } },
        ],
        (prompt) => {
          promptSeen = prompt;
        },
      ),
    onEvent: (event) => {
      lifecycleEvents.push(event);
      if (event.kind === "completed") resolveCompletion();
    },
  });

  const started = manager.start({ prompt: "Fix the build." });
  assert.equal(started.ok, true);
  await completed;

  const latest = manager.status({});
  assert.equal(latest.task.id, started.task.id);
  assert.equal(latest.task.status, "completed");
  assert.equal(latest.task.threadId, "thread-123");
  assert.match(promptSeen, /# Vector Remote Coding Task/);
  assert.deepEqual(
    lifecycleEvents.filter((event) => event.kind !== "progress").map((event) => event.kind),
    ["started", "completed"],
  );
  assert.match(lifecycleEvents.at(-1).announcement, /Codex finished RileyJarvis/);
});

test("the execution router sends registered tool names to the manager", async () => {
  const calls = [];
  const manager = {
    probe: async (args) => (calls.push(["probe", args]), { ok: true }),
    start: (args) => (calls.push(["start", args]), { ok: true }),
    status: (args) => (calls.push(["status", args]), { ok: true }),
    list: () => (calls.push(["list", {}]), { ok: true }),
    resume: (args) => (calls.push(["resume", args]), { ok: true }),
    cancel: (args) => (calls.push(["cancel", args]), { ok: true }),
  };

  assert.deepEqual(await executeRemoteCodexTool(manager, "remote_codex_start", { prompt: "test" }), { ok: true });
  assert.deepEqual(calls, [["start", { prompt: "test" }]]);
  assert.equal(await executeRemoteCodexTool(manager, "not_a_remote_tool", {}), null);
});

function fakeCodexChild(events, onPrompt = () => {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = {
    end(prompt) {
      onPrompt(String(prompt));
      queueMicrotask(() => {
        for (const event of events) child.stdout.write(`${JSON.stringify(event)}\n`);
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      });
    },
  };
  child.kill = () => child.emit("close", null, "SIGTERM");
  return child;
}
