import { useQuery } from '@tanstack/react-query';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { RotateCw, SquareTerminal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Facts, Status } from '@/components/instrument';
import { Btn, Icon } from '@/components/signal';
import { useRefreshTask } from '@/components/source-bar';
import { api } from '@/lib/api';

/** xterm palette from the Signal tokens: inset black, secondary text, cyan cursor. */
const theme = {
	background: '#000000',
	foreground: '#ababab',
	cursor: '#3fb6d8',
	cursorAccent: '#06181f',
	selectionBackground: 'rgba(63,182,216,0.16)',
	black: '#16161a',
	red: '#f58581',
	green: '#63dda5',
	yellow: '#f2c173',
	blue: '#6fcde8',
	magenta: '#b98be8',
	cyan: '#6fcde8',
	white: '#ededef',
	brightBlack: '#6e6e78',
	brightRed: '#f58581',
	brightGreen: '#63dda5',
	brightYellow: '#f2c173',
	brightBlue: '#9ee1f3',
	brightMagenta: '#b98be8',
	brightCyan: '#9ee1f3',
	brightWhite: '#f7f7f8',
};

type Link = 'connecting' | 'connected' | 'closed';

const LINK: Record<Link, { tone: 'warning' | 'success' | 'neutral'; label: string }> = {
	connecting: { tone: 'warning', label: 'Connecting' },
	connected: { tone: 'success', label: 'Connected' },
	closed: { tone: 'neutral', label: 'Disconnected' },
};

function Shell({ sessionId, onConnected, onLink }: { sessionId: string; onConnected: () => void; onLink: (link: Link) => void }) {
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const term = new Terminal({
			cursorBlink: true,
			fontSize: 12,
			lineHeight: 1.5,
			fontFamily: "'Geist Mono Variable', 'Geist Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace",
			theme,
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(el);
		const refit = () => {
			// fit() throws while the renderer has no dimensions (hidden or disposing).
			try {
				fit.fit();
			} catch {}
		};
		refit();
		term.write('Starting the sandbox. A stopped task takes a few seconds to resume…\r\n');

		// Binary frames carry keystrokes and output; text frames carry resizes.
		const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
		const socket = new WebSocket(`${protocol}://${window.location.host}/vm/${sessionId}/pty?cols=${term.cols}&rows=${term.rows}`);
		socket.binaryType = 'arraybuffer';
		const encoder = new TextEncoder();
		let connected = false;
		onLink('connecting');
		const send = (data: string | Uint8Array<ArrayBuffer>) => socket.readyState === WebSocket.OPEN && socket.send(data);
		socket.onmessage = (event) => {
			if (!connected) {
				connected = true;
				term.reset();
				onLink('connected');
				onConnected();
			}
			term.write(new Uint8Array(event.data as ArrayBuffer));
		};
		socket.onerror = () => term.write('\r\nCould not reach the terminal server.\r\n');
		socket.onclose = () => {
			onLink('closed');
			term.write('\r\n[disconnected]\r\n');
		};
		term.onData((data) => send(encoder.encode(data)));
		term.onResize(({ cols, rows }) => send(JSON.stringify({ type: 'resize', cols, rows })));
		const observer = new ResizeObserver(refit);
		observer.observe(el);

		return () => {
			observer.disconnect();
			socket.close();
			term.dispose();
		};
	}, [sessionId, onConnected, onLink]);

	return <div ref={containerRef} className="h-full min-h-0 min-w-0" />;
}

/** Opening the terminal is an explicit request for a sandbox, so it starts one when the task is stopped. */
export function TerminalTab({ sessionId }: { sessionId: string }) {
	const [generation, setGeneration] = useState(0);
	const [link, setLink] = useState<Link>('connecting');
	const health = useQuery({ queryKey: ['health'], queryFn: api.health });
	const session = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.session(sessionId) });
	const onConnected = useRefreshTask(sessionId);

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-2">
			<div className="flex h-7 shrink-0 items-center gap-2.5">
				<Facts items={['Sandbox', session.data?.repo.split('/').pop(), health.data?.providers.sandbox]} className="flex-1" />
				<Status tone={LINK[link].tone} pulse={link === 'connecting'}>
					{LINK[link].label}
				</Status>
				<Btn variant="ghost" size="xs" icon={RotateCw} onClick={() => setGeneration((current) => current + 1)}>
					Restart
				</Btn>
			</div>
			<div className="in-well flex min-h-0 flex-1 flex-col overflow-hidden bg-(--bg-inset)">
				<div aria-hidden className="flex h-8 shrink-0 items-center gap-2 border-b border-(--border-subtle) bg-[linear-gradient(180deg,var(--card-bg-top),var(--card-bg))] px-3">
					<Icon icon={SquareTerminal} size={12} className={link === 'connected' ? 'text-(--accent-text)' : 'text-(--icon-tertiary)'} />
					<span className="in-num min-w-0 flex-1 truncate text-[11px] text-(--text-tertiary)">{session.data ? `${session.data.repo.split('/').pop()} — shell` : 'shell'}</span>
				</div>
				<div className="min-h-0 flex-1 p-3">
					<Shell key={generation} sessionId={sessionId} onConnected={onConnected} onLink={setLink} />
				</div>
			</div>
		</div>
	);
}
