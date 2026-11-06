import { registerRoutedModels } from '../core/routed-models.ts';
import { config } from '../config.ts';
import type { OpenRouterEffort, Reasoning } from '../core/ports.ts';
import { InvalidInputError } from '../core/errors.ts';
import type { AgentModel, HelperAgent } from '../core/types.ts';
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
	/** The OpenRouter model that names tasks and routines in a few words; null uses ANTON_TITLE_MODEL. */
	titleModel: string | null;
	/** Each helper agent's own model; null uses the task's. */
	agentModels: Record<HelperAgent, AgentModel | null>;
	/** The models Anton runs behind the agents for its own work; null uses each one's default. */
	backgroundModels: Record<BackgroundTask, string | null>;
	/** The effort each of those models works at, when one is chosen; null uses the work's own default. */
	backgroundReasoning: Record<BackgroundTask, Reasoning | null>;
	/**
	 * The context, in tokens, past which a conversation is compacted, when that comes before the model's
	 * window fills; null waits for the window. Every call sends the whole conversation, so a long thread
	 * on a 1M model otherwise sends up to a million tokens a call.
	 */
	compactAt: CompactAt;
	/**
	 * The same for Claude Code's models, which run on the plan's limits: Claude Code serves some at 1M, and a
	 * long thread compacted late spends more of the plan re-reading it each call than the summary costs.
	 */
	claudeCodeCompactAt: CompactAt;
};

export const COMPACT_AT = [100_000, 200_000, 400_000] as const;
export type CompactAt = (typeof COMPACT_AT)[number] | null;
export const DEFAULT_COMPACT_AT: CompactAt = 200_000;
export const DEFAULT_CLAUDE_CODE_COMPACT_AT: CompactAt = 200_000;

export const VISUAL_REPLIES = ['off', 'some', 'more'] as const;
export type VisualReplies = (typeof VISUAL_REPLIES)[number];

/** The agents that work for the coder, shared with src/db/spaces.ts, which stores a project's own choices for them. */
export { HELPER_AGENTS, type AgentModel, type HelperAgent } from '../core/types.ts';

/**
 * Work Anton has a model do behind the agents: reading long web results for the agent (src/services/web-digest.ts),
 * seeing the screen for a computer subagent whose models cannot, and summarizing a conversation when it compacts.
 */
export const BACKGROUND_TASKS = ['webDigest', 'vision', 'compaction'] as const;
export type BackgroundTask = (typeof BACKGROUND_TASKS)[number];
/** The models these use with nothing chosen; compaction's null is the task's own model. */
export const backgroundDefaults = (): Record<BackgroundTask, string | null> => ({
	webDigest: config.webDigestModel,
	vision: config.visionModel,
	compaction: null,
});
/** Run through the TextModel and VisionModel ports, which reach OpenRouter only. */
const ON_OPENROUTER: BackgroundTask[] = ['webDigest', 'vision'];
const NO_BACKGROUND_MODELS: Record<BackgroundTask, string | null> = { webDigest: null, vision: null, compaction: null };
const NO_BACKGROUND_REASONING: Record<BackgroundTask, Reasoning | null> = { webDigest: null, vision: null, compaction: null };

const KEY = 'general';

/** The agents render synchronously, so they read the compaction point from the settings last read; each message reads them first. */
let compactAtNow: CompactAt = DEFAULT_COMPACT_AT;
let claudeCodeCompactAtNow: CompactAt = DEFAULT_CLAUDE_CODE_COMPACT_AT;
export const compactionCeiling = (): CompactAt => compactAtNow;
/** Where a conversation on `model` (`<gateway>/<model>`) compacts: Claude Code's own point for its models, else Compact at. */
export const compactionCeilingFor = (model: string, settings: Pick<GeneralSettings, 'compactAt' | 'claudeCodeCompactAt'> = { compactAt: compactAtNow, claudeCodeCompactAt: claudeCodeCompactAtNow }): CompactAt =>
	model.startsWith('claude-code/') ? settings.claudeCodeCompactAt : settings.compactAt;
/** Read the same way, from the settings last read: a digest or a compaction cannot wait on the database. */
let backgroundNow: Record<BackgroundTask, string | null> = NO_BACKGROUND_MODELS;
let backgroundEffortNow: Record<BackgroundTask, Reasoning | null> = NO_BACKGROUND_REASONING;
/** The model for one kind of background work: the one chosen in Settings › General, else its default. */
export const backgroundModel = (task: BackgroundTask): string | null => backgroundNow[task] ?? backgroundDefaults()[task];
/** An effort as OpenRouter takes it: its nearest level for the two Anton has and it does not. */
export function textEffort(level: Reasoning | null): OpenRouterEffort | undefined {
	if (!level) return undefined;
	return level === 'max' ? 'xhigh' : level;
}

/** The effort chosen beside that model in Settings › General; null when none was, or no model was chosen. */
export const backgroundReasoning = (task: BackgroundTask): Reasoning | null => (backgroundNow[task] ? (backgroundEffortNow[task] ?? null) : null);

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
		titleModel: null,
		compactAt: DEFAULT_COMPACT_AT,
		claudeCodeCompactAt: DEFAULT_CLAUDE_CODE_COMPACT_AT,
		...stored,
		agentModels,
		backgroundModels: { ...NO_BACKGROUND_MODELS, ...stored.backgroundModels },
		backgroundReasoning: { ...NO_BACKGROUND_REASONING, ...stored.backgroundReasoning },
	};
	compactAtNow = settings.compactAt;
	claudeCodeCompactAtNow = settings.claudeCodeCompactAt;
	registerRoutedModels('background', Object.values(settings.backgroundModels));
	backgroundNow = settings.backgroundModels;
	backgroundEffortNow = settings.backgroundReasoning;
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
	// Titles are written over OpenRouter's plain chat API (src/providers/openrouter/text.ts), so a plan's model cannot write them.
	if (next.titleModel && !(next.titleModel.startsWith('openrouter/') && (await findModel(next.titleModel)))) {
		throw new InvalidInputError(`Titles are written by an OpenRouter model; ${next.titleModel} is not one.`);
	}
	await setSetting(KEY, next);
	compactAtNow = next.compactAt;
	claudeCodeCompactAtNow = next.claudeCodeCompactAt;
	registerRoutedModels('background', Object.values(next.backgroundModels));
	backgroundNow = next.backgroundModels;
	backgroundEffortNow = next.backgroundReasoning;
	return next;
}

/** The model that names tasks and routines. */
export async function titleModel(): Promise<string> {
	return (await generalSettings()).titleModel ?? config.titleModel;
}

export async function defaultModel(): Promise<string> {
	return (await generalSettings()).model ?? config.model;
}
