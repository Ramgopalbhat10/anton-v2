# Anton v2 Coding Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Anton v2, a Cursor-agents-style web app: GitHub-connected coding sessions on a Modal snapshot VM, Flue 2.0 agent, Git/Terminal/Files from the live sandbox, PR loop.

**Architecture:** One Vite project (`@flue/vite` + Hono in `src/app.ts`, React 19 + TanStack Router client). Local fallback uses Flue `local()` and a file libSQL database so the UI and agent work without Modal/Turso/GitHub. Production path: Modal filesystem snapshots, Turso, OpenRouter, Tigris blobs only.

**Tech Stack:** Flue 2.0, React 19, TanStack Router + Query, Tailwind v4, shadcn/ui, `@pierre/diffs` + `@pierre/trees`, xterm.js, `@flue/libsql`, Modal JS SDK, Tigris S3.

## Global Constraints

- App name: **Anton v2**. Package name: `anton-v2`.
- Node `>=22.19.0`. Official scaffold via `flue init --target node --deploy`.
- Default model specifier: `openrouter/anthropic/claude-sonnet-4`. Composer picker lists OpenRouter ids from a small allowlist.
- Live Git/Files/Terminal always come from the sandbox, never Tigris.
- Tigris stores only logs, memory packs, artifacts.
- One snapshot lineage per project; one warm sandbox per project; attach-or-wait, do not fork.
- Flue subagents share the parent sandbox; explorer and tester write report files; parent owns commits/PRs.
- No secrets in git. Placeholders live in `.env.example`.
- Dev server binds `0.0.0.0:43127`.
- Copy is real product copy, not lorem. Dark Cursor-agents chrome.

## File structure (locked)

```
src/app.ts                          Hono: OAuth, /api/*, agent mount
src/db.ts                           @flue/libsql adapter (Turso or file)
src/agents/coder.ts                 CodingAgent + explorer/tester subagents
src/lib/env.ts                      typed env with local fallbacks
src/lib/crypto.ts                   token encrypt/decrypt
src/lib/github.ts                   OAuth + repo list + PR helpers
src/lib/sessions.ts                 session state machine
src/lib/sandbox.ts                  create/restore/stop Modal or local sandbox
src/lib/vm-proxy.ts                 fs, git, pty against live sandbox
src/lib/tigris.ts                   optional blob put/get
src/lib/models.ts                   OpenRouter allowlist
src/web/main.tsx                    React 19 entry
src/web/routes.tsx                  TanStack Router tree
src/web/styles.css                  Tailwind + shadcn tokens
src/web/components/icon-rail.tsx
src/web/components/chat-sidebar.tsx
src/web/components/thread.tsx
src/web/components/composer.tsx
src/web/components/vm-panel.tsx
src/web/components/git-tab.tsx
src/web/components/files-tab.tsx
src/web/components/terminal-tab.tsx
src/web/lib/flue-client.ts
tests/sessions.test.ts
tests/sandbox-lifecycle.test.ts
tests/coder-agent.test.ts
.env.example
.cursor/environment.json
```

---

### Task 1: Scaffold Flue Node deploy + env placeholders

**Files:**
- Create via `npx @flue/cli init /tmp/anton-v2-scaffold --target node --deploy`
- Move generated files to `/workspace` (keep `docs/superpowers/**`)
- Create: `.env.example`
- Modify: generated `.env` (placeholders only), `package.json` name `anton-v2`

**Interfaces:**
- Consumes: empty workspace except docs + git
- Produces: `flue.config.ts` (`target: 'node'`), `vite.config.ts` with `flue()`, `src/app.ts` Hono app, `src/db.ts` libSQL adapter, `src/agents/hello.ts` to be renamed in Task 3

- [ ] **Step 1: Scaffold**

```bash
npx --yes @flue/cli init /tmp/anton-v2-scaffold --target node --deploy
```

Expected: `flue.config.ts`, `vite.config.ts`, `src/app.ts`, `src/db.ts`, `src/agents/hello.ts`, `.env`, `package.json`.

- [ ] **Step 2: Move into /workspace** without deleting `docs/superpowers`.

- [ ] **Step 3: Write `.env.example`**

```
OPENROUTER_API_KEY=
ANTHROPIC_API_KEY=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_CALLBACK_URL=http://127.0.0.1:43127/api/auth/github/callback
TURSO_DATABASE_URL=file:./data/anton.db
TURSO_AUTH_TOKEN=
MODAL_TOKEN_ID=
MODAL_TOKEN_SECRET=
TIGRIS_ENDPOINT=
TIGRIS_BUCKET=
TIGRIS_ACCESS_KEY_ID=
TIGRIS_SECRET_ACCESS_KEY=
SESSION_SECRET=dev-session-secret-change-me
TOKEN_ENCRYPTION_KEY=dev-token-key-change-me-32b
ANTON_DEV_USER=1
```

`ANTON_DEV_USER=1` enables local-unauthenticated operator for Phase 1–4.

- [ ] **Step 4: `npm install` and `npx vite build`** (or `npm run check:types` if generated). Fix only scaffold errors.

- [ ] **Step 5: Commit** `chore: scaffold anton-v2 with flue init`

---

### Task 2: React 19 + TanStack Router + shadcn Cursor-agents shell

**Files:**
- Create: `src/web/**` listed above (shell with mock session data first)
- Modify: `vite.config.ts` to add React + TanStack Router plugins alongside `flue()`, `src/app.ts` to serve the client in dev
- Test: visual — `/` renders sidebar + thread + VM panel empty states

**Interfaces:**
- Consumes: Vite/Flue server
- Produces: routes `/` and `/agents/$sessionId`; `VmPanel` tabs `git` | `terminal` | `files`; composer model picker using `OPENROUTER_MODELS` from `src/lib/models.ts`

```ts
export const OPENROUTER_MODELS = [
  { id: 'openrouter/anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' },
  { id: 'openrouter/anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5' },
  { id: 'openrouter/moonshotai/kimi-k2.6', label: 'Kimi K2.6' },
] as const;
```

- [ ] **Step 1:** Add `react`, `react-dom`, `@tanstack/react-router`, `@tanstack/react-query`, `@tanstack/router-plugin`, Tailwind, shadcn (`npx shadcn@latest init` + button, tabs, scroll-area, dropdown-menu, tooltip, sonner, separator, sheet, dialog, avatar, badge, empty, input, textarea, skeleton, alert).
- [ ] **Step 2:** Implement shell matching Cursor agents (icon rail, chat list, thread, collapsible Git/Terminal/Files panel). Empty Git: “No pushed changes.”
- [ ] **Step 3:** Bind Vite to port `43127`, host `0.0.0.0`.
- [ ] **Step 4:** Commit `feat: add Cursor-style agent shell`

---

### Task 3: CodingAgent + local sandbox + session API

**Files:**
- Create: `src/agents/coder.ts`, `src/lib/sessions.ts`, `src/lib/sandbox.ts`, `src/lib/env.ts`, `tests/sessions.test.ts`, `tests/coder-agent.test.ts`
- Modify: `src/app.ts` mount `app.route('/agents/coder', createAgentRouter(Coder))` and `/api/sessions`

**Interfaces:**

```ts
export type SessionStatus = 'starting' | 'running' | 'error' | 'stopped';

export type Session = {
  id: string;
  projectId: string;
  flueConversationId: string;
  sandboxId: string | null;
  status: SessionStatus;
  model: string;
  prUrl: string | null;
  errorMessage: string | null;
  createdAt: string;
};

export function createSession(input: { projectId: string; model: string }): Promise<Session>;
export function getSession(id: string): Promise<Session | null>;
export function listSessions(): Promise<Session[]>;
export function stopSession(id: string): Promise<Session>;

export async function attachSandbox(session: Session): Promise<{ sandbox: unknown; cwd: string }>;
```

`Coder` agent:

```ts
'use agent';
export function Coder() {
  useModel(modelFromSession()); // default openrouter/anthropic/claude-sonnet-4
  useSandbox(localFactory);     // local() when no Modal tokens
  useSubagent(explorer);
  useSubagent(tester);
  useTool(openPullRequest);
  return instructions;
}
```

- [ ] **Step 1:** Write `tests/sessions.test.ts` covering first create → `starting` then `running`; `stopSession` sets `stopped` and `sandboxId` null; second session on same project does not create a second sandbox while one is warm.
- [ ] **Step 2:** Run tests — fail.
- [ ] **Step 3:** Implement sessions + local sandbox workspace directory `data/workspaces/<projectId>` (git init if missing).
- [ ] **Step 4:** Tests pass. Agent module renamed from hello. `flue run src/agents/coder.ts --message "Reply with the word ready."` if `OPENROUTER_API_KEY` is set; otherwise skip live run and keep unit tests.
- [ ] **Step 5:** Commit `feat: add Coder agent and session state machine`

---

### Task 4: VM proxy — Git, Files, Terminal

**Files:**
- Create: `src/lib/vm-proxy.ts`, `src/web/components/git-tab.tsx`, `files-tab.tsx`, `terminal-tab.tsx`
- Modify: `src/app.ts` `/api/vm/:sessionId/fs`, `/api/vm/:sessionId/git`, `/api/vm/:sessionId/pty`
- Test: `tests/vm-proxy.test.ts` with a fixture git repo

**Interfaces:**

```ts
export type GitStatus = {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  patch: string; // unified diff vs upstream or HEAD
  log: Array<{ sha: string; subject: string; at: string }>;
};

export function listPaths(cwd: string): Promise<string[]>;
export function readFile(cwd: string, path: string): Promise<string>;
export function gitStatus(cwd: string): Promise<GitStatus>;
```

Pierre: Files tab uses `@pierre/trees/react`; Git Diff uses `@pierre/diffs/react` `parsePatchFiles` + `CodeView`. Empty patch → copy “No pushed changes.”

Terminal: xterm.js + node-pty (local) or Modal exec stream. WebSocket `/api/vm/:sessionId/pty`.

- [ ] **Step 1:** Fixture tests for `gitStatus` empty vs dirty.
- [ ] **Step 2:** Implement proxy + UI wiring to live session cwd.
- [ ] **Step 3:** Commit `feat: stream Git Files and Terminal from the sandbox`

---

### Task 5: GitHub OAuth + repo picker + open_pull_request

**Files:** `src/lib/github.ts`, `src/lib/crypto.ts`, OAuth routes, `RepoPickerDialog`, `open_pull_request` tool in `coder.ts`.

When `GITHUB_CLIENT_ID` is unset, New Chat uses the local `dev` project (`ANTON_DEV_USER`). When set: OAuth, encrypt token, list repos, clone into sandbox on first pick.

`open_pull_request` runs in the sandbox (`gh pr create` or git push + API). Writes `sessions.prUrl`.

- [ ] Tests for crypto roundtrip and OAuth state.
- [ ] Commit `feat: GitHub OAuth, repo picker, and PR tool`

---

### Task 6: Modal snapshot lifecycle + Tigris blobs

**Files:** `src/lib/sandbox.ts` Modal path, `src/lib/tigris.ts`.

If `MODAL_TOKEN_ID` set: create sandbox from base image or `snapshot_image_id`; inject GitHub secret; snapshot on stop; no volume. If Tigris keys set: put session log on stop; never store tree/diff/pty.

- [ ] Tests: mock Modal client — first boot clones, stop stores snapshot id, second boot uses snapshot not clone; missing snapshot triggers reclone path.
- [ ] Commit `feat: Modal filesystem snapshots and Tigris artifacts`

---

### Task 7: Environment + README

**Files:** `.cursor/environment.json`, `README.md`, `package.json` scripts `dev` (`vite --host 0.0.0.0 --port 43127`).

```json
{
  "name": "Anton v2",
  "install": "npm ci",
  "terminals": [{ "name": "dev", "command": "npm run dev" }]
}
```

Secrets stay optional for local fallback. Document required vars for GitHub/Modal/OpenRouter/Turso/Tigris.

- [ ] Commit `docs: README and Cloud Agent environment`

---

## Spec coverage

| Spec item | Task |
| --- | --- |
| Flue Vite monolith | 1 |
| Cursor agents UI | 2 |
| OpenRouter picker | 2–3 |
| Sessions + local/Modal sandbox | 3, 6 |
| Git/Terminal/Files from VM | 4 |
| Explorer/tester subagents | 3 |
| PR loop + GitHub OAuth | 5 |
| Snapshot not Tigris for tree | 6 |
| Tigris logs/artifacts only | 6 |
| Env placeholders | 1, 7 |
| Idle 15m stop | 3 (timer in sessions) |

## Execution

User asked to implement phase by phase in this session (inline). Origin `anton-v2` creation requires a user action (token cannot create mrgb repos); keep shipping on the current branch and push to `anton-v2` when the repo exists.
