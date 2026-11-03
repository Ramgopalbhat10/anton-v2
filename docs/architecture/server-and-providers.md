# Server, providers and Flue

Linked from [AGENTS.md](../../AGENTS.md).

- `src/core/ports.ts` — the interfaces every provider implements (sandbox, object store, git host, model catalog, plans). `src/providers/index.ts` picks implementations from config.
- `src/providers/` — Modal, Docker, local, S3, disk, GitHub, OpenRouter, Vercel, and the plans: ChatGPT, Claude Code (`claude-code/runtime.ts`, the only file importing the Claude Agent SDK), OpenCode Go and Cursor (`cursor/plan.ts`, the only file importing `@cursor/sdk`).
- `src/flue/` — adapters into Flue: the machine sandbox driver, `live-models.ts` (any catalog model resolves), and the plan bridges (`subscription-models.ts`, `opencode-go-models.ts`, `claude-code-models.ts`).
- `src/db/` — libSQL client, versioned migrations, queries. `src/app.ts` — Hono routes. `src/server.ts` — production server.
- Gotcha: Cloudflare closes a request at 100 seconds, so Stop and Delete answer by `ANSWER_MS` and finish behind the answer (`answer-within.ts`).
- Gotcha: Cursor moves tool results over 40KB into a file its own (disabled) tools would read, so `cursor/plan.ts` hands long results back in parts through `read_tool_output`, and gives each agent an in-memory store, since the SDK's JSONL store rereads its whole file per update.
