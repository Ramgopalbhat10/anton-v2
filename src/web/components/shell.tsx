import { useQuery } from '@tanstack/react-query';
import { Outlet, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Menu, PanelRight } from 'lucide-react';
import { createContext, useContext, useState } from 'react';
import { ChatSidebar } from '@/components/chat-sidebar';
import { IconRail } from '@/components/icon-rail';
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
					<Button onClick={() => create.mutate()} disabled={create.isPending}>
						New chat
					</Button>
					{create.isError ? <p className="text-[12px] text-destructive">Could not start a chat.</p> : null}
				</Empty>
			</div>
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
