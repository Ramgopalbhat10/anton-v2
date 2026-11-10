import { useFlueAgent } from '@flue/react';
import { useNavigate } from '@tanstack/react-router';
import { EyeOff, Send, Square, X } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { withAttachments } from '../../core/attachments';
import { newIncognitoId } from '../../core/incognito';
import { parseRouted } from '../../core/model-route';
import { api, type ModelChoice, type ModelRoute, type Reasoning } from '@/lib/api';
import { deliveredImages, MAX_IMAGES } from '@/lib/attachments';
import { cn } from '@/lib/utils';
import { AttachmentTray, useAttachments } from '@/components/attachments';
import { ComposerInput } from '@/components/composer-input';
import { ComposerPlus } from '@/components/composer-plus';
import { Mascot, useMascotMood } from '@/components/mascot';
import { ModelPicker, useModels } from '@/components/model-picker';
import { Icon, IconBtn } from '@/components/signal';
import { Thread } from '@/components/thread';

const IMAGE_ONLY = 'Look at the attached image.';

/**
 * The composer, stripped to what an incognito chat has: text, images and files, a model,
 * and the user's connectors through ComposerPlus. No session, no sandbox, no plan, no todo.
 */
function IncognitoComposer({
	id,
	agent,
	className,
	onSend,
}: {
	id: string;
	agent: ReturnType<typeof useFlueAgent>;
	className?: string;
	onSend: () => void;
}) {
	const [text, setText] = useState('');
	const [sending, setSending] = useState(false);
	const [choice, setChoice] = useState<Partial<ModelChoice>>({});
	const [route, setRoute] = useState<ModelRoute | null>(null);
	const attachments = useAttachments();
	const models = useModels();
	const specifier = choice.model ?? models.data?.default ?? '';
	const reasoning = choice.reasoning !== undefined ? choice.reasoning : null;
	const { model, route: encoded } = parseRouted(specifier);
	const chosenModel = models.data?.models.find((item) => item.id === model);
	const busy = agent.status === 'submitted' || agent.status === 'streaming';
	const blind = attachments.images.length > 0 && chosenModel !== undefined && !chosenModel.vision;
	const ready = !sending && !blind && (text.trim().length > 0 || attachments.count > 0);
	const mood = useMascotMood({ busy, waiting: false, stir: text });

	async function send() {
		if (!ready) return;
		const taken = attachments.take();
		const typed = text.trim();
		setText('');
		setSending(true);
		onSend();
		try {
			// The model choice is primed with the first send; until then the chat calls nothing.
			await api.chooseIncognito(id, { model, reasoning, route: route ?? encoded }).catch(() => undefined);
			// Files are read as text for the message and never stored; pictures go as images.
			const attached = await Promise.all(taken.files.map((file) => api.attachIncognito(file.file.name, file.file)));
			const base = typed || (taken.images.length && !attached.length ? IMAGE_ONLY : '');
			await agent.sendMessage(withAttachments(base, attached, 'task'), { images: deliveredImages(taken.images).slice(0, MAX_IMAGES) });
		} catch (error) {
			setText((current) => [typed, current].filter(Boolean).join('\n\n'));
			attachments.restore(taken);
			attachments.setNotice(`Not sent: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			setSending(false);
		}
	}

	function submit(event: FormEvent) {
		event.preventDefault();
		void send();
	}

	function stop() {
		void api.stopIncognito(id).catch(() => undefined);
	}

	return (
		<form className={cn('relative mx-auto flex w-full max-w-[680px] flex-col gap-2', className)} onSubmit={submit} {...attachments.dropZone}>
			<AttachmentTray attachments={attachments} />
			<div className="in-card relative flex flex-col gap-2 px-3 pt-3 pb-2 focus-within:border-(--border-strong)">
				<Mascot mood={mood} className="absolute right-5 bottom-[calc(100%-1px)]" />
				<ComposerInput
					autoFocus={!busy}
					value={text}
					onChange={setText}
					onPaste={attachments.onPaste}
					placeholder={busy ? 'Add to what Anton is doing' : 'Ask anything — this chat is never saved'}
					className="min-h-[72px]"
				/>
				{attachments.notice || blind ? (
					<div className="px-1 text-micro text-(--warning-text)">
						{blind ? `${chosenModel?.name ?? 'This model'} cannot see images. Pick a model marked Vision to send them.` : attachments.notice}
					</div>
				) : null}
				<div className="flex flex-nowrap items-center gap-1.5">
					<ComposerPlus attachments={attachments} side="bottom" />
					<ModelPicker
						value={{ model: specifier, reasoning }}
						onChange={(change) => setChoice((current) => ({ ...current, ...change }))}
						route={route}
						onRoute={(next) => setRoute(next)}
						height={28}
						side="bottom"
					/>
					<div className="min-w-0 flex-[1_1_8px]" />
					{busy ? <IconBtn icon={Square} size="sm" label="Stop" onClick={stop} /> : null}
					<IconBtn type="submit" icon={Send} size="sm" variant="primary" label="Send" disabled={!ready} />
				</div>
			</div>
		</form>
	);
}

/**
 * Incognito chat: a throwaway conversation inside a dark frame. The sidebars are gone,
 * nothing is written anywhere, and closing the window — the X in the frame, or leaving —
 * ends it for good.
 */
export function IncognitoPage() {
	const [id] = useState(newIncognitoId);
	const agent = useFlueAgent({ url: `/api/agents/incognito/${id}` });
	const navigate = useNavigate();
	const [started, setStarted] = useState(false);
	// Only a chat that actually ran has anything to delete; closing it — the X, leaving the
	// page, or the app itself closing — kicks the deletion off without waiting on it.
	const used = useRef(false);
	const chatting = started || agent.messages.length > 0 || agent.status === 'submitted' || agent.status === 'streaming';

	const destroy = useCallback(() => {
		if (!used.current) return;
		used.current = false;
		void api.closeIncognito(id).catch(() => undefined);
	}, [id]);

	useEffect(() => {
		const onHide = () => destroy();
		window.addEventListener('pagehide', onHide);
		return () => {
			window.removeEventListener('pagehide', onHide);
			destroy();
		};
	}, [destroy]);

	const close = useCallback(() => void navigate({ to: '/' }), [navigate]);

	return (
		<div className="incognito flex min-h-0 flex-1 flex-col">
			<div className="incognito-viewport">
				<div className="incognito-card">
					{chatting ? (
						<div className="incognito-stage flex h-full min-h-0 flex-col">
							<div className="flex min-h-0 min-w-0 flex-1 flex-col">
								<Thread sessionId={id} agent={agent} />
							</div>
							<div className="px-4 pt-2 pb-4">
								<IncognitoComposer
									id={id}
									agent={agent}
									onSend={() => {
										used.current = true;
										setStarted(true);
									}}
								/>
							</div>
						</div>
					) : (
						<div className="incognito-stage flex h-full items-center justify-center px-6">
							<IncognitoComposer
								id={id}
								agent={agent}
								onSend={() => {
									used.current = true;
									setStarted(true);
								}}
							/>
						</div>
					)}
				</div>
			</div>
			<button type="button" onClick={close} aria-label="Close incognito chat" title="Close incognito chat" className="incognito-exit">
				<Icon icon={EyeOff} size={16} className="incognito-exit-eye" />
				<Icon icon={X} size={16} className="incognito-exit-x" />
			</button>
		</div>
	);
}
