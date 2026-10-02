import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Send, Square, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { ModelPicker, useModels } from '@/components/model-picker';
import { Icon, IconBtn, Kbd } from '@/components/signal';
import { api, type Session } from '@/lib/api';
import { type ImageAttachment, MAX_IMAGES, readImages } from '@/lib/attachments';
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
		setImages((current) => [...current, ...read.images]);
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
	const model = models.data?.models.find((item) => item.id === choice.model);
	const blind = images.length > 0 && model !== undefined && !model.vision;
	const budget = useQuery({ queryKey: ['budget', sessionId], queryFn: () => api.budget(sessionId), refetchInterval: 30_000 });
	const blocked = budget.data?.blocked ?? null;
	const ready = (text.trim() || images.length > 0) && !blind && !blocked;

	return (
		<form
			className="shrink-0 px-4 pt-1 pb-4"
			onSubmit={async (event) => {
				event.preventDefault();
				if (!ready) return;
				const sent = images;
				askToNotify();
				setText('');
				setImages([]);
				setNotice(null);
				await onSend(text.trim() || IMAGE_ONLY, sent);
			}}
		>
			<div
				className="mx-auto flex max-w-[700px] flex-col gap-2 rounded-xl bg-(--bg-surface) px-3 pt-3 pb-2"
				onDragOver={(event) => event.preventDefault()}
				onDrop={(event) => {
					event.preventDefault();
					void attach([...event.dataTransfer.files]);
				}}
			>
				{images.length > 0 ? <Thumbnails images={images} onRemove={(id) => setImages((current) => current.filter((image) => image.id !== id))} /> : null}
				<textarea
					value={text}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter' && !event.shiftKey) {
							event.preventDefault();
							event.currentTarget.form?.requestSubmit();
						}
					}}
					onPaste={(event) => {
						const files = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'));
						if (files.length === 0) return;
						event.preventDefault();
						void attach(files);
					}}
					placeholder={busy ? 'Add to what the agent is doing' : 'Ask Anton to change the workspace'}
					rows={2}
					className="w-full resize-none border-0 bg-transparent p-0 text-[13px] leading-[19px] text-(--text-primary) outline-none"
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
					<ModelPicker
						value={choice}
						onChange={(change) => {
							// Show the choice at once; the server's copy replaces it when it lands.
							queryClient.setQueryData<Session>(['session', sessionId], (current) => current && { ...current, ...change });
							void api.editSession(sessionId, change).then((updated) => queryClient.setQueryData(['session', sessionId], updated));
						}}
					/>
					<div className="flex min-w-0 flex-[1_1_8px] items-center justify-end gap-1.5 overflow-hidden text-[11px] whitespace-nowrap text-(--text-disabled)">
						<span className="truncate">{busy ? 'Send to the running agent' : 'Send'}</span>
						<Kbd keys="enter" size="sm" />
					</div>
					{busy ? (
						<IconBtn icon={Square} size="sm" variant="secondary" label="Stop the agent" onClick={() => void stop()} disabled={stopping} />
					) : null}
					<IconBtn type="submit" icon={Send} size="sm" variant="primary" label="Send message" disabled={!ready} />
				</div>
			</div>
		</form>
	);
}
