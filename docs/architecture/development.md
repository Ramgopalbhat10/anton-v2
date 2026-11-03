# Development notes

Linked from [AGENTS.md](../../AGENTS.md).

- `npm run build && npm start` runs production on `PORT`; `npm run start:backup` runs it under Litestream, streaming both SQLite files to Tigris (`litestream.yml`).
- `npm install` runs `scripts/patch-flue.ts`, which patches Flue bugs: duplicate skill names when a repo has `.agents/skills`, subagents copying their parent's compaction reserve, and `flue.db` opened without a busy timeout. Drop each patch once Flue fixes it.
- `scripts/perf/profile.ts` profiles a task page in Chromium with a scripted reply (no keys needed).
- `npx flue run src/agents/coder.ts --message "Say ready."` tries the Coder (needs an LLM key).
