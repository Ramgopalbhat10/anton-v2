import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ListChecks, Send, SquareDashedMousePointer, Square, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ComposerPlus } from '@/components/composer-plus';
import { AttachmentTray, useAttachments } from '@/components/attachments';
import { ComposerInput } from '@/components/composer-input';
import { ContextMeter } from '@/components/context-meter';
import { ModelPicker, useModels } from '@/components/model-picker';
import { Btn, Icon, IconBtn, Kbd } from '@/components/signal';
import { TodoPill } from '@/components/todo-pill';
import { api, isChat, SAFETY_NET_MS, type Session } from '@/lib/api';
import { type ImageAttachment, imageFromBase64, MAX_IMAGES } from '@/lib/attachments';
import { expandCommand } from '@/lib/completion';
import { elementContext, elementLabel, type InboxItem, takeFromInbox, useInbox } from '@/lib/composer-inbox';
import { askToNotify } from '@/lib/notifications';
import { withAttachments } from '../../core/attachments';

/** Sent when a message is only images, since the agent always gets text. */
const IMAGE_ONLY = 'Look at the attached image.';
const ELEMENT_ONLY = 'Look at the selected element.';

type Element = Extract<InboxItem, { kind: 'element' }>;

/** Elements picked in the Browser panel: a picture of each and what it is, removable before sending. */
function ElementChips({ elements, onRemove }: { elements: Element[]; onRemove: (id: string) => void }) {
	return (
		<div className="flex flex-wrap gap-1.5">
			{elements.map(({ id, element }) => (
				<div
					key={id}
					title={`${element.selector}\n${element.url}`}
					className="flex h-9 max-w-[260px] items-center gap-2 rounded-md border border-(--border-subtle) bg-(--well-bg) pr-1 pl-1"
				>
					{element.image ? (
						<img src={`data:image/png;base64,${element.image}`} alt="" className="h-7 w-10 shrink-0 rounded-[4px] bg-white object-contain" />
					) : (
						<span className="inline-flex h-7 w-10 shrink-0 items-center justify-center rounded-[4px] bg-(--alpha-white-6) text-(--icon-tertiary)">
							<Icon icon={SquareDashedMousePointer} size={13} />
						</span>
					)}
					<span className="flex min-w-0 flex-col">
						<span className="truncate font-mono text-[11px] text-(--text-primary)">{elementLabel(element)}</span>
						<span className="truncate text-[10.5px] text-(--text-tertiary)">{element.components[0]?.source ?? element.selector}</span>
					</span>
					<button
						type="button"
						aria-label={`Remove ${elementLabel(element)}`}
						onClick={() => onRemove(id)}
						className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-(--icon-tertiary) hover:bg-(--bg-hover) hover:text-(--text-primary)"
					>
						<Icon icon={X} size={10} />
					</button>
				</div>
			))}
		</div>
	);
}

/** Plan mode: the agent investigates and proposes a plan, and changes nothing until the plan is approved. */
export const PlanToggle = memo(function PlanToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
	return (
		<Btn
			size="xs"
			variant={on ? 'secondary' : 'ghost'}
			icon={ListChecks}
			aria-pressed={on}
			title={on ? 'Plan mode: the agent proposes a plan and changes nothing until you approve it' : 'Turn on plan mode'}
			onClick={() => onChange(!on)}
		>
			Plan
		</Btn>
	);
});

/**
 * Messages sent while the agent works join its current turn: it reads them
 * after the step it is on, so they redirect it without stopping it.
 * Memoized: the thread around it re-renders with every streamed chunk, and
 * the draft need not.
 */
export const Composer = memo(function Composer({
	sessionId,
	busy,
	onSend,
	onStop,
}: {
	sessionId: string;
	busy?: boolean;
	onSend: (text: string, images: ImageAttachment[]) => Promise<void>;
	onStop: () => Promise<void>;
}) {
	const [text, setText] = useState('');
	const attachments = useAttachments();
	const { images, addImages } = attachments;
	const [elements, setElements] = useState<Element[]>([]);
	/** What is being attached while a message with files is on its way. */
	const [sending, setSending] = useState<string | null>(null);
	// What the Browser panel hands over (a picked element, a drawing) joins the draft.
	const inbox = useInbox(sessionId);
	useEffect(() => {
		if (!inbox.length) return;
		const items = takeFromInbox(sessionId);
		const picked = items.filter((item): item is Element => item.kind === 'element');
		const drawn = items.flatMap((item) => (item.kind === 'image' ? [item.image] : []));
		if (picked.length) setElements((current) => [...current, ...picked]);
		const handed = items.flatMap((item) => (item.kind === 'text' ? [item.text] : []));
		if (handed.length) setText((current) => [current.trimEnd(), ...handed].filter(Boolean).join('\n\n'));
		if (drawn.length) addImages(drawn);
	}, [inbox, sessionId, addImages]);
	const [stopping, setStopping] = useState(false);
	const stop = async () => {
		setStopping(true);
		await onStop().finally(() => setStopping(false));
	};
	const queryClient = useQueryClient();
	const models = useModels();
	const session = useQuery({
		queryKey: ['session', sessionId],
		queryFn: () => api.session(sessionId),
	});
	const chosen = session.data?.model ?? models.data?.default ?? '';
	const reasoning = session.data?.reasoning ?? null;
	// One object while the choice holds, so the model picker skips the renders typing causes.
	const choice = useMemo(() => ({ model: chosen, reasoning }), [chosen, reasoning]);
	const planning = session.data?.planMode ?? false;
	const edit = useCallback(
		(change: Partial<Session>) => {
			// Show the choice at once; the server's copy replaces it when it lands.
			queryClient.setQueryData<Session>(['session', sessionId], (current) => current && { ...current, ...change });
			void api.editSession(sessionId, change).then((updated) => queryClient.setQueryData(['session', sessionId], updated));
		},
		[queryClient, sessionId],
	);
	const togglePlan = useCallback((planMode: boolean) => edit({ planMode }), [edit]);
	const model = models.data?.models.find((item) => item.id === choice.model);
	const blind = images.length > 0 && model !== undefined && !model.vision;
	const budget = useQuery({ queryKey: ['budget', sessionId], queryFn: () => api.budget(sessionId), refetchInterval: SAFETY_NET_MS });
	const blocked = budget.data?.blocked ?? null;
	const ready = (text.trim() || attachments.count > 0 || elements.length > 0) && !blind && !blocked && !sending;

	return (
		<form
			className="shrink-0 px-4 pt-1 pb-4"
			onSubmit={async (event) => {
				event.preventDefault();
				if (!ready) return;
				const taken = attachments.take();
				const picked = elements;
				const typed = text;
				askToNotify();
				setText('');
				setElements([]);
				setSending(taken.files.length === 0 ? null : taken.files.length === 1 ? taken.files[0]!.name : `${taken.files.length} files`);
				try {
					// Files go to the task's Library first, and the message carries what they say.
					const attached = await Promise.all(taken.files.map((file) => api.attachToTask(sessionId, file.file)));
					// Only a /command waits to read the saved commands, so any other message goes at once.
					const saved = text.trim().startsWith('/') ? await queryClient.fetchQuery({ queryKey: ['commands'], queryFn: api.commands, staleTime: 60_000 }) : { commands: [] };
					const typedMessage = expandCommand(text.trim(), saved.commands, true);
					const message = typedMessage || (picked.length ? ELEMENT_ONLY : taken.images.length && !attached.length ? IMAGE_ONLY : '');
					// Each element goes as text the agent can search the code with, and as its picture when the model can see.
					const pictures: ImageAttachment[] =
						model?.vision === false
							? []
							: picked.flatMap(({ id, element }) => (element.image ? [imageFromBase64(element.image, `${element.tag}.png`, 'image/png', id)] : []));
					const context = picked.map(({ element }) => elementContext(element)).join('\n\n');
					await onSend(withAttachments(context ? `${message}\n\n${context}` : message, attached, 'task'), [...taken.images, ...pictures].slice(0, MAX_IMAGES + picked.length));
				} catch (error) {
					// Put the draft back so nothing typed is lost, and say why it did not go.
					setText((current) => current || typed);
					attachments.restore(taken);
					setElements((current) => (current.length ? current : picked));
					attachments.setNotice(`Not sent: ${error instanceof Error ? error.message : String(error)}`);
				} finally {
					setSending(null);
				}
			}}
		>
			{/* The agent's todo list, while the task has one; it renders nothing otherwise. */}
			<div className="mx-auto mb-1.5 flex max-w-[700px] justify-center empty:hidden">
				<TodoPill sessionId={sessionId} busy={Boolean(busy)} />
			</div>
			<div
				className="in-card relative mx-auto flex max-w-[700px] flex-col gap-2 px-3 pt-3 pb-2 focus-within:border-(--border-strong)"
				{...attachments.dropZone}
			>
				{elements.length > 0 ? <ElementChips elements={elements} onRemove={(id) => setElements((current) => current.filter((item) => item.id !== id))} /> : null}
				<AttachmentTray attachments={attachments} />
				<ComposerInput
					value={text}
					onChange={setText}
					sessionId={sessionId}
					onPaste={attachments.onPaste}
					placeholder={busy ? 'Add to what the agent is doing' : planning ? 'Describe what to plan' : session.data && isChat(session.data) ? 'Ask anything' : 'Ask Anton to change the workspace'}
				/>
				{blocked || blind || attachments.notice || sending ? (
					<div className={blocked ? 'text-[12px] text-(--danger-text)' : sending && !blind ? 'text-[12px] text-(--text-tertiary)' : 'text-[12px] text-(--warning-text)'}>
						{blocked ?? (blind ? `${model?.name ?? 'This model'} cannot see images. Pick a model marked Vision to send them.` : sending ? `Attaching ${sending}…` : attachments.notice)}
					</div>
				) : null}
				<div className="flex flex-nowrap items-center gap-1.5">
					<ComposerPlus attachments={attachments} />
					<ModelPicker value={choice} onChange={edit} />
					{/* A chat has no code to plan changes to. */}
					{session.data && isChat(session.data) ? null : <PlanToggle on={planning} onChange={togglePlan} />}
					{choice.model ? <ContextMeter sessionId={sessionId} model={choice.model} /> : null}
					{/* Enter sends, as everywhere; the hint speaks up only while the agent is running. */}
					<div className="flex min-w-0 flex-[1_1_8px] items-center justify-end gap-1.5 overflow-hidden text-[11px] whitespace-nowrap text-(--text-disabled) max-sm:invisible">
						{busy ? (
							<>
								<span className="truncate">Send to the running agent</span>
								<Kbd keys="enter" size="sm" />
							</>
						) : null}
					</div>
					{busy ? <IconBtn icon={Square} size="sm" variant="secondary" label="Stop the agent" onClick={() => void stop()} disabled={stopping} /> : null}
					<IconBtn type="submit" icon={Send} size="sm" variant="primary" label="Send message" disabled={!ready} />
				</div>
			</div>
		</form>
	);
});
