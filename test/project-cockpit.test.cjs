const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const {
  coerceRequestedPath,
  isAllowedProjectPath,
  mergeProjectRegistry,
  projectCockpitCheck,
  resolveProjectRepo,
} = require("../electron/project-cockpit.cjs");

test("mergeProjectRegistry keeps defaults and lets saved repos override by name", () => {
  const defaults = [{ name: "RileyJarvis", aliases: ["ricky"], path: "/default/rileyjarvis" }];
  const merged = mergeProjectRegistry([{ name: "RileyJarvis", aliases: ["local"], path: "/local/rileyjarvis" }], defaults);

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], {
    name: "RileyJarvis",
    aliases: ["local"],
    path: path.resolve("/local/rileyjarvis"),
  });
});

test("resolveProjectRepo matches saved project aliases", () => {
  const repos = [{ name: "Paw Paperwork", aliases: ["paw", "pawpaperwork"], path: "/tmp/pawpaperwork" }];
  const resolved = resolveProjectRepo(repos, { project: "paw" }, { defaultRepos: [] });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.repo.name, "Paw Paperwork");
});

test("resolveProjectRepo requires absolute paths under allowed roots", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ricky-root-"));
  const inside = path.join(root, "repo with spaces");
  const siblingPrefix = `${root}-sibling`;
  await fsp.mkdir(inside, { recursive: true });

  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(siblingPrefix, { recursive: true, force: true });
  });

  assert.equal(isAllowedProjectPath(inside, [root]), true);
  assert.equal(isAllowedProjectPath(path.join(siblingPrefix, "repo"), [root]), false);

  const fileUrl = pathToFileURL(inside).href;
  assert.equal(coerceRequestedPath(fileUrl), inside);

  const relative = resolveProjectRepo([], { path: "relative/repo" }, { allowedRoots: [root], defaultRepos: [] });
  assert.equal(relative.ok, false);
  assert.match(relative.error, /must be absolute/);

  const outside = resolveProjectRepo([], { path: path.join(siblingPrefix, "repo") }, { allowedRoots: [root], defaultRepos: [] });
  assert.equal(outside.ok, false);
  assert.match(outside.error, /outside allowed project roots/);
});

test("projectCockpitCheck inspects a clean Git repo and returns a cockpit artifact", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ricky-cockpit-"));
  const repo = path.join(root, "sample-repo");
  await fsp.mkdir(repo, { recursive: true });
  await fsp.writeFile(path.join(repo, "README.md"), "# Sample Repo\n\nOperational notes.\n");
  await fsp.writeFile(
    path.join(repo, "package.json"),
    JSON.stringify(
      {
        scripts: {
          build: "echo build",
          typecheck: "echo typecheck",
        },
      },
      null,
      2,
    ),
  );
  await fsp.writeFile(path.join(repo, ".env.local"), "OPENAI_API_KEY=test\n");
  await fsp.mkdir(path.join(repo, "node_modules"));

  execGit(repo, ["init", "-b", "main"]);
  execGit(repo, ["config", "user.email", "ricky@example.com"]);
  execGit(repo, ["config", "user.name", "Ricky Tests"]);
  execGit(repo, ["add", "."]);
  execGit(repo, ["commit", "-m", "init"]);

  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const result = await projectCockpitCheck(
    { path: repo },
    {
      allowedRoots: [root],
      defaultRepos: [],
      repos: [],
      skipLiveRemote: true,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.state, "OK");
  assert.equal(result.artifact.kind, "projectCockpit");

  const report = JSON.parse(result.artifact.content);
  assert.equal(report.git.branch, "main");
  assert.equal(report.git.dirtyCount, 0);
  assert.deepEqual(report.package.verificationCommands, ["npm run typecheck", "npm run build"]);
  assert.match(report.sections.docsVision.join("\n"), /README.md: Sample Repo/);
});

test("projectCockpitCheck reports setup blockers without failing tool execution", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ricky-cockpit-blocked-"));
  const repo = path.join(root, "blocked-repo");
  await fsp.mkdir(repo, { recursive: true });
  await fsp.writeFile(path.join(repo, "README.md"), "# Blocked Repo\n");
  await fsp.writeFile(path.join(repo, ".env.example"), "OPENAI_API_KEY=\n");
  await fsp.writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { build: "echo build" } }, null, 2));

  execGit(repo, ["init", "-b", "main"]);
  execGit(repo, ["config", "user.email", "ricky@example.com"]);
  execGit(repo, ["config", "user.name", "Ricky Tests"]);
  execGit(repo, ["add", "."]);
  execGit(repo, ["commit", "-m", "init"]);

  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const result = await projectCockpitCheck(
    { path: repo },
    {
      allowedRoots: [root],
      defaultRepos: [],
      repos: [],
      skipLiveRemote: true,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.state, "BLOCKED");
  assert.match(result.report.sections.blockers.join("\n"), /node_modules is missing/);
  assert.match(result.report.sections.blockers.join("\n"), /no .env.local or .env file/);
});

function execGit(cwd, args) {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
  });
}
