import { Link, useRouterState } from '@tanstack/react-router';
import { MessageSquarePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function IconRail() {
	const path = useRouterState({ select: (state) => state.location.pathname });
	const home = path === '/';

	return (
		<nav className="flex w-12 shrink-0 flex-col items-center border-r border-border bg-sidebar">
			<div className="flex h-10 w-full items-center justify-center">
				<Tooltip>
					<TooltipTrigger asChild>
						<Button variant={home ? 'default' : 'secondary'} size="icon-sm" asChild>
							<Link to="/" aria-label="Home">
								A
							</Link>
						</Button>
					</TooltipTrigger>
					<TooltipContent side="right">Home</TooltipContent>
				</Tooltip>
			</div>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button variant="ghost" size="icon-sm" asChild>
						<Link to="/" aria-label="Chats">
							<MessageSquarePlus />
						</Link>
					</Button>
				</TooltipTrigger>
				<TooltipContent side="right">Chats</TooltipContent>
			</Tooltip>
		</nav>
	);
}
