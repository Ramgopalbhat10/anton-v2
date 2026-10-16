# Claude plans through Claude Code — design

Status: built, not yet tried against a real Claude account. Settings › Subscriptions has a Claude card. Where the build differs from the first design, this document now says what was built.

ChatGPT plans already work (`src/services/subscriptions.ts`, `src/providers/chatgpt/`, `src/flue/subscription-models.ts`): Anton signs in with OpenAI's Sign in with ChatGPT, keeps the token, and calls the Responses API with it. Claude cannot work the same way. This document says why, and how Anton can run tasks on a Claude Pro or Max plan anyway.

## What Anthropic allows

From [Claude Code: legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) (read October 2026):

- OAuth sign-in is for Claude subscribers using "Claude Code and other native Anthropic applications".
- Developers building on Claude, including with the Agent SDK, should use API keys. Third parties may not offer Claude.ai sign-in in their own apps, may not route requests through Free, Pro or Max credentials on their users' behalf, and "may not collect, store, or intermediate Claude.ai credentials or session tokens"; sign-in must complete through Anthropic's own flow.
- It also does not stop an end user from signing in to the **unmodified Claude Code binary** with their own subscription, including where a platform hosts Claude Code.
- Anthropic has enforced this on its servers since January 2026: tokens from a Claude sign-in only work for requests that come from Claude Code.

[Using the Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says Agent SDK and `claude -p` usage still draws on the plan's limits (a billing change announced for June 2026 was paused), and from October 7, 2026 Max and Team plans also include monthly API credits.

So, for Anton:

| Route | Allowed | Notes |
|---|---|---|
| pi-ai's `anthropic` OAuth (Flue already ships it) | No | Signs in as Claude Code's OAuth client and sends Claude Code's headers, system prompt and tool names. This is the pattern Anthropic forbids and blocks. |
| Anton stores a token from `claude setup-token` and calls the Messages API | No | Anton would store and use the token itself. |
| Run the unmodified `claude` binary (Claude Agent SDK), signed in through Claude Code's own flow, for the one person who owns this Anton | Yes, for personal use | Anton is single-user. Not acceptable if Anton is ever offered to other people. |
| Max/Team plan API credits through an API key | Yes | Plain API usage; no Claude Code involved. |

## Recommendation

1. **Now, no new code:** a Max or Team plan's monthly API credits can be used with an Anthropic API key. Adding pi's `anthropicProvider()` with `ANTHROPIC_API_KEY` (one `setProvider` call plus a catalog, as for OpenRouter) gets Claude models billed to those credits, with the spending caps working as they do today. This is worth doing on its own, and does not depend on the rest.
2. **Subscription usage:** add a **Claude Code bridge**: a pi-ai `Provider` whose stream runs the Claude Agent SDK instead of calling an HTTP API, with Anton's own tools exposed to Claude Code over MCP. The rest of this document designs it.

## How t3code and pi do it

- **t3code** (`apps/server/src/provider/Drivers/ClaudeDriver.ts`) hands each turn to `@anthropic-ai/claude-agent-sdk`, which runs the `claude` binary with its own tools, one `CLAUDE_CONFIG_DIR` per account. It runs on your own machine, where `claude auth login` was already done. It replaces the whole agent loop, which Anton cannot do without losing its own tools (`start_workspace`, `open_pull_request`, the browser, code mode, plan mode, memory, the reviewer).
- **pi-claude-bridge** (npm `pi-claude-bridge`, a pi extension) is closer to what Anton needs: Claude models show up as a pi provider (`claude-bridge/claude-opus-5`), Claude Code does the reasoning, and **every tool call flows back through pi** and is run by pi's own tools. It needs pi-coding-agent's extension API, so it cannot be dropped into Flue, but its design carries over.

## Design: the Claude Code bridge

### Where it runs

On Anton's server, next to the agents, **not** in the task's sandbox:

- A task starts read-only, with no sandbox; the bridge must answer then too.
- `AGENTS.md`: credentials stay out of machines the agent has used. Claude Code's sign-in lives in its own config directory on Anton's server, which agents never reach. They only run commands in sandboxes.
- Claude Code itself runs with **all built-in tools off**: it can call only Anton's tools, through MCP. It never edits files or runs commands on the server.

### Sign-in

Anton never sees the token. Claude Code keeps it.

- Anton runs the binary with `CLAUDE_CONFIG_DIR=<dataDir>/claude-code` (and `HOME` set to the same folder), so it reads no other sign-in on the server. Litestream backs up only the databases, so the sign-in survives a restart only where the data folder is a lasting disk.
- Signing in: Settings › Subscriptions › Claude shows the one command to run once on the server, with the path of the `claude` the SDK bundles, for example `CLAUDE_CONFIG_DIR=/data/claude-code /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude auth login` (over `fly ssh console` when hosted). The login screen tells you to paste a code when the browser cannot reach the callback, as on any remote machine. "Check again" on the card then reads the sign-in.
- The child process gets only `PATH`, locale, `TMPDIR`, proxy and CA variables from Anton's environment: never `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN`, so its calls can only bill the plan it signed in to. A sign-in that reports an API key or a cloud provider shows as "Needs attention" and lists no models.
- Status: the SDK's `accountInfo()` and `supportedModels()` (or `claude auth status`), which report whether it is signed in, the plan and the email without handing Anton the token, fill the card and a Connections check.
- Not used: `claude setup-token` with `CLAUDE_CODE_OAUTH_TOKEN`. That would have Anton store a session token, which the rules above forbid.

### The provider

`src/flue/claude-code-models.ts`, registered by both agents next to the OpenRouter and ChatGPT providers:

```ts
setProvider(claudeCodeProvider(loadedModels, () => runtimeFor('claude-code'), runtimeHooks('claude-code')));
```

- Provider id `claude-code`; models `claude-code/claude-opus-5` etc., from the SDK's `supportedModels()` for the plan (aliases resolved to their full ids, `default` left out), with output sizes and prices filled in from pi's Anthropic catalog (`ANTHROPIC_MODELS`), or the newest model of the same family for one pi does not know yet. Every plan model gets a 200K context, except one Claude Code lists under its `[1m]` name, which it serves only on plans that include 1M and which gets 1M; Flue compacts at that size. A model Claude Code says supports fast mode (`supportsFastMode`) has a `…[fast]` variant, the model picker's Fast switch, which opens Claude Code with the `fastMode` setting and bills paid extra usage rather than the plan. The card shows the plan's 5-hour and weekly limits from the SDK's `/usage` answer (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`, read with the status probe and left out when it fails).
- `auth.apiKey.resolve` returns a placeholder: the binary authenticates itself. A model is listed only while Claude Code says it is signed in, and a call made after a sign-out fails with Claude Code's own message.
- `api: { stream, streamSimple }` is custom: it turns a pi `Context` into an Agent SDK `query()` and the SDK's messages back into pi's `AssistantMessageEventStream`.

### One model call, step by step

Flue calls the model once per step: context in, one assistant message out (text, thinking, tool calls). The Agent SDK instead runs a whole loop and calls tools itself. The bridge makes the two meet at tool calls:

1. Flue calls `streamSimple(model, context)`. The bridge looks up a live **bridge session** for this conversation, keyed by `options.sessionId` (Flue's session id).
2. With none, or when `context` no longer extends what the session has seen (compaction, a fork, an edited message, a restart), it starts a new `query()`:
   - `systemPrompt: { type: 'preset', preset: 'claude_code', append: context.systemPrompt }`. Claude Code's own prompt stays; Anton's instructions are appended. A fully custom prompt is possible, but keeping Claude Code's is the safer reading of "unmodified".
   - `tools: []` (no built-in tools); `mcpServers: { anton: <an in-process MCP server> }` that serves each tool's JSON Schema as Flue gives it, marked `anthropic/alwaysLoad` since there is no tool search; `allowedTools: ['mcp__anton']`; `permissionMode: 'dontAsk'`, which refuses anything not allowed instead of asking; `settingSources: []`, `strictMcpConfig` and `persistSession: false`, so no user or project settings, hooks, memory or MCP servers load and nothing is written to Claude Code's session history. Auto-compaction and auto-memory are off by environment, since Flue compacts.
   - `cwd`: an empty folder under the config directory; `model`: the Claude id; `thinking` (adaptive, or disabled when the level is off) and `effort` from Flue's thinking level, moved to the nearest level the model offers.
   - Built: earlier turns are sent as a text transcript (`<conversation_so_far>`) in the first user message, followed by the latest user message. Writing a Claude Code session file and passing `resume`, as pi-claude-bridge does, would keep signed thinking; it is left for later.
3. The bridge streams the SDK's raw stream events (`includePartialMessages`) out as pi `text_*`, `thinking_*` and `toolcall_*` events. A step ends at the model call's `message_stop`.
4. A model call that ends with tool calls ends the pi stream with them and stop reason `toolUse`. When Claude Code then calls `mcp__anton__<tool>`, the MCP handler **does not run the tool**: it parks a promise, paired with the tool call by the `claudecode/toolUseId` Claude Code puts on each MCP call.
5. Flue runs the tools (in the sandbox, or on Anton for read-only tools), appends the `toolResult`s and calls `streamSimple` again. The bridge sees that the new context is the old one plus those results, resolves the parked MCP calls with them (or keeps a result until Claude Code asks for it), and streams on in the same `query()`.
6. A model call with no tool calls ends the step with stop reason `stop` and its usage. The SDK's `result` that follows is skipped on the next step; the user's next message is sent into the same `query()`.
7. On abort (`options.signal`), an error or a mismatch the bridge closes the `query()`, and the next step starts a new one with the transcript. Conversations idle for 10 minutes are closed.

Parallel tool calls: one model call can ask for several tools, and they come back as one pi message with several `toolCall`s; Claude Code calls them one by one or together, and each gets its result whenever it asks.

### Cost, caps and limits

- Usage is recorded in tokens, at $0, or at Anthropic API prices when "Count toward the spending caps" is on. These are the same two options the ChatGPT card has (`SubscriptionOptions`).
- The SDK reports rate-limit events and an `assistant` message with `error` (or a `result` with `is_error`) when the plan's limit is reached. The bridge turns these into a pi error "Claude plan limit reached: <Claude Code's message>", which the thread already shows, and notes the time for the usage views.
- When Claude Code says the plan has moved on to paid extra usage, the Claude card warns and links claude.ai/settings/usage. Turn extra usage off there so tasks stop at the limit instead.
- At most `ANTON_CLAUDE_CODE_MAX_OPEN` (default 3) Claude Code conversations stay open across all agents; a new one closes the longest idle. Busy ones are never closed, so the cap can be passed briefly rather than block a step.

### Ports and files

The ChatGPT `SubscriptionProvider` port is built around Anton holding an OAuth token, which does not fit here. `src/core/ports.ts` has an `AgentRuntime` port instead: a vendor's own agent program that Anton drives as a model, signed in through the program itself. It reports `status()` (signed in, email, plan, version, problem), `listModels()`, the `signInCommand` for the card, and `open()`, which starts one conversation that takes user content, calls back for each tool result (`callTool`) and yields `RuntimeEvent`s (the model call's stream events, errors with whether the plan's limit caused them, extra-usage notices and turn ends). The bridge sees only these, never the SDK's own types.

- `src/providers/claude-code/runtime.ts`: the Agent SDK, its `accountInfo()` and `supportedModels()`. It is the only file that imports `@anthropic-ai/claude-agent-sdk`.
- `src/flue/claude-code-models.ts`: the pi provider and the bridge (steps 1–7).
- `src/services/subscriptions.ts`: lists runtimes next to OAuth plans in `subscriptionsView()`, `subscriptionModels()` and `planUsage()`, with the same options and change announcements; `runtimeHooks()` gives the bridge where to note limits and extra usage. Disconnecting is refused with the `auth logout` command, since Anton holds nothing to forget. Settings › Connections checks the sign-in too.
- Settings › Subscriptions: the Claude card shows status, the sign-in command with a copy button, the account and plan, the two options, the model list and an extra-usage warning.

### Tests

`tests/claude-code.test.ts`: the bridge against a fake `AgentRuntime` (a plain answer; two tool calls, one delivered while Claude Code waits and one before it asks, then the user's next message in the same conversation; a context that no longer extends, which starts a new conversation with the transcript; a plan limit, extra usage, an early turn end and an abort; the open-conversation cap), the SDK message mapping, the sign-in status, model listing, the child environment and the subscriptions service. `tests/ui/subscriptions.test.tsx` covers the card. Still to do: one opt-in end-to-end run against a signed-in `claude`, with extra usage off.

## Risks and open questions

- **Policy can change.** Anthropic paused one Agent SDK billing change in 2026 and may resume it. The card should link the support article, and the bridge should surface whatever the SDK reports instead of guessing.
- **"Unmodified"** covers the binary; the SDK options above (no built-in tools, appended system prompt) are features the SDK documents. Replacing the system prompt entirely is a gray area, so the design keeps Claude Code's.
- **Latency:** a process per conversation, and a pause per tool call while Flue runs the tool. Measure it against direct API calls before turning the bridge on by default.
- **Thinking replay:** Claude's signed thinking blocks live inside Claude Code's session. A new `query()` after compaction loses them, which is acceptable.
- **Binary size and platform:** the SDK bundles a native `claude` per platform. The production image needs the linux-x64 one; check that `npm ci` on the deploy target installs it.
