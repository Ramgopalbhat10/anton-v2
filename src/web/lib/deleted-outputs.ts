import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { categoryOf } from '@/lib/artifacts';
import { isImagePath } from '../../core/outputs';

/*
 * Files you deleted from a task's Library (there or on the Artifacts page).
 * A reply that drew one, linked it or carded it says it was deleted instead
 * of showing a broken picture or page. Read from the task's Library listing,
 * the query its Library panel and the reply's cards share, which a delete
 * refreshes everywhere at once (live-updates.ts).
 */

/** Whether the task's file was deleted; false while unknown, or with no task. */
export function useDeletedOutput(sessionId: string | null | undefined, path: string | null | undefined): boolean {
	const deleted = useQuery({
		queryKey: ['outputs', sessionId],
		queryFn: () => api.outputs(sessionId!),
		staleTime: 30_000,
		enabled: Boolean(sessionId && path),
		select: (data) => Boolean(path && data.deleted?.includes(path)),
	});
	return deleted.data ?? false;
}

/** What to call a deleted file: a page, an image, or a file. */
export function deletedNoun(path: string): string {
	if (categoryOf(path) === 'app') return 'page';
	if (isImagePath(path)) return 'image';
	return 'file';
}
