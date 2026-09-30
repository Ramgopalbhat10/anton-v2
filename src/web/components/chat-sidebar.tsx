import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { RepoPicker } from '@/components/repo-picker';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
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
	const queryClient = useQueryClient();
	const sessionsQuery = useQuery({ queryKey: ['sessions'], queryFn: api.sessions });
	const me = useQuery({ queryKey: ['me'], queryFn: api.me });
	const create = useCreateChat();
	const [pickerOpen, setPickerOpen] = useState(false);
	const pendingChat = useRef(false);
	const sessions = sessionsQuery.data?.sessions ?? [];
	const projects = sessionsQuery.data?.projects ?? (sessionsQuery.data?.project ? [sessionsQuery.data.project] : []);
	const storedId = typeof window === 'undefined' ? null : localStorage.getItem('anton.projectId');
	const project = projects.find((item) => item.id === storedId) ?? sessionsQuery.data?.project ?? projects[0];
	const grouped = groupSessions(sessions);
	const oauth = Boolean(me.data?.oauth);

	function newChat() {
		if (oauth && !project) {
			pendingChat.current = true;
			setPickerOpen(true);
			return;
		}
		create.mutate(oauth ? project?.id : undefined);
		onNavigate();
	}

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
					variant="secondary"
					onClick={newChat}
					disabled={create.isPending}
				>
					<Plus data-icon="inline-start" />
					New chat
				</Button>
			</div>
			<div className="flex h-7 items-center px-3 text-[11px] text-muted-foreground">
				{oauth ? (
					<button type="button" className="truncate hover:text-foreground" onClick={() => setPickerOpen(true)}>
						{project?.repoFullName ?? 'Choose a repository'}
					</button>
				) : (
					<span className="truncate">{project?.repoFullName ?? 'local/anton-v2'}</span>
				)}
			</div>
			<ScrollArea className="min-h-0 flex-1">
				<div className="px-2 pb-2">
				{sessionsQuery.isError ? (
					<p className="px-2 py-2 text-[13px] text-destructive">Could not load chats.</p>
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
					{me.data?.user?.avatarUrl ? <AvatarImage src={me.data.user.avatarUrl} alt="" /> : null}
					<AvatarFallback>{(me.data?.user?.login ?? 'A').slice(0, 1).toUpperCase()}</AvatarFallback>
				</Avatar>
				<span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
					{oauth ? (me.data?.user?.login ?? 'GitHub') : 'Anton Dev'}
				</span>
				{me.data?.user?.needsReconnect ? (
					<a href="/api/auth/github" className="shrink-0 text-[12px] text-foreground underline-offset-4 hover:underline">
						Reconnect
					</a>
				) : null}
				{oauth ? (
					<Button
						variant="ghost"
						size="xs"
						onClick={() => {
							void api.logout().then(() => {
								localStorage.removeItem('anton.projectId');
								queryClient.clear();
								window.location.assign('/');
							});
						}}
					>
						Log out
					</Button>
				) : null}
			</div>
			{oauth ? (
				<RepoPicker
					open={pickerOpen}
					onOpenChange={(open) => {
						setPickerOpen(open);
						if (!open) pendingChat.current = false;
					}}
					onPicked={(projectId) => {
						const start = pendingChat.current;
						pendingChat.current = false;
						if (!start) return;
						create.mutate(projectId);
						onNavigate();
					}}
				/>
			) : null}
		</aside>
	);
}
