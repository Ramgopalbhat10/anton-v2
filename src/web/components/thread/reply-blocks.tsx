import type { FlueConversationMessage } from '@flue/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleStop } from '@/lib/icons';
import { memo, type ReactNode, useContext, useMemo, useState } from 'react';
import { field } from '@/components/thread/tool-describe';
import { AgentsCard, delegationOf } from '@/components/thread/subagents';
import { DeletedArtifact } from '@/components/content/output-viewer';
import { HtmlFrame } from '@/components/content/html-frame';
import { Btn, Icon, Spinner } from '@/components/kit/signal';
import { api } from '@/lib/api';
import { outputUrl } from '@/lib/api/outputs';
import { isPlanRefusal } from '../../../core/model-refusal';
import { openViewer } from '@/lib/viewer';
import { useDeletedOutput } from '@/lib/deleted-outputs';
import { taskQueries } from '@/lib/task-queries';
import { madeImageOf, pageOf, sameItems, type ToolPart } from '@/components/thread/blocks';
import { SessionId } from '@/components/thread/session-context';

export function Drawing({ what }: { what: string }) {
	return (
		<div className="flex h-9 items-center gap-2 rounded-control border border-dashed border-(--line) px-3 text-small text-(--text-3)">
			<Spinner size={12} />
			{what}
		</div>
	);
}

export const PageBlock = memo(function PageBlock({ sessionId, part }: { sessionId: string; part: ToolPart }) {
	const page = pageOf(part);
	const deleted = useDeletedOutput(sessionId, page?.path);
	if (!page) return <Drawing what="Drawing a page" />;
	if (deleted) return <DeletedArtifact path={page.path} />;
	return <HtmlFrame sessionId={sessionId} path={page.path} title={page.title} height={page.height} />;
});

function aspectOf(input: unknown): string {
	const [width, height] = field(input, 'aspect_ratio').split(':').map(Number);
	return width > 0 && height > 0 ? `${width} / ${height}` : '1 / 1';
}

/** A light checkerboard under an image asked for with a transparent background, so a dark mark on it still shows. */
const CHECKERBOARD = { background: 'repeating-conic-gradient(var(--text) 0% 25%, var(--text) 0% 50%) 50% / 16px 16px' };

export const ImageBlock = memo(function ImageBlock({ sessionId, part }: { sessionId: string; part: ToolPart }) {
	const made = madeImageOf(part);
	const prompt = field(part.input, 'prompt');
	const deleted = useDeletedOutput(sessionId, made?.path);
	if (made && deleted) return <DeletedArtifact path={made.path} />;
	if (!made) {
		return (
			<div
				role="status"
				className="in-sweep flex h-60 max-w-full items-center justify-center gap-2 self-start rounded-control border border-dashed border-(--line) bg-(--bg-app) px-3 text-small text-(--text-3)"
				style={{ aspectRatio: aspectOf(part.input) }}
			>
				<Spinner size={12} />
				Making an image
			</div>
		);
	}
	return (
		<figure className="flex max-w-full flex-col gap-1.5 self-start">
			<button
				type="button"
				title={`Open ${made.path}`}
				onClick={() => openViewer({ sessionId, path: made.path }, [], sessionId)}
				className="block w-fit max-w-full cursor-zoom-in rounded-control outline-none focus-visible:shadow-(--focus)"
			>
				<img
					src={outputUrl(sessionId, made.path)}
					alt={prompt}
					className="block max-h-[420px] max-w-full rounded-control border border-(--line) bg-(--bg-app)"
					style={part.input && (part.input as { transparent?: unknown }).transparent === true ? CHECKERBOARD : undefined}
				/>
			</button>
			<figcaption className="max-w-[560px] truncate text-small text-(--text-3)" title={prompt}>
				{made.model ? <span className="text-(--text-2)">{made.model}</span> : null}
				{made.model && prompt ? ' · ' : ''}
				{prompt}
			</figcaption>
		</figure>
	);
});

/** A batch of subagent calls; its list is rebuilt each render, so it re-renders only when one of its calls changed. */
export const AgentsBlock = memo(
	function AgentsBlock({ sessionId, calls }: { sessionId: string; calls: ToolPart[] }) {
		const delegations = useMemo(() => calls.map(delegationOf), [calls]);
		return <AgentsCard sessionId={sessionId} calls={delegations} />;
	},
	(prev, next) => prev.sessionId === next.sessionId && sameItems(prev.calls, next.calls),
);

export function Notice({ children }: { children: ReactNode }) {
	return (
		<div className="in-callout in-callout--bad flex items-start gap-2 px-3 py-2 text-body leading-[19px] text-(--text)">
			<Icon icon={CircleAlert} size={14} className="mt-0.5 shrink-0 text-(--bad)" />
			<div className="min-w-0 flex-1 break-words">{children}</div>
		</div>
	);
}

/** A plan that turns its model away fails the same way however often it is sent, so it says so; nothing switches by itself, since another model may bill another account. */
function RetryOnDefault({ refused, onRetry }: { refused: boolean; onRetry: (text: string) => void }) {
	const sessionId = useContext(SessionId);
	const queryClient = useQueryClient();
	const fallback = useQuery(taskQueries.fallback(sessionId)).data?.fallback ?? null;
	const [switching, setSwitching] = useState(false);
	if (!fallback) return null;
	const retry = async () => {
		setSwitching(true);
		try {
			const session = await api.switchToFallbackModel(sessionId);
			queryClient.setQueryData(['session', sessionId], session);
			void queryClient.invalidateQueries({ queryKey: ['fallback', sessionId] });
			onRetry('Continue');
		} finally {
			setSwitching(false);
		}
	};
	return (
		<div className="mt-2 flex flex-wrap items-center gap-2">
			<span>{refused ? `Its model's plan turned this reply away, so sending it again will fail the same way.` : 'Sending it again may fail the same way.'}</span>
			<Btn size="sm" variant="secondary" disabled={switching} onClick={() => void retry()}>
				Retry on {fallback.name}
			</Btn>
		</div>
	);
}

export const SettlementNotice = memo(function SettlementNotice({ message, retry }: { message: FlueConversationMessage; retry?: (text: string) => void }) {
	// Stopping is something you did, not a failure: one quiet line, however many messages it stopped.
	if (message.settlement?.outcome === 'aborted') {
		return (
			<div className="flex items-center gap-1.5 text-small text-(--text-3)">
				<Icon icon={CircleStop} size={12} />
				Stopped
			</div>
		);
	}
	const text = message.parts
		.map((part) => (part.type === 'text' ? part.text : ''))
		.join('')
		.trim();
	return (
		<Notice>
			{text || 'The agent turn failed. Send the message again to retry.'}
			{retry ? <RetryOnDefault refused={isPlanRefusal(text)} onRetry={retry} /> : null}
		</Notice>
	);
});
