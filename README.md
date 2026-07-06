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
git clone https://github.com/rbrown101010/rileyjarvis.git
cd rileyjarvis
npm install
cp .env.example .env.local
npm run dev
```

On Windows PowerShell:

```powershell
git clone https://github.com/rbrown101010/rileyjarvis.git
cd rileyjarvis
npm install
Copy-Item .env.example .env.local
npm run dev
```

Edit `.env.local` before starting voice features:

```bash
OPENAI_API_KEY=your_openai_api_key_here
EXA_API_KEY=your_exa_api_key_here
```

`OPENAI_API_KEY` is required. `EXA_API_KEY` is optional; web search will show a setup message when it is missing.

## Platform Notes

Vector runs locally. Depending on the features you use, macOS may ask for:

- Microphone permission for voice conversation.
- Accessibility permission for computer-control tools.
- Screen Recording permission for screenshots and screen inspection.

Computer-control tools are blocked until the app is in computer-use mode. Computer-control tools are currently exposed only on macOS; on Windows, voice, artifacts, Project Cockpit, notes, records, web search, image generation, and thumbnails remain available.

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
