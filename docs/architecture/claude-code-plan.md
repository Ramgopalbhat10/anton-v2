# Claude plans through Claude Code

Linked from [models-and-plans](models-and-plans.md). Built; not yet tried end to end against a real Claude account.

ChatGPT plans work by Anton holding the plan's token and calling the API. Claude plans cannot: Anton runs the unmodified Claude Code binary (through the Claude Agent SDK) as the model, and Claude Code calls Anton's tools.

## What Anthropic allows

From [Claude Code: legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) (read October 2026): Claude sign-in is for Claude Code and Anthropic's own apps; third parties may not offer Claude.ai sign-in, route requests through Free/Pro/Max credentials for their users, or "collect, store, or intermediate Claude.ai credentials or session tokens". An end user may sign the unmodified Claude Code binary in with their own plan, including where a platform hosts it. Since January 2026 Anthropic's servers accept plan tokens only from Claude Code. Agent SDK usage draws on the plan's limits ([support article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)).

| Route | Allowed |
|---|---|
| pi-ai's `anthropic` OAuth (impersonates Claude Code's client) | No: the forbidden, blocked pattern |
| Store a `claude setup-token` token and call the Messages API | No: Anton would hold the token |
| Run unmodified `claude`, signed in through its own flow, for the one owner of this Anton | Yes, personal use only; not if Anton is ever offered to others |
| Max/Team API credits through an API key | Yes (plain API) |

## Where it runs and sign-in

- On Anton's server, never in a sandbox: a task starts with no sandbox, and credentials stay out of machines the agent used. Claude Code runs with every built-in tool off and can call only Anton's tools over MCP; it never edits files or runs commands on the server.
- Config: `CLAUDE_CONFIG_DIR=<dataDir>/claude-code` (and `HOME` the same), so it reads no other sign-in. Litestream backs up only the databases, so the sign-in survives a restart only on a lasting data disk.
- Sign in (`startSignIn` in `src/providers/claude-code/runtime.ts`): Anton runs `claude auth login --claudeai` with no terminal and `BROWSER` a no-op, opens the URL it prints, and passes the code Claude's page shows to it on stdin. Anton relays only that one-time code, never sees the token. A refused code ends that login, so the card starts a new one; the sign-in waits 10 minutes in memory. Sign out runs `claude auth logout`. `signInCommand` is the fallback for a runtime without `signIn`, and Check again reads a sign-in made by hand.
- The child gets only `PATH`, locale, `TMPDIR`, proxy and CA variables, never `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN`, so it can bill only the plan it signed in to. A sign-in reporting an API key or cloud provider shows Needs attention and lists no models.
- Status comes from the SDK's `accountInfo()` and `supportedModels()` (signed in, plan, email; no token).

## The provider (`src/flue/claude-code-models.ts`)

- Provider id `claude-code`; models from `supportedModels()` (aliases resolved, `default` dropped), with output sizes and prices from pi's `ANTHROPIC_MODELS` (or the newest same-family model). Context per model comes from the status probe switching its idle session to each model (`setModel`) and reading `getContextUsage({ detail: 'summary' })`, which makes no model call; otherwise 1M for a `[1m]` name, else 200K. Claude Code's models compact at Settings › General's Compact Claude Code at (200K default), since each call rereads the thread on the plan's limits. A model with `supportsFastMode` gets a `[fast]` variant that opens Claude Code with `fastMode` and bills paid extra usage. The card's 5-hour and weekly limits come from the SDK's experimental `/usage` answer, left out when it fails.
- `auth.apiKey.resolve` returns a placeholder (the binary authenticates itself). A model is listed only while Claude Code reports a sign-in.

## One model call

Flue calls the model once per step; the Agent SDK runs a whole loop and calls tools itself. The bridge meets them at tool calls:

1. `streamSimple(model, context)` looks up a live bridge session keyed by `options.sessionId`.
2. With none, or when `context` no longer extends what the session saw (compaction, fork, edit, restart), it starts a new `query()`: `systemPrompt` preset `claude_code` with Anton's prompt appended (keeping Claude Code's prompt is the safer reading of "unmodified"); `tools: []`; one in-process MCP server serving Flue's tool schemas (marked `anthropic/alwaysLoad`), `allowedTools: ['mcp__anton']`, `permissionMode: 'dontAsk'`; `settingSources: []`, `strictMcpConfig`, `persistSession: false`, so no settings, hooks, memory or session files; auto-compaction and auto-memory off by environment (Flue compacts); `cwd` an empty folder; thinking and effort mapped from Flue's level. Earlier turns go as a `<conversation_so_far>` transcript in the first user message (signed thinking is lost; acceptable). A tool list that changed alone does not restart the session when the runtime implements `setTools` — the bridge swaps the served list and notifies `tools/list_changed` — because MCP servers connect lazily mid-conversation; model, instructions and effort changes still do.
3. SDK stream events (`includePartialMessages`) become pi `text_*`, `thinking_*` and `toolcall_*` events; a step ends at `message_stop`.
4. A call ending in tool calls ends the pi stream with `toolUse`. When Claude Code then calls `mcp__anton__<tool>`, the handler does not run it: it parks a promise, matched by the `claudecode/toolUseId` on the MCP call.
5. Flue runs the tools and calls `streamSimple` again; the bridge sees the old context plus results, resolves the parked calls (or holds a result until asked), and streams on in the same `query()`. Parallel calls work the same way, each resolved whenever Claude Code asks.
6. A call with no tool calls ends with `stop`; the SDK's following `result` is skipped, and the next user message goes into the same `query()`.
7. Abort, error or mismatch closes the `query()`; the next step replays the transcript. Idle conversations close at 55 minutes (under Claude Code's one-hour cache for a plan; a replayed one matches nothing cached). One waiting on Anton's tools (a subagent) is never closed.

## Cost and limits

- Usage is recorded in tokens at $0, or at API prices toward the caps (the same `SubscriptionOptions` as ChatGPT).
- A plan limit (rate-limit events, an `assistant` error or `result.is_error`) becomes the error "Claude plan limit reached: <message>" and is noted for the usage views. When Claude Code reports paid extra usage, the card warns and links claude.ai/settings/usage; the owner should turn extra usage off there so tasks stop at the limit.
- At most `ANTON_CLAUDE_CODE_MAX_OPEN` (3) conversations stay open; a new one closes the longest idle. Busy ones are never closed, so the cap can be passed briefly.

## Ports and files

- `AgentRuntime` in `src/core/ports.ts` (not `SubscriptionProvider`, which assumes Anton holds an OAuth token): `status()`, `listModels()`, `signIn()`, `signOut()`, `signInCommand`, and `open()`, a conversation that takes user content, calls back per tool (`callTool`) and yields `RuntimeEvent`s. The bridge sees only these, never SDK types.
- `src/providers/claude-code/runtime.ts` is the only importer of `@anthropic-ai/claude-agent-sdk`.
- `src/services/models/subscriptions.ts` lists runtimes beside OAuth plans (`subscriptionsView()`, `subscriptionModels()`, `planUsage()`); `runtimeHooks()` tells the bridge where to note limits and extra usage.
- Tests: `tests/claude-code.test.ts` (bridge against a fake `AgentRuntime`, SDK mapping, status, environment), `tests/ui/subscriptions.test.tsx` (the card). Not done: an opt-in end-to-end run against a signed-in `claude`.

## Risks

- Policy can change; surface whatever the SDK reports rather than guess.
- Replacing Claude Code's system prompt entirely is a gray area, so it is appended to.
- Latency: a process per conversation and a pause per tool call; measure before making it a default.
- The SDK bundles a native `claude` per platform; the deploy target's `npm ci` must install the linux-x64 one.
