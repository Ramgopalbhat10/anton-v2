/**
 * The agent calls every connector tool through `connector_call` ({ tool, arguments }), so turning a connector
 * on or off never changes its tool list. The thread draws such a call as the tool it ran, so a Gmail send
 * still shows as the email with Send, and a server's tool with the server's mark. Kept per part, so a call
 * that did not change keeps its object and the rows memoized on it skip the render.
 */

export const CONNECTOR_CALL = 'connector_call';

type ToolLike = { toolName: string; input: unknown };

const unwrapped = new WeakMap<object, object>();

export function asConnectorTool<T extends ToolLike>(part: T): T {
	if (part.toolName !== CONNECTOR_CALL) return part;
	const input = part.input && typeof part.input === 'object' ? (part.input as { tool?: unknown; arguments?: unknown }) : {};
	if (typeof input.tool !== 'string' || !input.tool) return part;
	const known = unwrapped.get(part);
	if (known) return known as T;
	const shown = { ...part, toolName: input.tool, input: input.arguments ?? {} };
	unwrapped.set(part, shown);
	return shown;
}
