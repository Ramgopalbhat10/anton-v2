# AGENTS.md

Anton v2 is a Flue 2.0 coding agent with a React UI. Each task runs on its own branch in its own sandbox.

## Layout

- `src/core/ports.ts` — the interfaces every provider implements (sandbox, object store, git host, model catalog).
- `src/providers/` — Modal, local, S3, disk, GitHub and OpenRouter implementations; `index.ts` picks them from config.
- `src/flue/` — adapters into Flue: the machine sandbox driver, and `live-models.ts`, which lets any model in the live catalog resolve.
- `src/services/` — task lifecycle: sessions, workspace (acquire and set up a machine), git, checkpoints, files (live, saved or base views), pull requests, terminal, previews, and the browser behind the screenshot tool. Headless work (`headless.ts`) polls every five minutes for automations (labeled issues, schedules) and pull request follow-ups; both reach the agent through `agent-runner.ts`, which also enforces the spending caps (`budget.ts`).
- `src/db/` — libSQL client, versioned migrations, queries.
- `src/agents/coder.ts` — Coder agent, explorer/tester subagents, `open_pull_request`.
- `src/app.ts` — Hono routes. `src/server.ts` — production server (API, UI, terminal WebSocket).
- `src/web/` — TanStack Router UI.

## Rules

- Viewing a task (files, changes, library) never starts a sandbox; only a prompt (typed, or sent by an automation or follow-up), the terminal, Resume or restoring a checkpoint does.
- Git credentials stay out of machines the agent has used: `git.gitAuthEnv()` is only for setup, before the agent or terminal gets the machine, and pushes go through the git host's API (`pushCommits`), never `git push` in the sandbox.
- New outside services go behind a port in `src/core/ports.ts`, not called directly from services.
- Services never import the agent; messages Anton sends on its own go through `sendToAgent` in `agent-runner.ts`, so the caps apply to them too.

## Commands

- `npm test`
- `npm run check:types`
- `npm run dev` — UI on :43127, API on :43128
- `npm run build && npm start` — production on `PORT`
- `npx flue run src/agents/coder.ts --message "Say ready."` (needs an LLM key)
- `npx flue docs search <query>`
