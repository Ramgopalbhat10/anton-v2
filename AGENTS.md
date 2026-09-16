# AGENTS.md

Anton v2 is a Flue 2.0 coding agent with a React UI.

## Layout

- `src/agents/coder.ts` — Coder agent, explorer/tester subagents, `open_pull_request`.
- `src/app.ts` — Hono route map (sessions, VM proxy, agent mount).
- `src/db.ts` — Flue conversation persistence (SQLite file).
- `src/lib/` — sessions, local sandbox, git/fs proxy.
- `src/web/` — TanStack Router UI.

## Commands

- `npm test`
- `npm run dev` — UI on :43127, API on :43128
- `npx flue run src/agents/coder.ts --message "Say ready."` (needs an LLM key)
- `npx flue docs search <query>`
