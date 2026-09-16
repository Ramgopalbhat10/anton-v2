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
			theme: { background: '#0a0a0a', foreground: '#ececec' },
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(el);
		fit.fit();

		const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
		const socket = new WebSocket(`${protocol}://${window.location.host}/api/vm/${sessionId}/pty`);
		socket.onmessage = (event) => {
			term.write(typeof event.data === 'string' ? event.data : '');
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

	return <div ref={containerRef} className="h-full min-h-0 bg-background" />;
}
