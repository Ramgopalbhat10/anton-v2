import { Outlet, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { PanelRight } from 'lucide-react';
import { ChatSidebar } from '@/components/chat-sidebar';
import { IconRail } from '@/components/icon-rail';
import { Thread } from '@/components/thread';
import { VmPanel } from '@/components/vm-panel';
import { Button } from '@/components/ui/button';

export function AppShell() {
	return (
		<div className="flex h-full">
			<IconRail />
			<ChatSidebar />
			<Outlet />
		</div>
	);
}

export function HomePage() {
	return (
		<div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
			Start a new chat to open a workspace VM.
		</div>
	);
}

export function SessionPage() {
	const { sessionId } = useParams({ from: '/agents/$sessionId' });
	const search = useSearch({ from: '/agents/$sessionId' });
	const navigate = useNavigate();
	const open = search.app !== 'closed';

	return (
		<div className="flex min-w-0 flex-1">
			<div className="flex min-w-0 flex-1 flex-col">
				<header className="flex items-center justify-between border-b border-border px-4 py-2">
					<div className="text-sm font-medium">Anton v2</div>
					<Button
						variant="ghost"
						size="icon"
						aria-label="Toggle VM panel"
						onClick={() =>
							navigate({
								to: '/agents/$sessionId',
								params: { sessionId },
								search: { app: open ? 'closed' : 'code' },
							})
						}
					>
						<PanelRight className="size-4" />
					</Button>
				</header>
				<Thread sessionId={sessionId} />
			</div>
			{open ? <VmPanel sessionId={sessionId} /> : null}
		</div>
	);
}
