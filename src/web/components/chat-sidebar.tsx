import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { api, type Session } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function groupSessions(sessions: Session[]) {
	const now = Date.now();
	const buckets: Record<string, Session[]> = {
		Today: [],
		Yesterday: [],
		'Last 7 days': [],
		'Last 30 days': [],
	};
	for (const session of sessions) {
		const age = now - new Date(session.createdAt).getTime();
		if (age < 24 * 60 * 60 * 1000) buckets.Today.push(session);
		else if (age < 48 * 60 * 60 * 1000) buckets.Yesterday.push(session);
		else if (age < 7 * 24 * 60 * 60 * 1000) buckets['Last 7 days'].push(session);
		else buckets['Last 30 days'].push(session);
	}
	return buckets;
}

export function ChatSidebar() {
	const navigate = useNavigate();
	const params = useParams({ strict: false }) as { sessionId?: string };
	const queryClient = useQueryClient();
	const sessionsQuery = useQuery({ queryKey: ['sessions'], queryFn: api.sessions });
	const create = useMutation({
		mutationFn: () => api.createSession({ title: 'New chat' }),
		onSuccess: (session) => {
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
			void navigate({ to: '/agents/$sessionId', params: { sessionId: session.id } });
		},
	});

	const sessions = sessionsQuery.data?.sessions ?? [];
	const project = sessionsQuery.data?.project;
	const grouped = groupSessions(sessions);

	return (
		<aside className="flex w-64 flex-col border-r border-border bg-card">
			<div className="flex items-center justify-between px-3 py-3">
				<div className="text-sm font-medium">Anton v2</div>
			</div>
			<div className="px-2">
				<Button className="w-full" variant="secondary" onClick={() => create.mutate()} disabled={create.isPending}>
					New Chat
				</Button>
			</div>
			<div className="mt-3 px-3 text-xs text-muted-foreground">{project?.repoFullName ?? 'local/anton-v2'}</div>
			<div className="mt-4 flex-1 overflow-y-auto px-2">
				{Object.entries(grouped).map(([label, items]) =>
					items.length === 0 ? null : (
						<section key={label} className="mb-4">
							<div className="px-2 pb-1 text-xs text-muted-foreground">{label}</div>
							{items.map((session) => (
								<Link
									key={session.id}
									to="/agents/$sessionId"
									params={{ sessionId: session.id }}
									className={cn(
										'mb-1 block truncate rounded-md px-2 py-1.5 text-sm hover:bg-accent',
										params.sessionId === session.id && 'bg-accent',
									)}
								>
									{session.title}
								</Link>
							))}
						</section>
					),
				)}
			</div>
			<div className="border-t border-border px-3 py-3 text-xs text-muted-foreground">Anton Dev</div>
		</aside>
	);
}
