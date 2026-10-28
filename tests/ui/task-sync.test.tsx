import { describe, expect, it } from 'vitest';
import type { Session } from '@/lib/api';
import { appQueryClient } from '@/lib/task-sync';
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
