# Anton v2

Anton v2 is a personal coding agent in the browser. You pick a GitHub repo and branch, describe the outcome, and Anton works on its own branch in its own sandbox. The right panel shows the task as it goes: **Changes**, **Terminal**, **Files** and **Library**.

## Requirements

- Node.js `>=22.19` (this repo pins `.nvmrc` to 22.22.2)

```sh
nvm use
npm install
cp .env.example .env
```

## Run

```sh
npm run dev          # UI on http://127.0.0.1:43127, API on :43128
npm test
npm run build && npm start   # production: one port (PORT, default 3000)
```

With no Modal or Tigris keys, Anton runs everything locally: each task gets a folder under `data/machines/`, and checkpoints go to `data/objects/`.

## How a task runs

1. **Create.** Anton resolves the branch to a commit and names a task branch `anton/<title>-<id>`. Nothing starts yet.
2. **Start.** A task starts read-only. Anton downloads the repo at the task's commit once, keeps it on its own disk, and the agent answers questions from it with `list_files`, `search_code` and `read_file`. That needs no sandbox, clone or branch. When the work needs edits, commands or a pull request, the agent calls `start_workspace`. Opening the terminal also starts the sandbox. A sandbox comes from, best first: the task's running sandbox, its snapshot from when it last stopped, the repo's warm image (dependencies installed, refreshed weekly), or a fresh clone. In both modes the agent can search the web and read pages through Parallel's free search MCP server.
   **Plan mode** (the Plan toggle, or "Plan first" on an automation) lets the agent investigate but not change anything: file writes are refused, there is no `start_workspace` or `open_pull_request`, and it proposes a plan with `propose_plan`. **Approve and build** turns plan mode off and tells the agent to go ahead.
   Every task's agent also reads the repo's **memory**: short notes it saved with `remember` in earlier tasks (how to run things, conventions, gotchas), which you can edit in the repository settings.
3. **Work.** The agent edits files in `/workspace/repo` and saves deliverables (reports, screenshots) to `/workspace/outputs`.
4. **Checkpoint.** After every agent response, Anton saves the changed files, the patch, the commit log and the outputs to storage.
5. **Stop.** Sandboxes stop when idle. Changes, Files and Library keep working from the checkpoint, and from the GitHub API for untouched files, without starting anything. **Resume** starts the sandbox again from its snapshot.
6. **Pull request.** The agent calls `open_pull_request`; Anton commits in the sandbox, then rebuilds those commits on GitHub through its API (same hashes), so the token never enters a sandbox the agent has used. Anton's token is used inside a sandbox only to clone during setup, before the agent starts.

## Providers

Every outside service sits behind a small interface in `src/core/ports.ts`, and each implementation lives in `src/providers/<name>/`. To swap one, add an entry to the table in `src/providers/index.ts` and choose it with an environment variable.

| Port | Implementations | Chosen by |
| --- | --- | --- |
| `SandboxProvider` | `modal`, `local` | `ANTON_SANDBOX` (default `modal` when `MODAL_TOKEN_ID` is set) |
| `ObjectStore` | `s3` (Tigris or any S3 API), `disk` | `ANTON_STORE` (default `s3` when `TIGRIS_SECRET_ACCESS_KEY` is set) |
| `GitHost` | `github` | |
| `ModelCatalog` | `openrouter` (live list from `GET /api/v1/models`, cached for an hour) | |

## Environment

| Variable | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | Model gateway |
| `ANTON_GITHUB_TOKEN` | Fine-grained token with Contents and Pull requests read/write on your repos |
| `ANTON_DEFAULT_REPO` | `owner/name` added on first run (optional) |
| `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` | Modal sandboxes (`ak-…` / `as-…`) |
| `TIGRIS_ENDPOINT` / `TIGRIS_BUCKET` / `TIGRIS_ACCESS_KEY_ID` / `TIGRIS_SECRET_ACCESS_KEY` | Checkpoints, outputs and cached trees |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | Task records (default `file:./data/anton.db`) |
| `ANTON_IDLE_MINUTES` | Stop a sandbox after this many idle minutes (default 15) |
| `ANTON_SANDBOX_CPU` / `ANTON_SANDBOX_MEMORY_MIB` | Sandbox size (default 1 CPU, 2048 MiB) |
| `ANTON_BASE_IMAGE` | Base image for new repos (default `node:22-bookworm`) |
| `ANTON_WEB_MCP_URL` | MCP server for the agent's `web_search` and `web_fetch` (default Parallel's free `https://search.parallel.ai/mcp`; `off` to turn off) |
| `PARALLEL_API_KEY` | Higher rate limits for web search (optional) |
| `ANTON_MODEL` | Default model (default `openrouter/~deepseek/deepseek-flash-latest`) |

Anton has no login of its own. Deploy it behind an access proxy (for example Cloudflare Access restricted to your email): anyone who reaches it can run code in your sandboxes and push with your token.

## Layout

| Path | What it is |
| --- | --- |
| `src/core/` | Ports, shared types, shell helpers, errors |
| `src/providers/` | Modal, local, S3, disk, GitHub and OpenRouter implementations |
| `src/services/` | Task lifecycle: sessions, workspace, git, checkpoints, files, pull requests, terminal |
| `src/db/` | libSQL client, versioned migrations, queries |
| `src/agents/coder.ts` | The Flue agent, its subagents and `open_pull_request` |
| `src/app.ts` | HTTP routes |
| `src/server.ts` | Production server: API, UI and terminal on one port |
| `src/web/` | React UI |
