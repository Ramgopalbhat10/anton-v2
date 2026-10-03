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
};

const KEY = 'general';

export async function generalSettings(): Promise<GeneralSettings> {
	return { model: null, reasoning: null, planMode: false, ...(await getSetting<Partial<GeneralSettings>>(KEY, {})) };
}

export async function setGeneralSettings(next: GeneralSettings): Promise<GeneralSettings> {
	if (next.model && !(await findModel(next.model))) throw new InvalidInputError(`Unknown model: ${next.model}`);
	await setSetting(KEY, next);
	return next;
}

export async function defaultModel(): Promise<string> {
	return (await generalSettings()).model ?? config.model;
}
