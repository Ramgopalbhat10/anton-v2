# AGENTS.md

Anton v2 is a Flue 2.0 coding agent with a React UI. Each task runs on its own branch in its own sandbox.

## Layout

- `src/core/ports.ts` — the interfaces every provider implements (sandbox, object store, git host, model catalog).
- `src/providers/` — Modal, local, S3, disk, GitHub and OpenRouter implementations; `index.ts` picks them from config.
- `src/flue/` — adapters into Flue: the machine sandbox driver, and `live-models.ts`, which lets any model in the live catalog resolve.
- `src/services/` — task lifecycle: sessions, workspace (acquire and set up a machine), git, checkpoints, files (live, saved or base views), pull requests, terminal, previews, and the browser behind the screenshot tool. Headless work (`headless.ts`) polls every five minutes for automations (labeled issues, schedules) and pull request follow-ups; both reach the agent through `agent-runner.ts`, which also enforces the spending caps (`budget.ts`).
- `src/db/` — libSQL client, versioned migrations, queries.
- `src/core/plugins.ts` reads skills, plugins and marketplaces (Agent Skills, Claude Code, Devin, Codex, Cursor, Agent Plugins); `src/services/plugins.ts` installs them and gives each task its skills (the repo's own first, then installed plugins).
- `src/agents/coder.ts` — Coder agent: read-only repo tools until `start_workspace`, then the sandbox, explorer/tester subagents and `open_pull_request`.
- `src/app.ts` — Hono routes. `src/server.ts` — production server (API, UI, terminal WebSocket).
- `src/web/` — TanStack Router UI.

## Rules

- Viewing a task (files, changes, library) never starts a sandbox. A task starts read-only: the agent answers from a snapshot of the repo on Anton's side (`repo-snapshot.ts`) and starts its sandbox with `start_workspace` only when it must edit or run code. The terminal, Resume and restoring a checkpoint also start one; a task that has had a machine keeps using it.
- Git credentials stay out of machines the agent has used: `git.gitAuthEnv()` is only for setup, before the agent or terminal gets the machine, and pushes go through the git host's API (`pushCommits`), never `git push` in the sandbox.
- New outside services go behind a port in `src/core/ports.ts`, not called directly from services.
- Pages update from server events (`GET /api/events`), not polling: a change the UI shows is announced with `announce()` from `src/core/changes.ts`, and `src/web/lib/live-updates.ts` maps it to the queries to refetch. Polling is only a slow safety net.
- Services never import the agent; messages Anton sends on its own go through `sendToAgent` in `agent-runner.ts`, so the caps apply to them too.

## Commands

- `npm test` (server) and `npm run test:ui` (React components, in `tests/ui/`)
- `npm run check:types`
- `npm run dev` — UI on :43127, API on :43128
- `npm run build && npm start` — production on `PORT`
- `npx flue run src/agents/coder.ts --message "Say ready."` (needs an LLM key)
- `npx flue docs search <query>`
