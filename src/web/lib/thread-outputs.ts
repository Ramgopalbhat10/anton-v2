import { useQueries, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api, type Output, type Session } from '@/lib/api';
import type { ViewerItem } from '@/lib/viewer';
import { outputLinkPath } from '../../core/outputs';

/*
 * What a project's threads saved, for the coordinator's side of the project:
 * the files each thread's row offers, and the links the coordinator passes on
 * from a thread's reply, which name a file in that thread's Library.
 */

/** The threads whose files the project reads, newest first; the Library lists as many. */
export const LISTED_THREADS = 24;

/** A thread's Library without the files you attached, newest first. */
export const madeBy = (outputs: Output[] | undefined): Output[] => (outputs ?? []).filter((output) => !output.path.startsWith('uploads/')).sort((a, b) => b.mtimeMs - a.mtimeMs);

/** One thread's Library, shared with its Library panel's own query. */
export function useThreadOutputs(sessionId: string): Output[] {
	const outputs = useQuery({ queryKey: ['outputs', sessionId], queryFn: () => api.outputs(sessionId), staleTime: 30_000 });
	return useMemo(() => madeBy(outputs.data?.outputs), [outputs.data]);
}

/** A thread named by the start of its id, as the coordinator names them. */
const byPrefix = (threads: Session[], id: string) => threads.find((thread) => thread.id === id || (id.length >= 6 && thread.id.startsWith(id)));

/**
 * Finds the thread file a link in the coordinator's words names: by the
 * thread's id (`#thread-1a2b3c4d/outputs/diagram.png`), or, for a path the
 * coordinator copied from a reply (`../outputs/diagram.png`), the newest
 * thread that saved a file there, else the newest whose reply names it.
 */
export function useThreadFileResolver(threads: Session[]): (href: string) => ViewerItem | null {
	const recent = useMemo(() => [...threads].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, LISTED_THREADS), [threads]);
	const results = useQueries({ queries: recent.map((thread) => ({ queryKey: ['outputs', thread.id], queryFn: () => api.outputs(thread.id), staleTime: 30_000 })) });
	const stamp = results.map((result) => result.dataUpdatedAt).join(',');
	// The results come as a new array each render; their update times say when one changed.
	const owners = useMemo(() => {
		const map = new Map<string, string>();
		recent.forEach((thread, index) => {
			for (const output of results[index]?.data?.outputs ?? []) if (!map.has(output.path)) map.set(output.path, thread.id);
		});
		return map;
	}, [recent, stamp]);
	return useMemo(
		() => (href: string) => {
			const named = /^#thread-([\w-]+)\/(.+)$/.exec(href.trim());
			if (named) {
				const thread = byPrefix(threads, named[1]);
				const path = outputLinkPath(named[2]);
				return thread && path ? { sessionId: thread.id, path } : null;
			}
			const path = outputLinkPath(href);
			if (!path) return null;
			const owner = owners.get(path) ?? recent.find((thread) => thread.lastReply?.includes(path))?.id;
			return owner ? { sessionId: owner, path } : null;
		},
		[threads, recent, owners],
	);
}
