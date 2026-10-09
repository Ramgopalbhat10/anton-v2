import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, ListChecks, Send, Square, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { ComposerInput } from '@/components/composer-input';
import { ContextMeter } from '@/components/context-meter';
import { ModelPicker, useModels } from '@/components/model-picker';
import { Btn, Icon, IconBtn, Kbd } from '@/components/signal';
import { api, SAFETY_NET_MS, type Session } from '@/lib/api';
import { type ImageAttachment, MAX_IMAGES, readImages } from '@/lib/attachments';
import { expandCommand } from '@/lib/completion';
import { askToNotify } from '@/lib/notifications';

/** Sent when a message is only images, since the agent always gets text. */
const IMAGE_ONLY = 'Look at the attached image.';

function Thumbnails({ images, onRemove }: { images: ImageAttachment[]; onRemove: (id: string) => void }) {
	return (
		<div className="flex flex-wrap gap-1.5">
			{images.map((image) => (
				<div key={image.id} className="relative size-14 overflow-hidden rounded-md border border-(--border-subtle)">
					<img src={image.preview} alt={image.filename} className="size-full object-cover" />
					<button
						type="button"
						aria-label={`Remove ${image.filename}`}
						onClick={() => onRemove(image.id)}
						className="absolute top-0.5 right-0.5 inline-flex size-4 items-center justify-center rounded-sm bg-(--bg-scrim) text-(--text-primary)"
					>
						<Icon icon={X} size={10} />
					</button>
				</div>
			))}
		</div>
	);
}

/** Plan mode: the agent investigates and proposes a plan, and changes nothing until the plan is approved. */
export function PlanToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
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
}

/**
 * Messages sent while the agent works join its current turn: it reads them
 * after the step it is on, so they redirect it without stopping it.
 */
export function Composer({
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
	const [images, setImages] = useState<ImageAttachment[]>([]);
	const [notice, setNotice] = useState<string | null>(null);
	const [stopping, setStopping] = useState(false);
	const picker = useRef<HTMLInputElement>(null);
	const attach = async (files: File[]) => {
		if (files.length === 0) return;
		const read = await readImages(files, MAX_IMAGES - images.length);
		// Clamped here too: two quick pastes both read the count from before either landed.
		setImages((current) => [...current, ...read.images].slice(0, MAX_IMAGES));
		setNotice(read.rejected);
	};
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
	const choice = { model: session.data?.model ?? models.data?.default ?? '', reasoning: session.data?.reasoning ?? null };
	const planning = session.data?.planMode ?? false;
	const edit = (change: Partial<Session>) => {
		// Show the choice at once; the server's copy replaces it when it lands.
		queryClient.setQueryData<Session>(['session', sessionId], (current) => current && { ...current, ...change });
		void api.editSession(sessionId, change).then((updated) => queryClient.setQueryData(['session', sessionId], updated));
	};
	const model = models.data?.models.find((item) => item.id === choice.model);
	const blind = images.length > 0 && model !== undefined && !model.vision;
	const budget = useQuery({ queryKey: ['budget', sessionId], queryFn: () => api.budget(sessionId), refetchInterval: SAFETY_NET_MS });
	const blocked = budget.data?.blocked ?? null;
	const ready = (text.trim() || images.length > 0) && !blind && !blocked;

	return (
		<form
			className="shrink-0 px-4 pt-1 pb-4"
			onSubmit={async (event) => {
				event.preventDefault();
				if (!ready) return;
				const sent = images;
				const typed = text;
				askToNotify();
				setText('');
				setImages([]);
				setNotice(null);
				try {
					const saved = await queryClient.fetchQuery({ queryKey: ['commands'], queryFn: api.commands, staleTime: 60_000 });
					await onSend(expandCommand(text.trim(), saved.commands, true) || IMAGE_ONLY, sent);
				} catch (error) {
					// Put the draft back so nothing typed is lost, and say why it did not go.
					setText((current) => current || typed);
					setImages((current) => (current.length ? current : sent));
					setNotice(`Not sent: ${error instanceof Error ? error.message : String(error)}`);
				}
			}}
		>
			<div
				className="in-card relative mx-auto flex max-w-[700px] flex-col gap-2 px-3 pt-3 pb-2 focus-within:border-(--border-strong)"
				onDragOver={(event) => event.preventDefault()}
				onDrop={(event) => {
					event.preventDefault();
					void attach([...event.dataTransfer.files]);
				}}
			>
				{images.length > 0 ? <Thumbnails images={images} onRemove={(id) => setImages((current) => current.filter((image) => image.id !== id))} /> : null}
				<ComposerInput
					value={text}
					onChange={setText}
					sessionId={sessionId}
					onPaste={(event) => {
						const files = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'));
						if (files.length === 0) return;
						event.preventDefault();
						void attach(files);
					}}
					placeholder={busy ? 'Add to what the agent is doing' : planning ? 'Describe what to plan' : 'Ask Anton to change the workspace'}
				/>
				{blocked || blind || notice ? (
					<div className={blocked ? 'text-[12px] text-(--danger-text)' : 'text-[12px] text-(--warning-text)'}>
						{blocked ?? (blind ? `${model?.name ?? 'This model'} cannot see images. Pick a model marked Vision to send them.` : notice)}
					</div>
				) : null}
				<div className="flex flex-nowrap items-center gap-1.5">
					<input
						ref={picker}
						type="file"
						accept="image/png,image/jpeg,image/gif,image/webp"
						multiple
						hidden
						onChange={(event) => {
							void attach([...(event.target.files ?? [])]);
							event.target.value = '';
						}}
					/>
					<IconBtn icon={ImagePlus} size="sm" label="Attach images" onClick={() => picker.current?.click()} disabled={images.length >= MAX_IMAGES} />
					<ModelPicker value={choice} onChange={edit} />
					<PlanToggle on={planning} onChange={(planMode) => edit({ planMode })} />
					{choice.model ? <ContextMeter sessionId={sessionId} model={choice.model} /> : null}
					<div className="flex min-w-0 flex-[1_1_8px] items-center justify-end gap-1.5 overflow-hidden text-[11px] whitespace-nowrap text-(--text-disabled) max-sm:invisible">
						<span className="truncate">{busy ? 'Send to the running agent' : 'Send'}</span>
						<Kbd keys="enter" size="sm" />
					</div>
					{busy ? <IconBtn icon={Square} size="sm" variant="secondary" label="Stop the agent" onClick={() => void stop()} disabled={stopping} /> : null}
					<IconBtn type="submit" icon={Send} size="sm" variant="primary" label="Send message" disabled={!ready} />
				</div>
			</div>
		</form>
	);
}
