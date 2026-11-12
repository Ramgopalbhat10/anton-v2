import { test, expect } from 'bun:test';
import { streamDevin } from '@oh-my-pi/pi-ai/providers/devin';
import { buildModel } from '@oh-my-pi/pi-catalog/build';
import { create, toBinary } from '@oh-my-pi/pi-catalog/discovery/protobuf';
import {
	GetChatMessageResponseSchema, GetUserJwtResponseSchema, ModelUsageStatsSchema, StopReason,
} from '@oh-my-pi/pi-catalog/discovery/devin-proto';
import { runDevinRequest } from './worker.mjs';

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const modelFor = (id, cost) => ({
	id, name: id, api: 'devin', provider: 'devin', baseUrl: 'https://server.codeium.com',
	reasoning: false, input: ['text'], contextWindow: 262144, maxTokens: 8192, cost,
});

/** Exercise the real transport, codecs and usage calculator; no network or PAT. */
function fakeFetch(seen) {
	return async (input) => {
		const pathname = new URL(input).pathname;
		seen.push(pathname);
		if (pathname.endsWith('/GetUserJwt')) return new Response(toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: 'fixture-auth' })));
		if (!pathname.endsWith('/GetChatMessage')) throw new Error(`Unexpected request ${pathname}`);
		const bytes = toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, {
			messageId: 'fixture-response', deltaText: 'OK', stopReason: StopReason.STOP_PATTERN,
			usage: create(ModelUsageStatsSchema, { inputTokens: 1_000_000n, outputTokens: 1_000_000n, cacheReadTokens: 1_000_000n, cacheWriteTokens: 1_000_000n }),
		}));
		const frame = new Uint8Array(5 + bytes.length);
		new DataView(frame.buffer).setUint32(1, bytes.length, false);
		frame.set(bytes, 5);
		return new Response(frame, { headers: { 'content-type': 'application/connect+proto' } });
	};
}

for (const id of ['swe-2-flash', 'swe-2']) {
	for (const [label, cost] of [['zero plan accounting', zero], ['supplied nonzero prices', { input: 7, output: 11, cacheRead: 2, cacheWrite: 3 }]]) {
		test(`${id}: worker preserves ${label}, not catalog or scheduled rates`, async () => {
			const supplied = modelFor(id, cost);
			// Zero prices trigger both fallback rates and dated catalog rates.
			// Nonzero prices must also survive, even when no correction is needed.
			if (cost === zero) {
				const corrected = buildModel({ ...supplied, api: 'devin-agent' }).cost;
				expect(corrected).not.toEqual(cost);
				expect(corrected.timeBased?.effectiveRates.length).toBeGreaterThan(0);
			}
			const seen = [];
			const messages = [];
			let wireModel;
			await runDevinRequest({ action: 'stream', key: 'fixture-key', model: supplied, context: { messages: [{ role: 'user', content: 'Say OK', timestamp: 0 }] }, options: { maxTokens: 64 } }, (message) => messages.push(message), {
				stream: (model, context, options) => {
					wireModel = model;
					return streamDevin(model, context, { ...options, fetch: fakeFetch(seen) });
				},
			});
			expect(wireModel.cost).toEqual(cost);
			expect(wireModel.cost.timeBased).toBeUndefined();
			expect(wireModel.cost.longContext).toBeUndefined();
			expect(wireModel.identity).toBeDefined();
			const done = messages.find((message) => message.type === 'event' && message.event.type === 'done');
			expect(done).toBeDefined();
			expect(done.event.message.usage.totalTokens).toBe(4_000_000);
			expect(done.event.message.usage.cost).toEqual({ ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite });
			expect(seen).toEqual(['/exa.auth_pb.AuthService/GetUserJwt', '/exa.api_server_pb.ApiServerService/GetChatMessage']);
			expect(messages.at(-1)).toEqual({ type: 'complete' });
			expect(supplied.cost).toEqual(cost);
		});
	}
}
