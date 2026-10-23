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

const KEY = 'general';

/** The agents render synchronously, so they read the compaction point from the settings last read; each message reads them first. */
let compactAtNow: CompactAt = DEFAULT_COMPACT_AT;
export const compactionCeiling = (): CompactAt => compactAtNow;

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
	};
	compactAtNow = settings.compactAt;
	return settings;
}

export async function setGeneralSettings(next: GeneralSettings): Promise<GeneralSettings> {
	for (const model of [next.model, ...Object.values(next.agentModels).map((choice) => choice?.model)]) {
		if (model && !(await findModel(model))) throw new InvalidInputError(`Unknown model: ${model}`);
	}
	const images = getProviders().images;
	if (next.imageModel && images && !(await images.list()).some((info) => info.id === next.imageModel)) {
		throw new InvalidInputError(`Unknown image model: ${next.imageModel}`);
	}
	await setSetting(KEY, next);
	compactAtNow = next.compactAt;
	return next;
}

export async function defaultModel(): Promise<string> {
	return (await generalSettings()).model ?? config.model;
}
