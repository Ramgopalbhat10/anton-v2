import { memo, useId, useRef, useState } from 'react';
import { splitAttachments } from '../../core/attachments';
import { messageText, type ThreadRow } from '@/lib/joined';

const PREVIEW_LENGTH = 180;

/** Bound the accessible name as well as the visually clamped preview. */
function preview(text: string) {
	const clean = text.replace(/\s+/g, ' ').trim();
	return clean.length > PREVIEW_LENGTH ? `${clean.slice(0, PREVIEW_LENGTH - 1).trimEnd()}…` : clean;
}

export function chatTurns(rows: ThreadRow[]) {
	return rows.flatMap((row) => row.message.role === 'user' && !row.message.settlement
		? [{ id: row.message.id, input: preview(splitAttachments(messageText(row.message)).text) || 'Attachment' }]
		: []);
}

type Props = { rows: ThreadRow[]; onNavigate: (id: string) => void };

/** Whether two lists of rows hold the same inputs. A streamed reply makes new rows on every chunk, but your messages keep theirs. */
function sameInputs(before: ThreadRow[], after: ThreadRow[]): boolean {
	const inputs = (rows: ThreadRow[]) => rows.filter((row) => row.message.role === 'user' && !row.message.settlement).map((row) => row.message);
	const a = inputs(before);
	const b = inputs(after);
	return a.length === b.length && a.every((message, index) => message === b[index]);
}

/** The rail of your messages beside the conversation; drawn again only when they change, not on each chunk of a reply. */
export const ChatNavigation = memo(function ChatNavigation({ rows, onNavigate }: Props) {
	const [active, setActive] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const previewId = useId();
	const handle = useRef<HTMLButtonElement>(null);
	const turns = chatTurns(rows);
	const selected = turns.find((turn) => turn.id === active);
	if (!turns.length) return null;
	return (
		<nav aria-label="Chat navigation" className="group/nav absolute right-0 top-1/2 z-20 flex -translate-y-1/2 items-center"
			onMouseLeave={(event) => { if (!event.currentTarget.contains(document.activeElement)) setActive(null); }}
			onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setActive(null); } }}
			onKeyDown={(event) => { if (event.key === 'Escape') { setActive(null); setOpen(false); handle.current?.focus(); } }}>
			{selected ? (
				<div id={previewId} role="tooltip" className="in-pop absolute right-full w-[min(280px,65vw)] p-3 text-small leading-[18px]">
					<div className="line-clamp-2 break-words font-semibold text-(--text)">{selected.input}</div>
				</div>
			) : null}
			{/* One visible handle opens the rail on both touch and pointer devices. */}
			<button ref={handle} type="button" aria-label={open ? 'Hide chat navigation' : 'Show chat navigation'} aria-expanded={open}
				onClick={() => { setOpen(!open); setActive(null); }}
				className={`absolute right-0 ${open ? '-top-10' : ''} flex h-10 w-4 items-center justify-center rounded-l-control text-(--text-3) outline-none hover:bg-(--bg-hover) hover:text-(--text-2) focus-visible:shadow-(--focus) [@media(hover:hover)]:group-hover/nav:pointer-events-none [@media(hover:hover)]:group-hover/nav:opacity-0 [@media(hover:hover)]:focus-visible:pointer-events-auto [@media(hover:hover)]:focus-visible:opacity-100`}>
				<span aria-hidden="true">⋮</span>
			</button>
			<div className={`flex max-h-[50vh] flex-col overflow-x-hidden overflow-y-auto py-1 transition-[opacity,width] duration-200 motion-reduce:transition-none [@media(hover:hover)]:group-hover/nav:w-10 [@media(hover:hover)]:group-hover/nav:opacity-100 [@media(hover:hover)]:group-hover/nav:pointer-events-auto ${open ? 'w-10 opacity-100' : 'pointer-events-none w-5 opacity-0'}`}>
				{turns.map((turn, index) => (
					<button key={turn.id} type="button" tabIndex={open ? 0 : -1} aria-label={`Go to input ${index + 1}: ${turn.input}`} aria-describedby={active === turn.id ? previewId : undefined}
						onMouseEnter={() => setActive(turn.id)}
						onFocus={() => setActive(turn.id)} onBlur={() => setActive((current) => current === turn.id ? null : current)}
						onClick={(event) => { onNavigate(turn.id); setOpen(false); setActive(null); if (event.detail === 0) handle.current?.focus(); else event.currentTarget.blur(); }}
						className="group flex h-3 w-10 shrink-0 items-center justify-end rounded-inner outline-none focus-visible:shadow-(--focus)">
						<span className="h-[3px] w-4 rounded-full bg-(--text-3) transition-[width,background-color] duration-200 group-hover:w-8 group-hover:bg-(--accent) group-focus-visible:w-8 group-focus-visible:bg-(--accent) motion-reduce:transition-none" />
					</button>
				))}
			</div>
		</nav>
	);
}, (before, after) => before.onNavigate === after.onNavigate && sameInputs(before.rows, after.rows));
