import type { FlueConversationMessage, FlueConversationPart } from '@flue/react';
import { CornerDownRight, FoldVertical } from '@/lib/icons';
import { Fragment, memo } from 'react';
import { SentText } from '@/components/thread/sent-text';
import { Icon } from '@/components/kit/signal';
import { SentAttachments } from '@/components/composer/attachments';
import { splitAttachments } from '../../../core/attachments';
import { tokens } from '@/lib/format';
import { sameItems } from '@/components/thread/blocks';

type FilePart = Extract<FlueConversationPart, { type: 'file' }>;

/** Your message gets a new object each chunk (the client gives it back its local id), so it compares by its parts. */
export const UserMessage = memo(UserMessageView, (prev, next) => prev.message.parts === next.message.parts && prev.note === next.note && sameItems(prev.meta, next.meta));

function UserMessageView({ message, meta, note }: { message: FlueConversationMessage; meta: string[]; note?: string }) {
	// Attached files show as chips; the text they carry is the agent's to read.
	const { text, files } = splitAttachments(message.parts.map((part) => (part.type === 'text' ? part.text : '')).join(''));
	const images = message.parts.filter((part): part is FilePart => part.type === 'file' && part.mediaType.startsWith('image/') && Boolean(part.url));
	return (
		<div className="group/user flex flex-col items-end gap-1.5">
			{images.length > 0 ? (
				<div className="flex max-w-[520px] flex-wrap justify-end gap-1.5">
					{images.map((image, index) => (
						<a key={image.id ?? index} href={image.url} target="_blank" rel="noreferrer">
							<img src={image.url} alt={image.filename ?? 'Attached image'} className="block max-h-40 max-w-60 rounded-card shadow-[0_0_0_1px_var(--line)]" />
						</a>
					))}
				</div>
			) : null}
			<SentAttachments files={files} />
			{/* A long hash, path or URL breaks where it must, rather than widening the thread. */}
			{text ? <SentText text={text} className="max-w-[min(560px,85%)]" /> : null}
			{note ? (
				<div className="flex items-center gap-1.5 text-small text-(--text-3)">
					<Icon icon={CornerDownRight} size={11} className="-scale-y-100" />
					{note}
				</div>
			) : null}
			{/* The same for every message, so it waits for the pointer. */}
			<div className="in-caption flex items-center gap-1.5 opacity-0 transition-opacity duration-(--t-fast) group-hover/user:opacity-100">
				{meta.map((item, index) => (
					<Fragment key={item + index}>
						{index > 0 ? <span>·</span> : null}
						<span>{item}</span>
					</Fragment>
				))}
			</div>
		</div>
	);
}

type CompactionView = { at: string; before: number; after: number | null };

export function compactionsOf(message: FlueConversationMessage): CompactionView[] {
	const list = message.metadata?.compactions;
	return Array.isArray(list) ? list.filter((entry): entry is CompactionView => typeof entry?.before === 'number') : [];
}

export function CompactionMark({ compaction }: { compaction: CompactionView }) {
	return (
		<div role="separator" aria-label="Conversation compacted" className="flex items-center gap-3 py-1 text-micro text-(--text-3)">
			<span className="h-px flex-1 bg-(--line)" />
			<span className="inline-flex items-center gap-1.5">
				<Icon icon={FoldVertical} size={12} />
				<span>Conversation compacted</span>
				{compaction.before ? (
					<span className="in-num text-(--text-4)">
						{tokens(compaction.before)}
						{compaction.after ? ` → ${tokens(compaction.after)}` : ''} tokens
					</span>
				) : null}
			</span>
			<span className="h-px flex-1 bg-(--line)" />
		</div>
	);
}
