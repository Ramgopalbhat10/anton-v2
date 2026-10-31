# Threat model: Ramgopalbhat10/anton-v2

Anton v2 is a **single-user**, browser-based autonomous coding agent (Flue 2.0 runtime, Hono API, React UI). Each task runs on its own `anton/<title>-<id>` branch in its own sandbox; the agent edits code, runs commands, browses, and opens pull requests with the owner's GitHub token.

Source: code exploration (no `SECURITY_MODEL.md` exists) plus the owner's answers during scan setup. No infrastructure repository exists; deployment is `npm run start:backup` (`scripts/start-with-backup.sh`, Litestream → Tigris per `litestream.yml`) on a host behind an access proxy.

## Owner-provided facts
- **Deployment:** hosted behind an access proxy (e.g. Cloudflare Access) restricted to the owner only. The app has **no login of its own** (README › Backups); the proxy is the authentication boundary. **Nothing bypasses the proxy**: no GitHub webhook is set up (`ANTON_GITHUB_WEBHOOK_SECRET` unset, so `/api/github/webhook` answers 404), and OAuth callbacks also go through the proxy.
- **Sandbox egress:** Modal sandboxes run with an outbound domain allowlist (Settings › Sandboxes `allowedDomains` → `outboundDomainAllowlist` in `src/providers/modal/sandbox.ts`; GitHub always allowed per `sandbox-settings.ts`), so sandbox code cannot exfiltrate to arbitrary hosts.
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
| **API** | `src/app.ts`, `src/api/mobile.ts`, `src/server.ts`, `src/core/upgrades.ts`, `src/services/terminal.ts` (WebSocket `/vm/<id>/pty`) | Server; reached only through the proxy, except the webhook |
| **Agents** | `src/agents/` (coder, coordinator, reviewer), `src/flue/`, `src/services/code-mode.ts`, `tool-results.ts`, `asks.ts`, `show.ts`, `memory.ts`, `follow-ups.ts` | Server process acting on untrusted model output |
| **Sandboxes** | `src/providers/modal/`, `src/providers/local/`, `src/services/workspace.ts`, `git.ts`, `browser*.ts`, `computer.ts`, `live-browser.ts`, `previews.ts`, `renders.ts`, `page-fetch.ts`, `src/core/desktop*.ts`, `src/providers/kernel/` | Untrusted execution; boundary between agent-run code and the server |
| **Integrations** | `src/providers/github/`, `chatgpt/`, `claude-code/`, `cursor/`, `opencode-go/`, `openrouter/`, `vercel/`, `google/`, `webpush/`; `src/services/subscriptions.ts`, `connectors.ts`, `connector-tools.ts`, `mail.ts`, `mcp-*.ts`, `plugins.ts`, `secrets.ts`, `pull-requests.ts`, `host-commits.ts` | Holds and uses third-party credentials |
| **Automations** | `src/services/headless.ts`, `pr-watch.ts`, `automations.ts`, `reviews.ts`, `code-review.ts`, `agent-runner.ts`, `budget.ts`, webhook handler in `src/app.ts` | Server; starts agent work from GitHub issues/PRs/comments without the owner present |
| **Storage** | `src/db/`, `src/db.ts`, `src/providers/s3/`, `src/providers/disk/`, `src/services/checkpoints.ts`, `storage.ts`, `restore.ts`, `litestream.yml`, `scripts/` | Server-side persistence: libSQL/Turso, Tigris/S3 objects |

## Trust boundaries and entry points
1. **Internet → access proxy → API.** All `/api/*` routes (~170 in `src/app.ts`) and the terminal/desktop sockets are reachable only by the owner through the proxy. Owner confirms nothing bypasses the proxy (webhook off, callbacks behind it). Still in scope: anything that listens on another port or interface outside the proxy (`HOST` unset binds all interfaces), and the webhook handler's code should the secret ever be set.
2. **Owner's browser ↔ Anton origin.** Cross-site requests and WebSocket hijacking from other sites the owner visits (CSRF; `isSameOrigin` guards the pty socket). Agent-produced content served on Anton's origin (outputs, SVG via `SVG_CSP`, renders/`render-frame`, mermaid, markdown) is untrusted, so XSS here gives full control of Anton.
3. **Untrusted content → agent (prompt injection).** Repo files, web search/fetch results (Parallel MCP), PR/issue comments and reviews pulled by `headless.ts`/`pr-watch.ts`, emails via the Gmail connector, MCP server tool output, plugin/skill marketplaces (`anthropics/skills`, `CognitionAI/devin-marketplace` by default), browser pages. Injected instructions must not obtain host secrets, send mail without approval (`mail.ts` approval + digest), push outside the task branch, or exceed budget caps.
4. **Sandbox → server.** Agent-run code is untrusted. The GitHub token is meant to enter a sandbox only for the initial clone before the agent starts (`cloneRepo` with `gitAuthEnv()` in `workspace.ts`); pushes are rebuilt via the GitHub API (`host-commits.ts`). Outputs, checkpoints, patches, tar files, file paths and branch names coming back from the sandbox are untrusted input to the server (path traversal, command injection into `quote()`-built shell strings, tar extraction).
5. **Server → third parties.** `page-fetch.ts` proxies requests for rendered pages with an SSRF guard (public addresses only, checked per connection). Model gateways, Kernel, Modal, Tigris, Turso, push services.

## Assets
- **GitHub token** (`ANTON_GITHUB_TOKEN`, Contents + PRs read/write): push to the owner's repos. Critical.
- **Plan and API keys:** ChatGPT sign-in tokens, OpenRouter / Vercel / OpenCode Go / Cursor keys (stored in settings in `anton.db`), Claude Code sign-in in `<dataDir>/claude-code`, Modal, Tigris, Turso, Kernel, Google OAuth client and Gmail tokens, webhook secret, VAPID keys, repo/shared sandbox env secrets (`secrets.ts`, redacted by `src/core/redact.ts` when `hideSecrets`). Critical.
- **Gmail / connector access:** read and draft mail, send only after owner approval. Critical.
- **Task data:** `anton.db` (repos, tasks, settings, usage, secrets), `flue.db` (all conversations), checkpoints and outputs in the bucket. High.
- **Spend:** Modal compute, model usage, Kernel browser seconds; capped by `budget.ts`. Medium–High.

## Attacker profiles (all relevant per owner)
- **A1 Prompt injector:** controls content the agent reads (repo, web, PR comments, issues, email, MCP output, plugins).
- **A2 Sandbox code:** arbitrary code running in a task's Modal sandbox (from A1 or a malicious dependency) trying to reach the server, host secrets, other tasks, or the owner's browser.
- **A3 Network attacker without proxy access:** can reach the webhook path, OAuth callbacks, any port not behind the proxy, or can lure the owner's browser to a malicious site (CSRF / cross-site WebSocket).
- **A4 Malicious MCP server, connector, plugin or marketplace** the owner added.

## Existing controls
- Access proxy (owner only); `HOST=127.0.0.1` recommended when the tunnel is local.
- Webhook HMAC (`signedByGitHub`), and a delivery only names which PR to re-read.
- Pty WebSocket same-origin check (`isSameOrigin` in `terminal.ts`); short-lived credentialed socket URLs for desktop/browser (`Machine.socketUrl`, Modal connect tokens).
- Token kept out of agent-used sandboxes; pushes rebuilt via the API.
- Local sandbox `shellEnv` passes only PATH/HOME/LANG.
- Outputs download as `application/octet-stream` except images/PDF; SVG sandboxed with CSP; `nosniff`.
- `page-fetch.ts` SSRF guard (public IPs only, every redirect, no cookies, size/time limits).
- Mail sends need owner approval bound to a draft digest.
- Plan mode refuses writes; spending caps (`budget.ts`); secret redaction (`redact.ts`, `hideSecrets` default on).
- Request bodies validated with valibot (`body()` in `app.ts`).

## Open questions
- None outstanding. (Answered: nothing bypasses the proxy; sandbox egress is allowlisted.)
