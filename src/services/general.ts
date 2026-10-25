import { config } from '../config.ts';
import type { Reasoning } from '../core/ports.ts';
import { InvalidInputError } from '../core/errors.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { getProviders } from '../providers/index.ts';
import { findModel } from './models.ts';

/** How a new task starts when the launcher or an automation does not say. */
export type GeneralSettings = {
	/** Null uses ANTON_MODEL. */
	model: string | null;
	/** Null uses the model's own default. */
	reasoning: Reasoning | null;
	planMode: boolean;
	/** A reviewer agent reads each pull request the agent opens or updates and comments on it. */
	reviewPullRequests: boolean;
	/** The agent gets run_script, to do many reads, searches or lookups in one short program, and reaches the repo's MCP servers through it. */
	codeMode: boolean;
	/** How much the agent draws its replies (cards, charts, pages) rather than writing them: off, when it helps, or freely. */
	visualReplies: VisualReplies;
	/** Pages the agent writes can call web APIs, through Anton (src/services/page-fetch.ts). */
	pageNetwork: boolean;
	/** The model generate_image draws with; null uses ANTON_IMAGE_MODEL. A task on an image model draws with its own. */
	imageModel: string | null;
	/** Each helper agent's own model; null uses the task's. */
	agentModels: Record<HelperAgent, AgentModel | null>;
	/** The models Anton runs behind the agents for its own work; null uses each one's default. */
	backgroundModels: Record<BackgroundTask, string | null>;
	/**
	 * The context, in tokens, past which a conversation is compacted, when that comes before the model's
	 * window fills; null waits for the window. Every call sends the whole conversation, so a long thread
	 * on a 1M model otherwise sends up to a million tokens a call.
	 */
	compactAt: CompactAt;
};

export const COMPACT_AT = [100_000, 200_000, 400_000] as const;
export type CompactAt = (typeof COMPACT_AT)[number] | null;
export const DEFAULT_COMPACT_AT: CompactAt = 200_000;

export const VISUAL_REPLIES = ['off', 'some', 'more'] as const;
export type VisualReplies = (typeof VISUAL_REPLIES)[number];

/** The agents that work for the coder: its explorer, tester, browser and computer subagents, and the reviewer of its pull requests. */
export const HELPER_AGENTS = ['explorer', 'tester', 'browser', 'computer', 'reviewer'] as const;
export type HelperAgent = (typeof HELPER_AGENTS)[number];
/** A null reasoning level uses the model's default. */
export type AgentModel = { model: string; reasoning: Reasoning | null };

/**
 * Work Anton has a model do behind the agents: naming tasks, reading long web results for the agent (src/services/web-digest.ts),
 * seeing the screen for a computer subagent whose models cannot, and summarizing a conversation when it compacts.
 */
export const BACKGROUND_TASKS = ['title', 'webDigest', 'vision', 'compaction'] as const;
export type BackgroundTask = (typeof BACKGROUND_TASKS)[number];
/** The models these use with nothing chosen; compaction's null is the task's own model. */
export const backgroundDefaults = (): Record<BackgroundTask, string | null> => ({
	title: config.titleModel,
	webDigest: config.webDigestModel,
	vision: config.visionModel,
	compaction: null,
});
/** Run through the TextModel and VisionModel ports, which reach OpenRouter only. */
const ON_OPENROUTER: BackgroundTask[] = ['title', 'webDigest', 'vision'];
const NO_BACKGROUND_MODELS: Record<BackgroundTask, string | null> = { title: null, webDigest: null, vision: null, compaction: null };

const KEY = 'general';

/** The agents render synchronously, so they read the compaction point from the settings last read; each message reads them first. */
let compactAtNow: CompactAt = DEFAULT_COMPACT_AT;
export const compactionCeiling = (): CompactAt => compactAtNow;
/** Read the same way, from the settings last read: a title, a digest or a compaction cannot wait on the database. */
let backgroundNow: Record<BackgroundTask, string | null> = NO_BACKGROUND_MODELS;
/** The model for one kind of background work: the one chosen in Settings › General, else its default. */
export const backgroundModel = (task: BackgroundTask): string | null => backgroundNow[task] ?? backgroundDefaults()[task];

export async function generalSettings(): Promise<GeneralSettings> {
	const stored = await getSetting<Partial<GeneralSettings>>(KEY, {});
	const agentModels = { explorer: null, tester: null, browser: null, computer: null, reviewer: null, ...stored.agentModels };
	const settings: GeneralSettings = {
		model: null,
		reasoning: null,
		planMode: false,
		reviewPullRequests: true,
		codeMode: true,
		visualReplies: 'some',
		pageNetwork: true,
		imageModel: null,
		compactAt: DEFAULT_COMPACT_AT,
		...stored,
		agentModels,
		backgroundModels: { ...NO_BACKGROUND_MODELS, ...stored.backgroundModels },
	};
	compactAtNow = settings.compactAt;
	backgroundNow = settings.backgroundModels;
	return settings;
}

export async function setGeneralSettings(next: GeneralSettings): Promise<GeneralSettings> {
	for (const model of [next.model, ...Object.values(next.agentModels).map((choice) => choice?.model)]) {
		if (model && !(await findModel(model))) throw new InvalidInputError(`Unknown model: ${model}`);
	}
	for (const task of BACKGROUND_TASKS) {
		const model = next.backgroundModels[task];
		if (!model) continue;
		const info = await findModel(model);
		if (!info) throw new InvalidInputError(`Unknown model: ${model}`);
		if (ON_OPENROUTER.includes(task) && !model.startsWith('openrouter/')) throw new InvalidInputError(`${model} is not an OpenRouter model, which ${task} needs`);
		if (task === 'vision' && !info.vision) throw new InvalidInputError(`${model} does not read images`);
	}
	const images = getProviders().images;
	if (next.imageModel && images && !(await images.list()).some((info) => info.id === next.imageModel)) {
		throw new InvalidInputError(`Unknown image model: ${next.imageModel}`);
	}
	await setSetting(KEY, next);
	compactAtNow = next.compactAt;
	backgroundNow = next.backgroundModels;
	return next;
}

export async function defaultModel(): Promise<string> {
	return (await generalSettings()).model ?? config.model;
}
