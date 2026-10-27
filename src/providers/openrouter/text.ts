import type { TextModel } from '../../core/ports.ts';

/** `apiKey` is read on each call, so a key pasted in Settings › Subscriptions needs no restart. */
export type TextOptions = { apiUrl: string; apiKey: string | (() => string | null) };

/** A few words should take a second or two; one that hangs is given up on, and the caller keeps what it had. */
const TIMEOUT_MS = 15_000;

type WireResponse = {
	choices?: Array<{ message?: { content?: string | null } }>;
	usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
};

/** Any OpenRouter model, given one prompt and no tools, with the key Anton already has. */
export function openRouterText({ apiUrl, apiKey }: TextOptions): TextModel {
	return {
		runs: (model) => model.startsWith('openrouter/'),
		async write({ model, prompt, maxTokens, reasoning, timeoutMs }, signal) {
			const key = typeof apiKey === 'function' ? apiKey() : apiKey;
			if (!key) throw new Error('Writing text needs an OpenRouter key. Add one under Settings › Subscriptions.');
			const timeout = AbortSignal.timeout(timeoutMs ?? TIMEOUT_MS);
			const response = await fetch(`${apiUrl}/chat/completions`, {
				method: 'POST',
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
				headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: model.slice('openrouter/'.length),
					messages: [{ role: 'user', content: prompt }],
					max_tokens: maxTokens,
					...(reasoning ? { reasoning: { effort: reasoning } } : {}),
					usage: { include: true },
				}),
			});
			if (!response.ok) throw new Error(`OpenRouter ${model}: ${response.status} ${(await response.text()).slice(0, 300)}`);
			const body = (await response.json()) as WireResponse;
			const text = body.choices?.[0]?.message?.content?.trim();
			if (!text) throw new Error(`${model} wrote nothing`);
			return { text, inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0, cost: body.usage?.cost ?? 0 };
		},
	};
}
