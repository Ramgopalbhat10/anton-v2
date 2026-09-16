import { SquareTerminal, Home, MessageSquarePlus } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';

export function IconRail() {
	return (
		<nav className="flex w-12 flex-col items-center gap-2 border-r border-border bg-sidebar py-3">
			<Link to="/" aria-label="Home">
				<Button variant="ghost" size="icon">
					<Home className="size-4" />
				</Button>
			</Link>
			<Link to="/" aria-label="New chat">
				<Button variant="ghost" size="icon">
					<MessageSquarePlus className="size-4" />
				</Button>
			</Link>
			<div className="mt-auto">
				<SquareTerminal className="size-4 text-muted-foreground" />
			</div>
		</nav>
	);
}
