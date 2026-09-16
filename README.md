# Anton v2

Anton v2 is a Cursor-style coding agent in the browser. Chat in the center. The right panel is a live VM: **Git**, **Terminal**, and **Files** come from a sandbox workspace, not from object storage.

This first slice runs **locally**: a git workspace on disk, Flue 2.0 as the agent harness, Turso/libSQL file DB for sessions. Fill in the env placeholders to unlock OpenRouter, GitHub OAuth, Modal snapshots, and Tigris artifacts.

## Requirements

- Node.js `>=22.19` (this repo pins `.nvmrc` to 22.22.2)

```sh
nvm use
npm install
cp .env.example .env
```

## Run

```sh
npm run dev
```

UI: http://127.0.0.1:43127  
Agent API: http://127.0.0.1:43128

- **New Chat** creates a session and a local git workspace under `data/workspaces/`.
- Git / Files / Terminal work without an LLM key.
- Set `OPENROUTER_API_KEY` to talk to the Coder agent (`openrouter/anthropic/claude-sonnet-4` by default).

```sh
npm test
```

## Environment

See `.env.example`. Leave GitHub / Modal / Tigris empty for local mode.

| Variable | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | Model gateway |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | OAuth (later; empty = local project) |
| `TURSO_DATABASE_URL` | Session records (default `file:./data/anton.db`) |
| `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` | Snapshot VMs (empty = local directory sandbox) |
| `TIGRIS_*` | Logs / memory / artifacts only |

## Architecture

Same machine-channel split as Cursor cloud agents and Devin:

| Surface | Source of truth | Transport |
| --- | --- | --- |
| Chat | Flue conversation | HTTP/SSE to the control plane |
| Git | `git` in the sandbox cwd | REST `/api/vm/:id/git` |
| Files | sandbox disk | REST `/api/vm/:id/fs` and `/file` |
| Terminal | PTY in the sandbox | WebSocket `/vm/:id/pty` on the UI origin |

Object storage is not in this path. Tigris is logs/artifacts only. Spec: `docs/superpowers/specs/2026-09-15-coding-workspace-design.md`.
