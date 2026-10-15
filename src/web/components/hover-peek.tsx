import { HoverCard } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The rest of what a one-line row or chip stands for, in a card once the
 * pointer rests on it. Clicks inside stay inside: the card is portalled, but
 * React still bubbles its events to the row that opens on click.
 */
export function HoverPeek({
	content,
	children,
	side = 'top',
	align = 'start',
	width = 320,
	openDelay = 350,
}: {
	content: ReactNode;
	children: ReactNode;
	side?: 'top' | 'bottom' | 'left' | 'right';
	align?: 'start' | 'center' | 'end';
	width?: number;
	openDelay?: number;
}) {
	return (
		<HoverCard.Root openDelay={openDelay} closeDelay={90}>
			<HoverCard.Trigger asChild>{children}</HoverCard.Trigger>
			<HoverCard.Portal>
				<HoverCard.Content
					side={side}
					align={align}
					sideOffset={6}
					collisionPadding={12}
					onClick={(event) => event.stopPropagation()}
					className={cn('in-pop z-50 flex flex-col gap-2.5 p-3 outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0')}
					style={{ width }}
				>
					{content}
				</HoverCard.Content>
			</HoverCard.Portal>
		</HoverCard.Root>
	);
}
