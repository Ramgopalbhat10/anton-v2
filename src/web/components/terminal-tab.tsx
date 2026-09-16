import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';

export function TerminalTab({ sessionId }: { sessionId: string }) {
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const term = new Terminal({
			cursorBlink: true,
			fontSize: 13,
			convertEol: true,
			theme: { background: '#0a0a0a', foreground: '#ececec' },
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(el);
		fit.fit();
		term.write('Connecting to VM…\r\n');

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
		const onResize = () => fit.fit();
		window.addEventListener('resize', onResize);

		return () => {
			window.removeEventListener('resize', onResize);
			socket.close();
			term.dispose();
		};
	}, [sessionId]);

	return <div ref={containerRef} className="h-full min-h-[240px] min-w-0 bg-background" />;
}
