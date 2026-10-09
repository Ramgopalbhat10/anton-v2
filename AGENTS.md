# AGENTS.md

Anton v2 is a Flue 2.0 coding agent with a React UI. Each task runs on its own branch in its own sandbox.

## Layout

- `src/core/ports.ts` — the interfaces every provider implements (sandbox, object store, git host, model catalog).
- `src/providers/` — Modal, local, S3, disk, GitHub, OpenRouter and ChatGPT-plan (`chatgpt/`, Sign in with ChatGPT) implementations; `index.ts` picks them from config.
- `src/services/subscriptions.ts` — plans signed in to from Settings › Subscriptions: keeps each sign-in, renews its token for the agents' calls, and adds the plan's models to the list, and counts each plan's use (`planUsage`). Claude plans are designed in `docs/claude-code-subscription.md`, not built.
- `src/flue/` — adapters into Flue: the machine sandbox driver, `live-models.ts`, which lets any model in the live catalog resolve, and `subscription-models.ts`, which runs `openai/…` models on a signed-in ChatGPT plan.
- `src/services/` — task lifecycle: sessions, workspace (acquire and set up a machine), git, checkpoints, files (live, saved or base views), pull requests, terminal, previews, and the browser behind the `browser` and `screenshot` tools (one Chromium tab per machine, kept open between steps by a small server inside the machine). Headless work (`headless.ts`) polls every five minutes for automations (labeled issues, schedules) and pull request follow-ups; both reach the agent through `agent-runner.ts`, which also enforces the spending caps (`budget.ts`).
- `src/services/context-usage.ts` measures each task's context window from the runtime's `turn_request` and `turn` events (the composer's context meter); `latest-input.ts` keeps each task's latest input, recorded by the Coder for every message it is given (`useDelivery` in `useAgentStart`; the runtime emits no event for delivered messages), and fills in older tasks once at start from the runtime's accepted submissions.
- `src/services/live-browser.ts` — the Browser panel: a hosted browser per task (the `BrowserHost` port, Kernel in `src/providers/kernel/`, on with `KERNEL_API_KEY`), shown through its live view and driven over the Chrome DevTools Protocol (`src/core/cdp.ts`) for the address bar, picking an element (`describe-element.ts` runs in the page: HTML, selector, styles, React components and their files) and screenshots to draw on (`src/web/components/sketch.tsx`). Picks and drawings reach the composer through `src/web/lib/composer-inbox.ts`. Opening it never starts the sandbox.
- `src/db/` — libSQL client, versioned migrations, queries.
- `src/core/plugins.ts` reads skills, plugins and marketplaces (Agent Skills, Claude Code, Devin, Codex, Cursor, Agent Plugins); `src/services/plugins.ts` installs them and gives each task its skills (the repo's own first, then installed plugins).
- `src/agents/coder.ts` — Coder agent: read-only repo tools until `start_workspace`, then the sandbox, explorer/tester subagents (each on its own model when Settings > General sets one) and `open_pull_request`. Work on web pages goes to its `browser` subagent, whose `browser` tool steps in the Browser panel's shared browser (`agentBrowse` in `live-browser.ts`, Playwright over the same DevTools endpoint, so the user watches and can take over) or in the sandbox's headless browser for the dev server on localhost. Both run the one step in `browser-step.ts`. With code mode on it also gets `run_script` (`src/services/code-mode.ts`): one JavaScript program, run in a QuickJS VM on Anton's side, that calls the read-only repo tools, the task's MCP servers and `decide()`.
- `src/services/decisions.ts` — the decision model (TypeSafe's Jev through OpenRouter, a `DecisionModel` port): yes/no and choice questions answered with probabilities for a fraction of a cent. Follow-ups and automatic reviews use it to skip work; without it they behave as before.
- `src/agents/reviewer.ts` — Reviewer agent (on its own model when Settings > General sets one): after each push (`code-review.ts`) it reads the pull request in the task's sandbox without writing and posts a review on GitHub; follow-ups bring its findings back to the Coder.
- `src/app.ts` — Hono routes. `src/server.ts` — production server (API, UI, terminal WebSocket).
- `src/web/` — TanStack Router UI.

## Rules

- Viewing a task (files, changes, library) never starts a sandbox. A task starts read-only: the agent answers from a snapshot of the repo on Anton's side (`repo-snapshot.ts`) and starts its sandbox with `start_workspace` only when it must edit or run code. The terminal, Resume and restoring a checkpoint also start one; a task that has had a machine keeps using it.
- Git credentials stay out of machines the agent has used: `git.gitAuthEnv()` is only for setup, before the agent or terminal gets the machine, and pushes go through the git host's API (`pushCommits`), never `git push` in the sandbox.
- New outside services go behind a port in `src/core/ports.ts`, not called directly from services.
- Pages update from server events (`GET /api/events`), not polling: a change the UI shows is announced with `announce()` from `src/core/changes.ts`, and `src/web/lib/live-updates.ts` maps it to the queries to refetch. Polling is only a slow safety net.
- Services never import the agents; messages Anton sends on its own go through `sendToAgent` in `agent-runner.ts` (to the coder or the reviewer), so the caps apply to them too.

## Commands

- `npm test` (server) and `npm run test:ui` (React components, in `tests/ui/`)
- `npm run check:types`
- `npm run dev` — UI on :43127, API on :43128
- `npm run build && npm start` — production on `PORT`; `npm run start:backup` does the same under Litestream, which restores and streams both SQLite files to Tigris (`litestream.yml`)
- `npx flue run src/agents/coder.ts --message "Say ready."` (needs an LLM key)
- `npx flue docs search <query>`
