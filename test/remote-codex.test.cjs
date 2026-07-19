const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const {
  buildOperatorPrompt,
  buildRemoteCodexCommand,
  buildRemoteReviewCommand,
  createRemoteCodexManager,
  extractInputRequest,
  extractReportSections,
  isRecoverableRemoteFailure,
  needsUserInput,
  normalizeAccess,
  parseRemoteRepos,
  parseReviewOutput,
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
      "remote_codex_commit",
      "remote_codex_push",
      "remote_codex_pr",
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

const reviewFixture = [
  "::vector-review::branch",
  "feature/fix-build",
  "::vector-review::head",
  "abc1234",
  "::vector-review::track",
  "## feature/fix-build...origin/feature/fix-build [ahead 1]",
  "::vector-review::status",
  " M src/app.ts",
  "?? docs/notes.md",
  "::vector-review::stat",
  " src/app.ts | 12 ++++++------",
  " 2 files changed, 8 insertions(+), 4 deletions(-)",
  "::vector-review::log",
  "abc1234 Fix the build",
  "def5678 Previous work",
  "::vector-review::diff",
  "diff --git a/src/app.ts b/src/app.ts",
  "@@ -1,3 +1,3 @@",
  "-const broken = true;",
  "+const broken = false;",
].join("\n");

function createCompletableManager(overrides = {}) {
  const lifecycleEvents = [];
  const spawnCalls = [];
  const prompts = [];
  let resolveReview;
  const reviewed = new Promise((resolve) => {
    resolveReview = resolve;
  });
  const manager = createRemoteCodexManager({
    env: {
      VECTOR_CODEX_SSH_TARGET: "vector-lizardbox",
      VECTOR_CODEX_REPOS: '{"RileyJarvis":"/home/lizardbox/repos/rileyjarvis"}',
      VECTOR_CODEX_DEFAULT_REPO: "RileyJarvis",
    },
    spawnProcess: (bin, args) => {
      spawnCalls.push({ bin, remoteCommand: args.at(-1) });
      return fakeCodexChild(
        [
          { type: "thread.started", thread_id: "thread-123" },
          {
            type: "item.completed",
            item: { type: "agent_message", text: "## Outcome\nBuild fixed.\n## Verification\nTests pass." },
          },
        ],
        (prompt) => prompts.push(prompt),
      );
    },
    runFile: async () => ({ stdout: reviewFixture }),
    onEvent: (event) => {
      lifecycleEvents.push(event);
      if (event.kind === "review") resolveReview();
    },
    ...overrides,
  });
  return { manager, lifecycleEvents, spawnCalls, prompts, reviewed };
}

test("manager remembers the latest task, emits completion, and collects a review", async () => {
  const { manager, lifecycleEvents, prompts, reviewed } = createCompletableManager();

  const started = manager.start({ prompt: "Fix the build." });
  assert.equal(started.ok, true);
  await reviewed;

  const latest = manager.status({});
  assert.equal(latest.task.id, started.task.id);
  assert.equal(latest.task.status, "completed");
  assert.equal(latest.task.threadId, "thread-123");
  assert.match(prompts[0], /# Vector Remote Coding Task/);
  assert.deepEqual(
    lifecycleEvents.filter((event) => event.kind !== "progress").map((event) => event.kind),
    ["started", "completed", "review"],
  );

  const reviewEvent = lifecycleEvents.at(-1);
  assert.equal(reviewEvent.artifact.kind, "codexReview");
  assert.match(reviewEvent.announcement, /Review ready for RileyJarvis: 2 files changed, 8 added, 4 removed/);
  const review = JSON.parse(reviewEvent.artifact.content);
  assert.equal(review.branch, "feature/fix-build");
  assert.equal(review.filesChanged, 2);
  assert.equal(review.insertions, 8);
  assert.equal(review.deletions, 4);
  assert.equal(review.outcome, "Build fixed.");
  assert.equal(review.verification, "Tests pass.");
  assert.match(review.diff, /const broken = false;/);
  assert.equal(latest.artifact.kind, "codexReview");
});

test("review commands and parsing survive empty and partial git output", () => {
  const command = buildRemoteReviewCommand("/srv/repo with 'quote'");
  assert.match(command, /::vector-review::branch/);
  assert.match(command, /git diff --stat HEAD/);
  assert.match(command, /git status --porcelain/);
  assert.match(command, /head -c 60000/);

  const empty = parseReviewOutput("");
  assert.equal(empty.filesChanged, 0);
  assert.equal(empty.diff, "");

  const untrackedOnly = parseReviewOutput("::vector-review::status\n?? new-file.md\n::vector-review::stat\n");
  assert.equal(untrackedOnly.filesChanged, 1);
  assert.deepEqual(untrackedOnly.statusLines, ["?? new-file.md"]);
});

test("report sections are extracted from Codex final messages", () => {
  const sections = extractReportSections(
    ["## Outcome", "Fixed the login bug.", "", "### Verification", "npm test passes.", "Git actions", "None."].join("\n"),
  );
  assert.equal(sections.outcome, "Fixed the login bug.");
  assert.equal(sections.verification, "npm test passes.");
  assert.equal(sections.gitActions, "None.");
  assert.equal(sections.remainingIssues, "");
});

test("voice verbs resume the completed thread with canned instructions and full access", async () => {
  const { manager, spawnCalls, prompts, reviewed } = createCompletableManager();
  manager.start({ prompt: "Fix the build." });
  await reviewed;

  const committed = manager.commit({ message: "Fix login redirect" });
  assert.equal(committed.ok, true);
  assert.match(spawnCalls.at(-1).remoteCommand, /resume '.*thread-123/);
  assert.match(spawnCalls.at(-1).remoteCommand, /--sandbox danger-full-access/);
  assert.match(prompts.at(-1), /Commit the work from this thread now\./);
  assert.match(prompts.at(-1), /Fix login redirect/);
  assert.match(prompts.at(-1), /Do not push\./);
});

test("push and PR verbs carry their own guardrails", async () => {
  const first = createCompletableManager();
  first.manager.start({ prompt: "Fix the build." });
  await first.reviewed;

  first.manager.push({});
  assert.match(first.prompts.at(-1), /Never force-push\./);

  const second = createCompletableManager();
  second.manager.start({ prompt: "Fix the build." });
  await second.reviewed;

  second.manager.openPullRequest({ title: "Fix login" });
  assert.match(second.prompts.at(-1), /pull request/i);
  assert.match(second.prompts.at(-1), /Fix login/);
  assert.match(second.prompts.at(-1), /URL on its own line/);
});

test("verbs refuse when there is no completed resumable task", async () => {
  const none = createCompletableManager();
  const noTask = none.manager.commit({});
  assert.equal(noTask.ok, false);
  assert.match(noTask.error, /no Remote Codex task yet/i);

  const running = createCompletableManager({
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = { end() {} };
      child.kill = () => child.emit("close", null, "SIGTERM");
      return child;
    },
  });
  running.manager.start({ prompt: "Long task." });
  const whileRunning = running.manager.push({});
  assert.equal(whileRunning.ok, false);
  assert.match(whileRunning.error, /still working/i);
  running.manager.cancel({});
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
