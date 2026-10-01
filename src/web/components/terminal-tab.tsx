import { useQuery } from '@tanstack/react-query';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { RotateCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Btn } from '@/components/signal';
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

function Shell({ sessionId }: { sessionId: string }) {
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const term = new Terminal({
			cursorBlink: true,
			fontSize: 12,
			lineHeight: 1.5,
			fontFamily: "'Geist Mono Variable', 'Geist Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace",
			convertEol: true,
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
		term.write('Connecting to the sandbox…\r\n');

		const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
		const socket = new WebSocket(`${protocol}://${window.location.host}/vm/${sessionId}/pty`);
		socket.binaryType = 'arraybuffer';
		socket.onopen = () => {
			term.write('Connected.\r\n');
		};
		socket.onerror = () => {
			term.write('WebSocket error. Is the UI dev server running?\r\n');
		};
		socket.onclose = () => {
			term.write('\r\n[disconnected]\r\n');
		};
		socket.onmessage = (event) => {
			if (typeof event.data === 'string') {
				term.write(event.data);
				return;
			}
			term.write(new Uint8Array(event.data as ArrayBuffer));
		};
		term.onData((data) => {
			if (socket.readyState === WebSocket.OPEN) socket.send(data);
		});
		const observer = new ResizeObserver(refit);
		observer.observe(el);

		return () => {
			observer.disconnect();
			socket.close();
			term.dispose();
		};
	}, [sessionId]);

	return <div ref={containerRef} className="h-full min-h-0 min-w-0" />;
}

export function TerminalTab({ sessionId }: { sessionId: string }) {
	const [generation, setGeneration] = useState(0);
	const files = useQuery({ queryKey: ['files', sessionId], queryFn: () => api.files(sessionId) });
	const cwd = files.data?.cwd.split('/').pop();

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-2">
			<div className="flex h-7 shrink-0 items-center gap-2 text-[11px] tracking-[0.04em] text-(--text-disabled)">
				<span className="truncate uppercase">Sandbox{cwd ? ` · ${cwd}` : ''} · Local shell</span>
				<div className="flex-1" />
				<Btn variant="ghost" size="xs" icon={RotateCw} onClick={() => setGeneration((current) => current + 1)}>
					Restart
				</Btn>
			</div>
			<div className="min-h-0 flex-1 overflow-hidden rounded-lg bg-(--bg-inset) p-3">
				<Shell key={generation} sessionId={sessionId} />
			</div>
		</div>
	);
}
