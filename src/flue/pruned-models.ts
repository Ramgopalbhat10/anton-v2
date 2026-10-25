import type { Api, Context, Model, Provider, StreamOptions } from '@earendil-works/pi-ai';
import { compactionPoint, pruneContext } from '../services/context-prune.ts';

/**
 * A provider whose calls send old tool results cleared once a conversation grows (src/services/context-prune.ts).
 * The runtime names each conversation in the call's `sessionId`; a call without one is sent as it is. Not for the
 * plan runtimes (Claude Code, Cursor), which keep their own conversation and match what they are sent against it.
 */
export function withPruning(provider: Provider): Provider {
	const pruned = (model: Model<Api>, context: Context, options: StreamOptions | undefined): Context =>
		options?.sessionId ? pruneContext(options.sessionId, context, compactionPoint(model)).context : context;
	return {
		...provider,
		stream: (model, context, options) => provider.stream(model, pruned(model, context, options), options),
		streamSimple: (model, context, options) => provider.streamSimple(model, pruned(model, context, options), options),
	} as Provider;
}
