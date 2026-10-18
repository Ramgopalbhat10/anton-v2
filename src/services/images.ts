import { randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import { announce } from '../core/changes.ts';
import { InvalidInputError } from '../core/errors.ts';
import { writeMachineFile } from '../core/machine-fs.ts';
import type { ImageModelInfo, ImageReference } from '../core/ports.ts';
import { quote } from '../core/shell.ts';
import { getProviders } from '../providers/index.ts';
import { slug } from './browser-step.ts';
import { saveOutput } from './checkpoints.ts';
import { readOutputFile } from './files.ts';
import { countReplySpend } from './response-usage.ts';
import { generalSettings } from './general.ts';
import { modelFor } from './sessions.ts';
import { recordUsage } from './usage.ts';
import { liveMachine } from './workspace.ts';

/*
 * Images the agent makes with generate_image, through the ImageModel port
 * (OpenRouter's image models). The task's own model only writes the prompt,
 * so a model that cannot draw, or a plan whose route offers no image tool
 * (ChatGPT's, Claude Code's), still makes images. Each one is kept in the
 * Library under images/ and drawn in the thread, and its cost is counted on
 * the task like any model call.
 */

export const IMAGE_DIR = 'images';
/** The most images one call starts from; models take more, but a prompt rarely needs them. */
export const MAX_REFERENCES = 4;
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

const NO_KEY = 'Making images needs an OpenRouter key. Add one under Settings › Subscriptions.';

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };

export const imagesAvailable = (): boolean => Boolean(getProviders().images);

/** The image models the key may use, for Settings › General; empty without a key. */
export async function imageModels(): Promise<ImageModelInfo[]> {
	return (await getProviders().images?.list()) ?? [];
}

/** The model an image is drawn with: the task's own when it is an image model, else Settings › General's, else ANTON_IMAGE_MODEL. */
export async function imageModelFor(id: string): Promise<string> {
	const listed = await imageModels().catch(() => []);
	const task = modelFor(id).model;
	if (listed.some((info) => info.id === task)) return task;
	return (await generalSettings()).imageModel ?? config.imageModel;
}

/** A Library path as the agent may write it: `../outputs/images/a.png` and `images/a.png` are the same file. */
const libraryPath = (path: string) => path.trim().replace(/^(\.\.\/)?outputs\//, '');

async function reference(id: string, path: string): Promise<ImageReference> {
	const file = libraryPath(path);
	const mimeType = IMAGE_TYPES[file.split('.').pop()?.toLowerCase() ?? ''];
	if (!mimeType) throw new InvalidInputError(`${path} is not a PNG, JPEG, WebP or GIF image.`);
	const bytes = await readOutputFile(id, file).catch(() => null);
	if (!bytes) throw new InvalidInputError(`${path} is not in the task's Library. Pass the path of an image you made, a screenshot, or one the user attached (uploads/…).`);
	if (bytes.length > MAX_REFERENCE_BYTES) throw new InvalidInputError(`${path} is over 10 MB.`);
	return { bytes, mimeType };
}

export type ImageRequest = { prompt: string; name?: string; from?: string[]; aspect_ratio?: string; transparent?: boolean };

export type MadeImage = { path: string; model: string; note: string };

/**
 * Makes one image and keeps it in the Library: in the sandbox's outputs folder
 * when the task has one, so its code can use the file, else in storage.
 */
export async function generateImage(id: string, request: ImageRequest, signal?: AbortSignal): Promise<MadeImage> {
	const images = getProviders().images;
	if (!images) throw new Error(NO_KEY);
	const prompt = request.prompt.trim();
	if (!prompt) throw new InvalidInputError('Describe the image to make in prompt.');
	const from = request.from ?? [];
	if (from.length > MAX_REFERENCES) throw new InvalidInputError(`Start from at most ${MAX_REFERENCES} images.`);
	const model = await imageModelFor(id);
	if (!images.runs(model)) throw new InvalidInputError(`${model} is not an image model Anton can run. Choose one in Settings › General.`);
	const info = (await images.list().catch(() => [])).find((listed) => listed.id === model);
	if (from.length && info && info.references < from.length) {
		throw new InvalidInputError(info.references ? `${info.name} starts from at most ${info.references} images.` : `${info.name} makes images from words alone; describe the change instead.`);
	}
	const references = await Promise.all(from.map((path) => reference(id, path)));
	const made = await images.generate({ model, prompt, references, aspectRatio: request.aspect_ratio, transparent: request.transparent }, signal);
	await recordUsage(id, { inputTokens: made.inputTokens, outputTokens: made.outputTokens, cost: made.cost }, model);
	countReplySpend(id, made.cost);
	const path = `${IMAGE_DIR}/${slug(request.name ?? prompt.split(/\s+/).slice(0, 6).join(' ')) || 'image'}-${randomBytes(3).toString('hex')}.${EXTENSIONS[made.mimeType] ?? 'png'}`;
	const machine = await liveMachine(id).catch(() => null);
	if (machine) {
		await machine.exec(`mkdir -p ${quote(`${machine.root}/outputs/${IMAGE_DIR}`)}`);
		await writeMachineFile(machine, `${machine.root}/outputs/${path}`, made.image);
	} else {
		await saveOutput(id, path, made.image, made.mimeType);
	}
	announce({ kind: 'task', id, what: 'files' });
	const name = info ? `${info.vendor}: ${info.name}` : model;
	return {
		path,
		model: name,
		note:
			`Done: the image is already shown to the user in the thread, made with ${name}. It is in the Library as ${path}` +
			(machine ? `, and in the sandbox at ../outputs/${path}` : '') +
			'. Do not show, link or describe it again; reply in a sentence or two. To change it, call generate_image again with this path in from.',
	};
}
