# Context, compaction and traces

Linked from [AGENTS.md](../../AGENTS.md). Every model call resends the whole conversation, so most rules here exist to keep it small and the prompt cache warm.

- `src/services/context-usage.ts` — the context meter and where agents compact (`compactionFor`: Settings › General's Compact at, 200K by default, and Compact Claude Code at for Claude Code's models, `compactionCeilingFor`; the summary comes from the compaction model and effort picked there, else the agent's own at `high`). A compaction keeps a fifth of the context word for word (`keptAfterCompaction`), so the agent does not reread its files.
- `src/flue/tool-result-cut.ts` — cuts tool results past 50KB, web searches past 12KB and fetches past 24KB (`LIMITS`); the agent reads on with `read_full_result` (`tool-results.ts`). Long web results are digested by a fast model instead (`web-digest.ts`) when that pays (`digestPays`).
- `src/services/context-prune.ts` — past half the compaction point, old tool results go as one-line stubs, in batches that pay back their cache miss (`warmShare`). Cleared stays cleared so the cache holds. Never on Claude Code or Cursor, and never drop reasoning on the Responses API.
- Anything that changes a running task's system prompt or tool list busts its cache: connectors are looked up through tools for that reason, and repo notes and project memory are read once per task.
- `src/services/response-trace.ts` — each Coder reply's trace (model calls split by prompt part, cache reads and writes, tool calls, subagents), saved in `response_traces` (latest 100 per task). `cacheVerdict` explains each hit or miss.
