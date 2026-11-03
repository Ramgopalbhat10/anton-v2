# Rules, in full

The short rules in [AGENTS.md](../../AGENTS.md), with their reasons.

- Viewing a task (files, changes, library) never starts a sandbox. A task starts read-only: the agent answers from a snapshot of the repo on Anton's side (`repo-snapshot.ts`; given `repo` as `owner/name@ref`, the same tools read any GitHub repository the token reaches, its branch or tag resolved once per ten minutes) and starts its sandbox with `start_workspace` only when it must edit or run code. The terminal, Resume and restoring a checkpoint also start one; a task that has had a machine keeps using it.
- Git credentials stay out of machines the agent has used: `git.gitAuthEnv()` is only for setup, before the agent or terminal gets the machine, and pushes go through the git host's API (`pushCommits`), never `git push` in the sandbox.
- New outside services go behind a port in `src/core/ports.ts`, not called directly from services.
- Pages update from server events (`GET /api/events`), not polling: a change the UI shows is announced with `announce()` from `src/core/changes.ts`, and `src/web/lib/live-updates.ts` maps it to the queries to refetch. Polling is only a slow safety net.
- Storage cleanup (`storage.ts`) removes only what is left of tasks this database deleted (`deleted_sessions`), never a task it does not know: a bucket can be shared with another server or a development copy, and a copy pointed at production storage once deleted every task's files.
- Nothing a page or a message waits on lists models from a vendor when a list is in hand: OpenRouter's catalog, each plan's list and Claude Code's status probe serve the last answer and fetch the next behind it (the gateway's list and the browser's are saved for the first load after a restart). Startup primes only the tasks whose replies the runtime resumes (`unsettledTasks`); a message primes its task in parallel and waits only for MCP servers never read.
- Services never import the agents; messages Anton sends on its own go through `sendToAgent` in `agent-runner.ts` (to the coder or the reviewer), so the caps apply to them too.

- A repository task's sandbox also starts as its agent starts a reply (`prewarmMachine` in `src/services/workspace.ts`, off with `ANTON_PREWARM_SANDBOX=0`), never for a chat, a task planning or reviewing, one that runs on this server, or one that only views; an unused one stops after its idle minutes.
