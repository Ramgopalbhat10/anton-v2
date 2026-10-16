import * as v from 'valibot';
import { config } from '../config.ts';
import { SCREEN } from '../core/desktop.ts';
import { getProviders } from '../providers/index.ts';
import { agentSettingsNow } from './agent-runner.ts';
import { loadedModels } from './models.ts';
import { modelFor } from './sessions.ts';
import { recordUsage } from './usage.ts';

/*
 * The computer tool's eyes: a vision model through the VisionModel port,
 * asked about one screenshot at a time with no tools, so it can only answer.
 * Each look is counted on the task like any model call.
 */

/**
 * The model that looks at the screen: the computer subagent's own model from
 * Settings when the vision port runs it and it reads images, else the task's,
 * else ANTON_VISION_MODEL.
 */
export function visionModelFor(id: string): string {
	const vision = getProviders().vision;
	const models = loadedModels();
	const sees = (model: string | undefined): model is string => Boolean(model && vision?.runs(model) && models.find((info) => info.id === model)?.vision);
	const own = agentSettingsNow().models.computer?.model;
	if (sees(own)) return own;
	const task = modelFor(id).model;
	return sees(task) ? task : config.visionModel;
}

const ON_SCREEN = `This is a screenshot of a computer's screen, ${SCREEN.width}×${SCREEN.height} pixels. Answer from the image alone.`;

async function look(id: string, prompt: string, png: Uint8Array, signal?: AbortSignal, mimeType = 'image/png'): Promise<{ text: string; cost: number }> {
	const vision = getProviders().vision;
	if (!vision) throw new Error('Seeing the screen needs an OpenRouter key (OPENROUTER_API_KEY).');
	const model = visionModelFor(id);
	const answer = await vision.look({ model, prompt, image: png, mimeType }, signal);
	await recordUsage(id, { inputTokens: answer.inputTokens, outputTokens: answer.outputTokens, cost: answer.cost }, model);
	return { text: answer.text, cost: answer.cost };
}

const Located = v.object({ found: v.boolean(), x: v.optional(v.nullable(v.number())), y: v.optional(v.nullable(v.number())), note: v.optional(v.string(), '') });

/** The first JSON object in a model's answer, which may come wrapped in a code fence or a sentence. */
export function jsonIn(text: string): unknown {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start < 0 || end < start) return null;
	try {
		return JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
}

/** Where `what` is on the screen, in pixels, or why it is not there. */
export async function locate(id: string, what: string, png: Uint8Array, signal?: AbortSignal): Promise<{ at: { x: number; y: number } | null; note: string; cost: number }> {
	const { text, cost } = await look(
		id,
		`${ON_SCREEN} Find ${what}. Reply with JSON only: {"found": true, "x": <pixels from the left>, "y": <pixels from the top>, "note": "<what is there>"} for the centre of it, ` +
			'or {"found": false, "note": "<what the screen shows instead>"}.',
		png,
		signal,
	);
	const parsed = v.safeParse(Located, jsonIn(text));
	if (!parsed.success) return { at: null, note: `The screen could not be read for ${what}.`, cost };
	const { found, x, y, note } = parsed.output;
	const inside = found && typeof x === 'number' && typeof y === 'number' && x >= 0 && y >= 0 && x < SCREEN.width && y < SCREEN.height;
	return { at: inside ? { x, y } : null, note, cost };
}

/** What the screen shows, in a few sentences, with the positions of what matters for `focus`. */
export async function describe(id: string, png: Uint8Array, focus: string | null, signal?: AbortSignal): Promise<{ screen: string; cost: number }> {
	const { text, cost } = await look(
		id,
		`${ON_SCREEN} In under 120 words, say what it shows: the focused window, any dialog, error or text that matters, and the controls that matter, each with the centre of it as (x, y) in pixels.` +
			(focus ? ` Focus on what bears on this: ${focus}` : ''),
		png,
		signal,
	);
	return { screen: text, cost };
}

/**
 * An image put into words, for a task whose own model cannot see: a picture
 * attached to a project thread's brief reaches it as this description.
 */
export async function describeImage(id: string, image: Uint8Array, mimeType: string, signal?: AbortSignal): Promise<string> {
	const { text } = await look(
		id,
		'Describe this image for someone who will work from it without seeing it, in under 250 words: what it is, its layout from top to bottom, every piece of text in it word for word, the colours, and any detail that matters.',
		image,
		signal,
		mimeType,
	);
	return text.trim();
}
