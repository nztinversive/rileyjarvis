# Remote Codex Operator Skill

Use this skill whenever Noah refers to Codex, a coding task, lizardbox, the Linux box, a saved project, or an earlier remote coding job.

## Start work immediately

Treat these as action requests:

- "Codex <project>: <task>"
- "Use Codex on <project>..."
- "Have Codex..."
- "Send this to Codex..."
- "Do this on lizardbox..."
- "Work on <project> on the Linux box..."
- "Fix <project>..."
- "Have the box handle the failing tests."

Call `remote_codex_start` immediately when the project and outcome are clear.

- Default project: `RileyJarvis`.
- Default access: `full-access`. Remote Codex on lizardbox is intentionally unrestricted.
- Use `read-only` or `workspace-write` only when Noah explicitly asks for restricted access.
- Preserve boundaries such as "don't commit", "don't push", or "read only".
- Do not ask for confirmation merely to start.
- After the tool returns, say only that Codex started, the project, and the short task id.

The Remote Codex backend automatically instructs Codex to inspect AGENTS.md, repository documentation, branch, dirty files, recent history, and project verification commands before editing. Do not bloat the user's prompt by repeating those details.

## Natural lifecycle follow-ups

Task ids are optional for status, resume, and cancel tools. When no id is spoken, omit it so the backend selects the active or most recent task. Include `project` only when Noah names one.

- "How's it going?", "Check Codex", "Is it done?", or "Show the result": call `remote_codex_task`.
- "What is Codex doing across my projects?": call `remote_codex_tasks`.
- "Continue that", "make the requested adjustment", or an answer to a relayed Codex question: call `remote_codex_resume`.
- "Stop it" or "cancel Codex": call `remote_codex_cancel`.

Vector receives automatic progress and terminal events. Completion, failure, timeout, cancellation, and questions needing Noah are shown in the UI and announced automatically. Do not repeatedly poll after starting a task.

## Git and delivery follow-ups

Explicit Git requests are authorized one-word verbs with dedicated tools. Call them immediately, without a task id unless Noah names one:

- "Commit that" or "commit it" -> call `remote_codex_commit` (pass `message` only when Noah dictates one).
- "Push it" -> call `remote_codex_push`.
- "Open a PR" or "make a PR" -> call `remote_codex_pr` (pass `title` only when Noah dictates one).
- "Commit it, push it, and open a PR" -> call `remote_codex_resume` with the whole sequence as one follow-up prompt.

After a completed task, Vector automatically fetches the diff and shows a review artifact with files changed, additions, deletions, and the verification report. When Noah asks what changed, summarize from that review briefly.

Do not invent commit, push, PR, publish, or deployment intent. Perform those actions only when Noah says them.

## Completion and questions

Codex is instructed to return Outcome, Changed files, Verification, Git actions, and Remaining issues. When asked about a completed task, summarize those fields briefly and show the full task artifact.

If an automatic event says Codex needs input:

1. Relay the exact concise question.
2. When Noah answers, call `remote_codex_resume` with the answer and no task id unless a project or id is needed to disambiguate.
3. Do not restart the work as a new task.

Transient SSH or Tailscale connection failures are retried once automatically. If the retry fails, state the connection error and suggest `remote_codex_status`.

## Voice examples

User: "Codex RileyJarvis: add a remote test doc, run checks, show the diff, don't commit."

Action: call `remote_codex_start` with project `RileyJarvis`, access `full-access`, and the requested outcome including the no-commit boundary.

User: "How's it going?"

Action: call `remote_codex_task` with no task id.

User: "Commit that and push it."

Action: call `remote_codex_resume` with no task id and a prompt to verify, create a focused commit, and push it.

User: "Yes, use Postgres."

Context: the latest automatic Remote Codex event asked which database to use.

Action: call `remote_codex_resume` with no task id and a prompt stating Noah chose Postgres.

Never substitute `project_cockpit_check` for a request to make changes. Project Cockpit is read-only; Remote Codex is the execution tool.
