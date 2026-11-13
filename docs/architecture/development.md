# Development notes

Linked from [AGENTS.md](../../AGENTS.md).

- `npm run build && npm start` runs production on `PORT`; `npm run start:backup` runs it under Litestream, streaming both SQLite files to Tigris (`litestream.yml`).
- `npm install` runs `scripts/patch-flue.ts`, which patches Flue bugs: duplicate skill names when a repo has `.agents/skills`, subagents copying their parent's compaction reserve, and `flue.db` opened without a busy timeout. Drop each patch once Flue fixes it.
- `scripts/perf/profile.ts` profiles a task page in Chromium with a scripted reply (no keys needed).
- `npm run ui:fixture` serves the real UI on Vite's dev server with `@flue/sdk` swapped for scripted conversations (`scripts/ui/chat-sdk.ts`) and the API mocked (`scripts/perf/mock-api.ts`, which answers any task as its scripted one). In a task's sandbox it binds the first of `$ANTON_PREVIEW_PORTS`, so Preview shows it; elsewhere `UI_FIXTURE_PORT` or 43160. Every conversation (`/agents/perf-task`, `/incognito`, a project's coordinator) starts with 8 long turns (`?turns=0` for none, `?turns=20` for more), and sending a message streams a reply. A Playwright script drives the conversation on screen through `window.__chat`: `send(text?, { chars, ms })` and `reply(...)` resolve once the reply settles, `streaming()` and `info()` report. It is the quick way to check layout, scrolling and streaming: a script against it runs in seconds, and the incognito scroll bug of PR #195 shows on it as a scroller as tall as its content (11,538px of 11,538px) and the fix as a 648px one.
- `npx flue run src/agents/coder.ts --message "Say ready."` tries the Coder (needs an LLM key).
