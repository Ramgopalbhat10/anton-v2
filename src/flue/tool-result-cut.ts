import { type FlueExecutionContext, type FlueExecutionOperation, instrument } from '@flue/runtime';
import { cutHeadAndTail, cutResult } from '../services/tool-results.ts';
import { digestResult, WEB_TOOLS } from '../services/web-digest.ts';

/**
 * An agent's own conversation: the coder's, the reviewer's or a coordinator's, each of which has
 * `read_full_result`. A subagent's runs in a session of its own under a task id, a tool's harness in a scope of its own.
 */
const isOwnConversation = (ctx: FlueExecutionContext) =>
	Boolean(ctx.instanceId) && !ctx.taskId && (ctx.session === undefined || ctx.session === 'default') && (ctx.harness === undefined || ctx.harness === 'default');

/**
 * Cuts a long tool result before the runtime keeps it in the conversation
 * (src/services/tool-results.ts). Every tool call passes through the runtime's
 * execution interceptors with what it returned, so this sees web fetches,
 * connectors, scripts and subagents' answers alike. A long web search or fetch
 * is read out against its objective instead (src/services/web-digest.ts). A
 * subagent's own calls carry its task id; it has no `read_full_result`, so its
 * other long results keep their start and end.
 */
export function toolResultCutInterceptor<T>(operation: FlueExecutionOperation, ctx: FlueExecutionContext, next: () => Promise<T>): Promise<T> {
	if (operation.type !== 'tool') return next();
	const { toolCallId, toolName } = operation;
	const subagent = Boolean(ctx.instanceId && ctx.taskId);
	if (!subagent && !isOwnConversation(ctx)) return next();
	if (WEB_TOOLS.has(toolName)) return next().then((result) => digestResult(ctx.instanceId!, toolCallId, toolName, result, subagent));
	if (subagent) return next().then((result) => cutHeadAndTail(toolName, result));
	return next().then((result) => cutResult(ctx.instanceId!, toolCallId, toolName, result));
}

const key = Symbol.for('anton.tool-result-cut');
const state = globalThis as typeof globalThis & { [key]?: () => Promise<void> };

/** Installs the interceptor once, across dev-server module reloads; Flue itself survives those reloads. */
export function installToolResultCut(): void {
	void state[key]?.();
	state[key] = instrument({ observe: () => undefined, interceptor: toolResultCutInterceptor, dispose: () => undefined });
}
