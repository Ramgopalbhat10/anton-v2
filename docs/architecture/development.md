# Development notes

Production start, Flue patches, and the task-page profiler. Linked from [AGENTS.md](../../AGENTS.md).

- `npm run build && npm start` — production on `PORT`; `npm run start:backup` does the same under Litestream, which restores and streams both SQLite files to Tigris (`litestream.yml`)
- `npm install` runs `scripts/patch-flue.ts`, which fixes Flue runtime bugs: a reply failing with "Skill name … appears in both agent definition and workspace discovery" when `start_workspace` brings up a sandbox whose repo has `.agents/skills` (drop it once Flue fixes `swapDiscovery`); a subagent on a model of its own copying its parent's compaction reserve, and so compacting at a few tens of thousands of tokens; and `flue.db` opened without a busy timeout, so a write meeting Litestream's lock failed with "database is locked". `anton.db`'s statements wait for such a lock the same way (`whenFree` in `src/db/client.ts`).
- `npx vite build --config scripts/perf/vite.config.ts && node scripts/perf/profile.ts [label] [--panel=Files|Changes|Agents]` — profiles a task page in Chromium while a scripted reply streams with three subagents (fake runtime and API, no keys): renders, long tasks, frames, input delay and heap
- `npx flue run src/agents/coder.ts --message "Say ready."` (needs an LLM key)
