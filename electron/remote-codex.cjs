const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function createRemoteCodexManager(options = {}) {
  const env = options.env || process.env;
  const spawnProcess = options.spawnProcess || spawn;
  const runFile = options.runFile || execFileAsync;
  const onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
  const tasks = new Map();
  const activeTaskByProject = new Map();
  let latestTaskId = "";

  function getConfig() {
    return remoteCodexConfig(env);
  }

  async function probe(args = {}) {
    const config = getConfig();
    const resolved = resolveRemoteRepo(config, args.project);
    if (!resolved.ok) return remoteCodexErrorArtifact(resolved.error, config);

    try {
      const { stdout } = await runFile(
        config.sshBin,
        [...sshBaseArgs(), config.target, buildRemoteProbeCommand(resolved.repo.path)],
        {
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
      );
      const details = parseKeyValueLines(stdout);
      const ok = details.codexAvailable === "yes" && details.repoAvailable === "yes";
      const messages = [];
      if (details.codexAvailable !== "yes") messages.push("Codex CLI is not available in the remote login shell.");
      if (details.repoAvailable !== "yes") messages.push(`Remote repository was not found: ${resolved.repo.path}`);
      if (details.gitRepo !== "yes") messages.push("The configured path is not a Git repository.");

      return {
        ok,
        target: config.target,
        project: resolved.repo.name,
        path: resolved.repo.path,
        details,
        error: messages.join(" "),
        artifact: {
          title: `Remote Codex: ${resolved.repo.name}`,
          kind: "markdown",
          content: [
            `# Remote Codex: ${resolved.repo.name}`,
            "",
            `- Target: \`${config.target}\``,
            `- Repository: \`${resolved.repo.path}\``,
            `- Codex: ${details.codexVersion || "not found"}`,
            `- Git branch: ${details.branch || "unavailable"}`,
            `- Status: ${ok ? "ready" : "setup required"}`,
            messages.length ? `\n${messages.join("\n")}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      };
    } catch (error) {
      return remoteCodexErrorArtifact(remoteErrorMessage(error), config, resolved.repo);
    }
  }

  function start(args = {}) {
    const config = getConfig();
    const resolved = resolveRemoteRepo(config, args.project);
    if (!resolved.ok) return remoteCodexErrorArtifact(resolved.error, config);

    const requestedPrompt = String(args.prompt || "").trim();
    if (!requestedPrompt) return remoteCodexErrorArtifact("A Codex task prompt is required.", config, resolved.repo);
    const access = normalizeAccess(args.access);

    return launchTask({
      config,
      repo: resolved.repo,
      prompt: buildOperatorPrompt(requestedPrompt, resolved.repo, access),
      requestedPrompt,
      access,
    });
  }

  function resume(args = {}) {
    const previous = findTask(args);
    if (!previous) {
      return remoteCodexErrorArtifact(taskNotFoundMessage(args), getConfig());
    }
    if (previous.status === "running") {
      return remoteCodexErrorArtifact(`Codex is still working on ${previous.repo.name}. Check it or cancel it before continuing the thread.`, getConfig(), previous.repo);
    }
    if (!previous.threadId) {
      return remoteCodexErrorArtifact("That task has no resumable Codex thread id yet.", getConfig(), previous.repo);
    }

    const requestedPrompt = String(args.prompt || "").trim();
    if (!requestedPrompt) return remoteCodexErrorArtifact("A follow-up prompt is required.", getConfig(), previous.repo);
    const access = normalizeAccess(args.access || previous.access);

    return launchTask({
      config: getConfig(),
      repo: previous.repo,
      prompt: buildOperatorPrompt(requestedPrompt, previous.repo, access, true),
      requestedPrompt,
      access,
      threadId: previous.threadId,
      resumedFrom: previous.id,
    });
  }

  function launchTask({ config, repo, prompt, requestedPrompt, access, threadId = "", resumedFrom = "" }) {
    const id = crypto.randomUUID();
    const task = {
      id,
      target: config.target,
      repo,
      access,
      status: "running",
      prompt,
      requestedPrompt,
      startedAt: new Date().toISOString(),
      completedAt: "",
      threadId,
      resumedFrom,
      finalMessage: "",
      lastAction: "Connecting to the Linux host.",
      events: [],
      stderr: [],
      process: null,
      timeout: null,
      retryTimer: null,
      attempts: 0,
      terminalEventEmitted: false,
      lastProgressAt: Date.now(),
    };
    tasks.set(id, task);
    latestTaskId = id;
    activeTaskByProject.set(projectKey(repo.name), id);

    const remoteCommand = buildRemoteCodexCommand(repo.path, access, threadId);
    task.timeout = setTimeout(() => {
      if (task.status !== "running") return;
      task.status = "timed_out";
      task.lastAction = `Task exceeded ${config.timeoutMs} ms and was stopped.`;
      clearTimeout(task.retryTimer);
      if (task.process) task.process.kill();
      else finalizeTask(task);
    }, config.timeoutMs);
    runAttempt(task, config, remoteCommand);

    return {
      ok: true,
      task: publicTask(task),
      artifact: remoteCodexTaskArtifact(task),
    };
  }

  function runAttempt(task, config, remoteCommand) {
    task.attempts += 1;
    task.status = "running";
    task.lastAction = task.attempts > 1 ? `Reconnecting to ${config.target} (attempt ${task.attempts}/2).` : "Connecting to the Linux host.";
    if (task.attempts === 1) emitTaskEvent(task, "started");
    let child;
    try {
      child = spawnProcess(config.sshBin, [...sshBaseArgs(), config.target, remoteCommand], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finishAttempt(task, config, remoteCommand, null, "", String(error?.message || error));
      return;
    }
    task.process = child;

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let spawnError = "";

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const parts = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = parts.pop() || "";
      for (const line of parts) consumeCodexLine(task, line, () => emitProgress(task));
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderrBuffer += chunk;
      const parts = stderrBuffer.split(/\r?\n/);
      stderrBuffer = parts.pop() || "";
      for (const line of parts) appendTail(task.stderr, line, 40);
    });

    child.on("error", (error) => {
      spawnError = String(error?.message || error);
      appendTail(task.stderr, spawnError, 40);
    });

    child.on("close", (code, signal) => {
      if (stdoutBuffer.trim()) consumeCodexLine(task, stdoutBuffer.trim(), () => emitProgress(task));
      if (stderrBuffer.trim()) appendTail(task.stderr, stderrBuffer.trim(), 40);
      task.process = null;
      task.signal = signal || "";
      finishAttempt(task, config, remoteCommand, code, signal || "", spawnError);
    });

    child.stdin?.end(`${task.prompt}\n`);
  }

  function finishAttempt(task, config, remoteCommand, code, signal, spawnError) {
    if (task.terminalEventEmitted) return;
    task.exitCode = code;
    task.signal = signal || "";

    if (task.status === "cancelled" || task.status === "timed_out") {
      finalizeTask(task);
      return;
    }

    const failureText = [spawnError, ...task.stderr.slice(-8)].filter(Boolean).join("\n");
    if (code !== 0 && task.attempts < 2 && isRecoverableRemoteFailure(code, failureText)) {
      task.lastAction = "The remote connection dropped. Retrying once automatically.";
      emitTaskEvent(task, "retrying");
      task.retryTimer = setTimeout(() => runAttempt(task, config, remoteCommand), 1_500);
      return;
    }

    if (code === 0) {
      task.status = needsUserInput(task.finalMessage) ? "needs_input" : "completed";
      if (task.status === "needs_input") task.lastAction = extractInputRequest(task.finalMessage);
    } else {
      task.status = "failed";
      if (!task.finalMessage && task.stderr.length > 0) task.lastAction = task.stderr.at(-1);
    }
    finalizeTask(task);
  }

  function finalizeTask(task) {
    if (task.terminalEventEmitted) return;
    task.terminalEventEmitted = true;
    task.completedAt = task.completedAt || new Date().toISOString();
    task.process = null;
    clearTimeout(task.timeout);
    clearTimeout(task.retryTimer);
    if (activeTaskByProject.get(projectKey(task.repo.name)) === task.id) {
      activeTaskByProject.delete(projectKey(task.repo.name));
    }
    emitTaskEvent(task, task.status === "needs_input" ? "attention" : task.status);
    if (task.status === "completed") void collectReview(task);
  }

  async function collectReview(task) {
    const config = getConfig();
    try {
      const { stdout } = await runFile(
        config.sshBin,
        [...sshBaseArgs(), config.target, buildRemoteReviewCommand(task.repo.path)],
        {
          timeout: 20_000,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        },
      );
      task.review = parseReviewOutput(stdout);
    } catch (error) {
      task.review = { error: remoteErrorMessage(error) };
    }
    emitTaskEvent(task, "review");
  }

  function emitProgress(task) {
    const now = Date.now();
    if (now - task.lastProgressAt < 60_000) return;
    task.lastProgressAt = now;
    emitTaskEvent(task, "progress");
  }

  function emitTaskEvent(task, kind) {
    try {
      onEvent(remoteCodexLifecycleEvent(task, kind));
    } catch {
      // Lifecycle notifications must never interrupt a Codex task.
    }
  }

  function findTask(args = {}) {
    const explicitId = String(args.taskId || "").trim();
    if (explicitId) return tasks.get(explicitId) || null;
    const requestedProject = String(args.project || "").trim();
    if (requestedProject) {
      const config = getConfig();
      const resolved = resolveRemoteRepo(config, requestedProject);
      if (!resolved.ok) return null;
      const activeId = activeTaskByProject.get(projectKey(resolved.repo.name));
      if (activeId && tasks.has(activeId)) return tasks.get(activeId);
      return Array.from(tasks.values()).reverse().find((task) => projectKey(task.repo.name) === projectKey(resolved.repo.name)) || null;
    }
    if (latestTaskId && tasks.has(latestTaskId)) return tasks.get(latestTaskId);
    return Array.from(tasks.values()).at(-1) || null;
  }

  function status(args = {}) {
    const task = findTask(args);
    if (!task) return remoteCodexErrorArtifact(taskNotFoundMessage(args), getConfig());
    return {
      ok: task.status === "running" || task.status === "completed" || task.status === "needs_input",
      task: publicTask(task),
      artifact: taskArtifact(task),
    };
  }

  function list() {
    const rows = Array.from(tasks.values())
      .reverse()
      .map(publicTask);
    return {
      ok: true,
      tasks: rows,
      artifact: {
        title: "Remote Codex Tasks",
        kind: "table",
        content: JSON.stringify(rows, null, 2),
      },
    };
  }

  function cancel(args = {}) {
    const task = findTask(args);
    if (!task) return remoteCodexErrorArtifact(taskNotFoundMessage(args), getConfig());
    if (task.status !== "running") {
      return { ok: true, task: publicTask(task), artifact: remoteCodexTaskArtifact(task) };
    }
    task.status = "cancelled";
    task.lastAction = "Cancellation requested.";
    task.completedAt = new Date().toISOString();
    clearTimeout(task.timeout);
    clearTimeout(task.retryTimer);
    task.process?.kill();
    finalizeTask(task);
    return { ok: true, task: publicTask(task), artifact: remoteCodexTaskArtifact(task) };
  }

  function runVerb(args, promptLines) {
    return resume({
      taskId: args.taskId,
      project: args.project,
      prompt: promptLines.filter(Boolean).join(" "),
      access: "full-access",
    });
  }

  function commit(args = {}) {
    const message = String(args.message || "").trim();
    return runVerb(args, [
      "Commit the work from this thread now.",
      "Stage the files this task changed (leave unrelated dirty files alone when possible) and create one focused commit that follows the repository's commit conventions.",
      message ? `Use this commit message: ${message}` : "Write a clear, conventional commit message yourself.",
      "Do not push.",
      "End your final response with the sections Outcome and Git actions, including the new commit hash.",
    ]);
  }

  function push(args = {}) {
    return runVerb(args, [
      "Push the current branch for this thread's work to its remote now.",
      "If the branch has no upstream, set one with push -u. Never force-push.",
      "If the work is not committed yet, stop and say so instead of committing on your own.",
      "End your final response with the sections Outcome and Git actions, naming the branch and remote you pushed to.",
    ]);
  }

  function openPullRequest(args = {}) {
    const title = String(args.title || "").trim();
    return runVerb(args, [
      "Open a pull request for this thread's work now.",
      "Push the branch first if it has not been pushed. Use the gh CLI if available; if it is not, report that instead of improvising.",
      title ? `Use this pull request title: ${title}` : "Write an accurate pull request title yourself.",
      "Write a concise body with a summary and a verification section.",
      "End your final response with the sections Outcome and Git actions, and put the pull request URL on its own line.",
    ]);
  }

  return {
    cancel,
    commit,
    config: () => publicRemoteConfig(getConfig()),
    list,
    openPullRequest,
    probe,
    push,
    resume,
    start,
    status,
  };
}

function remoteCodexConfig(env = process.env) {
  const repos = parseRemoteRepos(env.VECTOR_CODEX_REPOS);
  const defaultProject = String(env.VECTOR_CODEX_DEFAULT_REPO || repos[0]?.name || "").trim();
  const timeoutValue = Number(env.VECTOR_CODEX_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return {
    target: String(env.VECTOR_CODEX_SSH_TARGET || "").trim(),
    sshBin: String(env.VECTOR_CODEX_SSH_BIN || "ssh").trim() || "ssh",
    defaultProject,
    repos,
    timeoutMs: Number.isFinite(timeoutValue) ? Math.max(30_000, Math.min(timeoutValue, 4 * 60 * 60 * 1000)) : DEFAULT_TIMEOUT_MS,
  };
}

function parseRemoteRepos(value) {
  const input = String(value || "").trim();
  if (!input) return [];
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    parsed = Object.fromEntries(
      input
        .split(";")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const index = entry.indexOf("=");
          return index > 0 ? [entry.slice(0, index).trim(), entry.slice(index + 1).trim()] : [entry, entry];
        }),
    );
  }

  if (Array.isArray(parsed)) {
    return parsed.map(normalizeRemoteRepo).filter((repo) => repo.name && repo.path);
  }
  if (!parsed || typeof parsed !== "object") return [];
  return Object.entries(parsed)
    .map(([name, repo]) => normalizeRemoteRepo(typeof repo === "string" ? { name, path: repo } : { name, ...repo }))
    .filter((repo) => repo.name && repo.path);
}

function normalizeRemoteRepo(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    name: String(source.name || "").trim(),
    aliases: Array.isArray(source.aliases) ? source.aliases.map(String).map((item) => item.trim()).filter(Boolean) : [],
    path: String(source.path || "").trim(),
  };
}

function resolveRemoteRepo(config, project) {
  if (!config.target) return { ok: false, error: "VECTOR_CODEX_SSH_TARGET is not configured in .env.local." };
  if (config.repos.length === 0) return { ok: false, error: "VECTOR_CODEX_REPOS is not configured in .env.local." };
  const query = String(project || config.defaultProject || "").trim().toLowerCase();
  const repo =
    config.repos.find((candidate) => [candidate.name, ...candidate.aliases].some((name) => name.toLowerCase() === query)) ||
    (query ? null : config.repos[0]);
  if (!repo) return { ok: false, error: `No remote Codex repository matches "${project}".` };
  return { ok: true, repo };
}

function normalizeAccess(value) {
  const input = String(value || "full-access").toLowerCase();
  if (input === "read-only") return "read-only";
  if (input === "workspace-write") return "workspace-write";
  if (input === "full-access" || input === "danger-full-access") return "danger-full-access";
  return "danger-full-access";
}

function sshBaseArgs() {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ];
}

function buildRemoteCodexCommand(repoPath, access = "full-access", threadId = "") {
  const sandbox = normalizeAccess(access);
  const resume = threadId ? ` resume ${shellQuote(threadId)} -` : " -";
  const command = [
    "set -o pipefail",
    'export PATH="$HOME/.local/bin:$PATH"',
    `cd -- ${shellQuote(repoPath)}`,
    `exec codex -a never exec --json --color never --sandbox ${sandbox} -C ${shellQuote(repoPath)}${resume}`,
  ].join("; ");
  return `bash -lc ${shellQuote(command)}`;
}

function buildRemoteReviewCommand(repoPath) {
  const section = (name, command) => `echo '::vector-review::${name}'; ${command} 2>/dev/null || true`;
  const command = [
    'export PATH="$HOME/.local/bin:$PATH"',
    `cd -- ${shellQuote(repoPath)}`,
    section("branch", "git branch --show-current"),
    section("head", "git rev-parse --short HEAD"),
    section("track", "git status -sb | head -n 1"),
    section("status", "git status --porcelain"),
    section("stat", "git diff --stat HEAD"),
    section("log", "git log --oneline -5"),
    section("diff", "git diff HEAD | head -c 60000"),
  ].join("; ");
  return `bash -lc ${shellQuote(command)}`;
}

function parseReviewOutput(stdout) {
  const sections = {};
  let current = "";
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const marker = line.match(/^::vector-review::(\w+)\s*$/);
    if (marker) {
      current = marker[1];
      sections[current] = [];
      continue;
    }
    if (current) sections[current].push(line);
  }
  const text = (name) => (sections[name] || []).join("\n").trim();
  const statText = text("stat");
  const totals = statText.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
  const statusLines = text("status").split("\n").filter(Boolean);
  return {
    branch: text("branch"),
    head: text("head"),
    tracking: text("track"),
    statusLines,
    statText,
    filesChanged: totals ? Number(totals[1]) : statusLines.length,
    insertions: totals?.[2] ? Number(totals[2]) : 0,
    deletions: totals?.[3] ? Number(totals[3]) : 0,
    commits: text("log").split("\n").filter(Boolean),
    diff: text("diff"),
  };
}

function extractReportSections(message) {
  const names = ["Outcome", "Changed files", "Verification", "Git actions", "Remaining issues"];
  const heading = new RegExp(`^\\s{0,3}(?:#{1,6}\\s*|\\*\\*)?(${names.join("|")})(?:\\*\\*)?\\s*:?\\s*$`, "i");
  const sections = {};
  let current = "";
  for (const line of String(message || "").split(/\r?\n/)) {
    const match = line.match(heading);
    if (match) {
      current = match[1].toLowerCase();
      sections[current] = [];
      continue;
    }
    if (current) sections[current].push(line);
  }
  const text = (name) => (sections[name.toLowerCase()] || []).join("\n").trim();
  return {
    outcome: text("Outcome"),
    changedFiles: text("Changed files"),
    verification: text("Verification"),
    gitActions: text("Git actions"),
    remainingIssues: text("Remaining issues"),
  };
}

function buildRemoteProbeCommand(repoPath) {
  const command = [
    'export PATH="$HOME/.local/bin:$PATH"',
    "printf 'user=%s\\n' \"$(id -un)\"",
    "printf 'host=%s\\n' \"$(hostname)\"",
    "if command -v codex >/dev/null 2>&1; then printf 'codexAvailable=yes\\n'; printf 'codexVersion='; codex --version; else printf 'codexAvailable=no\\n'; fi",
    `if test -d ${shellQuote(repoPath)}; then printf 'repoAvailable=yes\\n'; else printf 'repoAvailable=no\\n'; fi`,
    `if git -C ${shellQuote(repoPath)} rev-parse --is-inside-work-tree >/dev/null 2>&1; then printf 'gitRepo=yes\\n'; printf 'branch='; git -C ${shellQuote(repoPath)} branch --show-current; else printf 'gitRepo=no\\n'; fi`,
  ].join("; ");
  return `bash -lc ${shellQuote(command)}`;
}

function buildOperatorPrompt(requestedPrompt, repo, access, resumed = false) {
  return [
    "# Vector Remote Coding Task",
    "",
    `Project: ${repo.name}`,
    `Repository: ${repo.path}`,
    `Access: ${access}`,
    resumed ? "This is follow-up work in the existing Codex thread." : "",
    "",
    "Before changing anything:",
    "1. Read every applicable AGENTS.md and the repository's primary README/contributor instructions.",
    "2. Inspect the current branch, git status, dirty files, and recent relevant history. Preserve unrelated user changes.",
    "3. Discover the project's own verification commands from its manifests, scripts, and documentation.",
    "",
    "Execution rules:",
    "- Complete the requested outcome autonomously and follow existing conventions.",
    "- Run the most relevant checks and fix failures caused by your work.",
    "- Do not commit, push, create a pull request, publish, or deploy unless the request explicitly asks for it.",
    "- If a decision from Noah is genuinely required, stop cleanly and end your final response with exactly `VECTOR_NEEDS_INPUT: <one concise question>`.",
    "- Otherwise finish with sections named Outcome, Changed files, Verification, Git actions, and Remaining issues.",
    "",
    "# Noah's request",
    "",
    requestedPrompt,
  ]
    .filter(Boolean)
    .join("\n");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function consumeCodexLine(task, line, onProgress = () => {}) {
  const clean = String(line || "").trim();
  if (!clean) return;
  let event;
  try {
    event = JSON.parse(clean);
  } catch {
    appendTail(task.events, { type: "output", text: clean.slice(0, 2000) }, 120);
    task.lastAction = clean.slice(0, 300);
    return;
  }

  const type = String(event.type || "event");
  if (type === "thread.started" && event.thread_id) task.threadId = String(event.thread_id);
  if (type === "item.started") task.lastAction = summarizeItem(event.item, "Started");
  if (type === "item.completed") {
    task.lastAction = summarizeItem(event.item, "Completed");
    if (event.item?.type === "agent_message" && event.item.text) task.finalMessage = String(event.item.text);
  }
  if (type === "turn.failed" || type === "error") {
    task.lastAction = String(event.error?.message || event.message || "Codex reported an error.");
  }
  if (type === "turn.completed" && !task.finalMessage) task.lastAction = "Codex completed the turn.";
  appendTail(task.events, summarizeEvent(event), 120);
  if (type === "item.started" || type === "item.completed" || type === "turn.failed") onProgress();
}

function summarizeItem(item, prefix) {
  const source = item && typeof item === "object" ? item : {};
  if (source.type === "command_execution") return `${prefix} command: ${String(source.command || "").slice(0, 220)}`;
  if (source.type === "agent_message") return `${prefix} response.`;
  if (source.type === "file_change") return `${prefix} file change.`;
  return `${prefix} ${source.type || "work item"}.`;
}

function summarizeEvent(event) {
  const summary = { type: String(event.type || "event") };
  if (event.thread_id) summary.threadId = String(event.thread_id);
  if (event.item?.type) summary.itemType = String(event.item.type);
  if (event.item?.command) summary.command = String(event.item.command).slice(0, 500);
  if (event.item?.text) summary.text = String(event.item.text).slice(0, 2000);
  if (event.error?.message || event.message) summary.error = String(event.error?.message || event.message).slice(0, 1000);
  return summary;
}

function appendTail(array, value, limit) {
  if (!value) return;
  array.push(value);
  if (array.length > limit) array.splice(0, array.length - limit);
}

function publicTask(task) {
  return {
    id: task.id,
    target: task.target,
    project: task.repo.name,
    path: task.repo.path,
    access: task.access,
    status: task.status,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    threadId: task.threadId,
    resumedFrom: task.resumedFrom,
    finalMessage: task.finalMessage,
    lastAction: task.lastAction,
    exitCode: task.exitCode,
    attempts: task.attempts,
  };
}

function taskArtifact(task) {
  return task.review ? remoteCodexReviewArtifact(task) : remoteCodexTaskArtifact(task);
}

function remoteCodexReviewArtifact(task) {
  const review = task.review || {};
  const report = extractReportSections(task.finalMessage);
  return {
    title: `Review: ${task.repo.name}`,
    kind: "codexReview",
    content: JSON.stringify({
      project: task.repo.name,
      target: task.target,
      status: task.status,
      requested: task.requestedPrompt || "",
      branch: review.branch || "",
      head: review.head || "",
      tracking: review.tracking || "",
      filesChanged: review.filesChanged ?? null,
      insertions: review.insertions ?? 0,
      deletions: review.deletions ?? 0,
      statText: review.statText || "",
      statusLines: review.statusLines || [],
      commits: review.commits || [],
      diff: review.diff || "",
      reviewError: review.error || "",
      outcome: report.outcome || conciseResult(task.finalMessage),
      changedFiles: report.changedFiles,
      verification: report.verification,
      gitActions: report.gitActions,
      remainingIssues: report.remainingIssues,
    }),
  };
}

function remoteCodexTaskArtifact(task) {
  const final = task.finalMessage ? `\n## Result\n\n${task.finalMessage}` : "";
  const errors =
    (task.status === "failed" || task.status === "timed_out") && task.stderr.length
      ? `\n## Remote output\n\n\`\`\`\n${task.stderr.slice(-12).join("\n")}\n\`\`\``
      : "";
  return {
    title: `Codex: ${task.repo.name}`,
    kind: "markdown",
    content: [
      `# Codex: ${task.repo.name}`,
      "",
      `- Status: ${task.status}`,
      `- Target: \`${task.target}\``,
      `- Access: ${task.access}`,
      `- Connection attempts: ${task.attempts || 1}`,
      task.threadId ? `- Thread: \`${task.threadId}\`` : "",
      "",
      task.lastAction || "Waiting for progress.",
      final,
      errors,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function projectKey(value) {
  return String(value || "").trim().toLowerCase();
}

function taskNotFoundMessage(args = {}) {
  const requested = String(args.taskId || args.project || "").trim();
  return requested ? `Remote Codex task not found: ${requested}` : "There is no Remote Codex task yet.";
}

function isRecoverableRemoteFailure(code, message) {
  if (Number(code) === 255 && !/permission denied|host key verification failed/i.test(String(message || ""))) return true;
  return /connection (?:closed|reset|refused|timed out)|broken pipe|could not resolve hostname|network is unreachable|no route to host|tailscale/i.test(
    String(message || ""),
  );
}

function needsUserInput(message) {
  return /VECTOR_NEEDS_INPUT\s*:/i.test(String(message || ""));
}

function extractInputRequest(message) {
  const match = String(message || "").match(/VECTOR_NEEDS_INPUT\s*:\s*(.+)/i);
  return match?.[1]?.trim() || "Codex needs input before it can continue.";
}

function remoteCodexLifecycleEvent(task, kind) {
  const publicState = publicTask(task);
  const resultSummary = conciseResult(task.finalMessage);
  let announcement = "";
  if (kind === "completed") {
    announcement = `Codex finished ${task.repo.name}.${resultSummary ? ` ${resultSummary}` : ""}`;
  } else if (kind === "progress") {
    announcement = `Codex is still working on ${task.repo.name}. ${task.lastAction || "Work is continuing."}`;
  } else if (kind === "retrying") {
    announcement = `The connection to lizardbox dropped while Codex was working on ${task.repo.name}. Retrying once automatically.`;
  } else if (kind === "attention") {
    announcement = `Codex needs your input on ${task.repo.name}. ${extractInputRequest(task.finalMessage)}`;
  } else if (kind === "failed") {
    announcement = `Codex failed on ${task.repo.name}. ${task.lastAction || "Open the task result for details."}`;
  } else if (kind === "timed_out") {
    announcement = `Codex timed out on ${task.repo.name}.`;
  } else if (kind === "cancelled") {
    announcement = `The Codex task for ${task.repo.name} was cancelled.`;
  } else if (kind === "review") {
    const review = task.review || {};
    if (!review.error && (review.filesChanged || review.statusLines?.length)) {
      announcement = `Review ready for ${task.repo.name}: ${review.filesChanged} file${review.filesChanged === 1 ? "" : "s"} changed, ${review.insertions} added, ${review.deletions} removed. Say commit it, push it, or make a PR.`;
    }
  }
  return {
    kind,
    at: new Date().toISOString(),
    task: publicState,
    artifact: taskArtifact(task),
    announcement,
  };
}

function conciseResult(message) {
  const text = String(message || "")
    .replace(/VECTOR_NEEDS_INPUT\s*:.*/gis, "")
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}

function remoteCodexErrorArtifact(error, config = {}, repo = null) {
  return {
    ok: false,
    error,
    artifact: {
      title: "Remote Codex Setup",
      kind: "markdown",
      content: [
        "# Remote Codex setup required",
        "",
        error,
        config.target ? `\nTarget: \`${config.target}\`` : "",
        repo?.path ? `\nRepository: \`${repo.path}\`` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
  };
}

function remoteErrorMessage(error) {
  const stderr = String(error?.stderr || "").trim();
  if (stderr) return stderr.split(/\r?\n/).slice(-4).join("\n");
  return error instanceof Error ? error.message : String(error);
}

function parseKeyValueLines(output) {
  const result = {};
  for (const line of String(output || "").split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return result;
}

function publicRemoteConfig(config) {
  return {
    enabled: Boolean(config.target && config.repos.length),
    target: config.target,
    defaultProject: config.defaultProject,
    repos: config.repos,
    timeoutMs: config.timeoutMs,
  };
}

module.exports = {
  buildOperatorPrompt,
  buildRemoteCodexCommand,
  buildRemoteProbeCommand,
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
};
