import { ChevronDown, ChevronUp } from 'lucide-react';
import { Fragment, useCallback, useContext, useMemo, useRef } from 'react';
import { FileLinks, fileRef } from '@/components/markdown';
import { IconBtn } from '@/components/signal';
import { RICH_CLASS, richRanges, splitRich } from '@/lib/rich-text';
import { useFold } from '@/lib/use-fold';
import { cn } from '@/lib/utils';

/**
 * What you typed, as you typed it, with its links, a `/command` and `@` file
 * references marked as the composer marks them; a reference to a file the task
 * has opens it in Files.
 */
export function RichText({ text }: { text: string }) {
	const files = useContext(FileLinks);
	const pieces = useMemo(() => splitRich(text, 0, text.length, richRanges(text)), [text]);
	return pieces.map((piece) => {
		if (!piece.kind) return <Fragment key={piece.start}>{piece.text}</Fragment>;
		if (piece.kind === 'link')
			return (
				<a key={piece.start} href={piece.text} target="_blank" rel="noreferrer" className={cn(RICH_CLASS.link, 'hover:decoration-current')}>
					{piece.text}
				</a>
			);
		const ref = piece.kind === 'file' ? fileRef(piece.text.slice(1)) : null;
		if (ref && files?.has(ref.path))
			return (
				<button key={piece.start} type="button" title={`Open ${ref.path}`} onClick={() => files.open(ref.path, ref.line)} className={cn(RICH_CLASS.chip, 'hover:bg-(--accent-bg-subtle-hover)')}>
					{piece.text}
				</button>
			);
		return (
			<span key={piece.start} className={RICH_CLASS.chip}>
				{piece.text}
			</span>
		);
	});
}

/** Lines a sent message shows until it is opened out. */
const SENT_FOLD = { lines: 8 };

/** A sent message's bubble: a long one folds to a few lines, faded at the foot, with a chevron to show it whole. */
export function SentText({ text, className }: { text: string; className?: string }) {
	const body = useRef<HTMLDivElement>(null);
	const box = useCallback(() => body.current, []);
	const fold = useFold(box, text, SENT_FOLD);
	return (
		<div
			className={cn(
				'relative rounded-[14px_14px_4px_14px] border border-(--card-border) bg-(--bg-overlay) px-3.5 py-2.5 text-[13px] leading-[19px] shadow-(--card-highlight)',
				className,
			)}
		>
			<div
				ref={body}
				className={cn('overflow-hidden whitespace-pre-wrap text-pretty [overflow-wrap:anywhere]', fold.long && 'pr-6', fold.long && !fold.open && 'in-fold-fade')}
				style={fold.style}
			>
				<RichText text={text} />
			</div>
			{fold.long ? (
				<IconBtn
					size="xs"
					icon={fold.open ? ChevronUp : ChevronDown}
					label={fold.open ? 'Fold the message back' : 'Show the whole message'}
					aria-expanded={fold.open}
					className="absolute top-1.5 right-1.5"
					onClick={fold.toggle}
				/>
			) : null}
		</div>
	);
}
