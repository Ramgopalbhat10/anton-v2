import type { ModelInfo, Reasoning } from '../core/ports.ts';
import { getProviders } from '../providers/index.ts';

let loaded: readonly ModelInfo[] = [];

/** Every model the gateway offers for agent work. */
export async function listModels(): Promise<ModelInfo[]> {
	const models = await getProviders().models.list();
	loaded = models;
	return models;
}

/** The last list fetched, for the agent's synchronous model lookup. */
export function loadedModels(): readonly ModelInfo[] {
	return loaded;
}

export async function findModel(id: string): Promise<ModelInfo | undefined> {
	return (await listModels()).find((model) => model.id === id);
}

/** The level a task runs at: its own choice when the model accepts it, else the model's default. */
export function reasoningFor(model: ModelInfo | undefined, chosen: Reasoning | null): Reasoning {
	if (!model?.reasoning.length) return 'off';
	return chosen && model.reasoning.includes(chosen) ? chosen : model.defaultReasoning;
}
