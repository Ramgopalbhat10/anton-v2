# Agents, subagents and skills

Linked from [AGENTS.md](../../AGENTS.md).

- `src/agents/coder.ts` — the Coder. It reads a repo snapshot until `start_workspace`, then gets the sandbox, explorer, tester, browser and computer subagents, and `open_pull_request`. Its prompts live here: `WORKSPACE_PROMPT`, `CHAT_WORKSPACE_PROMPT`, `READ_HINT`, `FINISH_HINT`, `REQUIREMENTS_HINT`.
- How it checks work: type check and focused tests itself while working, the changed package's whole suite once before finishing (in the background, failures read from a log). A UI change gets one Playwright script; the browser subagent is for flows a script cannot express. A change opens its pull request in the same reply once it works.
- Do not loosen the DeepSWE verification: the requirement todos and their evidence, `FINISH_HINT`, the finish review (`src/services/finish-review.ts`, `selfCheck` on plan models) and the stall check (`reply-check.ts`) carry the benchmark results. Make it faster by cutting waste, not checks.
- `src/services/code-mode.ts` — `run_script`: one QuickJS program that calls the read-only tools, MCP servers and `decide()`.
- `src/services/subagent-runs.ts` — what subagents do, saved per task; a run past `SUBAGENT_BUDGET_MS` (20 minutes) is ended with a note. `src/flue/subagent-stop.ts` stops one on its own.
- Browser work: `browser-step.ts` (one step, settles on quiet network or a still DOM, never `networkidle`), `browser-autopilot.ts` (drives `do` steps, stops before any click that may buy, send, post or delete unless confirmed), `page-memory.ts`, `page-judge.ts`. Reading pages goes to `web_search`/`web_fetch`, not the browser.
- `src/agents/reviewer.ts` — reviews each push read-only and posts through `post_review` (`REVIEW_GUIDE`: correctness, then security). `review-tasks.ts` makes a task for reviewing anyone's pull request.
- Skills and plugins: `src/core/plugins.ts` reads them, `src/services/plugins.ts` installs them, `skill-files.ts` copies their files into the sandbox (as a saved script, since piping to `bash -s` is very slow under gVisor).
- Limits: a Coder turn may run 4 hours (`Coder.durability`); a command with no timeout stops after 10 minutes (`COMMAND_TIMEOUT_MS`).
