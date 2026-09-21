import { Link, useRouterState } from '@tanstack/react-router';
import { MessageSquarePlus, SquarePen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function IconRail() {
	const path = useRouterState({ select: (state) => state.location.pathname });
	const home = path === '/';

	return (
		<nav className="flex w-12 shrink-0 flex-col items-center border-r border-border bg-sidebar">
			<div className="flex h-10 w-full items-center justify-center">
				<Link
					to="/"
					aria-label="Home"
					className={cn(
						'flex size-7 items-center justify-center rounded-md text-[11px] font-semibold tracking-tight',
						home ? 'bg-foreground text-background' : 'bg-muted text-foreground hover:bg-accent',
					)}
				>
					A
				</Link>
			</div>
			<Link to="/" aria-label="Chats" title="Chats" className="mt-1">
				<Button variant="ghost" size="icon" aria-label="Chats">
					<MessageSquarePlus className="size-4" />
				</Button>
			</Link>
			<div className="mt-auto flex h-10 w-full items-center justify-center border-t border-border">
				<SquarePen className="size-3.5 text-muted-foreground" aria-hidden />
			</div>
		</nav>
	);
}
