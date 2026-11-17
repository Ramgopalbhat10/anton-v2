# Connectors

Linked from [AGENTS.md](../../AGENTS.md).

- Settings › Connectors (`src/web/components/settings/connectors.tsx`, catalog in `src/web/lib/connector-catalog.ts`) turns each connector on or off for every task.
- The agent never gets a connector's tools in its tool list: `connector_tools` lists them and `connector_call` calls one (`src/services/connectors/connector-tools.ts`), reading the state as they run. Switching a connector changes neither tools nor instructions, so the prompt cache holds.
- MCP servers live in `mcp_servers` (`src/services/connectors/mcp-servers.ts`); OAuth sign-in is `src/services/connectors/mcp-sign-in.ts`. Tokens reach connections as a bearer, never a view.
- Accounts (Google, `src/providers/google/sign-in.ts`) sign in with PKCE on the owner's OAuth client; `src/services/connectors/connectors.ts` keeps their tokens on the server, never in a sandbox, a view or the model.
- Gmail (`src/services/connectors/mail.ts`): `gmail_send` never sends. It keeps the draft in `mail_approvals` and waits for the user's Send press (`src/web/components/thread/mail-card.tsx`), which sends only if the draft is unchanged.
- Composio apps sit behind the `AppsConnector` port (`src/providers/composio/`). `src/services/connectors/composio.ts` keeps one `composio_accounts` row per toolkit (account id, status, logo; never tokens) and maps them onto connector states. The project key is a `KeySlot` (`COMPOSIO_API_KEY` or pasted), loaded at startup by `loadComposioKey`.
- A Composio tool reaches the agent as `composio__<toolkit>__<action>` through the same `connector_tools`/`connector_call` pair, never `run_script` (`codeMode: false`). Reads run at once; a call that would change something is kept in `tool_approvals` (`src/services/connectors/tool-approvals.ts`) and waits for the user's Run press (`src/web/components/thread/tool-approval-card.tsx`), which reruns the stored call. Only a leading read verb in the tool's name skips approval.
