import { HoverCard, Popover } from 'radix-ui';
import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/** Clicks inside stay inside: the card is portalled, but React still bubbles its events to the row that opens on click. `quiet` keeps it shut while a chip inside shows its own peek. */
export function HoverPeek({
	content,
	children,
	side = 'top',
	align = 'start',
	width = 320,
	openDelay = 350,
	quiet = false,
	interactive = false,
}: {
	content: ReactNode;
	children: ReactNode;
	side?: 'top' | 'bottom' | 'left' | 'right';
	align?: 'start' | 'center' | 'end';
	width?: number;
	openDelay?: number;
	quiet?: boolean;
	interactive?: boolean;
}) {
	const [open, setOpen] = useState(false);
	if (interactive) return <InteractivePeek content={content} side={side} align={align} width={width} openDelay={openDelay} quiet={quiet}>{children}</InteractivePeek>;
	return (
		<HoverCard.Root open={open && !quiet} onOpenChange={setOpen} openDelay={openDelay} closeDelay={90}>
			<HoverCard.Trigger asChild>{children}</HoverCard.Trigger>
			<HoverCard.Portal>
				<HoverCard.Content
					side={side}
					align={align}
					sideOffset={6}
					collisionPadding={12}
					onClick={(event) => event.stopPropagation()}
					className={cn('in-pop z-[var(--z-popover)] flex flex-col gap-2.5 p-3 outline-none')}
					style={{ width, maxWidth: 'calc(100vw - 24px)' }}
				>
					{content}
				</HoverCard.Content>
			</HoverCard.Portal>
		</HoverCard.Root>
	);
}

/** HoverCard removes tab stops, so an interactive peek is a non-modal popover that takes neither focus nor clicks when opened by hover. */
function InteractivePeek({ content, children, side = 'top', align = 'start', width = 320, openDelay = 350, quiet = false }: Omit<ComponentProps<typeof HoverPeek>, 'interactive'>) {
	const [open, setOpen] = useState(false);
	const anchor = useRef<HTMLDivElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const returnFocus = useRef<HTMLElement | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const enter = useRef(false);
	const clear = () => clearTimeout(timer.current);
	const show = () => { clear(); timer.current = setTimeout(() => setOpen(true), openDelay); };
	const hide = () => {
		clear();
		if (!panel.current?.contains(document.activeElement)) timer.current = setTimeout(() => setOpen(false), 90);
	};
	const focusFirst = () => panel.current?.querySelector<HTMLElement>('a[href], button:not([disabled]), [tabindex="0"]')?.focus();
	useEffect(() => () => clearTimeout(timer.current), []);
	return <Popover.Root open={open && !quiet} onOpenChange={setOpen} modal={false}>
		<Popover.Anchor asChild ref={anchor}
			onPointerEnter={(event) => { if (event.pointerType !== 'touch') show(); }}
			onPointerLeave={hide}
			onFocus={(event) => { returnFocus.current = event.target as HTMLElement; show(); }}
			onBlur={(event) => { if (!panel.current?.contains(event.relatedTarget)) hide(); }}
			onKeyDown={(event) => {
				if (event.key !== 'ArrowDown' || quiet) return;
				event.preventDefault();
				clear();
				returnFocus.current = event.target as HTMLElement;
				if (open) focusFirst();
				else { enter.current = true; setOpen(true); }
			}}
			aria-haspopup="dialog" aria-expanded={open && !quiet} aria-keyshortcuts="ArrowDown"
		>{children}</Popover.Anchor>
		<Popover.Portal>
			<Popover.Content ref={panel} side={side} align={align} sideOffset={6} collisionPadding={12}
				aria-label="Thread details"
				onOpenAutoFocus={(event) => { event.preventDefault(); if (enter.current) { enter.current = false; focusFirst(); } }}
				onCloseAutoFocus={(event) => event.preventDefault()}
				onEscapeKeyDown={() => { clear(); returnFocus.current?.focus(); clear(); }}
				onPointerEnter={clear} onPointerLeave={hide} onFocus={clear}
				onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) { clear(); timer.current = setTimeout(() => setOpen(false), 90); } }}
				onClick={(event) => event.stopPropagation()}
				className="in-pop z-[var(--z-popover)] flex flex-col gap-2.5 p-3 outline-none"
				style={{ width, maxWidth: 'calc(100vw - 24px)' }}
			>{content}</Popover.Content>
		</Popover.Portal>
	</Popover.Root>;
}
