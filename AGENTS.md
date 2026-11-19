# AGENTS.md

Anton v2 is a Flue 2.0 coding agent with a React UI. Each task runs on its own branch in its own sandbox.

This file is an index. Read the doc for the area you change, not all of them.

## Where things are

| Area | Code | Read |
| --- | --- | --- |
| Ports, providers (Modal, Docker, local, S3, GitHub, plans), Flue adapters, DB, setup | `src/core/ports.ts`, `src/providers/`, `src/flue/`, `src/db/`, `src/services/settings/setup.ts` | [server-and-providers](docs/architecture/server-and-providers.md) |
| HTTP entry and routes (mount order matters) | `src/app.ts`, `src/routes/`, `src/server.ts` | [server-and-providers](docs/architecture/server-and-providers.md) |
| Plans, gateways, model variants, background and decision models | `src/services/models/subscriptions.ts`, `src/services/models/general.ts`, `src/services/models/decisions.ts` | [models-and-plans](docs/architecture/models-and-plans.md), [claude-code-plan](docs/architecture/claude-code-plan.md) |
| ACP agent runtimes (Devin, Antigravity) jailed in Modal sidecars | `src/providers/acp/` | [acp-runtime](docs/architecture/acp-runtime.md) |
| Task lifecycle, sandboxes, chats, run on host, headless runs | `src/services/tasks/`, `src/services/sandbox/`, `src/services/automations/`, `scripts/anton-run.ts` | [tasks-and-sandboxes](docs/architecture/tasks-and-sandboxes.md) |
| Context window, cuts, pruning, compaction, reply traces | `src/services/context/`, `src/services/replies/compaction-pin.ts` | [context-and-traces](docs/architecture/context-and-traces.md) |
| Coder, subagents, checks at a reply's end, background jobs, Reviewer, skills | `src/agents/coder/`, `src/agents/reviewer.ts`, `src/services/replies/`, `src/services/sandbox/background-jobs.ts`, `src/core/plugins.ts` | [agents](docs/architecture/agents.md) |
| Browser and Computer panels | `src/services/browser/` | [browser-and-computer](docs/architecture/browser-and-computer.md) |
| What replies draw, Artifacts page, attachments | `src/web/components/thread/thread.tsx`, `src/web/components/pages/artifacts-page.tsx`, `src/services/artifacts/` | [replies-and-artifacts](docs/architecture/replies-and-artifacts.md) |
| Projects, coordinator, threads, project files | `src/services/projects/`, `src/agents/coordinator.ts` | [projects](docs/architecture/projects.md) |
| Connectors | `src/services/connectors/`, `src/web/components/settings/connectors.tsx` | [connectors](docs/architecture/connectors.md) |
| Web UI, panels, push notifications | `src/web/`, `src/services/notify/` | [web-ui](docs/architecture/web-ui.md) |
| Dev tooling, Flue patches, UI fixture, backups | `scripts/`, `litestream.yml` | [development](docs/architecture/development.md) |

## Rules

Reasons and details: [rules](docs/architecture/rules.md).

- Viewing a task never starts a sandbox; a task reads from a repo snapshot until it needs one.
- Git credentials never reach a machine the agent or terminal has used; pushes go through the git host's API.
- New outside services go behind a port in `src/core/ports.ts`.
- Pages update from server events (`announce()`), not polling.
- Storage cleanup removes only what this database deleted.
- Nothing a page or message waits on fetches a vendor's model list when one is in hand.
- Services never import the agents; Anton's own messages go through `sendToAgent`.
- No re-export `index.ts` barrels; import files directly with explicit `.ts` extensions. Only agent entry files carry `'use agent'`.
- Comments only for invariants, outside systems' quirks, security reasons and traps.
- Keep this file an index: put new detail in the area's doc and add a row here only for a new area.

## Commands

- `npm test` (server) and `npm run test:ui` (React components, in `tests/ui/`)
- `npm run check:types`, and `npm run lint:hooks` (the rules of hooks fail it; missing effect dependencies are warnings)
- `npm run dev` — UI on :43127, API on :43128
- `npm run ui:fixture` — the real UI with scripted, streaming conversations and a mocked API, for checking a page in a browser (no server, keys or sandbox; `window.__chat` drives it). Use it rather than building a fake backend; see [development](docs/architecture/development.md)
- `npm run build && npm start` — production; more in [development](docs/architecture/development.md)
- `npx flue docs search <query>`
