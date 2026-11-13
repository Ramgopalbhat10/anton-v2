import { useFlueAgent } from '@flue/react';
import { useNavigate } from '@tanstack/react-router';
import { EyeOff, Send, Square, X } from 'lucide-react';
import { type FormEvent, type Ref, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { withAttachments } from '../../core/attachments';
import { newIncognitoId } from '../../core/incognito';
import { parseRouted } from '../../core/model-route';
import { api, type ModelChoice, type ModelRoute, type Reasoning } from '@/lib/api';
import { deliveredImages, MAX_IMAGES } from '@/lib/attachments';
import { flyFrom } from '@/lib/flight';
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
	formRef,
	onSend,
	choice,
	onChoice,
	route,
	onRoute,
}: {
	id: string;
	agent: ReturnType<typeof useFlueAgent>;
	className?: string;
	formRef?: Ref<HTMLFormElement>;
	onSend: () => void;
	choice: Partial<ModelChoice>;
	onChoice: (change: Partial<ModelChoice>) => void;
	route: ModelRoute | null;
	onRoute: (route: ModelRoute | null) => void;
}) {
	const [text, setText] = useState('');
	const [sending, setSending] = useState(false);
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
		<form ref={formRef} className={cn('relative mx-auto flex w-full max-w-[680px] flex-col gap-2 px-4 pt-1 pb-4', className)} onSubmit={submit} {...attachments.dropZone}>
			<AttachmentTray attachments={attachments} />
			<div className="in-card relative flex flex-col gap-2 px-3 pt-3 pb-2 focus-within:border-(--border-strong)">
				<Mascot mood={mood} className="absolute right-5 bottom-[calc(100%-1px)]" />
				<ComposerInput
					autoFocus={!busy}
					value={text}
					onChange={setText}
					onPaste={attachments.onPaste}
					placeholder={busy ? 'Add to what Anton is doing' : 'Ask anything — this chat is never saved'}
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
						onChange={onChoice}
						route={route}
						onRoute={onRoute}
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
	// The model pick lives here so it survives the composer moving into the thread.
	const [choice, setChoice] = useState<Partial<ModelChoice>>({});
	const [route, setRoute] = useState<ModelRoute | null>(null);
	// Only a chat that actually ran has anything to delete; closing it — the X, leaving the
	// page, or the app itself closing — kicks the deletion off without waiting on it.
	const used = useRef(false);
	const busy = agent.status === 'submitted' || agent.status === 'streaming';
	const chatting = started || agent.messages.length > 0 || busy;
	// One composer for the whole page: it sits dead-center until the first send, then glides
	// down to dock under the thread — the same element, so focus and text survive the move.
	const formRef = useRef<HTMLFormElement>(null);
	const lastRect = useRef<DOMRect | null>(null);
	const wasChatting = useRef(chatting);

	useLayoutEffect(() => {
		const form = formRef.current;
		if (!form) return;
		const before = lastRect.current;
		// Mid-flight the box is transformed; only settled boxes are worth remembering.
		if (form.getAnimations().length === 0) lastRect.current = form.getBoundingClientRect();
		if (wasChatting.current === chatting) return;
		wasChatting.current = chatting;
		if (before) flyFrom(form, before);
	});

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
	const markStarted = useCallback(() => {
		used.current = true;
		setStarted(true);
	}, []);
	const composer = (
		<IncognitoComposer
			id={id}
			agent={agent}
			formRef={formRef}
			choice={choice}
			onChoice={(change) => setChoice((current) => ({ ...current, ...change }))}
			route={route}
			onRoute={setRoute}
			onSend={markStarted}
		/>
	);

	return (
		<div className="incognito flex min-h-0 flex-1 flex-col">
			<div className="incognito-viewport">
				<div className="incognito-card">
					<div className="incognito-stage flex h-full min-h-0 flex-col">
						{chatting ? (
							// The thread waits for something to show: mounting it on send would flash
							// its empty state during the beat before the message lands.
							// Thread must be a constrained flex child so its scrollport fills only
							// the space above the composer, including when the draft grows.
							<div className="flex min-h-0 min-w-0 flex-1 flex-col">
								{agent.messages.length > 0 || busy ? <Thread sessionId={id} agent={agent} composer={null} fresh /> : null}
							</div>
						) : null}
						<div className={cn('min-w-0', chatting ? 'shrink-0' : 'flex min-h-0 flex-1 items-center justify-center px-6')}>{composer}</div>
					</div>
				</div>
			</div>
			<button type="button" onClick={close} aria-label="Close incognito chat" title="Close incognito chat" className="incognito-exit">
				<Icon icon={EyeOff} size={16} className="incognito-exit-eye" />
				<Icon icon={X} size={16} className="incognito-exit-x" />
			</button>
		</div>
	);
}
