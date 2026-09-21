import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, type Session } from '@/lib/api';
import { useCreateChat } from '@/lib/create-chat';
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

export function ChatSidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
	const params = useParams({ strict: false }) as { sessionId?: string };
	const sessionsQuery = useQuery({ queryKey: ['sessions'], queryFn: api.sessions });
	const create = useCreateChat();
	const sessions = sessionsQuery.data?.sessions ?? [];
	const project = sessionsQuery.data?.project;
	const grouped = groupSessions(sessions);

	return (
		<aside
			className={cn(
				'w-[260px] shrink-0 flex-col border-r border-border bg-sidebar',
				open ? 'fixed inset-y-0 left-12 z-30 flex shadow-2xl md:static md:shadow-none' : 'hidden md:flex',
			)}
		>
			<div className="flex h-10 shrink-0 items-center border-b border-border px-3">
				<div className="truncate text-[13px] font-medium">Anton</div>
			</div>
			<div className="px-2 pb-2 pt-3">
				<Button
					className="h-8 w-full justify-start gap-2 px-2 font-normal"
					variant="outline"
					onClick={() => {
						create.mutate();
						onNavigate();
					}}
					disabled={create.isPending}
				>
					<Plus className="size-3.5" />
					New chat
				</Button>
			</div>
			<div className="flex h-7 items-center px-3 text-[11px] text-muted-foreground">
				<span className="truncate">{project?.repoFullName ?? 'local/anton-v2'}</span>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
				{sessionsQuery.isError ? (
					<p className="px-2 py-2 text-[13px] text-destructive">Could not load chats.</p>
				) : sessionsQuery.isPending ? (
					<div className="flex flex-col gap-1 px-1">
						<div className="h-7 animate-pulse rounded-md bg-muted" />
						<div className="h-7 animate-pulse rounded-md bg-muted" />
						<div className="h-7 animate-pulse rounded-md bg-muted" />
					</div>
				) : sessions.length === 0 ? (
					<p className="px-2 py-2 text-[13px] leading-5 text-muted-foreground">
						No chats yet. Start one to attach the workspace VM.
					</p>
				) : null}
				{Object.entries(grouped).map(([label, items]) =>
					items.length === 0 ? null : (
						<section key={label} className="mb-3">
							<div className="flex h-7 items-center px-2 text-[11px] text-muted-foreground">{label}</div>
							<div className="flex flex-col gap-0.5">
								{items.map((session) => (
									<Link
										key={session.id}
										to="/agents/$sessionId"
										params={{ sessionId: session.id }}
										search={{ app: 'code' }}
										onClick={onNavigate}
										className={cn(
											'flex h-7 items-center gap-2 rounded-md px-2 text-[13px] text-foreground/90 hover:bg-accent',
											params.sessionId === session.id && 'bg-accent text-foreground',
										)}
									>
										<span
											className={cn(
												'size-1.5 shrink-0 rounded-full',
												session.status === 'running' ? 'bg-foreground' : 'bg-muted-foreground/40',
											)}
										/>
										<span className="truncate">{session.title}</span>
									</Link>
								))}
							</div>
						</section>
					),
				)}
			</div>
			<div className="flex h-10 shrink-0 items-center gap-2 border-t border-border px-3">
				<div className="flex size-5 items-center justify-center rounded-full bg-muted text-[10px] font-medium">A</div>
				<span className="truncate text-[12px] text-muted-foreground">Anton Dev</span>
			</div>
		</aside>
	);
}
