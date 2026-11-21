import { describe, expect, it } from 'vitest';
import type { Session } from '@/lib/api/sessions';
import { appQueryClient, withWholeText } from '@/lib/task-sync';
import { session } from './render';

describe('a task read two ways', () => {
	it('shows the same title and state in its header as in the sidebar, whichever read lands last', async () => {
		const queryClient = appQueryClient();
		await queryClient.fetchQuery({ queryKey: ['session', 'a'], queryFn: async () => session({ id: 'a', title: 'what is the eth price today', working: true }) });
		await queryClient.fetchQuery({ queryKey: ['sessions'], queryFn: async () => ({ sessions: [session({ id: 'a', title: 'ETH price today', working: false }), session({ id: 'b' })] }) });
		expect(queryClient.getQueryData<Session>(['session', 'a'])).toMatchObject({ title: 'ETH price today', working: false });
		// A task not open anywhere is left to be read when it opens.
		expect(queryClient.getQueryData(['session', 'b'])).toBeUndefined();

		await queryClient.fetchQuery({ queryKey: ['session', 'a'], queryFn: async () => session({ id: 'a', title: 'ETH price today', working: false, asking: 'Which currency?' }), staleTime: 0 });
		expect(queryClient.getQueryData<{ sessions: Session[] }>(['sessions'])!.sessions[0]).toMatchObject({ asking: 'Which currency?' });
	});
});

describe('a task list of rows', () => {
	it('never shortens the open task’s texts, and takes a changed text as still cut', async () => {
		const queryClient = appQueryClient();
		const brief = `${'Plan the migration. '.repeat(60)}`;
		await queryClient.fetchQuery({ queryKey: ['session', 'a'], queryFn: async () => session({ id: 'a', brief, lastReply: 'old reply' }) });
		await queryClient.fetchQuery({
			queryKey: ['sessions'],
			queryFn: async () => ({ sessions: [session({ id: 'a', title: 'renamed', brief: brief.slice(0, 300), lastReply: 'a new reply, cut', cut: ['brief', 'lastReply'] })] }),
		});
		const own = queryClient.getQueryData<Session>(['session', 'a'])!;
		expect(own.title).toBe('renamed');
		expect(own.brief).toBe(brief);
		expect(own.lastReply).toBe('a new reply, cut');
		expect(own.cut).toEqual(['lastReply']);
	});

	it('takes a row whole when nothing was cut', () => {
		const row = session({ id: 'a', title: 'x' });
		expect(withWholeText(row, session({ id: 'a', title: 'y' }))).toBe(row);
	});
});
