# Connectors

Linked from [AGENTS.md](../../AGENTS.md).

- Settings › Connectors (`settings/connectors.tsx`, catalog in `src/web/lib/connector-catalog.ts`) turns each connector on or off for every task.
- The agent never gets a connector's tools in its tool list: `connector_tools` lists them and `connector_call` calls one (`src/services/connector-tools.ts`), reading the state as they run. Switching a connector changes neither tools nor instructions, so the prompt cache holds.
- MCP servers live in `mcp_servers` (`src/services/mcp-servers.ts`); OAuth sign-in is `mcp-sign-in.ts`. Tokens reach connections as a bearer, never a view.
- Accounts (Google, `src/providers/google/sign-in.ts`) sign in with PKCE on your own OAuth client; `src/services/connectors.ts` keeps their tokens on the server, never in a sandbox, a view or the model.
- Gmail (`src/services/mail.ts`): `gmail_send` never sends. It keeps the draft in `mail_approvals` and waits for the user's Send press (`mail-card.tsx`), which sends only if the draft is unchanged.
