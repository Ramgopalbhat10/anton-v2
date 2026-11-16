import { createHash } from 'node:crypto';
import { lookEnv, writeLook } from './desktop-look.ts';

// Shell only, so it runs the same in every provider's machine.

/** The Modal image has them; an older machine installs them on first use. */
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
	'tint2',
	'pcmanfm',
	'lxterminal',
	// Mousepad warns in red across every window when run as root, as the sandbox does.
	'l3afpad',
	'papirus-icon-theme',
	// Adwaita's dark theme for GTK 2 apps (GTK 3 has it built in).
	'gnome-themes-extra',
	'librsvg2-common',
	'librsvg2-bin',
	'fonts-inter',
];

export const DESKTOP_TOOLS = ['Xvnc', 'websockify', 'openbox', 'xdotool', 'import', 'xdpyinfo', 'xsetroot', 'tint2', 'pcmanfm', 'lxterminal', 'l3afpad', 'rsvg-convert'];

export const SCREEN = { width: 1280, height: 800 } as const;

export type DesktopLayout = {
	display: string;
	/** Reached only from inside the machine. */
	vncPort: number;
	socketPort: number;
	files: string;
	home: string;
	root: string;
};

/** Named by the machine, as local machines share this computer's displays and ports. */
export function desktopLayout(root: string): DesktopLayout {
	const n = 10 + (createHash('sha256').update(root).digest().readUInt32BE(0) % 400);
	return { display: `:${n}`, vncPort: 5900 + n, socketPort: 6000 + n, files: `/tmp/anton-desktop-${n}`, home: `/tmp/anton-desktop-${n}.d`, root };
}

/** The desktop's processes must outlive the command that started them: Anton stops a command's processes by the tag in their environment. */
const detach = (command: string, log: string) => `env -u ANTON_EXEC setsid nohup ${command} > ${log} 2>&1 < /dev/null &`;

/** Installs what is missing when it can (root with apt), else exits 3 saying what is needed. */
export const ENSURE_DESKTOP = `
need=""
for tool in ${DESKTOP_TOOLS.join(' ')}; do command -v $tool >/dev/null || need=1; done
[ -z "$need" ] && exit 0
if [ "$(id -u)" = 0 ] && command -v apt-get >/dev/null; then
	(apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${DESKTOP_PACKAGES.join(' ')}) > /tmp/anton-desktop-install.log 2>&1 && exit 0
	tail -n 20 /tmp/anton-desktop-install.log >&2
fi
echo "The computer needs ${DESKTOP_PACKAGES.join(', ')} in the sandbox." >&2
exit 3
`;

export const desktopEnv = (layout: DesktopLayout) => `DISPLAY=${layout.display} ${lookEnv(layout)}`;

export const desktopRunning = ({ display, socketPort }: DesktopLayout) =>
	`DISPLAY=${display} xdpyinfo >/dev/null 2>&1 && (exec 3<>/dev/tcp/127.0.0.1/${socketPort}) 2>/dev/null`;

export function stopDesktop({ display, files }: DesktopLayout): string {
	return `
for name in socket panel icons wm x; do [ -f ${files}-$name.pid ] && kill "$(cat ${files}-$name.pid)" 2>/dev/null; rm -f ${files}-$name.pid; done
for i in $(seq 1 50); do DISPLAY=${display} xdpyinfo >/dev/null 2>&1 || exit 0; sleep 0.1; done
`;
}

/** The socket listens on ANTON_SCREEN_BIND when set (a local machine), else on every address, where only the provider's authenticated way in reaches it. */
export function startDesktop(layout: DesktopLayout): string {
	const { display, vncPort, socketPort, files, root } = layout;
	const n = display.slice(1);
	const { width, height } = SCREEN;
	const env = desktopEnv(layout);
	return `
${desktopRunning(layout)} && exit 0
for name in x wm panel icons socket; do [ -f ${files}-$name.pid ] && kill "$(cat ${files}-$name.pid)" 2>/dev/null; done
rm -f /tmp/.X${n}-lock /tmp/.X11-unix/X${n}
${writeLook(layout, SCREEN)}
cd '${root}' 2>/dev/null || cd /
${detach(`Xvnc ${display} -geometry ${width}x${height} -depth 24 -SecurityTypes None -localhost -rfbport ${vncPort} -AlwaysShared -AcceptSetDesktopSize=0`, `${files}-x.log`)}
echo $! > ${files}-x.pid
for i in $(seq 1 100); do DISPLAY=${display} xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done
DISPLAY=${display} xdpyinfo >/dev/null 2>&1 || { tail -n 20 ${files}-x.log >&2; exit 1; }
DISPLAY=${display} xsetroot -solid '#0A0A0B' 2>/dev/null
${env} ${detach('openbox', `${files}-wm.log`)}
echo $! > ${files}-wm.pid
${env} ${detach('pcmanfm --desktop --profile anton', `${files}-icons.log`)}
echo $! > ${files}-icons.pid
${env} ${detach('tint2', `${files}-panel.log`)}
echo $! > ${files}-panel.pid
${detach(`websockify "\${ANTON_SCREEN_BIND:-0.0.0.0}:${socketPort}" 127.0.0.1:${vncPort}`, `${files}-socket.log`)}
echo $! > ${files}-socket.pid
for i in $(seq 1 100); do (exec 3<>/dev/tcp/127.0.0.1/${socketPort}) 2>/dev/null && exit 0; sleep 0.1; done
tail -n 20 ${files}-socket.log >&2
exit 1
`;
}
