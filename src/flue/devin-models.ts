import {
	type AssistantMessage, type AssistantMessageEvent, type Context, type Model, type Provider, type SimpleStreamOptions,
	createAssistantMessageEventStream, createProvider,
} from '@earendil-works/pi-ai';
import type { ModelInfo } from '../core/ports.ts';
import { runDevinWorker } from '../providers/devin/worker.ts';

/** Keep the two pi implementations apart: only JSON crosses the process boundary. */
export function devinProvider(live: () => readonly ModelInfo[], key: () => Promise<string>, run = runDevinWorker): Provider {
	const streamSimple = (model: Model<string>, context: Context, options?: SimpleStreamOptions) => {
		const stream = createAssistantMessageEventStream();
		void (async () => {
			let terminal = false;
			try {
				await run({ action: 'stream', key: await key(), model, context,
					options: { maxTokens: options?.maxTokens, temperature: options?.temperature, sessionId: options?.sessionId } }, (message) => {
					if (message.type !== 'event' || terminal) return;
					const event = message.event as AssistantMessageEvent;
					// The old pi must see its own API name on replay, including partials.
					for (const field of ['partial', 'message', 'error'] as const) {
						const output = (event as unknown as Record<string, AssistantMessage>)[field];
						if (output) { output.api = 'devin'; output.provider = 'devin'; }
					}
					if (event.type === 'done' || event.type === 'error') terminal = true;
					stream.push(event);
				}, options?.signal);
				if (!terminal) throw new Error('Devin ended without a model response.');
			} catch (error) {
				if (!terminal) {
					const output: AssistantMessage = { role: 'assistant', content: [], api: 'devin', provider: 'devin', model: model.id,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						stopReason: options?.signal?.aborted ? 'aborted' : 'error', errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now() };
					stream.push({ type: 'error', reason: output.stopReason as 'error' | 'aborted', error: output });
				}
			} finally { stream.end(); }
		})();
		return stream;
	};
	const base = createProvider<string>({ id: 'devin', name: 'Devin', models: [],
		auth: { apiKey: { name: 'Devin PAT', resolve: async () => ({ auth: { apiKey: await key() }, source: 'Settings › Subscriptions' }) } },
		api: { stream: streamSimple, streamSimple },
	});
	let memo: { from: readonly ModelInfo[]; models: Model<string>[] } | undefined;
	return { ...base, getModels: () => {
		const current = live();
		if (memo?.from !== current) memo = { from: current, models: current.filter((info) => /^devin\/swe-2(?:-flash)?$/.test(info.id)).map((info) => ({
			id: info.id.slice('devin/'.length), name: info.name, api: 'devin', provider: 'devin', baseUrl: 'https://server.codeium.com',
			...(info.requestModelId ? { requestModelId: info.requestModelId } : {}),
			reasoning: false, input: info.vision ? ['text', 'image'] : ['text'], cost: info.price, contextWindow: info.contextLength, maxTokens: info.maxOutput ?? 8192,
		})) };
		return memo.models;
	} } as Provider;
}
