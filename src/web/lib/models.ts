import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '@/lib/api';
import { unrouted } from '../../core/model-route';
import { shortName } from '@/lib/model-catalog';

type ModelList = Awaited<ReturnType<typeof api.models>>;

/** The list as this browser last fetched it, shown while the server answers, so the picker never opens empty. */
const SAVED_KEY = 'anton.models';

function savedModels(): ModelList | undefined {
	try {
		const raw = localStorage.getItem(SAVED_KEY);
		return raw ? (JSON.parse(raw) as ModelList) : undefined;
	} catch {
		return undefined;
	}
}

async function fetchModels(): Promise<ModelList> {
	const list = await api.models();
	try {
		localStorage.setItem(SAVED_KEY, JSON.stringify(list));
	} catch {
		// Storage full or blocked: the next visit waits for the server, as before.
	}
	return list;
}

export function useModels() {
	return useQuery({ queryKey: ['models'], queryFn: fetchModels, staleTime: 10 * 60_000, placeholderData: savedModels });
}

export function useModelName(): (model: string) => string {
	const models = useModels();
	const byId = useMemo(() => new Map((models.data?.models ?? []).map((model) => [model.id, shortName(model)] as const)), [models.data]);
	return (id) => {
		const model = unrouted(id);
		return byId.get(model) ?? (model.split('/').pop() ?? model).replace(/^~/, '');
	};
}
