import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { categoryOf } from '@/lib/artifacts';
import { isImagePath } from '../../core/outputs';

/* A reply that drew, linked or carded a file you deleted says so rather than show it broken; read from the Library listing a delete refreshes everywhere. */

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

export function deletedNoun(path: string): string {
	if (categoryOf(path) === 'app') return 'page';
	if (isImagePath(path)) return 'image';
	return 'file';
}
