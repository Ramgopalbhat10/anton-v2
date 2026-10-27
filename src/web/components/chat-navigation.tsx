import { useId, useState } from 'react';
import { splitAttachments } from '../../core/attachments';
import { messageText, type ThreadRow } from '@/lib/joined';

const PREVIEW_LENGTH = 180;

/** Keep previews short even for pasted logs, and collapse line breaks into readable prose. */
function preview(text: string) {
	const clean = text.replace(/\s+/g, ' ').trim();
	return clean.length > PREVIEW_LENGTH ? `${clean.slice(0, PREVIEW_LENGTH - 1).trimEnd()}…` : clean;
}

export function chatTurns(rows: ThreadRow[]) {
	const turns: { id: string; input: string; output: string }[] = [];
	for (const row of rows) {
		if (row.message.settlement) continue;
		if (row.message.role === 'user') {
			turns.push({ id: row.message.id, input: preview(splitAttachments(messageText(row.message)).text) || 'Attachment', output: '' });
		} else if (row.message.role === 'assistant' && turns.length) {
			const parts = row.segment?.parts ?? row.message.parts;
			const text = parts.map((part) => part.type === 'text' ? part.text : '').join('');
			const turn = turns[turns.length - 1];
			turn.output = preview([turn.output, text].filter(Boolean).join(' '));
		}
	}
	return turns;
}

export function ChatNavigation({ rows, onNavigate }: { rows: ThreadRow[]; onNavigate: (id: string) => void }) {
	const [active, setActive] = useState<string | null>(null);
	const previewId = useId();
	const turns = chatTurns(rows);
	const selected = turns.find((turn) => turn.id === active);
	if (!turns.length) return null;
	return (
		<nav aria-label="Chat navigation" className="absolute right-1 top-1/2 z-20 flex -translate-y-1/2 items-center" onMouseLeave={(event) => { if (!event.currentTarget.contains(document.activeElement)) setActive(null); }} onKeyDown={(event) => { if (event.key === 'Escape') { setActive(null); event.currentTarget.querySelector<HTMLElement>(':focus')?.blur(); } }}>
			{selected ? (
				<div id={previewId} role="tooltip" className="absolute right-full w-[min(280px,65vw)] rounded-xl border border-(--border) bg-(--bg-overlay) p-3 text-[12px] leading-[18px] shadow-lg">
					<div className="font-semibold text-(--text-primary)">{selected.input}</div>
					<div className="mt-2 text-(--text-secondary)">{selected.output || 'No response yet.'}</div>
				</div>
			) : null}
			<div className="flex max-h-[50vh] flex-col overflow-y-auto py-1">
				{turns.map((turn, index) => (
					<button key={turn.id} type="button" aria-label={`Go to input ${index + 1}: ${turn.input}`} aria-describedby={active === turn.id ? previewId : undefined}
						onMouseEnter={() => setActive(turn.id)}
						onFocus={() => setActive(turn.id)} onBlur={() => setActive((current) => current === turn.id ? null : current)}
						onClick={() => onNavigate(turn.id)}
						className="group flex h-5 w-10 shrink-0 items-center justify-end rounded outline-none focus-visible:ring-2 focus-visible:ring-(--accent-base)">
						<span className="h-[3px] w-4 rounded-full bg-(--text-tertiary) transition-[width,background-color] duration-200 group-hover:w-8 group-hover:bg-(--accent-base) group-focus-visible:w-8 group-focus-visible:bg-(--accent-base) motion-reduce:transition-none" />
					</button>
				))}
			</div>
		</nav>
	);
}
