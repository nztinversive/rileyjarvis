const remoteCodexToolSpecs = [
  {
    type: "function",
    name: "remote_codex_status",
    description: "Check the configured Tailscale Linux host, Codex CLI, and an allowlisted remote repository. Use for setup diagnostics, not for coding requests.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Configured remote repository name or alias." },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "remote_codex_start",
    description: "Immediately delegate a coding task to Codex CLI on the configured lizardbox Linux host. This is the required tool for voice requests such as 'Codex RileyJarvis: ...', 'Have Codex...', or 'Do this on the Linux box'.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Configured remote repository name or alias. Defaults to RileyJarvis." },
        prompt: { type: "string", description: "The complete coding outcome requested by the user, including stated commit or push boundaries." },
        access: { type: "string", enum: ["read-only", "workspace-write", "full-access"], default: "full-access", description: "Defaults to full-access on lizardbox. Use read-only or workspace-write only when the user explicitly asks for restricted access." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "remote_codex_task",
    description: "Show progress and results for a Remote Codex task. Omit taskId to use the active or most recent task, so phrases like 'how is it going?' work naturally.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Optional task id. Omit for the active or most recent task." },
        project: { type: "string", description: "Optional project name to select its active or most recent task." },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "remote_codex_tasks",
    description: "List background remote Codex tasks. Use when the user asks to check Codex but no task id is available in context.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "remote_codex_resume",
    description: "Continue the active or most recent completed Remote Codex thread. Use for follow-ups such as 'continue that', 'commit that', 'push it', or 'open a PR'.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Optional task id. Omit for the active or most recent task." },
        project: { type: "string", description: "Optional project name to select its most recent task." },
        prompt: { type: "string", description: "The complete follow-up instruction." },
        access: { type: "string", enum: ["read-only", "workspace-write", "full-access"], description: "Keeps the task's previous access when omitted." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "remote_codex_cancel",
    description: "Cancel the active or selected Remote Codex task.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Optional task id. Omit for the active or most recent task." },
        project: { type: "string", description: "Optional project name to select its active task." },
      },
      additionalProperties: false,
    },
  },
];

async function executeRemoteCodexTool(manager, name, args) {
  if (name === "remote_codex_status") return await manager.probe(args);
  if (name === "remote_codex_start") return manager.start(args);
  if (name === "remote_codex_task") return manager.status(args);
  if (name === "remote_codex_tasks") return manager.list();
  if (name === "remote_codex_resume") return manager.resume(args);
  if (name === "remote_codex_cancel") return manager.cancel(args);
  return null;
}

module.exports = {
  executeRemoteCodexTool,
  remoteCodexToolSpecs,
};
