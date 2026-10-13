import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { memo, type PointerEvent, useEffect, useRef, useState } from 'react';
import { Spinner } from '@/components/signal';
import { api, type Todo } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Long enough to cross from the pill to the list without it closing. */
const CLOSE_MS = 150;

function Done() {
	return (
		<span className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full bg-(--success-base) text-(--bg-canvas)">
			<Check aria-hidden size={9} strokeWidth={3} />
		</span>
	);
}

/** A ring that fills as items are done; a check once they all are. */
function Progress({ done, total }: { done: number; total: number }) {
	if (total > 0 && done === total) return <Done />;
	const size = 14;
	const r = (size - 3) / 2;
	const length = 2 * Math.PI * r;
	return (
		<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="-rotate-90">
			<circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--segment-off)" strokeWidth={2} />
			<circle
				cx={size / 2}
				cy={size / 2}
				r={r}
				fill="none"
				stroke="var(--accent-base)"
				strokeWidth={2}
				strokeLinecap="round"
				strokeDasharray={`${total ? Math.max(0.001, done / total) * length : 0} ${length}`}
			/>
		</svg>
	);
}

/** Done is a check, the step in hand spins while the agent works, the rest are dashed circles still to come. */
function Mark({ status, working }: { status: Todo['status']; working: boolean }) {
	if (status === 'completed') return <Done />;
	if (status === 'in_progress' && working) return <Spinner size={14} />;
	return (
		<span
			className={cn(
				'size-3.5 rounded-full border-[1.5px]',
				status === 'in_progress' ? 'border-(--accent-base)' : 'border-dashed border-(--text-disabled)',
			)}
		/>
	);
}

/**
 * The agent's todo list as a pill above the composer: how many steps are done,
 * and the list itself on hover, focus or a click (which keeps it open). It
 * follows the agent live, refetched only when it writes a new list, and shows
 * only the latest list, while the task has one.
 */
export const TodoPill = memo(function TodoPill({ sessionId, busy }: { sessionId: string; busy: boolean }) {
	const todos = useQuery({ queryKey: ['todos', sessionId], queryFn: () => api.todos(sessionId), staleTime: Infinity });
	const [open, setOpen] = useState(false);
	// Opened by a click, it stays until clicked again or dismissed; opened by hover or focus, it closes as the pointer leaves.
	const [pinned, setPinned] = useState(false);
	const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
	const cancelClose = () => {
		if (closing.current) clearTimeout(closing.current);
		closing.current = null;
	};
	const show = () => {
		cancelClose();
		setOpen(true);
	};
	const hide = () => {
		cancelClose();
		if (pinned) return;
		closing.current = setTimeout(() => setOpen(false), CLOSE_MS);
	};
	useEffect(() => cancelClose, []);
	const list = todos.data?.list?.todos ?? [];
	if (list.length === 0) return null;
	const done = list.filter((todo) => todo.status === 'completed').length;
	const current = list.find((todo) => todo.status === 'in_progress');
	const hover = {
		onPointerEnter: (event: PointerEvent) => event.pointerType === 'mouse' && show(),
		onPointerLeave: (event: PointerEvent) => event.pointerType === 'mouse' && hide(),
	};
	return (
		<PopoverPrimitive.Root
			open={open}
			onOpenChange={(next) => {
				// Escape or a click outside.
				if (!next) {
					cancelClose();
					setPinned(false);
				}
				setOpen(next);
			}}
		>
			<PopoverPrimitive.Trigger asChild>
				<button
					type="button"
					aria-label={`Todos: ${done} of ${list.length} done${current ? `. Now: ${current.content}` : ''}`}
					{...hover}
					onClick={(event) => {
						// Radix would toggle; a click on a list opened by hover keeps it open instead.
						event.preventDefault();
						cancelClose();
						if (open && pinned) {
							setOpen(false);
							setPinned(false);
						} else {
							setOpen(true);
							setPinned(true);
						}
					}}
					onFocus={(event) => {
						if (event.currentTarget.matches(':focus-visible')) show();
					}}
					onBlur={() => {
						if (!pinned) setOpen(false);
					}}
					className="flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-(--border-subtle) bg-(--well-bg) pr-2.5 pl-1.5 text-[11.5px] text-(--text-secondary) outline-none hover:border-(--border-strong) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring) data-[state=open]:border-(--border-strong) data-[state=open]:text-(--text-primary)"
				>
					<Progress done={done} total={list.length} />
					<span className="in-num">
						{done}/{list.length}
					</span>
					<span>Done</span>
				</button>
			</PopoverPrimitive.Trigger>
			<PopoverPrimitive.Portal>
				<PopoverPrimitive.Content
					side="top"
					align="center"
					sideOffset={6}
					collisionPadding={12}
					{...hover}
					// Hover should not pull focus away from the composer.
					onOpenAutoFocus={(event) => event.preventDefault()}
					onCloseAutoFocus={(event) => event.preventDefault()}
					className="z-50 flex max-h-[min(420px,60vh)] w-[min(420px,calc(100vw-24px))] origin-(--radix-popover-content-transform-origin) in-pop flex-col overflow-hidden text-(--text-primary) outline-none duration-(--duration-overlay) ease-(--ease-out) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:slide-out-to-bottom-1 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-bottom-1"
				>
					<header className="flex items-baseline gap-2 px-3.5 pt-3 pb-1.5">
						<span className="text-[13px] font-medium">Todos</span>
						<span className="in-num ml-auto text-[11px] text-(--text-tertiary)">
							{done} of {list.length} done
						</span>
					</header>
					<ol className="m-0 flex list-none flex-col overflow-y-auto px-2 pb-2">
						{list.map((todo, index) => (
							<li
								key={index}
								aria-current={todo.status === 'in_progress' ? 'step' : undefined}
								className="flex min-h-7 items-start gap-2.5 rounded-[7px] px-1.5 py-[5px] text-[12.5px] leading-[18px]"
							>
								<span className="flex h-[18px] shrink-0 items-center">
									<Mark status={todo.status} working={busy} />
								</span>
								<span
									className={cn(
										'min-w-0 flex-1 text-pretty',
										todo.status === 'completed' ? 'text-(--text-tertiary)' : todo.status === 'in_progress' ? 'text-(--text-primary)' : 'text-(--text-secondary)',
									)}
								>
									{todo.content}
								</span>
							</li>
						))}
					</ol>
				</PopoverPrimitive.Content>
			</PopoverPrimitive.Portal>
		</PopoverPrimitive.Root>
	);
});
