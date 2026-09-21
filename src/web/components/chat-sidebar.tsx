import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
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
					className="w-full justify-start"
					variant="outline"
					onClick={() => {
						create.mutate();
						onNavigate();
					}}
					disabled={create.isPending}
				>
					<Plus data-icon="inline-start" />
					New chat
				</Button>
			</div>
			<div className="flex h-7 items-center px-3 text-[11px] text-muted-foreground">
				<span className="truncate">{project?.repoFullName ?? 'local/anton-v2'}</span>
			</div>
			<ScrollArea className="min-h-0 flex-1">
				<div className="px-2 pb-2">
				{sessionsQuery.isError ? (
					<Alert variant="destructive">
						<AlertDescription>Could not load chats.</AlertDescription>
					</Alert>
				) : sessionsQuery.isPending ? (
					<div className="flex flex-col gap-1 px-1">
						<Skeleton className="h-7" />
						<Skeleton className="h-7" />
						<Skeleton className="h-7" />
					</div>
				) : sessions.length === 0 ? (
					<Empty className="border-0 px-2">
						<EmptyHeader>
							<EmptyTitle>No chats yet</EmptyTitle>
							<EmptyDescription>Start one to attach the workspace VM.</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : null}
				{Object.entries(grouped).map(([label, items]) =>
					items.length === 0 ? null : (
						<section key={label} className="mb-3">
							<div className="flex h-7 items-center px-2 text-[11px] text-muted-foreground">{label}</div>
							<div className="flex flex-col gap-0.5">
								{items.map((session) => (
								<Button
									key={session.id}
									variant={params.sessionId === session.id ? 'secondary' : 'ghost'}
									size="sm"
									className="w-full justify-start"
									asChild
								>
									<Link
										to="/agents/$sessionId"
										params={{ sessionId: session.id }}
										search={{ app: 'code' }}
										onClick={onNavigate}
									>
										<span
											className={cn(
												'size-1.5 shrink-0 rounded-full',
												session.status === 'running' ? 'bg-foreground' : 'bg-muted-foreground/40',
											)}
										/>
										<span className="truncate">{session.title}</span>
									</Link>
								</Button>
								))}
							</div>
						</section>
					),
				)}
				</div>
			</ScrollArea>
			<div className="flex h-10 shrink-0 items-center gap-2 border-t border-border px-3">
				<Avatar className="size-5">
					<AvatarFallback>A</AvatarFallback>
				</Avatar>
				<span className="truncate text-[12px] text-muted-foreground">Anton Dev</span>
			</div>
		</aside>
	);
}
