# ACP runtimes

Some vendors ship their coding agent as an ACP (Agent Client Protocol) server: a subprocess that speaks JSON-RPC over stdio — `initialize`, `authenticate`, `session/new`, `session/prompt`, `session/cancel`, `session/load`. Devin (`devin acp`) and Google Antigravity (`agy acp`) both do. One generic runtime drives any of them.

## Why not a model provider

ACP is a whole agent, not a model endpoint: it owns its prompt loop, context management and tool calls. Anton's `AgentRuntime` bridge already handles that shape — Flue calls the model once per step, the runtime's agent pauses at tool calls, Flue runs the tools and hands results back. Same pattern as the Claude Code and Cursor runtimes.

## The containment problem

ACP agents have native tools (read/write/exec) that cannot be disabled by configuration — verified on Devin: permission denies leak (`exec echo` and `write` slipped through), and the agent's own "cog" engine auto-approves safe-looking calls without asking the client. So the agent process runs **jailed**: inside a Modal Sandbox Sidecar with its own minimal filesystem and an egress allowlist covering only the vendor's API domains. Its native tools hit an empty box; its exec'd commands have no route out except the vendor API.

Anton's tools reach the agent as MCP servers declared in `session/new`. Each tool call crosses back to Anton over the exec channel — no public endpoint, no token on the wire:

```
Flue ── RuntimeEvent stream ──► AcpRuntime (host)
                                   │ sidecar.exec stdin/stdout (ACP JSON-RPC)
                                   ▼
              Modal sidecar "agent": devin acp   (egress: vendor domains only)
                 native tools → jailed fs          MCP client → stdio
                                   ▲                        │
                                   │            link.mjs (stdio↔TCP, in image)
                                   │                        ▼
                                   │            linkd.mjs (exec'd; TCP↔exec-stdio)
                                   │                        │ exec stdio
                                   └── MCP JSON-RPC ◄────────┘
                                        host MCP handler → callTool() rendezvous
```

`open()` returns immediately; handshake, auth and `session/new` complete lazily on first use. `session/update` notifications map to `RuntimeEvent`s: `agent_message_chunk`→text, `agent_thought_chunk`→thinking, `usage_update`→usage. Anton MCP `tools/call` synthesizes a `tool_use` block + `message_stop`; the parked `callTool` resolves when Flue delivers results — the same rendezvous the Claude Code bridge uses. `session/prompt`'s return closes the turn (`turn_end`). Native-tool `session/update`s are ignored: they run inside the jail and never touch Anton state.

## Per-agent descriptor

Everything agent-specific is a small descriptor; the engine is shared:

| Field | Devin | Antigravity (later) |
|---|---|---|
| `command` | `["devin","acp"]` | `["agy","acp"]` |
| `image` | node:22 + devin tarball + link scripts | node:22 + agy install + link scripts |
| `release` | `static.devin.ai/cli/current/manifest.json` → version+url+sha256 | TBD |
| `egress` | `*.devin.ai`, `*.codeium.com`, `*.windsurf.com` | Google's endpoints |
| `auth` | `authenticate{methodId:"devin-browser",_meta:{api_key}}`, key from local `credentials.toml` | TBD |
| `modelConfigId` | `"model"` (from `session/new` configOptions) | TBD |

`session/new` returns `configOptions` with the account's real model list — `listModels()` reads it live, no hardcoded catalog. `session/load` (`loadSession` capability) resumes after a sandbox restart.

## Agent releases

The agent binary is not installed per task: it is baked into the Modal image once, and every conversation is a ~1s sidecar start from that image. When a descriptor declares `release`, the host asks the vendor's manifest for the newest build before each image build (re-checked every 6h), verifies `sha256` inside the Dockerfile, and keys the image cache by version — a new release rebuilds once and only new sidecars get it; running conversations keep their binary. The descriptor's pinned version is the floor and the fallback when the manifest is unreachable or older.

Connection setup is the warm-up point: `signIn().complete()` fires `host.prepare()` in the background, which resolves the release and builds the image off the reply path, so by the first task the image is usually ready and Settings already lists the account's models. Auth is local (`src/providers/acp/local-cli.ts`): the vendor CLI's own login writes `credentials.toml` on this host and `status()`/`listModels()` read it directly, so checking sign-in never touches Modal at all.

## Isolation: sidecars vs dedicated sandboxes

Each conversation's jailed container comes in two flavors, chosen per agent in Settings › Subscriptions ("Dedicated sandbox") and stored as `acp.isolation.<agentId>`:

- **`sidecar`** (default): every conversation is a Modal *Sandbox Sidecar* of one shared anchor sandbox per host. Sidecars share the anchor's CPU/memory reservation, so cost is per anchor, not per sidecar — but sidecars are an experimental API and share one lifecycle.
- **`sandbox`**: every conversation (and warm slot) is a standalone Modal Sandbox from the standard `sandboxes.create` API — own filesystem, own egress policy, own `timeoutMs`/`idleTimeoutMs`, billed per sandbox while alive. Stronger isolation and no experimental surface; costs roughly one sandbox's reservation per open conversation.

Both get the same treatment otherwise: `sleep infinity` main process, `linkd` + agent execs inside, vendor-domain egress only, no credentials. The warm pool, per-model keys, staleness checks and host reaper are identical in both modes; a mode flip drains warm slots built for the old mode, and `claimWarm` never hands a slot to the wrong mode.

Cost note that motivated the reaper: Modal's `idleTimeoutMs` only watches a sandbox's *main* container execs — sidecar execs (and any long-lived exec in sandbox mode) keep it "active" forever, so idle timeouts alone never fire (this once billed ~$20/day of idle anchors). The host therefore reaps itself: after 20 minutes without any host call and no open conversation it terminates every warm slot, every live container and — in sidecar mode — the anchor itself, and the next call rebuilds cold. Dedicated-sandbox conversations are bounded the same way by `close()` plus their own `timeoutMs` backstop; orphaned ones are filterable in the Modal dashboard by the `anton-acp` tag.

## Auth and sign-in

The vendor credential stays on this host: `devin auth login --force-manual-token-flow` runs locally under `script(1)`'s PTY (the prompt refuses piped stdin), writing `~/.local/share/devin/credentials.toml`. ACP ignores stored CLI credentials by design — verified with an empty `XDG_DATA_HOME`, `authenticate _meta.api_key` alone opens `session/new` — so the runtime reads the key from that file and passes it per-session; the file is the only store and no sidecar ever holds credentials. Browser PKCE inside a container was impossible anyway (`xdg-open`); the manual-token flow is the headless path either way. `signOut` runs the CLI's own `auth logout` then removes the file; warm slots drain since their sessions would fail auth.

## Status

Spike-verified end to end on Modal (Oct 2025): ACP handshake over `sidecar.exec`, `authenticate` with a browser-login token, MCP round-trip through the in-image link, native `write` provably contained to the sidecar fs, egress allowlist blocking `example.com` while allowing `api.devin.ai`.

Not yet verified: `session/load` resume, `session/cancel`, permission-request policy under load, Antigravity descriptor.
