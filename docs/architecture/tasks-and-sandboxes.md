# Tasks and sandboxes

Linked from [AGENTS.md](../../AGENTS.md).

- `src/services/` holds the task lifecycle: `sessions.ts`, `workspace.ts` (acquire and set up a machine; kept in memory 20 seconds after a request and while its agent works), `git.ts`, `checkpoints.ts`, `files.ts`, terminal, previews and the in-machine browser.
- A sandbox stops its idle minutes (default 5) after its agent finishes (`idle-stop.ts`, checkpoint first). Only the agent working, an open terminal or a taken-over computer count as use, never reading files. A reply's checkpoint is written after it ends (`queueCheckpoint` in `coder.ts`), so the reply never waits on it.
- Warm images: a repo's first task saves one after setup, and a task starting from one past three quarters of its days (`RENEW_SHARE`) saves a new one, so no task waits on clone, install and snapshot. Setup is waited for, so nothing the agent does gets into an image.
- Previews: `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` carries the preview tunnels' hostnames (`previewHosts`), so a Vite dev server answers Preview on the first try.
- A repository task's sandbox starts as its agent starts a reply (`prewarmMachine`, off with `ANTON_PREWARM_SANDBOX=0`); not for chats, plans, reviews or host tasks.
- `src/services/agent-now.ts` — what the agent is doing this moment, from live events that are never replayed. Messages sent while it works wait in the runtime's queue (`waiting.ts`), and `joins.ts` notes where the agent read them.
- Chats are tasks with no repository (`projectId` null, stored as `''`). `start_workspace` gives them a scratch git folder (`initScratch`); no plan mode, repo notes or pull request.
- `run_on` picks the runner (`src/services/runners.ts`): the sandbox or `host`. Changing it stops the machine and clears `machine_state`.
- Sealed secrets (`sealed-secrets.ts`) never reach a machine or the model: `http_request` fills `{{secret:NAME}}` on the server, checks the secret's hosts first and hides the values in the answer.
- `host-commits.ts` brings a GitHub commit into a machine without credentials (`refs/replace/<sha>`).
- `headless.ts` polls labeled issues, PR follow-ups (`pr-watch.ts`, ETag-conditional reads) and scheduled routines (`src/core/schedule.ts`); all reach the agent through `agent-runner.ts`, which enforces the spending caps (`budget.ts`).
- `scripts/anton-run.ts` (`npm run anton:run`) runs tasks without the UI for benchmarks and before/after checks of harness changes.
