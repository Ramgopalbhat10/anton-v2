# Coding Agent Workspace — Design Spec

Date: 2026-09-15  
Status: draft for user review  
First slice: coding workspace (plugin catalog is a later spec)

This spec is the contract for the first product slice: a personal, multi-device web app where a user signs in with GitHub, opens a repo on a Modal snapshot VM, chats with a Flue 2.0 coding agent, sees Git / Terminal / Files from that VM, and can commit, push, and open a pull request.

## Goal

Ship one usable loop:

1. Sign in with GitHub OAuth and pick a repository.
2. Boot (or restore) a Modal sandbox from a filesystem snapshot that already has the repo cloned and git configured.
3. Chat with a Flue coding agent that can edit that VM. Specialists (explorer, tester) run as Flue subagents on the **same** VM.
4. Inspect work in a Cursor-agents-style UI: thread in the center; Git, Terminal, and Files on the right, all sourced from the live sandbox.
5. Open a PR on the connected GitHub repo.
6. On stop/idle, snapshot the VM so the next session starts quickly from that disk.

Success: a returning user opens a session, the VM is ready in seconds (no re-clone), the Git tab shows sandbox `git` state, the agent can change files, and a PR exists on GitHub.

## Non-goals (this slice)

- Plugin catalog, Agent Plugins marketplace, per-project vs global plugin install (follow-up spec).
- Desktop / VNC tab, Automations, Codebase browser as a separate Cursor product, Subscriptions.
- Multi-tenant billing, orgs, team workspaces.
- GitHub App (OAuth only).
- Memory snapshots (7-day TTL). Filesystem snapshots only.
- Forking a second writable VM when a project sandbox is busy.
- Mirroring the working tree, diffs, or terminal transcripts to object storage.

## Stack

- **App:** one Vite project. `@flue/vite` + Hono (`src/app.ts`) for the Node control plane and agent routes. React 19 + TanStack Router + TanStack Query + Tailwind + shadcn/ui for the UI. `@flue/react` + `@flue/sdk` for the thread.
- **Agent:** Flue 2.0 (`@flue/runtime`), Modal sandbox adapter, OpenRouter via Flue’s model specifier.
- **VM:** Modal Sandboxes, filesystem snapshots, Modal Secrets for GitHub tokens. Not Modal Volumes.
- **Records:** Turso via `@flue/libsql` (Flue `flue_*` tables) plus application tables in the same database.
- **Blobs:** Tigris (S3) for session logs, agent memory packs, and user artifacts only.
- **Git / files UI:** Pierre PatchDiff for git; a clickable workspace path list + file preview for Files (Pierre FileTree is not the live-VM viewer).
- **Terminal:** xterm.js attached to a PTY WebSocket on the **UI origin**, not tunneled through the Flue HTTP agent router.

Local fallback when Modal/Turso/Tigris/GitHub/OpenRouter are unset: Flue `local()` sandbox, libSQL file DB, skip blob uploads, skip OAuth (dev user). The production path is Modal + Turso + Tigris.

## Architecture

```
Browser (thin client, same pattern as Cursor agents / Devin)
  ├─ Chat HTTP/SSE ──► Flue/Hono :43128 /api/agents/coder/:id  ──tools──► sandbox cwd
  ├─ Git/Files REST ► Flue/Hono /api/vm/:id/{git,fs,file}     ──exec/read► sandbox disk
  └─ Terminal WS ───► UI Vite :43127 /vm/:id/pty              ──PTY──► bash in sandbox cwd

Control plane (must stay alive for in-flight Flue turns)
  ├─ CodingAgent + one warm sandbox per project
  ├─ GitHub OAuth + GitHub API / gh
  ├─ OpenRouter (model calls stay on the control plane)
  ├─ Turso (session records only)
  └─ Tigris (logs / memory / artifacts — never live tree/diff/PTY)
```

Cursor, Devin, Codex, and similar coding agents all use this split: the **sandbox disk is the source of truth**. The UI never reconstructs files from chat, object storage, or the LLM. Git is `git` in that tree. The terminal is a real PTY multiplexed over a machine channel. Agent HTTP is only for turns and tools.

Flue requires one live Node owner per agent instance. The UI is not serverless-only. Modal is the VM, not the place we host the web app unless we later deploy this same Node process there.

### Ownership split

| System | Owns | Does not own |
| --- | --- | --- |
| **Modal snapshot VM** | Repo files, `node_modules`, git config (`user.name` / `user.email`), installed tools, live `git` state, PTY | Conversation history, OAuth tokens at rest, queryable session index |
| **Turso** | Users, encrypted GitHub OAuth tokens, projects, sessions, snapshot/sandbox ids, PR URL, selected model, Flue conversation records | Working tree, diffs, PTY bytes |
| **Tigris** | Control-plane session logs, memory files (if kept outside git), user-uploaded artifacts | File contents, live diffs, interactive terminal |

Live UI never depends on Tigris. Cold start depends on Modal filesystem snapshot restore.

GitHub tokens are **Modal Secrets injected at sandbox boot**, not files in the snapshot image. After OAuth refresh, the next boot gets the new secret.

## UI

The shell matches Cursor’s agent web app (`cursor.com/agents/...` and `?app=code`), not a notes-vault two-pane editor.

- **Icon rail** (far left): home/sessions. Plugins later.
- **Chat sidebar:** New Chat; sessions grouped by Today / Yesterday / Last 7 days / Last 30 days; profile at the bottom.
- **Center:** Flue thread. User prompt as a quote block; thinking/status; todos; tool activity. Composer pinned at the bottom: attach (artifact → Tigris), OpenRouter model picker, send. Follow-ups stay on the same conversation id.
- **Header:** project/session title; overflow; toggle to show/hide the VM panel (closed vs `app=code`).
- **Right VM panel tabs:**
  - **Git:** repo name; `base → current` branch; sub-tabs Diff / Review / Commits. Pierre renders `git diff` / `git show` / `git log` from the sandbox. Empty Diff: “No pushed changes.”
  - **Terminal:** xterm PTY on the sandbox.
  - **Files:** path list from sandbox `fs` listing; click opens contents via sandbox file read.
- **Desktop** and **Subscriptions** are not in this slice.

New Chat requires a selected GitHub repo (dialog if none). Opening a session always targets that project’s snapshot lineage.

Mobile: sidebar and VM panel are drawers; the thread is the default surface.

Empty / loading / error:

- No GitHub: sign-in screen.
- No repos: empty picker with reconnect.
- Restoring snapshot: VM tabs show “Starting VM…”, composer disabled until sandbox is ready.
- VM error: explicit “VM unavailable” + retry, not an infinite spinner.
- Git clean: “No pushed changes.”
- PTY disconnect: reconnect to the same sandbox.

## Components

### UI units

- `IconRail`, `ChatSidebar`, `Thread` (`useFlueAgent`), `Composer`, `VmPanel`.
- `GitTab` (Pierre PatchDiff), `FilesTab` (path list + preview), `TerminalTab` (xterm on `/vm/:id/pty`).
- `RepoPickerDialog`, `GitHubReconnect`.

shadcn primitives: Button, Dialog, Dropdown Menu, Scroll Area, Tooltip, Tabs, Sonner.

### Control plane units

- `CodingAgent` (exported Flue agent).
- `sandboxes/modal.ts` (Flue Modal adapter wrapper). Snapshot create/restore lives in application code, not the adapter.
- `github/oauth.ts`, `github/repos.ts`, `github/pr.ts`.
- `vm/proxy.ts` — filesystem list/read, git porcelain, PTY. Always the live sandbox.
- `sessions.ts` — create/attach/stop, snapshot on stop, Turso writes.
- `open_pull_request` — Flue tool on the parent agent. Runs `git` + `gh pr create` (or GitHub API) in the sandbox using the injected token; writes `sessions.pr_url`.
- `tigris.ts` — put/get logs, memory packs, artifacts. Failures do not fail the session.

### Subagents (shared VM)

Flue subagents **cannot** call `useSandbox()`. They inherit the parent’s Modal sandbox. `task` may pass `cwd` to change directory inside that VM, never a second sandbox. Parallel `task` calls share one filesystem.

Mount:

- `explorer` — read-heavy investigation; writes `agent/explorer-report.md` (or similar under a reserved path) as the hand-off.
- `tester` — runs the project’s tests; writes `agent/test-report.md`.

The parent serializes write-heavy work and owns commits / push / PR. Specialists may run in parallel only when they do not contend on git index (reads and report files in disjoint paths). Nested `useSubagent` is allowed; depth cap is Flue’s (four). Specialists do not mount MCP (`useMcpConnection` throws in a subagent render).

## Data model (Turso)

Application tables (separate from Flue `flue_*`):

- `users` — `id`, `github_id`, `login`, `avatar_url`, `created_at`
- `oauth_tokens` — `user_id`, encrypted `access_token`, `refresh_token`, `expires_at`
- `projects` — `id`, `user_id`, `repo_full_name`, `default_branch`, `snapshot_image_id` (nullable until first snapshot), `updated_at`
- `sessions` — `id`, `project_id`, `flue_conversation_id`, `sandbox_id` (nullable when cold), `status` (`starting` | `running` | `error` | `stopped`), `model`, `pr_url` (nullable), `error_message` (nullable), `created_at`
- `artifacts` — `id`, `session_id`, `tigris_key`, `kind` (`log` | `memory` | `upload` | `other`), `created_at`

One snapshot lineage per project: `projects.snapshot_image_id` is the disk the next session boots from. One warm sandbox per project. A second session on the same project attaches to the warm sandbox if it exists; otherwise it waits until stop finishes the snapshot. No second writer.

## Data flow

### First project

1. OAuth; store encrypted tokens in Turso.
2. User picks `owner/repo`.
3. Boot Modal sandbox from the **base image** (git, `gh`, Node, common CLI).
4. Clone, `git config user.name/email` from GitHub profile, inject GitHub token as env from Modal Secret.
5. Filesystem snapshot; save `snapshot_image_id`; terminate compute if the user is not entering a chat yet.

### New Chat / open session

1. Insert `sessions` row with a new Flue conversation id and chosen OpenRouter model.
2. Create sandbox from `snapshot_image_id` (or first-project path if null). Inject current GitHub secret.
3. `CodingAgent` `useSandbox(modal(sandbox), { cwd: repo root })`. `useModel` receives the session’s OpenRouter model id in Flue’s provider string form (Pi/OpenRouter). Changing the picker updates the session row and the next turn’s `useModel` call.
4. Browser: thread via `@flue/react`; VM tabs via `/api/vm/:sessionId`.

### Agent turn

Follow-up → Flue `send()`. File/bash tools run in the VM. Git tab refreshes from sandbox git. Files tab reads sandbox FS. Terminal is the same machine. Workspace files are not written to Tigris.

### PR

Agent (parent) commits on a branch, pushes, opens a PR with `gh` or GitHub API. `sessions.pr_url` is stored. Git Diff shows the branch vs `default_branch`. Empty state remains “No pushed changes” only when there is nothing to push relative to upstream.

### Stop / idle

The header Stop control always snapshots then terminates. If there is no in-flight Flue turn and no live PTY for 15 minutes, the same path runs automatically. Sequence: filesystem snapshot → update `projects.snapshot_image_id` → terminate sandbox → `sessions.sandbox_id = null`, `status = stopped`. Next open restores that snapshot (no clone). Append-only session log object may go to Tigris; failure is ignored.

## Error handling

- **Snapshot missing / GC:** surface restore error; clone onto a new base image; snapshot again; do not pretend files are present.
- **Modal boot failure:** `status=error`, toast, retry. VM tabs: “VM unavailable.”
- **GitHub token expired:** VM and chat still work; push/PR shows reconnect CTA. New secret on next boot.
- **OpenRouter / model error:** turn fails; composer stays; retry or switch model. Do not mark partial stream as a settled assistant message.
- **PTY drop:** reconnect to the same sandbox.
- **Subagent git lock / conflict:** parent retries serially; error visible in thread and Terminal.
- **Tigris put/get failure:** session continues.
- **Refresh after a settled turn:** Flue/Turso history is the source; do not show “tool result is missing” for completed tool calls.

## Testing

- Session state machine: first clone → snapshot id set; restore uses snapshot not clone; stop clears `sandbox_id`; busy project does not create a second sandbox.
- Token handling: snapshot image creation is not given the raw token as a baked file; boot injects secret.
- `CodingAgent` render tests with a virtual/mock sandbox: explorer/tester are declared; they must not call `useSandbox`; parent has PR tool.
- VM proxy maps sandbox `git diff` into Pierre inputs (fixture patches).
- Router: unauthenticated `/` → login; session route shows starting vs running vs error.
- CI does not require live Modal. Optional local `flue run` with `local()` is documented, not gated.

## Plugin hook (not this slice)

Later, a GitHub-backed catalog of Agent Plugins 1.0 (`plugin.json`, `skills/`, `mcp.json`) will install globally or per project. This app will load those into `CodingAgent` with `useSkill` / `useMcpConnection` and store enablement in Turso. Client-specific extras go under a reverse-domain directory in the plugin package. This slice does not implement catalog UI, install, or MCP.

## Open decisions that are closed

| Topic | Decision |
| --- | --- |
| First sub-project | Coding workspace; plugins later |
| Tenancy | Personal SaaS: GitHub OAuth users, Turso per-user rows |
| Finish line | Clone → edit → commit → push → open PR |
| LLM | OpenRouter gateway, model picker in composer |
| GitHub | OAuth (not GitHub App) |
| App shape | Flue Vite monolith |
| VM persistence | Modal filesystem snapshots; not Volumes; not Tigris for the tree |
| Tigris | Logs, memory packs, artifacts only |
| UI | Cursor agent web app; VM tabs Git, Terminal, Files |
| Subagents | Explorer + tester specialists on the shared VM |
| Busy VM | Attach or wait; do not fork |
