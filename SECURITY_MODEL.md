# Threat model: Ramgopalbhat10/anton-v2

Anton v2 is a **single-user**, browser-based autonomous coding agent (Flue 2.0 runtime, Hono API, React UI). Each task runs on its own `anton/<title>-<id>` branch in its own sandbox; the agent edits code, runs commands, browses, and opens pull requests with the owner's GitHub token.

Source: code exploration plus the owner's answers. There is no infrastructure repository; deployment is `npm run start:backup` (`scripts/start-with-backup.sh`, Litestream → Tigris per `litestream.yml`) on a host behind an access proxy.

## Owner-provided facts
- **Deployment:** hosted behind an access proxy (e.g. Cloudflare Access) restricted to the owner only. The app has **no login of its own** (README › Deploy and security); the proxy is the authentication boundary. **Nothing bypasses the proxy**: no GitHub webhook is set up (`ANTON_GITHUB_WEBHOOK_SECRET` unset, so `/api/github/webhook` answers 404), and OAuth callbacks also go through the proxy.
- **Sandbox egress:** Modal sandboxes run with an outbound domain allowlist (Settings › Sandboxes `allowedDomains` → `outboundDomainAllowlist` in `src/providers/modal/sandbox.ts`; GitHub always allowed per `src/services/sandbox/sandbox-settings.ts`), so sandbox code cannot exfiltrate to arbitrary hosts.
- **Attackers:** every attacker class below is relevant; none is ruled out.
- **Critical assets:** all of: GitHub token / push access, model plan and API keys, Gmail / connector access, task data and conversations (`anton.db`, `flue.db`), and spend (sandbox compute, model costs).
- **Accepted risk / out of scope:**
  - The `local` sandbox provider (`src/providers/local/sandbox.ts`) has no isolation; it is dev-only.
  - No login in the app itself: an attacker who has passed the access proxy is the owner. Findings that need only "reach the API" are not in scope *unless* they work without passing the proxy (e.g. cross-site requests from the owner's browser, the webhook path, sockets bound outside the proxy).
  - Agent-run code doing anything **inside its own sandbox** is intended. What matters is crossing out of it: to the server, other tasks' sandboxes, host secrets, or the owner's browser origin.

## Components
| Component | Code | Trust side |
| --- | --- | --- |
| **Web UI** | `src/web/` | Owner's browser on Anton's origin; renders agent/model output (markdown, mermaid, show cards, outputs viewer, sketches) |
| **API** | `src/app.ts`, `src/routes/` (incl. `mobile.ts`), `src/server.ts`, `src/core/upgrades.ts`, `src/services/tasks/terminal.ts` (WebSocket `/vm/<id>/pty`) | Server; reached only through the proxy, except the webhook |
| **Agents** | `src/agents/` (coder, coordinator, reviewer), `src/flue/`, `src/services/sandbox/code-mode.ts`, `src/services/context/tool-results.ts`, `src/services/replies/asks.ts`, `src/services/artifacts/show.ts`, `src/services/projects/memory.ts`, `src/services/git/follow-ups.ts` | Server process acting on untrusted model output |
| **Sandboxes** | `src/providers/modal/`, `src/providers/local/`, `src/services/sandbox/workspace.ts`, `src/services/git/git.ts`, `src/services/browser/browser*.ts`, `src/services/browser/computer.ts`, `src/services/browser/live-browser.ts`, `src/services/browser/previews.ts`, `src/services/artifacts/renders.ts`, `src/services/browser/page-fetch.ts`, `src/core/desktop*.ts`, `src/providers/kernel/` | Untrusted execution; boundary between agent-run code and the server |
| **Integrations** | `src/providers/github/`, `chatgpt/`, `claude-code/`, `cursor/`, `opencode-go/`, `openrouter/`, `vercel/`, `google/`, `webpush/`; `src/services/models/subscriptions.ts`, `src/services/connectors/connectors.ts`, `src/services/connectors/connector-tools.ts`, `src/services/connectors/mail.ts`, `src/services/connectors/mcp-*.ts`, `src/services/settings/plugins.ts`, `src/services/secrets/secrets.ts`, `src/services/git/pull-requests.ts`, `src/services/git/host-commits.ts` | Holds and uses third-party credentials |
| **Automations** | `src/services/automations/headless.ts`, `src/services/git/pr-watch.ts`, `src/services/automations/automations.ts`, `src/services/git/reviews.ts`, `src/services/git/code-review.ts`, `src/services/tasks/agent-runner.ts`, `src/services/models/budget.ts`, webhook handler in `src/routes/connectors.ts` | Server; starts agent work from GitHub issues/PRs/comments without the owner present |
| **Storage** | `src/db/` (Flue's adapter in `src/db/adapter.ts`), `src/providers/s3/`, `src/providers/disk/`, `src/services/git/checkpoints.ts`, `src/services/settings/storage.ts`, `src/services/git/restore.ts`, `litestream.yml`, `scripts/` | Server-side persistence: libSQL/Turso, Tigris/S3 objects |

## Trust boundaries and entry points
1. **Internet → access proxy → API.** All `/api/*` routes (~200 in `src/routes/`) and the terminal/desktop sockets are reachable only by the owner through the proxy. Owner confirms nothing bypasses the proxy (webhook off, callbacks behind it). Still in scope: anything that listens on another port or interface outside the proxy (`HOST` unset binds all interfaces), and the webhook handler's code should the secret ever be set.
   Previews (`ANTON_PREVIEW_URL`, `src/core/preview-proxy.ts`): when set, requests and sockets whose Host is a preview hostname go to `127.0.0.1:<port>` instead of Anton, only for the ports projects preview on and never Anton's own `PORT`. They arrive through the same tunnel and proxy; each preview is its own origin, so agent-run pages cannot call Anton's API with the owner's cookies.
2. **Owner's browser ↔ Anton origin.** Cross-site requests and WebSocket hijacking from other sites the owner visits (CSRF; `isSameOrigin` guards the pty socket). Agent-produced content served on Anton's origin (outputs, SVG via `SVG_CSP`, renders/`render-frame`, mermaid, markdown) is untrusted, so XSS here gives full control of Anton.
3. **Untrusted content → agent (prompt injection).** Repo files, web search/fetch results (Parallel MCP), PR/issue comments and reviews pulled by `src/services/automations/headless.ts`/`src/services/git/pr-watch.ts`, emails via the Gmail connector, MCP server tool output, plugin/skill marketplaces (`anthropics/skills`, `CognitionAI/devin-marketplace` by default), browser pages. Injected instructions must not obtain host secrets, send mail without approval (`src/services/connectors/mail.ts` approval + digest), push outside the task branch, or exceed budget caps.
4. **Sandbox → server.** Agent-run code is untrusted. The GitHub token is meant to enter a sandbox only for the initial clone before the agent starts (`cloneRepo` with `gitAuthEnv()` in `src/services/sandbox/machine-setup.ts`); pushes are rebuilt via the GitHub API (`src/services/git/host-commits.ts`). Outputs, checkpoints, patches, tar files, file paths and branch names coming back from the sandbox are untrusted input to the server (path traversal, command injection into `quote()`-built shell strings, tar extraction).
5. **Server → third parties.** `src/services/browser/page-fetch.ts` proxies requests for rendered pages with an SSRF guard (public addresses only, checked per connection). Model gateways, Kernel, Modal, Tigris, Turso, push services.

## Assets
- **GitHub token** (`ANTON_GITHUB_TOKEN`, Contents + PRs read/write): push to the owner's repos. Critical.
- **Plan and API keys:** ChatGPT sign-in tokens, OpenRouter / Vercel / OpenCode Go / Cursor keys (stored in settings in `anton.db`), Claude Code sign-in in `<dataDir>/claude-code`, Modal, Tigris, Turso, Kernel (from the environment, or saved in Settings › Connections to `<dataDir>/anton.env`, mode 0600, plain text like `.env`), Google OAuth client and Gmail tokens, webhook secret, VAPID keys, repo/shared sandbox env secrets (`src/services/secrets/secrets.ts`, redacted by `src/core/redact.ts` when `hideSecrets`). Critical.
- **Gmail / connector access:** read and draft mail, send only after owner approval. Critical.
- **Task data:** `anton.db` (repos, tasks, settings, usage, secrets), `flue.db` (all conversations), checkpoints and outputs in the bucket. High.
- **Spend:** Modal compute, model usage, Kernel browser seconds; capped by `src/services/models/budget.ts`. Medium–High.

## Attacker profiles (all relevant per owner)
- **A1 Prompt injector:** controls content the agent reads (repo, web, PR comments, issues, email, MCP output, plugins).
- **A2 Sandbox code:** arbitrary code running in a task's Modal sandbox (from A1 or a malicious dependency) trying to reach the server, host secrets, other tasks, or the owner's browser.
- **A3 Network attacker without proxy access:** can reach the webhook path, OAuth callbacks, any port not behind the proxy, or can lure the owner's browser to a malicious site (CSRF / cross-site WebSocket).
- **A4 Malicious MCP server, connector, plugin or marketplace** the owner added.

## Existing controls
- Access proxy (owner only); `HOST=127.0.0.1` recommended when the tunnel is local.
- Webhook HMAC (`signedByGitHub`), and a delivery only names which PR to re-read.
- Pty WebSocket same-origin check (`isSameOrigin` in `src/services/tasks/terminal.ts`); short-lived credentialed socket URLs for desktop/browser (`Machine.socketUrl`, Modal connect tokens).
- Token kept out of agent-used sandboxes; pushes rebuilt via the API.
- Local sandbox `shellEnv` passes only PATH/HOME/LANG.
- Outputs download as `application/octet-stream` except images/PDF; SVG sandboxed with CSP (`SVG_CSP` in `src/routes/shared.ts`); `nosniff`.
- `src/services/browser/page-fetch.ts` SSRF guard (public IPs only, every redirect, no cookies, size/time limits).
- Mail sends need owner approval bound to a draft digest.
- Plan mode refuses writes; spending caps (`src/services/models/budget.ts`); secret redaction (`src/core/redact.ts`, `hideSecrets` default on).
- Request bodies validated with valibot (`body()` in `src/routes/shared.ts`).

## Open questions
- None outstanding.
