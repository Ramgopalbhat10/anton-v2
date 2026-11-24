import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronRight } from '@/lib/icons';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { memo, type PointerEvent, useEffect, useId, useRef, useState } from 'react';
import { Disclosure } from '@/components/kit/disclosure';
import { Icon, Spinner } from '@/components/kit/signal';
import type { Todo } from '@/lib/api/sessions';
import { cn } from '@/lib/utils';
import { taskQueries } from '@/lib/task-queries';

/** Long enough to cross from the pill to the list without it closing. */
const CLOSE_MS = 150;

function Done() {
	return (
		<span className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full bg-(--ok) text-(--bg-panel)">
			<Check aria-hidden size={9} strokeWidth={3} />
		</span>
	);
}

function Progress({ done, total }: { done: number; total: number }) {
	if (total > 0 && done === total) return <Done />;
	const size = 14;
	const r = (size - 3) / 2;
	const length = 2 * Math.PI * r;
	return (
		<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="-rotate-90">
			<circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--bg-active)" strokeWidth={2} />
			<circle
				cx={size / 2}
				cy={size / 2}
				r={r}
				fill="none"
				stroke="var(--accent)"
				strokeWidth={2}
				strokeLinecap="round"
				strokeDasharray={`${total ? Math.max(0.001, done / total) * length : 0} ${length}`}
			/>
		</svg>
	);
}

function Mark({ status, working }: { status: Todo['status']; working: boolean }) {
	if (status === 'completed') return <Done />;
	if (status === 'in_progress' && working) return <Spinner size={14} />;
	return (
		<span
			className={cn(
				'size-3.5 rounded-full border-[1.5px]',
				status === 'in_progress' ? 'border-(--accent)' : 'border-dashed border-(--text-4)',
			)}
		/>
	);
}

function Item({ todo, working, last }: { todo: Todo; working: boolean; last: boolean }) {
	const [open, setOpen] = useState(false);
	const detailsId = useId();
	const current = todo.status === 'in_progress';
	return (
		<li
			aria-current={current ? 'step' : undefined}
			data-current={current || undefined}
			className={cn('group/todo relative flex shrink-0 items-start gap-2.5 rounded-control px-1.5 py-1.5', current && 'bg-(--bg-hover)')}
		>
			{!last && (
				<span
					aria-hidden
					className={cn('absolute top-[26px] -bottom-1 left-[12.5px] w-px', todo.status === 'completed' ? 'bg-(--ok)/45' : 'bg-(--line-strong)')}
				/>
			)}
			<span className="flex h-[18px] shrink-0 items-center">
				<Mark status={todo.status} working={working} />
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className={cn('text-body leading-[18px] text-pretty break-words', current ? 'font-medium text-(--text)' : 'text-(--text-2)')}>{todo.content}</span>
				{todo.evidence ? (
					<div className="flex flex-col">
						<button
							type="button"
							aria-expanded={open}
							aria-controls={detailsId}
							onClick={() => setOpen(!open)}
							className="-mx-1 flex h-5 w-fit items-center gap-1 rounded-inner px-1 text-micro text-(--text-4) outline-none hover:bg-(--bg-active) hover:text-(--text-2) focus-visible:shadow-(--focus)"
						>
							<Icon icon={open ? ChevronDown : ChevronRight} size={11} />
							<span>Details</span>
						</button>
						<Disclosure open={open} id={detailsId}>
							<p className="m-0 mt-0.5 text-small leading-[17px] text-pretty break-words text-(--text-3)">{todo.evidence}</p>
						</Disclosure>
					</div>
				) : null}
			</div>
		</li>
	);
}

function Items({ list, working }: { list: Todo[]; working: boolean }) {
	const scroller = useRef<HTMLOListElement>(null);
	const currentAt = list.findIndex((todo) => todo.status === 'in_progress');
	// Opens on the step in hand, with the one before it in sight, however long the list.
	useEffect(() => {
		const node = scroller.current;
		const item = node?.querySelector<HTMLElement>('[data-current]');
		if (!node || !item) return;
		if (item.offsetTop < node.scrollTop || item.offsetTop + item.offsetHeight > node.scrollTop + node.clientHeight) {
			node.scrollTop = Math.max(0, item.offsetTop - 48);
		}
	}, [currentAt]);
	return (
		<ol ref={scroller} className="relative m-0 flex list-none flex-col overflow-y-auto overscroll-contain px-2 pb-2">
			{list.map((todo, index) => (
				<Item key={index} todo={todo} working={working} last={index === list.length - 1} />
			))}
		</ol>
	);
}

/** Refetched only when the agent writes a new list. */
export const TodoPill = memo(function TodoPill({ sessionId, busy }: { sessionId: string; busy: boolean }) {
	const todos = useQuery({ ...taskQueries.todos(sessionId), staleTime: Infinity });
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
					className="flex h-6 shrink-0 items-center gap-1.5 rounded-control bg-(--bg-surface) pr-2 pl-1.5 text-small font-medium text-(--text-2) shadow-[inset_0_0_0_1px_var(--line-strong)] outline-none hover:bg-(--bg-raised) hover:text-(--text) focus-visible:shadow-(--focus) data-[state=open]:bg-(--bg-raised) data-[state=open]:text-(--text)"
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
					className="z-50 flex max-h-[min(420px,60vh)] w-[min(420px,calc(100vw-24px))] origin-(--radix-popover-content-transform-origin) in-pop flex-col overflow-hidden text-(--text) outline-none"
				>
					<header className="flex items-baseline gap-2 px-3.5 pt-3 pb-1.5">
						<span className="text-body font-medium">Todos</span>
						<span className="in-num ml-auto text-micro text-(--text-3)">
							{done} of {list.length} done
						</span>
					</header>
					<Items list={list} working={busy} />
				</PopoverPrimitive.Content>
			</PopoverPrimitive.Portal>
		</PopoverPrimitive.Root>
	);
});
