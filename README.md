# Anton v2

Anton v2 is a personal coding agent in the browser. You pick a GitHub repo and branch and describe the outcome; Anton works on its own branch in its own sandbox and opens a pull request. It is built on Flue 2.0 with a React UI, and is meant for one person.

## Requirements

- Node.js `>=22.19` (`.nvmrc` pins 22.22.2)

```sh
nvm use
npm install
cp .env.example .env
```

Every value is optional at first. On a new server, Settings › Connections walks through what Anton needs (a model key, GitHub, sandboxes, storage), tests each value and saves it to `data/anton.env`, which is read over `.env` at start. With no Modal or Tigris keys, tasks run in local folders under `data/machines/` and checkpoints go to `data/objects/`.

## Run

```sh
npm run dev                  # UI on http://127.0.0.1:43127, API on :43128
npm test                     # server tests; npm run test:ui for the React components
npm run build && npm start   # production on one port (PORT, default 3000)
```

`npm run anton:run` runs tasks against a running Anton without the UI, for benchmarks and before/after checks. Each task appears in the UI and prints one JSON line (outcome, reply, time, tokens, cost, model calls, largest context):

```sh
npm run anton:run -- --model openrouter/deepseek/deepseek-v4.1-flash "Fix the failing test in src/date.ts"
npm run anton:run -- --url http://127.0.0.1:43128 --project <id> --tasks tasks.jsonl --out runs.jsonl --timeout 30m --budget 2.50
```

A tasks file holds one `{"name", "prompt", "project", "model", "reasoning"}` object per line; only `prompt` is required.

## Environment

| Variable | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | OpenRouter key, used while none is pasted in Settings › Subscriptions (optional) |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway key, used while none is pasted (optional) |
| `ANTON_GITHUB_TOKEN` | Fine-grained token: Contents and Pull requests read/write |
| `ANTON_GITHUB_WEBHOOK_SECRET` | Secret for a GitHub webhook on `/api/github/webhook` (optional) |
| `ANTON_DEFAULT_REPO` | `owner/name` added on first run (optional) |
| `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` | Modal sandboxes |
| `TIGRIS_ENDPOINT` / `TIGRIS_BUCKET` / `TIGRIS_ACCESS_KEY_ID` / `TIGRIS_SECRET_ACCESS_KEY` | Object storage for checkpoints, outputs and cached trees |
| `ANTON_DATA_DIR` | Databases, local machines and disk storage (default `./data`) |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | Task records on Turso instead of `anton.db` (optional) |
| `ANTON_SECRETS_KEY` | Encrypts sealed secrets (default: a key made in the data folder) |
| `ANTON_IDLE_MINUTES` | Idle minutes before a sandbox stops (default 5) |
| `ANTON_DOCKER_NETWORK` | Network for `docker` sandboxes; `none` keeps them offline |
| `ANTON_SANDBOX_CPU` / `ANTON_SANDBOX_MEMORY_MIB` | Sandbox size (default 1 CPU, 2048 MiB) |
| `ANTON_BASE_IMAGE` | Base image for new repos (default `node:22-bookworm`) |
| `ANTON_WEB_MCP_URL` | MCP server for `web_search` / `web_fetch` (default Parallel's free one; `off` to disable) |
| `PARALLEL_API_KEY` | Higher web search rate limits (optional) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Your Google OAuth client for Gmail (optional; can be pasted in Settings) |
| `ANTON_MODEL` | Default model (default `openrouter/~deepseek/deepseek-flash-latest`) |
| `ANTON_DECISION_MODEL` | Cheap OpenRouter model for yes/no decisions (default `~typesafe/jev-latest`; `off` to disable) |
| `ANTON_CLAUDE_CODE_PATH` | A `claude` binary to use instead of the SDK's bundled one (optional) |
| `ANTON_CLAUDE_CODE_MAX_OPEN` | Claude Code conversations kept open at once (default 3) |
| `ANTON_PUSH_CONTACT` | `mailto:` or `https:` contact for push services (default `mailto:anton@example.com`) |
| `TZ` | Time zone for the daily spending cap's midnight (default the server's) |
| `ANTON_PREVIEW_URL` | Where previews of tasks run on this server open, one hostname per port, such as `https://preview-{port}.example.com` (optional; see below) |

Which provider fills each port (`ANTON_SANDBOX`, `ANTON_STORE`, plans and gateways) is in [server-and-providers](docs/architecture/server-and-providers.md) and [models-and-plans](docs/architecture/models-and-plans.md).

## Deploy and security

Anton has no login of its own: anyone who reaches it can run code in your sandboxes and push with your token. Put it behind an access proxy (for example Cloudflare Access restricted to your email). When the proxy's tunnel runs on the same machine, start Anton with `HOST=127.0.0.1` so the tunnel is the only way in. If you set up the GitHub webhook, let only `/api/github/webhook` bypass the proxy; Anton refuses unsigned deliveries. See [SECURITY_MODEL.md](SECURITY_MODEL.md).

**Previews of tasks run on this server.** Their dev servers listen on this machine's ports, which a browser elsewhere cannot reach as `localhost`. Set `ANTON_PREVIEW_URL` to a hostname template with `{port}` in it, such as `https://preview-{port}.example.com`, and route those hostnames to Anton like its own: a DNS record for each preview port (or a wildcard) on the tunnel, a tunnel rule sending them to Anton's port, and the same access policy as Anton. Anton then serves each port a project previews on, never its own, at its hostname, sockets included, so Vite's live reload works. Keep the hostnames one level below the domain (`preview-43127.example.com`, not `43127.preview.example.com`): Cloudflare's free certificate covers only one level.

State lives in `anton.db` and `flue.db` in the data folder. `npm run build && npm run start:backup` runs Anton under [Litestream](https://litestream.io) (0.5+, needs the Tigris variables), which restores both files on a fresh server and streams writes to the bucket; details in [development](docs/architecture/development.md).

## Layout

| Path | What it is |
| --- | --- |
| `src/agents/coder/` | The Coder agent: entry (`index.ts`), prompts, subagents, workspace, `tools/` |
| `src/agents/` | Coordinator and Reviewer agents, shared provider registration |
| `src/app.ts`, `src/routes/` | Flue's HTTP entry and the Hono routes, one module per area |
| `src/server.ts` | Production server: API, UI and terminal on one port |
| `src/services/tasks/` | Task lifecycle, agent runs, waiting messages, terminal, runners |
| `src/services/sandbox/` | Machines: setup, spares, warm images, snapshot reads, background jobs |
| `src/services/git/` | Git, checkpoints, pull requests, reviews, base merges |
| `src/services/replies/` | Checks at a reply's end: gates, finish review, todos, asks |
| `src/services/context/` | Context meter, pruning, tool-result cuts, reply traces |
| `src/services/models/` | Plans, gateways, decision and vision models, usage, budget |
| `src/services/browser/` | Browser and Computer panels, the browser tool |
| `src/services/artifacts/` | Outputs, renders, images, attachments |
| `src/services/projects/` | Projects (spaces), threads, coordinator state, memory |
| `src/services/connectors/` | Connectors, MCP servers, Gmail, Composio, tool approvals |
| `src/services/secrets/`, `settings/`, `automations/`, `notify/` | Secrets, settings and setup, headless runs, notifications |
| `src/core/` | Ports, shared types and helpers |
| `src/db/` | libSQL client, migrations, queries, Flue's persistence adapter |
| `src/flue/` | Adapters into Flue: sandbox driver, model bridges, tools |
| `src/providers/` | Port implementations (Modal, Docker, S3, GitHub, OpenRouter, plans, …) |
| `src/web/` | React UI |
| `scripts/` | `anton:run`, benchmarks, reports, Flue patches, Litestream start |
| `tests/` | Server tests (`*.test.ts`) and UI tests (`tests/ui/`) |
| `docs/architecture/` | One doc per area, indexed by [AGENTS.md](AGENTS.md) |
