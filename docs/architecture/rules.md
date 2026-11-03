# Rules, with reasons

The rules in [AGENTS.md](../../AGENTS.md), and why they hold.

- Viewing a task never starts a sandbox. A task answers from a repo snapshot (`repo-snapshot.ts`) and starts its sandbox with `start_workspace` only to edit or run code. Sandboxes cost money and time.
- Git credentials stay out of machines: `gitAuthEnv()` is only for setup before the agent or terminal gets the machine, and pushes go through the git host's API (`pushCommits`). The agent can run anything in its sandbox.
- New outside services go behind a port in `src/core/ports.ts`, so providers stay swappable and testable.
- Pages update from `GET /api/events` (`announce()` in `src/core/changes.ts`); polling is only a slow safety net.
- Storage cleanup (`storage.ts`) removes only tasks this database deleted (`deleted_sessions`): a bucket can be shared, and a copy pointed at production once deleted every task's files.
- Model lists serve the last answer and fetch the next behind it, so no page or message waits on a vendor.
- Services never import the agents; Anton's own messages go through `sendToAgent` in `agent-runner.ts`, so spending caps apply to them too.
