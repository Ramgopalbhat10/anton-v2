import { useQuery } from '@tanstack/react-query';
import { Outlet, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Menu, PanelRight } from 'lucide-react';
import { createContext, useContext, useState } from 'react';
import { ChatSidebar } from '@/components/chat-sidebar';
import { IconRail } from '@/components/icon-rail';
import { RepoPicker } from '@/components/repo-picker';
import { Thread } from '@/components/thread';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { VmPanel } from '@/components/vm-panel';
import { api } from '@/lib/api';
import { useCreateChat } from '@/lib/create-chat';

const NavContext = createContext<() => void>(() => {});

function MenuButton() {
	const openNav = useContext(NavContext);
	return (
		<Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Open chats" onClick={openNav}>
			<Menu />
		</Button>
	);
}

export function AppShell() {
	const [navOpen, setNavOpen] = useState(false);
	const me = useQuery({ queryKey: ['me'], queryFn: api.me });
	const denied = new URLSearchParams(window.location.search).get('auth') === 'denied';

	if (me.isPending) {
		return <div className="h-dvh bg-background" />;
	}

	if (me.data?.oauth && !me.data.user) {
		return (
			<div className="flex h-dvh overflow-hidden bg-background">
				<IconRail />
				<div className="flex flex-1 items-center justify-center px-6">
					<Empty>
						<EmptyHeader>
							<EmptyTitle>Sign in with GitHub</EmptyTitle>
							<EmptyDescription>
								Anton clones the repository you pick and opens pull requests as you.
							</EmptyDescription>
						</EmptyHeader>
						<Button asChild>
							<a href="/api/auth/github">Sign in with GitHub</a>
						</Button>
						{denied ? <p className="text-[12px] text-destructive">GitHub sign-in did not finish. Try again.</p> : null}
					</Empty>
				</div>
			</div>
		);
	}

	return (
		<NavContext.Provider value={() => setNavOpen(true)}>
			<div className="flex h-dvh overflow-hidden bg-background">
				<IconRail />
				{navOpen ? (
					<button
						type="button"
						aria-label="Close chats"
						className="fixed inset-0 z-20 bg-black/50 md:hidden"
						onClick={() => setNavOpen(false)}
					/>
				) : null}
				<ChatSidebar open={navOpen} onNavigate={() => setNavOpen(false)} />
				<div className="flex min-h-0 min-w-0 flex-1">
					<Outlet />
				</div>
			</div>
		</NavContext.Provider>
	);
}

export function HomePage() {
	const create = useCreateChat();
	const me = useQuery({ queryKey: ['me'], queryFn: api.me });
	const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, enabled: !me.data?.oauth || Boolean(me.data?.user) });
	const [pickerOpen, setPickerOpen] = useState(false);
	const projects = sessions.data?.projects ?? (sessions.data?.project ? [sessions.data.project] : []);
	const storedId = localStorage.getItem('anton.projectId');
	const project = projects.find((item) => item.id === storedId) ?? sessions.data?.project ?? projects[0];

	function newChat() {
		if (me.data?.oauth && !project) {
			setPickerOpen(true);
			return;
		}
		create.mutate(me.data?.oauth ? project?.id : undefined);
	}

	return (
		<div className="flex min-w-0 flex-1 flex-col">
			<header className="flex h-10 shrink-0 items-center border-b border-border px-1 md:px-3">
				<MenuButton />
			</header>
			<div className="flex flex-1 items-center justify-center px-6">
				<Empty>
					<EmptyHeader>
						<EmptyTitle>Open a workspace</EmptyTitle>
						<EmptyDescription>
							A new chat attaches the sandbox. Git, files, and the terminal read that machine directly.
						</EmptyDescription>
					</EmptyHeader>
					<Button onClick={newChat} disabled={create.isPending}>
						New chat
					</Button>
					{create.isError ? <p className="text-[12px] text-destructive">Could not start a chat.</p> : null}
				</Empty>
			</div>
			{me.data?.oauth ? (
				<RepoPicker
					open={pickerOpen}
					onOpenChange={setPickerOpen}
					onPicked={(projectId) => create.mutate(projectId)}
				/>
			) : null}
		</div>
	);
}

export function SessionPage() {
	const { sessionId } = useParams({ from: '/agents/$sessionId' });
	const search = useSearch({ from: '/agents/$sessionId' });
	const navigate = useNavigate();
	const open = search.app !== 'closed';
	const session = useQuery({
		queryKey: ['session', sessionId],
		queryFn: () => api.session(sessionId),
	});

	function setOpen(next: boolean) {
		void navigate({
			to: '/agents/$sessionId',
			params: { sessionId },
			search: { app: next ? 'code' : 'closed' },
		});
	}

	return (
		<div className="flex min-w-0 flex-1">
			<div className={open ? 'hidden min-w-0 flex-1 flex-col md:flex' : 'flex min-w-0 flex-1 flex-col'}>
				<header className="flex h-10 shrink-0 items-center justify-between border-b border-border px-1 md:px-3">
					<div className="flex min-w-0 items-center">
						<MenuButton />
						<div className="truncate px-2 text-[13px] font-medium">{session.data?.session.title ?? 'Chat'}</div>
						{session.data?.session.prUrl?.startsWith('https://') ? (
							<a
								href={session.data.session.prUrl}
								className="truncate px-2 text-[12px] text-muted-foreground underline-offset-4 hover:underline"
							>
								Pull request
							</a>
						) : session.data?.session.prUrl ? (
							<span className="truncate px-2 text-[12px] text-muted-foreground">Local commit</span>
						) : null}
					</div>
					<Button variant="ghost" size="icon-sm" aria-label={open ? 'Hide workspace' : 'Show workspace'} onClick={() => setOpen(!open)}>
						<PanelRight />
					</Button>
				</header>
				<Thread sessionId={sessionId} />
			</div>
			{open ? <VmPanel sessionId={sessionId} onClose={() => setOpen(false)} /> : null}
		</div>
	);
}
