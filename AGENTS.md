# AGENTS.md

Anton v2 is a Flue 2.0 coding agent with a React UI. Each task runs on its own branch in its own sandbox.

## Layout

- `src/core/ports.ts` — the interfaces every provider implements (sandbox, object store, git host, model catalog).
- `src/providers/` — Modal, local, S3, disk, GitHub and OpenRouter implementations; `index.ts` picks them from config.
- `src/flue/` — adapters into Flue: the machine sandbox driver, and `live-models.ts`, which lets any model in the live catalog resolve.
- `src/services/` — task lifecycle: sessions, workspace (acquire and set up a machine), git, checkpoints, files (live, saved or base views), pull requests, terminal, previews, and the browser behind the screenshot tool.
- `src/db/` — libSQL client, versioned migrations, queries.
- `src/agents/coder.ts` — Coder agent, explorer/tester subagents, `open_pull_request`.
- `src/app.ts` — Hono routes. `src/server.ts` — production server (API, UI, terminal WebSocket).
- `src/web/` — TanStack Router UI.

## Rules

- Viewing a task (files, changes, library) never starts a sandbox; only a prompt, the terminal, Resume or restoring a checkpoint does.
- Git credentials stay in Anton: pass `git.gitAuthEnv()` only to commands Anton runs, never to the agent's shell.
- New outside services go behind a port in `src/core/ports.ts`, not called directly from services.

## Commands

- `npm test`
- `npm run check:types`
- `npm run dev` — UI on :43127, API on :43128
- `npm run build && npm start` — production on `PORT`
- `npx flue run src/agents/coder.ts --message "Say ready."` (needs an LLM key)
- `npx flue docs search <query>`
