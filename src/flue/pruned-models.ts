import type { Api, AssistantMessage, Context, Model, Provider, StreamOptions } from '@earendil-works/pi-ai';
import { cacheLifetime } from '../core/prompt-cache.ts';
import { compactionPoint, noteSent, type PruneModel, pruneContext } from '../services/context-prune.ts';

/**
 * A provider whose calls send old tool results cleared once a conversation grows (src/services/context-prune.ts).
 * The runtime names each conversation in the call's `sessionId`; a call without one is sent as it is. Not for the
 * plan runtimes (Claude Code, Cursor), which keep their own conversation and match what they are sent against it.
 */
/** APIs that take a conversation whose older assistant messages leave their reasoning out; the Responses API wants each tool call's reasoning item. */
const THINKING_OPTIONAL = new Set<string>(['openai-completions', 'anthropic-messages']);

/** What the clearing is told of a call's model: its prices, its API, and how long its provider's cache lasts. */
export const pruneModel = (model: Model<Api>): PruneModel => ({
	price: model.cost,
	dropThinking: THINKING_OPTIONAL.has(model.api),
	cacheMs: cacheLifetime(`${model.provider}/${model.id}`),
});

export function withPruning(provider: Provider): Provider {
	const pruned = <T>(send: (model: Model<Api>, context: Context, options: StreamOptions | undefined) => T) =>
		(model: Model<Api>, context: Context, options: StreamOptions | undefined): T => {
			const key = options?.sessionId;
			if (!key) return send(model, context, options);
			const { context: sent, call } = pruneContext(key, context, compactionPoint(model), Date.now(), pruneModel(model));
			const stream = send(model, sent, options);
			// The provider's count of what this call sent sizes the conversation's next one; the same stream, so no lookup.
			const result = (stream as { result?: () => Promise<AssistantMessage> } | undefined)?.result;
			if (typeof result === 'function') result.call(stream).then((message) => noteSent(key, call, message?.usage), () => {});
			return stream;
		};
	return {
		...provider,
		stream: pruned(provider.stream.bind(provider)),
		streamSimple: pruned(provider.streamSimple.bind(provider)),
	} as Provider;
}
