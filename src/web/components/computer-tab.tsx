import RFB from '@novnc/novnc';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Hand, Monitor, Pause, PencilLine, RotateCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWindowShown } from '@/components/browser-tab';
import { Sketch } from '@/components/sketch';
import { Btn, EmptyState, Icon, IconBtn, Spinner } from '@/components/signal';
import { api, type ComputerView } from '@/lib/api';
import { imageFromDataUrl } from '@/lib/attachments';
import { addToComposer } from '@/lib/composer-inbox';
import { useElementSize } from '@/lib/use-element-size';
import { cn } from '@/lib/utils';

/*
 * The Computer panel: the desktop inside the task's sandbox, shown over VNC
 * (noVNC in the page, through a short-lived address Anton asks the sandbox
 * for). You watch the agent's computer subagent at work, or take over to use
 * it yourself, which makes the agent wait until you give it back. Looking at
 * the panel never starts the sandbox; Start computer does.
 */

/** The screen stops streaming after a spell with no sign of you or the agent; the computer keeps running. */
const PAUSE_AFTER_MS = 5 * 60_000;

/** Whether the screen should stream, and a way to wake it. */
function useScreenAwake(on: boolean, agentBusy: boolean): [boolean, () => void] {
	const shown = useWindowShown();
	const [paused, setPaused] = useState(false);
	const lastSeen = useRef(Date.now());
	const busy = useRef(agentBusy);
	busy.current = agentBusy;
	const wake = useCallback(() => {
		lastSeen.current = Date.now();
		setPaused(false);
	}, []);
	useEffect(() => {
		const seen = () => {
			lastSeen.current = Date.now();
		};
		// Captured, as the screen stops the events it takes for the computer.
		window.addEventListener('pointermove', seen, { capture: true, passive: true });
		window.addEventListener('keydown', seen, { capture: true });
		return () => {
			window.removeEventListener('pointermove', seen, { capture: true });
			window.removeEventListener('keydown', seen, { capture: true });
		};
	}, []);
	useEffect(() => {
		lastSeen.current = Date.now();
	}, [shown]);
	useEffect(() => {
		if (agentBusy) wake();
	}, [agentBusy, wake]);
	useEffect(() => {
		if (!on || paused) return;
		const timer = setInterval(() => {
			if (busy.current) lastSeen.current = Date.now();
			else if (Date.now() - lastSeen.current > PAUSE_AFTER_MS) setPaused(true);
		}, 15_000);
		return () => clearInterval(timer);
	}, [on, paused]);
	return [on && shown && !paused, wake];
}

type Link = { state: 'connecting' | 'connected' | 'closed'; error?: string };

/**
 * The screen itself, connected while it is mounted. A connection that drops
 * uncleanly is tried again twice, each with a fresh address.
 */
function Screen({ sessionId, viewOnly, onLink }: { sessionId: string; viewOnly: boolean; onLink: (link: Link) => void }) {
	const target = useRef<HTMLDivElement>(null);
	const client = useRef<RFB | null>(null);
	const readOnly = useRef(viewOnly);
	readOnly.current = viewOnly;
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let cancelled = false;
		let rfb: RFB | null = null;
		onLink({ state: 'connecting' });
		api
			.connectComputer(sessionId)
			.then(({ url }) => {
				if (cancelled || !target.current) return;
				rfb = new RFB(target.current, url, { shared: true, wsProtocols: ['binary'] });
				rfb.scaleViewport = true;
				rfb.resizeSession = false;
				rfb.background = 'transparent';
				rfb.viewOnly = readOnly.current;
				rfb.addEventListener('connect', () => onLink({ state: 'connected' }));
				rfb.addEventListener('disconnect', (event) => {
					client.current = null;
					if (cancelled) return;
					const clean = (event as CustomEvent<{ clean?: boolean }>).detail?.clean;
					if (!clean && attempt < 2) setTimeout(() => setAttempt((count) => count + 1), 1000);
					else onLink({ state: 'closed' });
				});
				client.current = rfb;
			})
			.catch((error: Error) => !cancelled && onLink({ state: 'closed', error: error.message }));
		return () => {
			cancelled = true;
			rfb?.disconnect();
			client.current = null;
		};
	}, [sessionId, attempt, onLink]);
	useEffect(() => {
		if (!client.current) return;
		client.current.viewOnly = viewOnly;
		if (!viewOnly) client.current.focus();
	}, [viewOnly]);
	return <div ref={target} data-testid="computer-screen" aria-label="Computer screen" className={cn('absolute inset-0', viewOnly && '[&_canvas]:cursor-default!')} />;
}

function StartComputer({ sessionId, live }: { sessionId: string; live: boolean }) {
	const queryClient = useQueryClient();
	const start = useMutation({
		mutationFn: () => api.startComputer(sessionId),
		onSuccess: ({ url: _, ...next }) => queryClient.setQueryData<ComputerView>(['computer', sessionId], next),
	});
	return (
		<EmptyState
			icon={Monitor}
			title="A computer for this task"
			body={
				live
					? 'A desktop inside this task’s sandbox, where the agent uses programs and pages and you can take over. The sandbox is running; its desktop starts now.'
					: 'A desktop inside this task’s sandbox, where the agent uses programs and pages and you can take over. Starting it starts the sandbox.'
			}
		>
			<Btn size="sm" variant="primary" disabled={start.isPending} onClick={() => start.mutate()}>
				{start.isPending ? 'Starting…' : 'Start computer'}
			</Btn>
			{start.isError ? <p className="m-0 text-[12px] text-(--danger-text)">{start.error.message}</p> : null}
		</EmptyState>
	);
}

function Overlay({ children }: { children: React.ReactNode }) {
	return <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-(--bg-inset) px-6 text-center">{children}</div>;
}

export function ComputerTab({ sessionId }: { sessionId: string }) {
	const queryClient = useQueryClient();
	const view = useQuery({ queryKey: ['computer', sessionId], queryFn: () => api.computer(sessionId) });
	const computer = view.data;
	const running = Boolean(computer?.live && computer.running);
	const screen = computer?.screen ?? { width: 1280, height: 800 };
	const [area, room] = useElementSize<HTMLDivElement>();
	const scale = Math.min(room.width / screen.width, room.height / screen.height);
	const size = { width: Math.floor(screen.width * scale), height: Math.floor(screen.height * scale) };
	const [showing, wake] = useScreenAwake(running, Boolean(computer?.agentBusy));
	const [link, setLink] = useState<Link>({ state: 'connecting' });
	// Mounting the screen again connects again.
	const [connection, setConnection] = useState(0);
	const [sketch, setSketch] = useState<{ data: string; width: number; height: number } | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const control = useMutation({
		mutationFn: (driver: 'user' | 'agent') => api.setComputerControl(sessionId, driver),
		onSuccess: (next) => queryClient.setQueryData(['computer', sessionId], next),
	});
	const capture = useMutation({ mutationFn: () => api.computerScreenshot(sessionId), onSuccess: setSketch });

	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => setNotice(null), 2500);
		return () => clearTimeout(timer);
	}, [notice]);

	if (view.isPending) {
		return (
			<div className="flex h-7 items-center gap-2 text-[12px] text-(--text-tertiary)">
				<Spinner size={12} />
				Checking the computer
			</div>
		);
	}
	if (view.isError) return <EmptyState title="Computer unavailable" body={view.error.message} />;
	if (!running || !computer) return <StartComputer sessionId={sessionId} live={Boolean(computer?.live)} />;

	const yours = computer.userControl;
	const status = capture.error?.message ?? control.error?.message ?? notice;

	return (
		<div className="flex h-full min-h-0 flex-col gap-2">
			<div className="flex h-8 shrink-0 items-center gap-1.5">
				<span className="flex min-w-0 flex-1 items-center gap-1.5 pl-1 text-[12px] text-(--text-secondary)">
					{yours ? (
						<>
							<Icon icon={Hand} size={12} className="shrink-0 text-(--accent-text)" />
							<span className="truncate">You have the computer. The agent waits until you give it back.</span>
						</>
					) : computer.agentBusy ? (
						<>
							<span className="in-pulse size-1.5 shrink-0 rounded-full bg-(--accent-base)" />
							<span className="truncate">The agent is using the computer</span>
						</>
					) : (
						<span className="truncate text-(--text-tertiary)">Watching. Take over to use it yourself.</span>
					)}
				</span>
				<IconBtn
					icon={PencilLine}
					size="sm"
					label={sketch ? 'Stop drawing' : 'Draw on the screen'}
					aria-pressed={Boolean(sketch)}
					disabled={capture.isPending}
					onClick={() => (sketch ? setSketch(null) : capture.mutate())}
					className={cn(sketch && 'bg-(--accent-bg-subtle) text-(--accent-text)', capture.isPending && '[&_svg]:animate-pulse')}
				/>
				<Btn size="sm" variant={yours ? 'primary' : 'secondary'} icon={yours ? Bot : Hand} disabled={control.isPending} onClick={() => control.mutate(yours ? 'agent' : 'user')}>
					{yours ? 'Give back' : 'Take over'}
				</Btn>
			</div>
			<div ref={area} className="relative flex min-h-[240px] flex-1 items-center justify-center">
				<div className="in-well relative overflow-hidden bg-(--bg-inset)" style={{ width: size.width, height: size.height }}>
					{showing ? <Screen key={connection} sessionId={sessionId} viewOnly={!yours} onLink={setLink} /> : null}
					{!showing ? (
						<Overlay>
							<Icon icon={Pause} size={16} className="text-(--icon-tertiary)" />
							<div className="text-[12.5px] text-(--text-primary)">Paused while nobody watched</div>
							<p className="m-0 max-w-[300px] text-[11.5px] text-(--text-tertiary)">The computer keeps running in the sandbox.</p>
							<Btn size="sm" variant="primary" onClick={wake}>
								Resume
							</Btn>
						</Overlay>
					) : link.state === 'connecting' ? (
						<div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 bg-(--bg-inset) text-[12px] text-(--text-tertiary)">
							<Spinner size={12} />
							Connecting to the computer
						</div>
					) : link.state === 'closed' ? (
						<Overlay>
							<div className="text-[12.5px] text-(--text-primary)">The connection closed</div>
							{link.error ? <p className="m-0 max-w-[300px] text-[11.5px] text-(--text-tertiary)">{link.error}</p> : null}
							<Btn
								size="sm"
								variant="primary"
								icon={RotateCw}
								onClick={() => {
									setConnection((count) => count + 1);
									void view.refetch();
								}}
							>
								Reconnect
							</Btn>
						</Overlay>
					) : null}
					{sketch ? (
						<div className="absolute inset-0 z-20">
							<Sketch
								image={sketch.data}
								width={sketch.width}
								height={sketch.height}
								onClose={() => setSketch(null)}
								onAttach={(png) => {
									addToComposer(sessionId, { kind: 'image', image: imageFromDataUrl(png, 'drawing.png') });
									setNotice('Added the drawing to the message');
									setSketch(null);
								}}
							/>
						</div>
					) : null}
					{status ? (
						<div className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center">
							<span role="status" className="in-pop flex items-center gap-1.5 px-2.5 py-1 text-[11.5px] text-(--text-secondary)">
								{status}
							</span>
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
