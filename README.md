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
   **Plan mode** (the Plan toggle, or "Plan first" on an automation) lets the agent investigate but not change anything: file writes are refused, there is no `start_workspace` or `open_pull_request`, and it proposes a plan with `propose_plan`. Once a reply proposes one, the task waits on you with the plan, and **Approve and build** turns plan mode off and tells the agent to go ahead; turning plan mode on alone leaves nothing to approve.
   Every task's agent also reads the repo's **memory**: short notes it saved with `remember` in earlier tasks (how to run things, conventions, gotchas), which you can edit in the repository settings.
3. **Work.** The agent edits files in `/workspace/repo` and saves deliverables (reports, screenshots) to `/workspace/outputs`. To check a web app it runs the dev server and uses it with the `browser` tool: a Chromium tab inside the sandbox that stays open between steps, where it opens pages, clicks, types and takes screenshots, reading each page as its accessibility tree.
4. **Checkpoint.** After every agent response, Anton saves the changed files, the patch, the commit log and the outputs to storage.
5. **Stop.** Sandboxes stop when idle. Changes, Files and Library keep working from the checkpoint, and from the GitHub API for untouched files, without starting anything. **Resume** starts the sandbox again from its snapshot.
6. **Pull request.** The agent calls `open_pull_request`; Anton commits in the sandbox, then rebuilds those commits on GitHub through its API (same hashes), so the token never enters a sandbox the agent has used. Anton's token is used inside a sandbox only to clone during setup, before the agent starts.
7. **Review.** Each time the agent opens or updates a pull request, a second agent, the reviewer, reads the change in the same sandbox without changing anything. It follows the repo's `REVIEW.md` if there is one, and posts its findings on GitHub as a review with line comments. With follow-ups on, the agent then fixes them. Automatic reviews stop after three on one pull request; **Review the pull request** in the task menu asks for another, and Settings › General turns automatic reviews off.

## Providers

Every outside service sits behind a small interface in `src/core/ports.ts`, and each implementation lives in `src/providers/<name>/`. To swap one, add an entry to the table in `src/providers/index.ts` and choose it with an environment variable.

| Port | Implementations | Chosen by |
| --- | --- | --- |
| `SandboxProvider` | `modal`, `local` | `ANTON_SANDBOX` (default `modal` when `MODAL_TOKEN_ID` is set) |
| `ObjectStore` | `s3` (Tigris or any S3 API), `disk` | `ANTON_STORE` (default `s3` when `TIGRIS_SECRET_ACCESS_KEY` is set) |
| `GitHost` | `github` | |
| `ModelCatalog` | `openrouter` (live list from `GET /api/v1/models/user` with a key, else `/models`, cached for an hour) | |
| `GatewayAccount` | `openrouter` (the key's limits and credits from `GET /key` and `/credits`), `vercel` (the team's credits from `GET /v1/credits`) | Settings › Subscriptions, with a key from OpenRouter or Vercel AI Gateway, else `OPENROUTER_API_KEY` / `AI_GATEWAY_API_KEY` |
| `SubscriptionProvider` | `chatgpt` (Sign in with ChatGPT) | Settings › Subscriptions |
| `AgentRuntime` | `claude-code` (Claude Code through the Claude Agent SDK) | Settings › Subscriptions |
| `KeyPlan` | `opencode-go` (OpenCode Go), `cursor` (Cursor through the Cursor SDK) | Settings › Subscriptions, with a key from the vendor |
| `PushSender` | `webpush` (Web Push with VAPID, no library) | |

### Subscriptions

Instead of paying per token, tasks can run on a ChatGPT Plus or Pro plan. In **Settings › Subscriptions**, sign in with ChatGPT; OpenAI only sends the browser back to `http://127.0.0.1:1455/auth/callback`, which Anton catches itself when it runs on your computer, and which you paste into the page when Anton is hosted. You can also bring a sign-in made elsewhere: run `npx @earendil-works/pi-ai@latest login openai` on a computer with a browser and paste the `auth.json` it writes. Anton keeps the sign-in in its database and renews the token as it expires.

The plan's models (`openai/<model>`) come first in the model picker, marked PLAN. Their calls go to the OpenAI Responses API with your plan's token and count toward its limits; Anton records them at $0, or at API prices toward the spending caps if you switch that on. Claude Pro and Max plans work only inside Anthropic's own Claude Code, so Anton runs it on the server with its built-in tools off: Claude does the thinking and Anton runs every tool. Sign Claude Code in once with the command the Claude card shows (`CLAUDE_CONFIG_DIR=<data>/claude-code <claude> auth login`, over ssh when hosted), then press Check again. Claude Code keeps the sign-in and Anton never sees the token. The plan's models (`claude-code/<model>`) then show as PLAN like ChatGPT's. This is for your own use only, as Anthropic's terms allow; turn extra usage off at claude.ai/settings/usage so tasks stop at the plan's limit instead of billing more. Design and limits: [docs/claude-code-subscription.md](docs/claude-code-subscription.md).

OpenCode Go and Cursor plans take a key instead of a sign-in: paste one made in the OpenCode Console or Cursor's dashboard into their card, and Anton checks it with the vendor before keeping it on the server (never in a sandbox). OpenCode Go's models (`opencode-go/<model>`) are called directly on OpenCode's OpenAI- and Anthropic-shaped endpoints, and the card shows the plan's five-hour, weekly and monthly limits. Cursor has no plain model endpoint, so its models (`cursor/<model>`) run through Cursor's official SDK on the server the way Claude Code does: its own tools off, Anton's tools its only ones. Cursor publishes no per-token prices for those calls, so they are recorded at $0 and only the plan's own limits apply.

OpenRouter has a tab there too, though it is no plan: its models bill per token. Paste a key from openrouter.ai/settings/keys and Anton checks it with `GET /key` before keeping it on the server, then lists the models that key may use (`/models/user`, after your provider preferences and guardrails) a page at a time with a search, their prices and this month's tokens, beside the key's spending limits and the account's credits. The agents, the decision model and the computer's vision model all call OpenRouter with that key. `OPENROUTER_API_KEY` still works when no key is pasted; a pasted key wins, and disconnecting it hands back to the server's. Without either, OpenRouter models leave the model picker.

Vercel AI Gateway has a tab of its own that works the same way: paste a key from your Vercel dashboard (AI Gateway › API Keys), or set `AI_GATEWAY_API_KEY`, and the gateway's tool-calling models join the picker as `vercel/<creator>/<model>`, paid from your team's AI Gateway credits (the tab shows what is left). Only the agents call it; the decision, title and vision models stay on OpenRouter.

In a task's model picker, the chosen model on either gateway has two small menus beside its pin. They pick where that task's calls go: a provider to try first (each listed with its price and, where the gateway says, its speed), or a sort over all of them by price, throughput or latency. A provider and a sort exclude each other: once one is set only its icon stays (the provider's logo or the sort's icon), the picker's button shows it too, and the choice belongs to that task alone. The gateway falls back to its default routing when the chosen provider fails (OpenRouter's `provider.order` with `allow_fallbacks`, Vercel's `providerOptions.gateway.order`), and a provider is dropped when you switch models.

### On your phone

Anton installs as an app: on an iPhone, open it in Safari and tap Share › Add to Home Screen; on Android or in Chrome and Edge, use Install from the browser's menu or **Settings › Notifications**. Turn notifications on there, on each device, and Anton tells it when a task asks you something, has a plan waiting for approval, or fails (and when one finishes, if you switch that on), with what it asks. Tapping one opens the task on its conversation, ready to answer or approve. Nothing is sent while an Anton window is in front of you. iPhones and iPads get notifications only from the app on the home screen (iOS 16.4 or later). Notifications go through the browser's own push service (Google's, Apple's or Mozilla's), encrypted so it cannot read them.

## Environment

| Variable | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | Model gateway, used while no OpenRouter key is pasted in Settings › Subscriptions (optional) |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway, used while no key for it is pasted in Settings › Subscriptions (optional) |
| `ANTON_GITHUB_TOKEN` | Fine-grained token with Contents and Pull requests read/write on your repos |
| `ANTON_DEFAULT_REPO` | `owner/name` added on first run (optional) |
| `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` | Modal sandboxes (`ak-…` / `as-…`) |
| `TIGRIS_ENDPOINT` / `TIGRIS_BUCKET` / `TIGRIS_ACCESS_KEY_ID` / `TIGRIS_SECRET_ACCESS_KEY` | Checkpoints, outputs and cached trees |
| `ANTON_DATA_DIR` | Where Anton keeps both databases, local machines and disk storage (default `./data`) |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | Task records on Turso instead of `anton.db` in the data folder (optional) |
| `ANTON_IDLE_MINUTES` | Stop a sandbox this many minutes after its agent finishes (default 5) |
| `ANTON_SANDBOX_CPU` / `ANTON_SANDBOX_MEMORY_MIB` | Sandbox size (default 1 CPU, 2048 MiB) |
| `ANTON_BASE_IMAGE` | Base image for new repos (default `node:22-bookworm`) |
| `ANTON_WEB_MCP_URL` | MCP server for the agent's `web_search` and `web_fetch` (default Parallel's free `https://search.parallel.ai/mcp`; `off` to turn off) |
| `PARALLEL_API_KEY` | Higher rate limits for web search (optional) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Your own Google OAuth client for Gmail in Settings › Connectors, where it can be pasted instead (optional) |
| `ANTON_MODEL` | Default model (default `openrouter/~deepseek/deepseek-flash-latest`) |
| `ANTON_DECISION_MODEL` | Decision model on OpenRouter that keeps thanks-only comments from waking the agent, skips automatic reviews of documentation-only changes, and is `decide()` in code mode (default `~typesafe/jev-latest`; `off` to turn off) |
| `ANTON_CLAUDE_CODE_PATH` | A `claude` executable to run instead of the one the Claude Agent SDK bundles (optional) |
| `ANTON_CLAUDE_CODE_MAX_OPEN` | Claude Code conversations kept open at once; the longest idle closes first (default 3) |
| `ANTON_PUSH_CONTACT` | A `mailto:` or `https:` address push services can reach you at about Anton's notifications (default `mailto:anton@example.com`) |
| `TZ` | Time zone whose midnight starts a new day for the daily spending cap, e.g. `Asia/Kolkata` (default the server's) |

## Backups

Anton keeps its state in two SQLite files in the data folder: `anton.db` (repos, tasks, settings, usage) and `flue.db` (every conversation). Checkpoints and Library files are already in storage. To keep the databases safe too, start production with:

```sh
npm run build && npm run start:backup
```

This needs [Litestream](https://litestream.io) 0.5 or later on the server and the Tigris variables above. On start it restores both files from `db/` in the Tigris bucket when the server has none, then runs Anton under Litestream, which streams writes to the bucket every 30 seconds and uploads the last of them when the server stops cleanly. A new server with the same variables starts where the old one stopped. If the restore fails, Anton does not start, because an empty database next to your storage would lose every task. Only one server may run against a bucket at a time. Settings in `litestream.yml`.

Anton has no login of its own. Deploy it behind an access proxy (for example Cloudflare Access restricted to your email): anyone who reaches it can run code in your sandboxes and push with your token. When the proxy's tunnel runs on the same machine, start Anton with `HOST=127.0.0.1` so it listens only there and the tunnel is the only way in; otherwise it listens on every interface, and anyone on the same network can reach it without the proxy.

## Layout

| Path | What it is |
| --- | --- |
| `src/core/` | Ports, shared types, shell helpers, errors |
| `src/providers/` | Modal, local, S3, disk, GitHub, OpenRouter, ChatGPT-plan, Claude Code, OpenCode Go and Cursor implementations |
| `src/services/` | Task lifecycle: sessions, workspace, git, checkpoints, files, pull requests, terminal |
| `src/db/` | libSQL client, versioned migrations, queries |
| `src/agents/coder.ts` | The Flue agent, its subagents and `open_pull_request` |
| `src/agents/reviewer.ts` | The agent that reviews each pull request and posts its findings |
| `src/app.ts` | HTTP routes |
| `src/server.ts` | Production server: API, UI and terminal on one port |
| `src/web/` | React UI |
