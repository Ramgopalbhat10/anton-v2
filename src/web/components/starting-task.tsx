import { CircleAlert, Plus, Send, Square } from 'lucide-react';
import type { ReactNode } from 'react';
import { Mascot } from '@/components/mascot';
import { MenuButton } from '@/components/nav';
import { SentText } from '@/components/sent-text';
import { ModelMark, useModels } from '@/components/model-picker';
import { Btn, Icon, IconBtn, Spinner } from '@/components/signal';
import { WorkspacePane } from '@/components/workspace-pane';
import { shortName } from '@/lib/model-catalog';
import { useOnePane } from '@/lib/one-pane';
import type { Starting } from '@/lib/starting';
import { cn } from '@/lib/utils';

/** A line of text not there yet. */
function Bar({ width, className }: { width: string; className?: string }) {
	return <div className={cn('in-pulse h-2.5 rounded-full bg-(--bg-skeleton)', className)} style={{ width }} />;
}

/** The reply to come: a few lines, as the agent's answer will sit under your message. */
export function ReplySkeleton() {
	return (
		<div aria-hidden className="flex flex-col gap-2.5 pt-1">
			<Bar width="86%" />
			<Bar width="72%" />
			<Bar width="54%" />
		</div>
	);
}

/** A conversation loading: a message of yours and the reply under it. */
export function HistorySkeleton() {
	return (
		<div aria-hidden className="flex flex-col gap-5">
			<div className="flex justify-end">
				<div className="in-pulse h-9 w-[46%] rounded-[14px_14px_4px_14px] bg-(--bg-skeleton)" />
			</div>
			<ReplySkeleton />
		</div>
	);
}

/** The workspace as it opens: its tabs and a panel, not loaded yet. */
function WorkspaceSkeleton() {
	return (
		<WorkspacePane expanded={false}>
			<div aria-hidden className="flex h-11 shrink-0 items-center gap-1.5 px-3">
				<div className="in-pulse h-6 w-[72px] rounded-[8px] bg-(--bg-skeleton)" />
				<div className="in-pulse h-6 w-[64px] rounded-[8px] bg-(--bg-skeleton)" />
			</div>
			<div aria-hidden className="flex flex-col gap-3 border-t border-(--border-subtle) px-4 pt-4">
				<Bar width="38%" />
				<Bar width="62%" />
				<Bar width="48%" />
				<Bar width="70%" />
			</div>
		</WorkspacePane>
	);
}

/**
 * The composer as it will be once the task is made: the agent is working, so it reads as one you add to,
 * with your model named, and only its buttons wait. Drawn the same, so nothing blinks out as the page fills in.
 */
function ComposerSkeleton({ model }: { model: string }) {
	const info = useModels().data?.models.find((item) => item.id === model);
	return (
		<div className="shrink-0 px-4 pt-1 pb-4">
			<div aria-hidden className="in-card relative mx-auto flex max-w-[700px] flex-col gap-2 px-3 pt-3 pb-2">
				<Mascot mood="working" className="absolute right-5 bottom-[calc(100%-1px)]" />
				<div className="min-h-[38px] text-[13px] leading-[21px] text-(--text-placeholder)">Add to what the agent is doing</div>
				<div className="flex items-center gap-1.5">
					<IconBtn icon={Plus} size="sm" label="Attach files" tabIndex={-1} disabled />
					<div className="flex h-[26px] max-w-[260px] min-w-0 items-center gap-1.5 rounded-lg bg-(--bg-overlay) pr-1.5 pl-1 text-(--text-secondary)">
						{info ? <ModelMark model={info} size={16} /> : <Spinner size={12} tone="neutral" />}
						<span className="min-w-0 truncate text-[12px]">{info ? shortName(info) : 'Model'}</span>
					</div>
					<div className="flex-1" />
					<IconBtn icon={Square} size="sm" variant="secondary" label="Stop the agent" tabIndex={-1} disabled />
					<IconBtn icon={Send} size="sm" variant="primary" label="Send message" tabIndex={-1} disabled />
				</div>
			</div>
		</div>
	);
}

/**
 * A task or thread being made, laid out as its page will be: its title, what
 * you asked as your first message, and skeletons for the reply, the composer
 * and the workspace, so it opens the moment you send and fills in once the
 * server has made it. If it could not be made, it says why and offers to try again.
 */
export function StartingTask({
	starting,
	workspace,
	leading,
	onDiscard,
}: {
	starting: Starting;
	/** The workspace will open beside the conversation. */
	workspace: boolean;
	/** Shown before the title, such as the project a thread belongs to. */
	leading?: ReactNode;
	/** Where to go once you give up on it. */
	onDiscard: () => void;
}) {
	const { session, prompt, error } = starting;
	const onePane = useOnePane();
	const open = workspace && !onePane;
	const chat = !session.projectId;
	const kind = session.spaceId ? 'thread' : chat ? 'chat' : 'task';
	return (
		<div className="@container/workspace flex min-h-0 min-w-0 flex-1">
			<div className={cn('in-enter min-h-0 min-w-0 flex-1 flex-col', open ? 'hidden @min-[700px]/workspace:flex' : 'flex')}>
				<header className="flex h-11 shrink-0 items-center gap-2 pr-3 pl-2 md:pl-4">
					<MenuButton />
					{leading}
					<span className={cn('flex shrink-0 items-center gap-1.5 text-[12px] whitespace-nowrap', error ? 'text-(--danger-text)' : 'text-(--accent-text)')}>
						<span className={cn('size-1.5 shrink-0 rounded-full', error ? 'bg-(--danger-base)' : 'in-pulse bg-(--accent-base)')} />
						<span className="hidden sm:inline">{error ? 'Not started' : 'Starting'}</span>
					</span>
					<span className="min-w-[60px] flex-auto truncate text-[13px] font-medium">{session.title}</span>
				</header>
				<div className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-1">
					<div className="mx-auto flex max-w-[700px] flex-col gap-5">
						{/* Laid out as the message it becomes, its caption line included, so nothing moves when the page fills in. */}
						<div className="in-sent flex flex-col items-end gap-1.5">
							<SentText text={prompt || session.title} className="max-w-[min(520px,100%)]" />
							<div aria-hidden className="in-caption opacity-0">
								&nbsp;
							</div>
						</div>
						{error ? (
							<div role="alert" className="flex flex-col gap-2.5 rounded-[12px] border border-(--danger-border) bg-(--danger-bg) px-3 py-2.5 text-[12px] leading-[18px] text-(--danger-text)">
								<div className="flex items-start gap-2">
									<Icon icon={CircleAlert} size={12} className="mt-[3px]" />
									<div className="min-w-0 flex-1 break-words">
										Could not start the {kind}: {error}
									</div>
								</div>
								<div className="flex items-center gap-1.5">
									<Btn size="sm" variant="primary" onClick={starting.retry}>
										Try again
									</Btn>
									<Btn
										size="sm"
										variant="ghost"
										onClick={() => {
											starting.discard();
											onDiscard();
										}}
									>
										Discard
									</Btn>
								</div>
							</div>
						) : (
							<div role="status" className="flex flex-col gap-3">
								<div className="flex min-w-0 items-center gap-2 text-[12px] text-(--text-secondary)">
									<Spinner size={12} />
									<span className="in-shimmer min-w-0 truncate">Starting the {kind}</span>
								</div>
								<ReplySkeleton />
							</div>
						)}
					</div>
				</div>
				<ComposerSkeleton model={session.model} />
			</div>
			{open ? <WorkspaceSkeleton /> : null}
		</div>
	);
}
