# Server, providers and Flue

Linked from [AGENTS.md](../../AGENTS.md).

## Ports and providers

Every outside service sits behind an interface in `src/core/ports.ts`; implementations live in `src/providers/<name>/`, and `src/providers/index.ts` picks them from config.

| Port | Implementations | Chosen by |
| --- | --- | --- |
| `SandboxProvider` | `modal`, `docker` (a container per task), `local` (a folder, no isolation) | `ANTON_SANDBOX` (default `modal` when `MODAL_TOKEN_ID` is set, else `local`) |
| `ObjectStore` | `s3` (Tigris or any S3 API), `disk` | `ANTON_STORE` (default `s3` when `TIGRIS_SECRET_ACCESS_KEY` is set) |
| `GitHost` | `github` | |
| `ModelCatalog` | `openrouter` (`/models/user` with a key, else `/models`, cached an hour) | |
| `GatewayAccount` | `openrouter` (`GET /key`, `/credits`), `vercel` (`GET /v1/credits`) | Settings › Subscriptions key, else `OPENROUTER_API_KEY` / `AI_GATEWAY_API_KEY` |
| `SubscriptionProvider` | `chatgpt` | Settings › Subscriptions |
| `AgentRuntime` | `claude-code` (Claude Agent SDK), `devin` + `antigravity` (ACP agents in Modal, when `MODAL_TOKEN_ID` is set) | Settings › Subscriptions |
| `KeyPlan` | `opencode-go`, `cursor` (Cursor SDK) | Settings › Subscriptions |
| `DecisionModel`, `VisionModel`, `TextModel`, `ImageModel` | `openrouter` | |
| `Mailbox`, `AccountSignIn` | `google` | |
| `AppsConnector` | `composio` | `COMPOSIO_API_KEY` or a pasted key |
| `BrowserHost` | `kernel` | `KERNEL_API_KEY` |
| `PushSender` | `webpush` (VAPID, no library) | |

- Only `src/providers/claude-code/runtime.ts` imports the Claude Agent SDK, and only `src/providers/cursor/plan.ts` imports `@cursor/sdk`.
- `src/flue/` adapts these into Flue: the machine sandbox driver, `live-models.ts` (any catalog model resolves) and the plan bridges (`subscription-models.ts`, `opencode-go-models.ts`, `claude-code-models.ts`, whose `runtimeProvider` also drives ACP runtimes). `src/agents/providers.ts` registers them with `setProvider` once; each agent imports it for that side effect.

## Server

- `src/app.ts` is Flue's HTTP entry: boot work, the error handler, and the route modules of `src/routes/` mounted in order with `app.route('/', …)`. Each module keeps full paths; `src/routes/shared.ts` holds shared body checks and schemas. Hono copies a module's routes in when it is mounted, so mount order is registration order: a guard in front of a route (the agent routers' guards, the incognito views on `/api/sessions/*`) must sit in the same module, before it.
- `src/server.ts` is the production server (API, UI and terminal on one port); `src/core/site.ts` lays out its routes. Hashed `/assets/*` are `immutable` for a year (a missing one is a 404, not the page), everything else static is `no-cache`, and responses are gzipped except `text/event-stream`, since a Cloudflare tunnel carries the origin's bytes as sent. Every JSON `GET` under `/api/*` carries a weak `ETag` hashed from its body and `private, no-cache` (`src/core/conditional.ts`), so a read whose answer has not changed is an empty 304 the browser fills from its copy; `no-store` answers, streams and answers that set cookies pass through. `src/routes/conversation-window.ts` sits in front of Flue's agent routes: `?view=history&turns=N[&from=<id>]` answers Flue's history with only its latest turns (or from that message on), as `private, no-cache` rather than Flue's `no-store` so a conversation unchanged since it was last opened is an empty 304, and `/older?before=<id>&turns=N` the turns before a message (409 once it is gone); every other request goes to Flue's router untouched. Its keep-alive outlasts the proxy's (cloudflared 90 s, Cloudflare 900 s) so the proxy never reuses a connection Node has closed. A 522 behind a tunnel is the tunnel not reaching the server, not the API; cloudflared's `--protocol http2` is the usual fix when QUIC stalls. `src/db/` holds the libSQL client, migrations and queries; `src/db/adapter.ts` is Flue's persistence entry (`db` in `flue.config.ts`).
- Gotcha: Cloudflare closes a request at 100 seconds, so Stop and Delete answer by `ANSWER_MS` and finish behind the answer (`src/services/tasks/answer-within.ts`).

## Machine files

`readMachineFile` and `writeMachineFile` (`src/core/machine-fs.ts`) use the machine's own file access when it has one (`Machine.readFile`, `writeFile`), else a command (`wc -c` and `cat`, `cat >`), which every provider has; a login shell per file is costly where a command is a network round trip. The local machine uses Node. Modal's file API is behind `ANTON_SANDBOX_FILE_API=1`, off until tried on a real sandbox: it takes absolute paths only, has a read size limit, and makes missing folders where `cat >` fails; anything it cannot take falls back to the command. Docker has no file access. Either way a failure is one `CommandError` naming operation, path and reason (`fileError`).

## Setup and Connections

- Settings › Connections is also first-run setup (`src/services/settings/setup.ts`, routes `/api/setup`). Each slot (models, code host, sandboxes, object storage, database, decision model, web search) lists providers and the values each needs, with where each comes from now. Test (`POST /api/setup/:slot/test`) checks without saving (`src/providers/checks.ts`, one function per provider); Save checks again, then keeps.
- Model keys go where Settings › Subscriptions keeps them (`connectKey`); every other value goes to `<dataDir>/anton.env` (`src/saved-env.ts`), which `src/config.ts` lays over the environment before reading any setting. The database URL lives there, which is why it is a file and not a row. A secret never goes back to the page, only its last four characters.
- Live vs restart: the GitHub token and API address, the decision model and the web search server are getters on `config`, and saving one rebuilds them (`refreshLiveProviders`). The sandbox, object store and database are chosen once in `getProviders()`, so saving one shows Needs a restart; there is no restart route.
- Gotcha: a check with no answer in 10 seconds (`withTimeout` in `src/services/settings/connections.ts`) retraces the request (`src/services/settings/why-no-answer.ts`: address lookup, then a connection to each address) and says which was slow. Node resolves names on a pool of 4 threads, so a slow resolver stalls every new outbound request at once (it showed as GitHub, S3 and the decision model failing together). Failures also go to Recent problems.
- Gotcha: Cursor moves tool results over 40KB into a file its own (disabled) tools would read, so `src/providers/cursor/plan.ts` hands long results back in parts through `read_tool_output`, and gives each agent an in-memory store, since the SDK's JSONL store rereads its whole file per update.
