import { type FlueExecutionContext, type FlueExecutionOperation, instrument } from '@flue/runtime';
import { cutHeadAndTail, cutResult } from '../services/context/tool-results.ts';
import { skillFilesReady } from '../services/sandbox/skill-files.ts';
import { skillInParts } from '../services/context/skill-parts.ts';
import { digestResult, WEB_TOOLS } from '../services/context/web-digest.ts';
import { onMainCoder } from '../services/context/context-usage.ts';
import { todoNudge } from '../services/replies/todos.ts';

/** A subagent's runs in a session of its own under a task id, a tool's harness in a scope of its own. */
const isOwnConversation = (ctx: FlueExecutionContext) =>
	Boolean(ctx.instanceId) && !ctx.taskId && (ctx.session === undefined || ctx.session === 'default') && (ctx.harness === undefined || ctx.harness === 'default');

const SKILL_TOOL = 'activate_skill';

/**
 * Every tool call passes through the runtime's execution interceptors, so this sees web fetches, connectors, scripts and
 * subagents' answers alike. A subagent has no `read_full_result`, so its long results keep their start and end.
 */
export function toolResultCutInterceptor<T>(operation: FlueExecutionOperation, ctx: FlueExecutionContext, next: () => Promise<T>): Promise<T> {
	if (operation.type !== 'tool') return next();
	const { toolCallId, toolName } = operation;
	const subagent = Boolean(ctx.instanceId && ctx.taskId);
	if (!subagent && !isOwnConversation(ctx)) return next();
	if (WEB_TOOLS.has(toolName)) return next().then((result) => digestResult(ctx.instanceId!, toolCallId, toolName, result, subagent));
	// A skill comes whole but for its file list, or in sections to read on from; a subagent's is never cut.
	// Its files are copied into the sandbox in the background as it starts; a skill in use waits for them.
	if (toolName === SKILL_TOOL)
		return next().then(async (result) => {
			await skillFilesReady(ctx.instanceId!);
			return skillInParts(result, toolCallId, subagent ? null : ctx.instanceId!);
		});
	if (subagent) return next().then((result) => cutHeadAndTail(toolName, result));
	const cut = next().then((result) => cutResult(ctx.instanceId!, toolCallId, toolName, result));
	return onMainCoder(ctx) ? cut.then((result) => withTodoNudge(ctx.instanceId!, toolName, result)) : cut;
}

/** Rides after the result's own content, so a cut result's note stays where it points. */
async function withTodoNudge<T>(id: string, toolName: string, result: T): Promise<T> {
	const nudge = await todoNudge(id, toolName).catch(() => null);
	const content = (result as { content?: unknown } | null)?.content;
	if (!nudge || !Array.isArray(content)) return result;
	return { ...result, content: [...content, { type: 'text', text: nudge }] };
}

const key = Symbol.for('anton.tool-result-cut');
const state = globalThis as typeof globalThis & { [key]?: () => Promise<void> };

/** Installs the interceptor once, across dev-server module reloads; Flue itself survives those reloads. */
export function installToolResultCut(): void {
	void state[key]?.();
	state[key] = instrument({ observe: () => undefined, interceptor: toolResultCutInterceptor, dispose: () => undefined });
}
