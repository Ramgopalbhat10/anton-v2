// Minimal MCP server over a byte transport: the agent's link reaches Anton as
// newline-delimited JSON-RPC on the exec channel. Only what an ACP agent needs:
// initialize, tools/list, tools/call, ping.

import type { RuntimeTool, RuntimeToolOutput } from '../../core/ports.ts';
import type { AcpTransport } from './client.ts';

type Rpc = { id?: number | string; method?: string; params?: { name?: string; arguments?: unknown }; result?: unknown; error?: { message?: string } };

export function mcpServer(
	transport: AcpTransport,
	tools: RuntimeTool[] | (() => RuntimeTool[]),
	call: (name: string, args: unknown) => Promise<RuntimeToolOutput>,
): { close(): void; toolsChanged(): void } {
	let buffer = '';
	let closed = false;

	const send = (msg: unknown) => transport.write(`${JSON.stringify(msg)}\n`);
	const respond = (id: number | string, result: unknown) => send({ jsonrpc: '2.0', id, result });
	const fail = (id: number | string, message: string) => send({ jsonrpc: '2.0', id, error: { code: -32603, message } });

	async function handle(msg: Rpc): Promise<void> {
		if (msg.id === undefined || !msg.method) return; // notifications need no answer
		switch (msg.method) {
			case 'initialize':
				return respond(msg.id, {
					protocolVersion: (msg.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? '2025-06-18',
					capabilities: { tools: {} },
					serverInfo: { name: 'anton', version: '1.0.0' },
				});
			case 'ping':
				return respond(msg.id, {});
			case 'tools/list':
				return respond(msg.id, {
					tools: (typeof tools === 'function' ? tools() : tools).map((tool) => ({
						name: tool.name,
						description: tool.description,
						inputSchema: { ...tool.inputSchema, type: 'object' as const },
					})),
				});
			case 'tools/call': {
				// Names arrive as the agent namespaces them; the caller maps them to Anton's tools.
				const name = msg.params?.name ?? '';
				try {
					const output = await call(name, msg.params?.arguments ?? {});
					return respond(msg.id, { content: output.content, isError: output.isError });
				} catch (error) {
					return respond(msg.id, {
						content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
						isError: true,
					});
				}
			}
			default:
				return fail(msg.id, `Unsupported method: ${msg.method}`);
		}
	}

	void (async () => {
		try {
			for await (const chunk of transport.lines()) {
				buffer += chunk;
				let nl: number;
				while ((nl = buffer.indexOf('\n')) >= 0) {
					const line = buffer.slice(0, nl).trim();
					buffer = buffer.slice(nl + 1);
					if (!line) continue;
					let msg: Rpc;
					try {
						msg = JSON.parse(line) as Rpc;
					} catch {
						continue; // A malformed frame must not kill the channel.
					}
					// Not awaited: a tools/call parks until Flue runs the tool, and ping, tools/list and other calls must still answer meanwhile.
					void handle(msg).catch(() => undefined);
				}
			}
		} finally {
			closed = true;
		}
	})();

	return {
		close() {
			if (closed) return;
			closed = true;
			void transport.closeStdin().catch(() => {});
		},
		// Best effort: agents that re-list on the notification pick up added/removed tools mid-session.
		toolsChanged() {
			if (!closed) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
		},
	};
}
