const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

const execFileAsync = promisify(execFile);

const userHome = os.homedir();
const defaultProjectRoots = [
  path.resolve(process.cwd(), ".."),
  path.join(userHome, "Documents", "GitHub"),
  path.join(userHome, "source", "repos"),
  path.join(userHome, "code"),
  path.join(userHome, "Documents", "Screenshot app"),
  path.join(userHome, "Documents", "Test app"),
];
const defaultProjectRegistry = [
  { name: "RileyJarvis", aliases: ["riley", "ricky", "this repo"], path: path.resolve(process.cwd()) },
  { name: "FamilyPlate", aliases: ["family plate"], path: path.join(userHome, "Documents", "GitHub", "familyplate") },
  { name: "Paw Paperwork", aliases: ["paw", "pawpaperwork"], path: path.join(userHome, "Documents", "GitHub", "pawpaperwork") },
  { name: "Screenwell", aliases: ["screenshot app", "mobile screenwell"], path: path.join(userHome, "Documents", "Screenshot app", "mobile-screenwell") },
  { name: "TourForge", aliases: ["tour forge"], path: path.join(userHome, "Documents", "GitHub", "tourforge") },
  { name: "FactoryIQ", aliases: ["factory iq"], path: path.join(userHome, "Documents", "GitHub", "factoryiq") },
  { name: "ClarityDashboard", aliases: ["clarity", "clarity dashboard"], path: path.join(userHome, "Documents", "GitHub", "claritydashboard") },
  { name: "FW Gatekeeper", aliases: ["gatekeeper", "fw gatekeeper"], path: path.join(userHome, "Documents", "GitHub", "fw-gatekeeper") },
  { name: "Overlot", aliases: [], path: path.join(userHome, "Documents", "GitHub", "overlot") },
];

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function mergeProjectRegistry(savedRepos, defaults = defaultProjectRegistry) {
  const byName = new Map();
  for (const repo of defaults) {
    const normalized = normalizeProjectRepo(repo);
    if (normalized.name && normalized.path) byName.set(normalized.name.toLowerCase(), normalized);
  }
  for (const repo of Array.isArray(savedRepos) ? savedRepos : []) {
    const normalized = normalizeProjectRepo(repo);
    if (!normalized.name || !normalized.path) continue;
    byName.set(normalized.name.toLowerCase(), normalized);
  }
  return Array.from(byName.values());
}

function normalizeProjectRepo(repo) {
  const source = asObject(repo);
  return {
    name: String(source.name || "").trim(),
    aliases: Array.isArray(source.aliases) ? source.aliases.map(String).filter(Boolean) : [],
    path: source.path ? path.resolve(String(source.path)) : "",
  };
}

async function projectCockpitCheck(args, options = {}) {
  const repos = options.repos || defaultProjectRegistry;
  const resolved = resolveProjectRepo(repos, args, options);
  if (!resolved.ok) {
    const report = {
      state: "BLOCKED",
      project: String(args?.project || args?.path || "Project"),
      path: resolved.path || "",
      generatedAt: new Date().toISOString(),
      sections: {
        state: ["Project Cockpit could not resolve a local repository."],
        dirtyWorktree: [],
        remoteDrift: [],
        docsVision: [],
        verification: [],
        blockers: [resolved.error],
        nextAction: ["Use a saved repo name or an absolute path under an allowed project root."],
      },
      repos: mergeProjectRegistry(repos).map(publicProjectRepo),
    };
    return { ok: false, error: resolved.error, artifact: projectCockpitArtifact(report) };
  }

  const report = await inspectProjectRepo(resolved.repo, options);
  return {
    ok: true,
    project: report.project,
    path: report.path,
    state: report.state,
    report,
    artifact: projectCockpitArtifact(report),
  };
}

function resolveProjectRepo(repos, args = {}, options = {}) {
  const requestedPath = String(args.path || "").trim();
  if (requestedPath) {
    const coercedPath = coerceRequestedPath(requestedPath);
    if (!coercedPath || !path.isAbsolute(coercedPath)) {
      return {
        ok: false,
        path: coercedPath || requestedPath,
        error: `Project path must be absolute: ${requestedPath}`,
      };
    }

    const resolvedPath = path.resolve(coercedPath);
    if (!isAllowedProjectPath(resolvedPath, options.allowedRoots || defaultProjectRoots)) {
      return {
        ok: false,
        path: resolvedPath,
        error: `Path is outside allowed project roots: ${resolvedPath}`,
      };
    }
    return {
      ok: true,
      repo: {
        name: path.basename(resolvedPath),
        aliases: [],
        path: resolvedPath,
      },
    };
  }

  const query = String(args.project || "").trim().toLowerCase();
  const normalizedRepos = mergeProjectRegistry(repos, options.defaultRepos || defaultProjectRegistry);
  if (!query) {
    const cwd = path.resolve(options.cwd || process.cwd());
    const current = normalizedRepos.find((repo) => path.resolve(repo.path) === cwd) || normalizedRepos[0];
    return { ok: true, repo: current };
  }

  const match = normalizedRepos.find((repo) => {
    const names = [repo.name, ...repo.aliases].map((value) => value.toLowerCase());
    return names.some((name) => name === query || name.includes(query) || query.includes(name));
  });

  if (!match) {
    return {
      ok: false,
      error: `No saved repository matches "${args.project}".`,
    };
  }

  return { ok: true, repo: match };
}

function coerceRequestedPath(value) {
  if (/^file:\/\//i.test(value)) {
    try {
      return fileURLToPath(value);
    } catch {
      return "";
    }
  }
  return value;
}

function isAllowedProjectPath(candidatePath, roots = defaultProjectRoots) {
  const resolvedCandidate = path.resolve(candidatePath);
  return uniqueProjectRoots(roots).some((root) => {
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

function uniqueProjectRoots(roots = defaultProjectRoots) {
  return Array.from(new Set(roots.map((root) => path.resolve(root))));
}

async function inspectProjectRepo(repo, options = {}) {
  const projectPath = path.resolve(repo.path);
  const report = {
    state: "OK",
    project: repo.name || path.basename(projectPath),
    path: projectPath,
    generatedAt: new Date().toISOString(),
    sections: {
      state: [],
      dirtyWorktree: [],
      remoteDrift: [],
      docsVision: [],
      verification: [],
      blockers: [],
      nextAction: [],
    },
    git: {},
    package: {},
    docs: [],
  };

  const exists = await pathExists(projectPath);
  if (!exists) {
    report.state = "BLOCKED";
    report.sections.state.push("Repository path does not exist.");
    report.sections.blockers.push(`Missing path: ${projectPath}`);
    report.sections.nextAction.push("Fix the saved repo path or pass the correct local path.");
    return report;
  }

  const gitRoot = await gitOutput(projectPath, ["rev-parse", "--show-toplevel"]);
  if (!gitRoot.ok) {
    report.state = "BLOCKED";
    report.sections.state.push("Path exists but is not a Git repository.");
    report.sections.blockers.push("Git root could not be resolved.");
    report.sections.nextAction.push("Open Project Cockpit on a checked-out repo root.");
    return report;
  }

  report.path = gitRoot.stdout.trim() || projectPath;
  report.git.root = report.path;

  const [branch, head, status, upstream, localDrift, remoteUrl] = await Promise.all([
    gitOutput(report.path, ["branch", "--show-current"]),
    gitOutput(report.path, ["rev-parse", "--short", "HEAD"]),
    gitOutput(report.path, ["status", "--short", "--branch"]),
    gitOutput(report.path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
    gitOutput(report.path, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]),
    gitOutput(report.path, ["config", "--get", "remote.origin.url"]),
  ]);

  report.git.branch = branch.ok && branch.stdout.trim() ? branch.stdout.trim() : "detached";
  report.git.head = head.ok ? head.stdout.trim() : "unknown";
  report.git.upstream = upstream.ok ? upstream.stdout.trim() : "";
  report.git.remote = remoteUrl.ok ? remoteUrl.stdout.trim() : "";

  const statusLines = status.ok ? status.stdout.trim().split("\n").filter(Boolean) : [];
  const shortLines = statusLines.filter((line) => !line.startsWith("##"));
  report.git.dirtyCount = shortLines.length;
  report.sections.state.push(`${report.git.branch} @ ${report.git.head}`);
  report.sections.state.push(report.git.upstream ? `Upstream: ${report.git.upstream}` : "No upstream configured.");

  if (shortLines.length === 0) {
    report.sections.dirtyWorktree.push("Clean worktree.");
  } else {
    report.sections.dirtyWorktree.push(`${shortLines.length} changed file${shortLines.length === 1 ? "" : "s"} detected.`);
    report.sections.dirtyWorktree.push(...shortLines.slice(0, 12));
  }

  if (localDrift.ok && localDrift.stdout.trim()) {
    const [ahead, behind] = localDrift.stdout.trim().split(/\s+/).map((value) => Number(value));
    report.git.ahead = Number.isFinite(ahead) ? ahead : 0;
    report.git.behind = Number.isFinite(behind) ? behind : 0;
    report.sections.remoteDrift.push(`Local refs: ahead ${report.git.ahead}, behind ${report.git.behind}.`);
  } else {
    report.sections.remoteDrift.push("Local ahead/behind unavailable. Configure an upstream to classify drift.");
  }

  const liveRemote = await liveRemoteHead(report, options);
  if (liveRemote.ok) {
    report.git.liveRemoteHead = liveRemote.sha;
    report.sections.remoteDrift.push(`Live remote ${liveRemote.ref}: ${liveRemote.sha.slice(0, 12)}.`);
    if (liveRemote.sha.startsWith(report.git.head) || report.git.head.startsWith(liveRemote.sha.slice(0, report.git.head.length))) {
      report.sections.remoteDrift.push("Current HEAD matches the live remote branch.");
    } else {
      report.sections.remoteDrift.push("Current HEAD differs from the live remote branch; fetch or inspect before release work.");
    }
  } else if (liveRemote.message) {
    report.sections.remoteDrift.push(liveRemote.message);
  }

  const docs = await inspectDocs(report.path);
  report.docs = docs;
  if (docs.length === 0) {
    report.sections.docsVision.push("No README or vision docs found at the repo root.");
  } else {
    for (const doc of docs) {
      report.sections.docsVision.push(`${doc.file}: ${doc.summary}`);
    }
  }

  const packageInfo = await inspectPackage(report.path);
  report.package = packageInfo;
  report.sections.verification.push(...packageInfo.verificationLines);
  report.sections.blockers.push(...packageInfo.blockers);

  const envLines = await inspectEnvHints(report.path);
  if (envLines.length > 0) report.sections.blockers.push(...envLines);

  report.sections.nextAction.push(nextProjectAction(report));
  report.state = projectState(report);
  return report;
}

async function liveRemoteHead(report, options = {}) {
  if (options.skipLiveRemote === true) {
    return { ok: false, message: "Live remote check skipped." };
  }
  if (!report.git.remote || !report.git.upstream || !report.git.upstream.includes("/")) {
    return { ok: false, message: "Live remote check skipped because remote/upstream is unavailable." };
  }
  const [remoteName, ...branchParts] = report.git.upstream.split("/");
  const branchName = branchParts.join("/");
  if (!remoteName || !branchName) {
    return { ok: false, message: "Live remote check skipped because upstream could not be parsed." };
  }
  const result = await gitOutput(report.path, ["ls-remote", "--heads", remoteName, branchName], 10000);
  if (!result.ok || !result.stdout.trim()) {
    return { ok: false, message: "Live remote check failed or returned no branch data." };
  }
  const [sha, ref] = result.stdout.trim().split(/\s+/);
  return { ok: Boolean(sha), sha, ref: ref || `${remoteName}/${branchName}` };
}

async function inspectDocs(repoPath) {
  const candidates = ["vision.md", "README.md", "README.MD", "APP_STORE_SUBMISSION.md", "docs/ui-redesign-plan.md"];
  const docs = [];
  for (const file of candidates) {
    const filePath = path.join(repoPath, file);
    if (!(await pathExists(filePath))) continue;
    const raw = await readTextFile(filePath, 7000);
    const summary = summarizeDoc(raw);
    docs.push({ file, summary: summary || "present" });
  }
  return docs;
}

function summarizeDoc(raw) {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter((line) => line && !line.startsWith("```"));
  return lines.slice(0, 2).join(" / ").slice(0, 220);
}

async function inspectPackage(repoPath) {
  const packagePath = path.join(repoPath, "package.json");
  const info = {
    manager: "npm",
    scripts: [],
    verificationCommands: [],
    verificationLines: [],
    blockers: [],
  };
  if (!(await pathExists(packagePath))) {
    info.verificationLines.push("No root package.json found; use repo-specific verification docs.");
    return info;
  }

  try {
    const pkg = JSON.parse(await fs.readFile(packagePath, "utf8"));
    const scripts = asObject(pkg.scripts);
    info.scripts = Object.keys(scripts).sort();
    info.manager = await detectPackageManager(repoPath);
    info.verificationCommands = verificationCommands(info.manager, info.scripts);
    info.verificationLines.push(`Package manager: ${info.manager}.`);
    info.verificationLines.push(
      info.verificationCommands.length > 0
        ? `Suggested checks: ${info.verificationCommands.join(" -> ")}.`
        : "No obvious typecheck/build/test/smoke scripts found.",
    );
    if (info.scripts.length > 0) {
      info.verificationLines.push(`Available scripts: ${info.scripts.slice(0, 16).join(", ")}${info.scripts.length > 16 ? ", ..." : ""}.`);
    }
    if (!(await pathExists(path.join(repoPath, "node_modules")))) {
      info.blockers.push(`${installCommand(info.manager)} has not been run in this checkout; node_modules is missing.`);
    }
  } catch (error) {
    info.blockers.push(`package.json could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return info;
}

async function detectPackageManager(repoPath) {
  if (await pathExists(path.join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  if (await pathExists(path.join(repoPath, "yarn.lock"))) return "yarn";
  return "npm";
}

function verificationCommands(manager, scripts) {
  const priority = [
    "smoke:verify-docs-contract",
    "smoke:production-api:strict",
    "typecheck",
    "lint",
    "build",
    "test",
    "verify:mvp",
    "mobile:proof-ready",
    "native:ios:verify",
  ];
  const selected = [];
  for (const script of priority) {
    if (scripts.includes(script)) selected.push(runScriptCommand(manager, script));
  }
  for (const script of scripts) {
    if (selected.length >= 6) break;
    const command = runScriptCommand(manager, script);
    if (/^(smoke|verify|doctor|test):/.test(script) && !selected.includes(command)) {
      selected.push(command);
    }
  }
  return selected;
}

function runScriptCommand(manager, script) {
  if (manager === "pnpm") return `pnpm ${script}`;
  if (manager === "yarn") return `yarn ${script}`;
  return `npm run ${script}`;
}

function installCommand(manager) {
  if (manager === "pnpm") return "pnpm install";
  if (manager === "yarn") return "yarn install";
  return "npm ci";
}

async function inspectEnvHints(repoPath) {
  const entries = await fs.readdir(repoPath).catch(() => []);
  const examples = entries.filter((entry) => /^\.env(\..*)?\.example$|^\.env\.example$/.test(entry));
  if (examples.length === 0) return [];
  const localEnvExists = (await pathExists(path.join(repoPath, ".env.local"))) || (await pathExists(path.join(repoPath, ".env")));
  return localEnvExists ? [] : [`Env templates exist (${examples.join(", ")}) but no .env.local or .env file was found.`];
}

function nextProjectAction(report) {
  if (report.sections.blockers.length > 0) return "Resolve setup blockers first, then run the suggested checks.";
  if ((report.git.behind || 0) > 0) return "Sync with upstream before editing or releasing.";
  if ((report.git.dirtyCount || 0) > 0) return "Review dirty files and preserve unrelated changes before making edits.";
  const command = report.package?.verificationCommands?.[0];
  if (command) return `Run ${command} as the first verification gate.`;
  return "Read the repo docs and choose one narrow shippable slice.";
}

function projectState(report) {
  if (report.sections.blockers.length > 0) return "BLOCKED";
  if ((report.git.dirtyCount || 0) > 0 || (report.git.behind || 0) > 0) return "WARN";
  if (report.sections.remoteDrift.some((line) => line.includes("differs"))) return "WARN";
  return "OK";
}

function projectCockpitArtifact(report) {
  return {
    title: `Project Cockpit: ${report.project}`,
    kind: "projectCockpit",
    content: JSON.stringify(report),
  };
}

function projectRegistryArtifact(repos) {
  const rows = mergeProjectRegistry(repos).map(publicProjectRepo);
  return {
    title: "Project Cockpit Repos",
    kind: "table",
    content: JSON.stringify(rows, null, 2),
  };
}

function publicProjectRepo(repo) {
  return {
    name: repo.name,
    aliases: repo.aliases,
    path: repo.path,
  };
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readTextFile(filePath, maxCharacters) {
  const raw = await fs.readFile(filePath, "utf8");
  return raw.slice(0, maxCharacters);
}

async function gitOutput(cwd, args, timeout = 7000) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: error?.stdout || "",
      stderr: error?.stderr || "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

module.exports = {
  coerceRequestedPath,
  defaultProjectRegistry,
  defaultProjectRoots,
  inspectProjectRepo,
  isAllowedProjectPath,
  mergeProjectRegistry,
  projectCockpitCheck,
  projectRegistryArtifact,
  resolveProjectRepo,
  uniqueProjectRoots,
};
