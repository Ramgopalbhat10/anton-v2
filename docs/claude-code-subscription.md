# Claude plans through Claude Code — design

Status: proposed, not built. Settings › Subscriptions shows Claude as "Planned" and points here.

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

- Anton runs the binary with `CLAUDE_CONFIG_DIR=<dataDir>/claude-code` (on the Litestream-backed disk, so it survives restarts).
- Signing in: Settings › Subscriptions › Claude shows the one command to run once on the server, for example `fly ssh console -C "CLAUDE_CONFIG_DIR=/data/claude-code claude auth login"`. The login screen tells you to paste a code when the browser cannot reach the callback, as on any remote machine. Locally, a "Sign in" button can run the same command in Anton's terminal panel.
- Status: the SDK's `accountInfo()` and `supportedModels()` (or `claude auth status`), which report whether it is signed in, the plan and the email without handing Anton the token, fill the card and a Connections check.
- Not used: `claude setup-token` with `CLAUDE_CODE_OAUTH_TOKEN`. That would have Anton store a session token, which the rules above forbid.

### The provider

`src/flue/claude-code-models.ts`, registered by both agents next to the OpenRouter and ChatGPT providers:

```ts
setProvider(claudeCodeProvider(loadedModels, claudeCodeRuntime));
```

- Provider id `claude-code`; models `claude-code/claude-opus-5` etc., from the SDK's `supportedModels()` for the plan, with context sizes and prices filled in from pi's Anthropic catalog (`ANTHROPIC_MODELS`).
- `auth.apiKey.resolve` returns a placeholder: the binary authenticates itself. It throws "Claude Code is not signed in" when the status check says so, so the turn fails with a useful message.
- `api: { stream, streamSimple }` is custom: it turns a pi `Context` into an Agent SDK `query()` and the SDK's messages back into pi's `AssistantMessageEventStream`.

### One model call, step by step

Flue calls the model once per step: context in, one assistant message out (text, thinking, tool calls). The Agent SDK instead runs a whole loop and calls tools itself. The bridge makes the two meet at tool calls:

1. Flue calls `streamSimple(model, context)`. The bridge looks up a live **bridge session** for this conversation, keyed by `options.sessionId` (Flue's session id).
2. With none, or when `context` no longer extends what the session has seen (compaction, a fork, an edited message, a restart), it starts a new `query()`:
   - `systemPrompt: { type: 'preset', preset: 'claude_code', append: context.systemPrompt }`. Claude Code's own prompt stays; Anton's instructions are appended. A fully custom prompt is possible, but keeping Claude Code's is the safer reading of "unmodified".
   - `tools: []` (no built-in tools); `mcpServers: { anton: createSdkMcpServer({ tools: context.tools.map(toSdkTool) }) }`; `allowedTools: ['mcp__anton__*']`; `permissionMode: 'bypassPermissions'`, which only reaches Anton's tools; `settingSources: []` and `strictMcpConfig`, so no user or project settings, hooks or MCP servers load.
   - `cwd`: an empty directory per task; `model`: the Claude id; `thinking` and `effort` from Flue's thinking level (`maxThinkingTokens` is deprecated).
   - Earlier turns are replayed by writing them as a Claude Code session file and passing `resume`, as pi-claude-bridge does with `cc-session-io`. A first version can instead send a compact transcript as the first user message.
3. The bridge streams SDK `assistant` messages out as pi `text_*` and `thinking_*` events.
4. When Claude Code calls `mcp__anton__<tool>`, the MCP handler **does not run the tool**. It parks a promise, and the bridge ends this pi stream with a `toolCall` and stop reason `toolUse`.
5. Flue runs the tool (in the sandbox, or on Anton for read-only tools), appends the `toolResult` and calls `streamSimple` again. The bridge sees that the new context is the old one plus tool results, resolves the parked MCP promises with them, and keeps streaming the same `query()`.
6. The SDK's `result` message ends the turn with stop reason `stop`. Its `usage` becomes pi `Usage`.
7. On abort (`options.signal`) the bridge calls `query.interrupt()`. Sessions idle for 10 minutes are closed.

Parallel tool calls: Claude Code may call several MCP tools before waiting on any. The bridge collects every call made within one SDK assistant message and returns them together, as one pi message with several `toolCall`s.

### Cost, caps and limits

- Usage is recorded in tokens, at $0, or at Anthropic API prices when "Count toward the spending caps" is on. These are the same two options the ChatGPT card has (`SubscriptionOptions`).
- The SDK reports rate-limit events and a `result` with `is_error` when the plan's limit is reached. The bridge turns these into a pi error such as "Claude plan limit reached; resets at …", which the thread already shows.
- At most two Claude Code processes run at once (one coder and one helper); more queue.

### Ports and files

The ChatGPT `SubscriptionProvider` port is built around Anton holding an OAuth token, which does not fit here. Add a port to `src/core/ports.ts`:

```ts
/** A vendor's own agent program that Anton drives as a model, signed in through the program itself. */
export type AgentRuntime = {
	readonly id: string;            // 'claude-code'
	readonly name: string;          // 'Claude'
	readonly gateway: string;       // 'claude-code'
	status(): Promise<{ signedIn: boolean; email: string | null; plan: string | null; version: string | null; problem: string | null }>;
	listModels(): Promise<SubscriptionModel[]>;
	/** One Agent SDK conversation; the bridge in src/flue drives it. */
	open(options: AgentRuntimeSession): AgentRuntimeConversation;
};
```

- `src/providers/claude-code/runtime.ts`: the Agent SDK, its `accountInfo()` and `supportedModels()`. It is the only file that imports `@anthropic-ai/claude-agent-sdk`.
- `src/flue/claude-code-models.ts`: the pi provider and the bridge (steps 1–7).
- `src/services/subscriptions.ts`: lists runtimes next to OAuth plans in `subscriptionsView()` and `subscriptionModels()`, with the same options and change announcements.
- Settings › Subscriptions: the Claude card shows status, the sign-in command, the two options and the model list.

### Tests

- The bridge against a fake `AgentRuntime` that plays scripted SDK messages: text only; one tool call; two parallel tool calls; abort mid-tool; the context no longer extending the session, which starts a new `query()`; a plan-limit error.
- The tool schema mapping (valibot JSON schema to the SDK's MCP tool), including images in tool results.
- One opt-in end-to-end test, skipped without a signed-in `claude`: "Say ready." through `npx flue run src/agents/coder.ts`.

## Risks and open questions

- **Policy can change.** Anthropic paused one Agent SDK billing change in 2026 and may resume it. The card should link the support article, and the bridge should surface whatever the SDK reports instead of guessing.
- **"Unmodified"** covers the binary; the SDK options above (no built-in tools, appended system prompt) are features the SDK documents. Replacing the system prompt entirely is a gray area, so the design keeps Claude Code's.
- **Latency:** a process per conversation, and a pause per tool call while Flue runs the tool. Measure it against direct API calls before turning the bridge on by default.
- **Thinking replay:** Claude's signed thinking blocks live inside Claude Code's session. A new `query()` after compaction loses them, which is acceptable.
- **Binary size and platform:** the SDK bundles a native `claude` per platform. The production image needs the linux-x64 one; check that `npm ci` on the deploy target installs it.
