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
	/** The explorer and tester subagents' model and reasoning level (null for the model's default); a null model uses each task's own. */
	subagentModel: string | null;
	subagentReasoning: Reasoning | null;
};

const KEY = 'general';

export async function generalSettings(): Promise<GeneralSettings> {
	return { model: null, reasoning: null, planMode: false, reviewPullRequests: true, codeMode: false, subagentModel: null, subagentReasoning: null, ...(await getSetting<Partial<GeneralSettings>>(KEY, {})) };
}

export async function setGeneralSettings(next: GeneralSettings): Promise<GeneralSettings> {
	for (const model of [next.model, next.subagentModel]) {
		if (model && !(await findModel(model))) throw new InvalidInputError(`Unknown model: ${model}`);
	}
	await setSetting(KEY, next);
	return next;
}

export async function defaultModel(): Promise<string> {
	return (await generalSettings()).model ?? config.model;
}
