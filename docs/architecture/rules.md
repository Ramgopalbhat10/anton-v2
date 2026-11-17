# Rules, with reasons

The rules in [AGENTS.md](../../AGENTS.md), and why they hold.

- Viewing a task never starts a sandbox, and neither does reading. A repository task's `read`, `grep` and `glob` answer from a repo snapshot (`src/services/sandbox/repo-snapshot.ts`) until it has its workspace; its sandbox starts with its first command or change (a chat's with `start_workspace`). Sandboxes cost money and time.
- Git credentials stay out of machines: `gitAuthEnv()` is only for setup before the agent or terminal gets the machine, and pushes go through the git host's API (`pushCommits`). The agent can run anything in its sandbox.
- New outside services go behind a port in `src/core/ports.ts`, so providers stay swappable and testable.
- Pages update from `GET /api/events` (`announce()` in `src/core/changes.ts`); polling is only a slow safety net.
- Storage cleanup (`src/services/settings/storage.ts`) removes only tasks this database deleted (`deleted_sessions`): a bucket can be shared, and a copy pointed at production once deleted every task's files.
- Model lists serve the last answer and fetch the next behind it, so no page or message waits on a vendor.
- Services never import the agents; Anton's own messages go through `sendToAgent` in `src/services/tasks/agent-runner.ts`, so spending caps apply to them too.
- Code layout: no re-export barrels (`src/agents/coder/index.ts` and `src/providers/index.ts` hold code, not re-exports); import files directly with explicit `.ts` extensions (Node's type stripping cannot resolve directories). Only agent entry files carry `'use agent'`, since Flue registers every exported capitalized function in such a module as an agent keyed by its name; never rename `Coder`, `Coordinator` or `Reviewer`.
- Comments only for what the code cannot say: invariants and ordering, quirks of outside systems, security reasons, measured numbers behind constants, and traps.
- `src/web/lib/api.ts` composes the `api` object from `src/web/lib/api/*.ts` so tests can mock `'@/lib/api'`; components call the server through `api`, never a resource file's own object, and resource files never import `lib/api.ts`.
