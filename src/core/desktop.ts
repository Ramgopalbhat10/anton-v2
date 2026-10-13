import { createHash } from 'node:crypto';

/*
 * The desktop inside a task's machine, for the Computer panel and the agent's
 * computer subagent: TigerVNC's Xvnc (an X server and VNC server in one
 * process), Openbox for windows, websockify so a browser can reach the VNC
 * server, xdotool for input and ImageMagick for screenshots. Shell only, so it
 * runs the same in every provider's machine.
 */

/** Debian packages the desktop needs; the Modal image has them, and an older machine installs them on first use. */
export const DESKTOP_PACKAGES = [
	'tigervnc-standalone-server',
	'websockify',
	'openbox',
	'xdotool',
	'imagemagick',
	'x11-utils',
	'x11-xserver-utils',
	'xterm',
	'fonts-dejavu-core',
];

/** The screen, the Browser panel's viewport: what you see in the panel and what the agent's screenshots show. */
export const SCREEN = { width: 1280, height: 800 } as const;

/** Where one machine's desktop lives. */
export type DesktopLayout = {
	/** The X display, such as `:42`. */
	display: string;
	/** The VNC server's port, reached only from inside the machine. */
	vncPort: number;
	/** The WebSocket port the panel connects to. */
	socketPort: number;
	/** Prefix of its log and pid files. */
	files: string;
};

/**
 * Named by the machine, as local machines share this computer's displays and
 * ports; every Modal machine has the same root and so the same numbers, alone
 * in its own sandbox.
 */
export function desktopLayout(root: string): DesktopLayout {
	const n = 10 + (createHash('sha256').update(root).digest().readUInt32BE(0) % 400);
	return { display: `:${n}`, vncPort: 5900 + n, socketPort: 6000 + n, files: `/tmp/anton-desktop-${n}` };
}

/**
 * Processes the desktop starts must outlive the command that started them:
 * not stopped with it (Anton stops a command's processes by the tag in their
 * environment), and in their own session.
 */
const detach = (command: string, log: string) => `env -u ANTON_EXEC setsid nohup ${command} > ${log} 2>&1 < /dev/null &`;

/** Installs what is missing when it can (root with apt), else exits 3 saying what is needed. */
export const ENSURE_DESKTOP = `
need=""
for tool in Xvnc websockify openbox xdotool import xdpyinfo xsetroot; do command -v $tool >/dev/null || need=1; done
[ -z "$need" ] && exit 0
if [ "$(id -u)" = 0 ] && command -v apt-get >/dev/null; then
	(apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${DESKTOP_PACKAGES.join(' ')}) > /tmp/anton-desktop-install.log 2>&1 && exit 0
	tail -n 20 /tmp/anton-desktop-install.log >&2
fi
echo "The computer needs ${DESKTOP_PACKAGES.join(', ')} in the sandbox." >&2
exit 3
`;

/** Whether the display answers and the socket is up: one command, no side effects. */
export const desktopRunning = ({ display, socketPort }: DesktopLayout) =>
	`DISPLAY=${display} xdpyinfo >/dev/null 2>&1 && (exec 3<>/dev/tcp/127.0.0.1/${socketPort}) 2>/dev/null`;

/**
 * Starts the desktop unless it runs: the display, the window manager and the
 * socket, each waited for. The socket listens on ANTON_SCREEN_BIND when the
 * machine sets one (a local machine, on this computer alone), else on every
 * address, where only the provider's authenticated way in reaches it.
 */
export function startDesktop(layout: DesktopLayout): string {
	const { display, vncPort, socketPort, files } = layout;
	const n = display.slice(1);
	const { width, height } = SCREEN;
	return `
${desktopRunning(layout)} && exit 0
for name in x wm socket; do [ -f ${files}-$name.pid ] && kill "$(cat ${files}-$name.pid)" 2>/dev/null; done
rm -f /tmp/.X${n}-lock /tmp/.X11-unix/X${n}
${detach(`Xvnc ${display} -geometry ${width}x${height} -depth 24 -SecurityTypes None -localhost -rfbport ${vncPort} -AlwaysShared -AcceptSetDesktopSize=0`, `${files}-x.log`)}
echo $! > ${files}-x.pid
for i in $(seq 1 100); do DISPLAY=${display} xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done
DISPLAY=${display} xdpyinfo >/dev/null 2>&1 || { tail -n 20 ${files}-x.log >&2; exit 1; }
DISPLAY=${display} xsetroot -solid '#202124' 2>/dev/null
DISPLAY=${display} ${detach('openbox', `${files}-wm.log`)}
echo $! > ${files}-wm.pid
${detach(`websockify "\${ANTON_SCREEN_BIND:-0.0.0.0}:${socketPort}" 127.0.0.1:${vncPort}`, `${files}-socket.log`)}
echo $! > ${files}-socket.pid
for i in $(seq 1 100); do (exec 3<>/dev/tcp/127.0.0.1/${socketPort}) 2>/dev/null && exit 0; sleep 0.1; done
tail -n 20 ${files}-socket.log >&2
exit 1
`;
}
