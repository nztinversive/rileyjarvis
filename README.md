# Vector

Vector is a local Electron desktop AI companion with realtime voice, a visual artifact panel, image generation, web search, notes, and opt-in macOS computer control.

It is built with Electron, React, Vite, TypeScript, and the OpenAI Realtime API.

## Features

- Realtime speech-to-speech conversation with OpenAI Realtime.
- Animated companion face with listening, thinking, speaking, and working states.
- Artifact panel for markdown, menus, notes, Mermaid diagrams, generated images, Project Cockpit reports, records, and progress.
- Project Cockpit for read-only local repo status: branch, dirty files, remote drift, docs/vision hints, package scripts, verification suggestions, blockers, and next action.
- YouTube thumbnail board with persistent numbered generations and image edits.
- Optional Exa-powered web search.
- Local notes and records stored in the repo `data/` directory during development and the Electron user-data directory in packaged builds.
- Optional computer-use mode for opening apps, clicking, typing, scrolling, screenshots, and UI inspection on macOS.
- Windows packaging support for a portable desktop app.

## Requirements

- macOS or Windows 10/11
- Node.js 22.12+
- npm
- An OpenAI API key with Realtime and image generation access
- Optional: an Exa API key for web search

## Quick Start

```bash
git clone https://github.com/nztinversive/rileyjarvis.git
cd rileyjarvis
npm install
cp .env.example .env.local
npm run dev
```

Edit `.env.local` before starting voice features:

```bash
OPENAI_API_KEY=your_openai_api_key_here
EXA_API_KEY=your_exa_api_key_here
```

`OPENAI_API_KEY` is required. `EXA_API_KEY` is optional; web search will show a setup message when it is missing.

## Windows Setup

### 1. Install the prerequisites

Install these on the Windows computer:

- Windows 10 or 11, 64-bit.
- Node.js 22.12 or newer, including npm.
- Git for Windows.
- An OpenAI API key with Realtime and image generation access.

Open a new PowerShell window after installing Node.js and Git, then confirm they are available:

```powershell
node --version
npm --version
git --version
```

### 2. Download and configure Vector

Run these commands in PowerShell:

```powershell
git clone https://github.com/nztinversive/rileyjarvis.git
cd rileyjarvis
npm ci
Copy-Item .env.example .env.local
notepad .env.local
```

Replace the placeholder OpenAI key, then save and close Notepad:

```dotenv
OPENAI_API_KEY=your_openai_api_key_here
EXA_API_KEY=your_exa_api_key_here
```

The Exa key is optional and is only needed for web search. Keep `.env.local` private and never commit it.

### 3. Run Vector from source

From the `rileyjarvis` folder:

```powershell
npm run dev
```

Vite starts on `127.0.0.1:5173`, then the Vector desktop window opens. Allow microphone access when Windows prompts for it. If voice input is blocked later, enable microphone access under **Settings > Privacy & security > Microphone**.

### 4. Build the portable Windows app

To create a standalone portable executable:

```powershell
npm run dist:win
Copy-Item .env.local release\.env.local
```

The build output is:

```text
release\Vector-1.0.0-portable-x64.exe
```

Keep `.env.local` beside the portable `.exe`, then launch it from PowerShell or File Explorer. If you move the `.exe` to another folder or computer, move `.env.local` with it.

The app is currently unsigned. Windows SmartScreen may show a warning the first time it opens; choose **More info**, verify the app name is Vector, and choose **Run anyway** only if you built or received the file from a source you trust.

### Windows troubleshooting

- If PowerShell says `npm.ps1` cannot run because script execution is disabled, use `npm.cmd ci`, `npm.cmd run dev`, or `npm.cmd run dist:win` instead.
- If `node`, `npm`, or `git` is not recognized, close PowerShell, reopen it, and repeat the version checks above.
- If startup reports a missing OpenAI key, confirm the file is named exactly `.env.local` and is in the repo root for development or beside the portable `.exe` for packaged use.
- Computer-control tools are currently macOS-only. On Windows, voice, artifacts, Project Cockpit, notes, records, web search, image generation, and thumbnails remain available.

## Platform Notes

Vector runs locally. Depending on the features you use, macOS may ask for:

- Microphone permission for voice conversation.
- Accessibility permission for computer-control tools.
- Screen Recording permission for screenshots and screen inspection.

Computer-control tools are blocked until the app is in computer-use mode. Computer-control tools are currently exposed only on macOS; on Windows, voice, artifacts, Project Cockpit, notes, records, web search, image generation, and thumbnails remain available.

## Remote Codex over Tailscale

Vector can delegate coding work to Codex CLI on a Linux machine reachable through Tailscale and SSH. Configure the SSH target and one or more remote repositories in `.env.local`:

```dotenv
VECTOR_CODEX_SSH_TARGET=your-ssh-config-alias
VECTOR_CODEX_REPOS={"default":{"path":"/home/your-user/project","aliases":["linux","remote-box"]}}
VECTOR_CODEX_DEFAULT_REPO=default
VECTOR_CODEX_TIMEOUT_MS=1800000
```

The SSH target can be a `user@host` pair or an alias from `~/.ssh/config`. Repository names and aliases are the only project values Vector accepts; spoken prompts cannot supply arbitrary remote paths.

Remote Codex tools support:

- Checking the configured host, Codex CLI, repository, and branch.
- Starting background `codex exec --json` jobs with full access by default on lizardbox; read-only and workspace-write remain available when explicitly requested.
- Remembering the active or latest task so status, resume, and cancel commands do not require a task id.
- Streaming progress into Vector, issuing desktop and voice notifications on terminal states, and relaying questions that require user input.
- Retrying one recoverable SSH or Tailscale connection failure automatically.
- Cancelling jobs and resuming completed Codex threads for follow-ups such as commit, push, and pull-request creation.

Prompts are sent over SSH stdin rather than inserted into a remote shell command. Vector adds an operator preamble that tells Codex to inspect repository instructions, Git state, and project verification commands and to return a consistent completion report. The Linux account must already have Codex CLI installed and authenticated.

## Project Cockpit

Project Cockpit is a read-only local repo inspector. Ask Vector to check a saved project by name, for example:

```text
Check FamilyPlate.
Show the repo state for Paw.
Check this repo.
```

The report renders in the artifact panel with fixed sections:

- State
- Dirty Worktree
- Remote Drift
- Docs / Vision
- Verification
- Blockers
- Next Action

The default saved repo registry includes common local projects under `~/Documents/GitHub`, plus Screenwell under `~/Documents/Screenshot app/mobile-screenwell`. Project Cockpit does not install packages, commit, push, upload builds, or run release commands.

## Development

```bash
npm run dev
```

This starts Vite on `127.0.0.1:5173` and launches Electron.

Other useful commands:

```bash
npm run typecheck
npm test
npm run build
npm run pack
npm run dist:win
npm start
```

`npm run dist:win` creates an unsigned portable Windows executable under `release/`. Unsigned Windows builds may show SmartScreen warnings until code signing is added.

## Runtime Data

During development, the app creates a local `data/` directory for notes, records, generated images, and thumbnail-board state. In packaged builds, runtime data is stored under Electron's user-data directory. `.env.local` can be placed in the development repo, beside a portable packaged executable, or in the packaged app's user-data directory.

Do not commit:

- `.env.local`
- Anything under `data/`
- `dist/`
- `node_modules/`

## Security Notes

- API keys are loaded only from local environment files.
- `.env.local` and all `.env.*` files are ignored except `.env.example`.
- Generated images and local database files are ignored.
- Risky computer-control actions should require explicit confirmation.
- Typing and pressing Enter in computer-use mode are intentionally allowed without extra confirmation because they are core voice-control actions.
- Project Cockpit only reads repository metadata and allows explicit paths under configured local project roots.
- External artifact links open in the system browser; app window navigation is kept inside the local app.

Before publishing a fork, run:

```bash
npm run typecheck
npm test
npm run build
git status --short
```

Then verify that no local secrets or runtime data are staged.

## License

MIT
