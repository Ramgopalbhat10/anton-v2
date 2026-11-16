/**
 * The agent calls every connector tool through `connector_call` ({ tool, arguments }); the thread draws it as the tool it ran.
 * Kept per part, so an unchanged call keeps its object and the rows memoized on it skip the render.
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
