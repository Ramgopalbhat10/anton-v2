import { config } from '../config.ts';
import type { Reasoning } from '../core/ports.ts';
import { InvalidInputError } from '../core/errors.ts';
import { getSetting, setSetting } from '../db/settings.ts';
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
	/** The agent gets run_script, to do many reads, searches or lookups in one short program. */
	codeMode: boolean;
	/** Each helper agent's own model; null uses the task's. */
	agentModels: Record<HelperAgent, AgentModel | null>;
};

/** The agents that work for the coder: its explorer, tester and browser subagents, and the reviewer of its pull requests. */
export const HELPER_AGENTS = ['explorer', 'tester', 'browser', 'reviewer'] as const;
export type HelperAgent = (typeof HELPER_AGENTS)[number];
/** A null reasoning level uses the model's default. */
export type AgentModel = { model: string; reasoning: Reasoning | null };

const KEY = 'general';

export async function generalSettings(): Promise<GeneralSettings> {
	const stored = await getSetting<Partial<GeneralSettings>>(KEY, {});
	const agentModels = { explorer: null, tester: null, browser: null, reviewer: null, ...stored.agentModels };
	return { model: null, reasoning: null, planMode: false, reviewPullRequests: true, codeMode: false, ...stored, agentModels };
}

export async function setGeneralSettings(next: GeneralSettings): Promise<GeneralSettings> {
	for (const model of [next.model, ...Object.values(next.agentModels).map((choice) => choice?.model)]) {
		if (model && !(await findModel(model))) throw new InvalidInputError(`Unknown model: ${model}`);
	}
	await setSetting(KEY, next);
	return next;
}

export async function defaultModel(): Promise<string> {
	return (await generalSettings()).model ?? config.model;
}
