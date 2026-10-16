import type { VisionModel } from '../../core/ports.ts';

/** `apiKey` is read on each call, so a key pasted in Settings › Subscriptions needs no restart. */
export type VisionOptions = { apiUrl: string; apiKey: string | (() => string | null) };

/** A look at a screen is one step of the agent's; one that hangs must not hold it up for long. */
const TIMEOUT_MS = 60_000;

type WireResponse = {
	choices?: Array<{ message?: { content?: string | null } }>;
	usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
};

/** Any vision model OpenRouter offers, called with the image and a question and no tools, with the key Anton already has. */
export function openRouterVision({ apiUrl, apiKey }: VisionOptions): VisionModel {
	return {
		runs: (model) => model.startsWith('openrouter/'),
		async look({ model, prompt, image, mimeType }, signal) {
			const key = typeof apiKey === 'function' ? apiKey() : apiKey;
			if (!key) throw new Error('Seeing the screen needs an OpenRouter key. Add one under Settings › Subscriptions.');
			const timeout = AbortSignal.timeout(TIMEOUT_MS);
			const response = await fetch(`${apiUrl}/chat/completions`, {
				method: 'POST',
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
				headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: model.slice('openrouter/'.length),
					messages: [
						{
							role: 'user',
							content: [
								{ type: 'image_url', image_url: { url: `data:${mimeType};base64,${Buffer.from(image).toString('base64')}` } },
								{ type: 'text', text: prompt },
							],
						},
					],
					max_tokens: 800,
					usage: { include: true },
				}),
			});
			if (!response.ok) throw new Error(`OpenRouter ${model}: ${response.status} ${(await response.text()).slice(0, 300)}`);
			const body = (await response.json()) as WireResponse;
			const text = body.choices?.[0]?.message?.content?.trim();
			if (!text) throw new Error(`${model} said nothing about the image`);
			return { text, inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0, cost: body.usage?.cost ?? 0 };
		},
	};
}
