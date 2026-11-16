import { registerRoutedModels } from '../../core/routed-models.ts';
import { config } from '../../config.ts';
import type { OpenRouterEffort, Reasoning } from '../../core/ports.ts';
import { InvalidInputError } from '../../core/errors.ts';
import type { AgentModel, HelperAgent } from '../../core/types.ts';
import { getSetting, setSetting } from '../../db/settings.ts';
import { getProviders } from '../../providers/index.ts';
import { findModel } from './models.ts';

export type GeneralSettings = {
	/** Null uses ANTON_MODEL. */
	model: string | null;
	/** Null uses the model's own default. */
	reasoning: Reasoning | null;
	planMode: boolean;
	reviewPullRequests: boolean;
	codeMode: boolean;
	visualReplies: VisualReplies;
	pageNetwork: boolean;
	/** Null uses ANTON_IMAGE_MODEL. A task on an image model draws with its own. */
	imageModel: string | null;
	/** An OpenRouter model; null uses ANTON_TITLE_MODEL. */
	titleModel: string | null;
	/** Null uses the task's. */
	agentModels: Record<HelperAgent, AgentModel | null>;
	backgroundModels: Record<BackgroundTask, string | null>;
	backgroundReasoning: Record<BackgroundTask, Reasoning | null>;
	/** In tokens; null waits for the window. Every call sends the whole conversation, so a late compaction on a 1M model costs up to a million tokens a call. */
	compactAt: CompactAt;
	/** Claude Code serves some models at 1M, and a thread compacted late spends more of the plan re-reading it than the summary costs. */
	claudeCodeCompactAt: CompactAt;
};

export const COMPACT_AT = [100_000, 200_000, 400_000] as const;
export type CompactAt = (typeof COMPACT_AT)[number] | null;
export const DEFAULT_COMPACT_AT: CompactAt = 200_000;
export const DEFAULT_CLAUDE_CODE_COMPACT_AT: CompactAt = 200_000;

export const VISUAL_REPLIES = ['off', 'some', 'more'] as const;
export type VisualReplies = (typeof VISUAL_REPLIES)[number];

/** Shared with src/db/spaces.ts, which stores a project's own choices for them. */
export { HELPER_AGENTS, type AgentModel, type HelperAgent } from '../../core/types.ts';

export const BACKGROUND_TASKS = ['webDigest', 'vision', 'compaction'] as const;
export type BackgroundTask = (typeof BACKGROUND_TASKS)[number];
/** Compaction's null is the task's own model. */
export const backgroundDefaults = (): Record<BackgroundTask, string | null> => ({
	webDigest: config.webDigestModel,
	vision: config.visionModel,
	compaction: null,
});
/** The TextModel and VisionModel ports reach OpenRouter only. */
const ON_OPENROUTER: BackgroundTask[] = ['webDigest', 'vision'];
const NO_BACKGROUND_MODELS: Record<BackgroundTask, string | null> = { webDigest: null, vision: null, compaction: null };
const NO_BACKGROUND_REASONING: Record<BackgroundTask, Reasoning | null> = { webDigest: null, vision: null, compaction: null };

const KEY = 'general';

/** The agents render synchronously, so they read this from the settings last read; each message reads them first. */
let compactAtNow: CompactAt = DEFAULT_COMPACT_AT;
let claudeCodeCompactAtNow: CompactAt = DEFAULT_CLAUDE_CODE_COMPACT_AT;
export const compactionCeiling = (): CompactAt => compactAtNow;
/** Claude Code's own point for its models, else Compact at. */
export const compactionCeilingFor = (model: string, settings: Pick<GeneralSettings, 'compactAt' | 'claudeCodeCompactAt'> = { compactAt: compactAtNow, claudeCodeCompactAt: claudeCodeCompactAtNow }): CompactAt =>
	model.startsWith('claude-code/') ? settings.claudeCodeCompactAt : settings.compactAt;
/** A digest or a compaction cannot wait on the database. */
let backgroundNow: Record<BackgroundTask, string | null> = NO_BACKGROUND_MODELS;
let backgroundEffortNow: Record<BackgroundTask, Reasoning | null> = NO_BACKGROUND_REASONING;
export const backgroundModel = (task: BackgroundTask): string | null => backgroundNow[task] ?? backgroundDefaults()[task];
/** Its nearest level for the two Anton has and OpenRouter does not. */
export function textEffort(level: Reasoning | null): OpenRouterEffort | undefined {
	if (!level) return undefined;
	return level === 'max' ? 'xhigh' : level;
}

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

export async function titleModel(): Promise<string> {
	return (await generalSettings()).titleModel ?? config.titleModel;
}

export async function defaultModel(): Promise<string> {
	return (await generalSettings()).model ?? config.model;
}
