import { ChevronDown, ChevronUp } from '@/lib/icons';
import { memo, type RefObject, useCallback, useContext, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { components as markdownComponents, FileLinks, fileRef } from '@/components/content/markdown';
import { IconBtn, Spinner } from '@/components/kit/signal';
import { UploadingFiles } from '@/components/composer/attachments';
import { SentImages, type SentPicture } from '@/components/thread/sent-images';
import { RICH_CLASS } from '@/lib/rich-text';
import { sentMarkdownPlugins } from '@/lib/sent-markdown';
import { useFold } from '@/lib/use-fold';
import { cn } from '@/lib/utils';
import { type PendingChange, type PendingSend } from '@/components/thread/pending-send';

function sentFileRef(raw: string, files: FileLinks | null): { path: string; line?: number } | null {
	const parsed = fileRef(raw);
	if (parsed) return parsed;
	if (!files) return null;
	if (files.has(raw)) return { path: raw };
	const match = /^(.*):(\d+)(?:[-–]\d+)?$/.exec(raw);
	if (match && files.has(match[1]!)) return { path: match[1]!, line: Number(match[2]) };
	return null;
}

function SentToken({ kind, text }: { kind: 'command' | 'file'; text: string }) {
	const files = useContext(FileLinks);
	const ref = kind === 'file' ? sentFileRef(text.slice(1).replace(/^\.\//, ''), files) : null;
	if (ref && files?.has(ref.path)) {
		return (
			<button type="button" data-sent-token={kind} title={`Open ${ref.path}`} onClick={() => files.open(ref.path, ref.line)} className={cn(RICH_CLASS.chip, 'hover:bg-(--accent-soft)')}>
				{text}
			</button>
		);
	}
	return <span data-sent-token={kind} className={RICH_CLASS.chip}>{text}</span>;
}

const sentComponents: Components = {
	...markdownComponents,
	span: ({ node: _node, ...props }) => {
		const data = props as Record<string, unknown>;
		const kind = data['data-sent-token'];
		const value = data['data-sent-value'];
		if ((kind === 'command' || kind === 'file') && typeof value === 'string') {
			return <SentToken kind={kind} text={value} />;
		}
		return <span {...props} />;
	},
};

const SentMarkdown = memo(function SentMarkdown({ text, contentRef }: { text: string; contentRef: RefObject<HTMLDivElement | null> }) {
	return (
		<div ref={contentRef} className="sg-markdown sg-markdown--sent">
			<ReactMarkdown remarkPlugins={sentMarkdownPlugins} components={sentComponents}>
				{text}
			</ReactMarkdown>
		</div>
	);
});

/** Lines a sent message shows until it is opened out. */
const SENT_FOLD = { lines: 8 };

export function SentText({ text, className }: { text: string; className?: string }) {
	const body = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const box = useCallback(() => body.current, []);
	const inner = useCallback(() => content.current, []);
	const fold = useFold(box, text, { lines: SENT_FOLD.lines, inner });
	return (
		<div
			className={cn(
				'relative min-w-0 rounded-dialog rounded-br-inner bg-(--bg-raised) px-3 py-2 text-body-lg leading-[21px] shadow-[inset_0_0_0_1px_var(--line)]',
				className,
			)}
		>
			<div
				ref={body}
				data-sent-body=""
				className={cn('overflow-hidden text-pretty [overflow-wrap:anywhere]', fold.long && 'pr-6', fold.long && !fold.open && 'in-fold-fade')}
				style={fold.style}
			>
				<SentMarkdown text={text} contentRef={content} />
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

/** The id the runtime's client gives a message this page sent, which it keeps once the conversation lists it. */
const OWN_SEND = 'local:';

/** A send that takes over from its waiting message is already in place, so it does not rise again; neither does the conversation's first message. */
export function useSends() {
	const [pending, setPending] = useState<PendingSend | null>(null);
	const handedOver = useRef(false);
	const decided = useRef(new Map<string, boolean>());
	const onPending = useCallback((change: PendingChange) => {
		if (change === 'sent') handedOver.current = true;
		setPending(change === 'sent' ? null : change);
	}, []);
	const rises = useCallback((id: string, first: boolean): boolean => {
		if (!id.startsWith(OWN_SEND)) return false;
		const known = decided.current.get(id);
		if (known !== undefined) return known;
		const rise = !first && !handedOver.current;
		handedOver.current = false;
		decided.current.set(id, rise);
		return rise;
	}, []);
	return { pending, onPending, rises };
}



export function PendingMessage({ pending }: { pending: PendingSend }) {
	const pictures = pending.pictures ?? [];
	const files = pending.files ?? [];
	const label = pending.attaching ? `Attaching ${pending.attaching}` : 'Preparing message';
	return (
		<div className="in-sent flex flex-col items-end gap-1.5" aria-busy="true">
			<SentImages pictures={pictures} uploading />
			<UploadingFiles files={files} />
			{pending.text ? <SentText text={pending.text} className="max-w-[min(520px,100%)]" /> : null}
			{pictures.length || files.length ? (
				<span className="sr-only">{label}</span>
			) : (
				<div className="flex items-center gap-1.5 text-small text-(--text-3)">
					<Spinner size={11} tone="neutral" />
					{label}
				</div>
			)}
		</div>
	);
}
