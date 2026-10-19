import type { ImageModel, ImageModelInfo } from '../../core/ports.ts';

/** `apiKey` is read on each call, so a key pasted in Settings › Subscriptions needs no restart. */
export type ImagesOptions = { apiUrl: string; apiKey: () => string | null; ttlMs: number };

/** An image takes a model tens of seconds, a large one longer; one that hangs must not hold the reply up for good. */
const TIMEOUT_MS = 180_000;

type Parameter = { type: 'enum'; values: string[] } | { type: 'range'; min: number; max: number } | { type: 'boolean' };

/** The fields Anton reads from OpenRouter's `GET /images/models`. */
export type OpenRouterImageModel = {
	id: string;
	name: string;
	description?: string;
	supported_parameters?: Record<string, Parameter>;
};

type WireResponse = {
	data?: Array<{ b64_json?: string; media_type?: string }>;
	usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
};

const PREFIX = 'openrouter/';

const values = (parameter: Parameter | undefined): string[] => (parameter?.type === 'enum' ? parameter.values : []);

export function toImageModelInfo(model: OpenRouterImageModel): ImageModelInfo {
	const [vendor, ...rest] = model.name.split(': ');
	const references = model.supported_parameters?.input_references;
	return {
		id: `${PREFIX}${model.id}`,
		vendor: rest.length ? vendor : model.id.split('/')[0],
		name: rest.length ? rest.join(': ') : model.name,
		description: (model.description ?? '').slice(0, 200),
		references: references?.type === 'range' ? references.max : 0,
		aspectRatios: values(model.supported_parameters?.aspect_ratio).filter((ratio) => ratio !== 'auto'),
		transparent: values(model.supported_parameters?.background).includes('transparent'),
	};
}

/**
 * OpenRouter's image models, through its Images API (`POST /images`), with the
 * key Anton already has. The list is public and cached for `ttlMs`; a shape or
 * background the model does not offer is left out of the request rather than
 * failing it.
 */
export function openRouterImages({ apiUrl, apiKey, ttlMs }: ImagesOptions): ImageModel {
	let cached: { at: number; models: Promise<ImageModelInfo[]> } | undefined;

	function list(): Promise<ImageModelInfo[]> {
		if (cached && Date.now() - cached.at < ttlMs) return cached.models;
		const models = (async () => {
			const response = await fetch(`${apiUrl}/images/models`, { signal: AbortSignal.timeout(15_000) });
			if (!response.ok) throw new Error(`OpenRouter /images/models: ${response.status}`);
			return ((await response.json()) as { data: OpenRouterImageModel[] }).data.map(toImageModelInfo);
		})();
		const entry = { at: Date.now(), models };
		cached = entry;
		models.catch(() => cached === entry && (cached = undefined));
		return models;
	}

	return {
		runs: (model) => model.startsWith(PREFIX),
		list,
		async generate({ model, prompt, references, aspectRatio, transparent }, signal) {
			const key = apiKey();
			if (!key) throw new Error('Making images needs an OpenRouter key. Add one under Settings › Subscriptions.');
			const info = (await list().catch(() => [])).find((listed) => listed.id === model);
			const timeout = AbortSignal.timeout(TIMEOUT_MS);
			const response = await fetch(`${apiUrl}/images`, {
				method: 'POST',
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
				headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: model.slice(PREFIX.length),
					prompt,
					...(aspectRatio && (!info || info.aspectRatios.includes(aspectRatio)) ? { aspect_ratio: aspectRatio } : {}),
					...(transparent && info?.transparent ? { background: 'transparent', output_format: 'png' } : {}),
					...(references.length
						? {
								input_references: references.map((reference) => ({
									type: 'image_url',
									image_url: { url: `data:${reference.mimeType};base64,${Buffer.from(reference.bytes).toString('base64')}` },
								})),
							}
						: {}),
				}),
			});
			if (!response.ok) throw new Error(`OpenRouter ${model}: ${response.status} ${(await response.text()).slice(0, 300)}`);
			const body = (await response.json()) as WireResponse;
			const image = body.data?.find((item) => item.b64_json);
			if (!image?.b64_json) throw new Error(`${model} returned no image`);
			return {
				image: new Uint8Array(Buffer.from(image.b64_json, 'base64')),
				mimeType: image.media_type ?? 'image/png',
				inputTokens: body.usage?.prompt_tokens ?? 0,
				outputTokens: body.usage?.completion_tokens ?? 0,
				cost: body.usage?.cost ?? 0,
			};
		},
	};
}
