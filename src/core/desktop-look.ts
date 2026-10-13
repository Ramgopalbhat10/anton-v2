import { createHash } from 'node:crypto';

/*
 * What makes the desktop look like a computer's: a wallpaper, a taskbar
 * (tint2) with launchers, a clock and the open windows, icons on the desktop
 * (PCManFM), a dark window theme for Openbox, and dark GTK apps with Papirus
 * icons. All of it lives in the desktop's own folder and reaches its programs
 * through XDG_* variables, so a local machine never touches this computer's
 * own settings.
 */

/** Where one desktop keeps its settings, programs and wallpaper. */
export type LookPaths = {
	/** The desktop's folder. */
	home: string;
	/** The task's folder, where the terminal and file manager open. */
	root: string;
};

/**
 * The variables the desktop's programs run with, so they find its settings and
 * theme. GTK_THEME makes GTK 3's apps dark (settings.ini's dark preference
 * alone leaves them light), and GTK2_RC_FILES does the same for GTK 2's, as
 * Debian's PCManFM is. Caches stay where they are: Playwright finds its
 * browsers in the usual one. SHELL is what the terminal runs, which leaves the
 * desktop's settings out of the shell.
 */
export const lookEnv = ({ home }: LookPaths) =>
	`XDG_CONFIG_HOME=${home}/config XDG_DATA_HOME=${home}/data GTK_THEME=Adwaita:dark GTK2_RC_FILES=${home}/gtkrc-2.0 NO_AT_BRIDGE=1 SHELL=${home}/bin/anton-shell`;

/*
 * The wallpaper is Anton's own drawing: its cube mark, lit in Signal Cyan on a
 * floor of grid, wired to the machines it runs, one of them at work, as the
 * app's illustrations draw them. Isometric, at 1280×800, rendered in the
 * machine with rsvg-convert to the screen's size.
 */
const ISO_ORIGIN = { x: 790, y: 360 };
const COS30 = Math.cos(Math.PI / 6);

/** A point on or above the floor: along the floor's two axes, and its height. */
type Iso = [u: number, v: number, z: number];
const iso = ([u, v, z]: Iso) => [ISO_ORIGIN.x + (u - v) * COS30, ISO_ORIGIN.y + (u + v) * 0.5 - z] as const;
const isoPoints = (points: Iso[]) => points.map((point) => iso(point).map((n) => n.toFixed(1)).join(',')).join(' ');

/** A block standing on the floor, its three faces filled and its outline and near edges drawn, as the mark's are. */
function block(u: number, v: number, size: number, h: number, faces: { top: string; left: string; right: string }, edge: string, edgeWidth = 1): string {
	const [u1, v1] = [u + size, v + size];
	return [
		`<polygon points="${isoPoints([[u, v1, h], [u1, v1, h], [u1, v1, 0], [u, v1, 0]])}" fill="${faces.left}"/>`,
		`<polygon points="${isoPoints([[u1, v, h], [u1, v1, h], [u1, v1, 0], [u1, v, 0]])}" fill="${faces.right}"/>`,
		`<polygon points="${isoPoints([[u, v, h], [u1, v, h], [u1, v1, h], [u, v1, h]])}" fill="${faces.top}"/>`,
		`<g fill="none" stroke="${edge}" stroke-width="${edgeWidth}" stroke-linejoin="round">`,
		`<polygon points="${isoPoints([[u, v, h], [u1, v, h], [u1, v, 0], [u1, v1, 0], [u, v1, 0], [u, v1, h]])}"/>`,
		`<polyline points="${isoPoints([[u, v1, h], [u1, v1, h], [u1, v, h]])}"/>`,
		`<polyline points="${isoPoints([[u1, v1, h], [u1, v1, 0]])}"/>`,
		'</g>',
	].join('');
}

/** A machine the mark runs: a dark block with bars and a light on top, lit when at work. */
function machine(u: number, v: number, lit: boolean): string {
	const [size, h] = [80, 36];
	const [x, y] = iso([u + size - 14, v + 14, h]).map((n) => n.toFixed(1));
	const bars = [40, 28, 50].map(
		(length, i) =>
			`<polyline points="${isoPoints([[u + 12, v + 24 + i * 14, h], [u + 12 + length, v + 24 + i * 14, h]])}" fill="none" stroke="${lit && i === 0 ? '#3FB6D8' : 'rgba(255,255,255,0.18)'}" stroke-width="3" stroke-linecap="round"/>`,
	);
	return (
		block(u, v, size, h, { top: '#1C1C21', left: '#16161A', right: '#101012' }, lit ? 'rgba(111,205,232,0.7)' : 'rgba(255,255,255,0.14)') +
		bars.join('') +
		`<circle cx="${x}" cy="${y}" r="3.2" fill="${lit ? '#6FCDE8' : '#3A3A43'}"/>` +
		(lit ? `<circle cx="${x}" cy="${y}" r="9" fill="#3FB6D8" fill-opacity="0.35" filter="url(#soft)"/>` : '')
	);
}

/** A wire across the floor, square to the grid: solid cyan when it carries work, dashed when idle. */
const wire = (points: Iso[], lit: boolean) =>
	`<polyline points="${isoPoints(points)}" fill="none" stroke="${lit ? '#3FB6D8' : 'rgba(255,255,255,0.16)'}" stroke-width="${lit ? 2 : 1.5}"${lit ? '' : ' stroke-dasharray="4 6"'} stroke-linejoin="round"/>`;

function floor(): string {
	const lines: string[] = [];
	for (let n = -1400; n <= 1400; n += 40) lines.push(`<polyline points="${isoPoints([[n, -1400, 0], [n, 1400, 0]])}"/>`, `<polyline points="${isoPoints([[-1400, n, 0], [1400, n, 0]])}"/>`);
	return lines.join('');
}

export const WALLPAPER = (() => {
	const [width, height] = [1280, 800];
	const [glowX, glowY] = iso([0, 0, 0]);
	const [pulseX, pulseY] = iso([180, 50, 0]).map((n) => n.toFixed(1));
	const centre = (ISO_ORIGIN.x / width).toFixed(3);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs>
<radialGradient id="bg" cx="${centre}" cy="0.42" r="0.85"><stop offset="0" stop-color="#0F1C22"/><stop offset="0.55" stop-color="#0B0E11"/><stop offset="1" stop-color="#0A0A0B"/></radialGradient>
<radialGradient id="fade" cx="${centre}" cy="0.5" r="0.62"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<mask id="near"><rect width="${width}" height="${height}" fill="url(#fade)"/></mask>
<linearGradient id="top" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9EE1F3"/><stop offset="1" stop-color="#3FB6D8"/></linearGradient>
<linearGradient id="left" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2C9BBD"/><stop offset="1" stop-color="#17627A"/></linearGradient>
<linearGradient id="right" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#17627A"/><stop offset="1" stop-color="#0D3644"/></linearGradient>
<filter id="glow" filterUnits="userSpaceOnUse" x="-400" y="-400" width="2080" height="1600"><feGaussianBlur stdDeviation="70"/></filter>
<filter id="soft" filterUnits="userSpaceOnUse" x="-400" y="-400" width="2080" height="1600"><feGaussianBlur stdDeviation="6"/></filter>
<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.035 0"/></filter>
</defs>
<rect width="${width}" height="${height}" fill="url(#bg)"/>
<g mask="url(#near)" fill="none" stroke="#3FB6D8" stroke-opacity="0.11">${floor()}</g>
<ellipse cx="${glowX}" cy="${glowY + 40}" rx="330" ry="170" fill="#3FB6D8" fill-opacity="0.28" filter="url(#glow)"/>
${wire([[118, -40, 0], [180, -40, 0], [180, -190, 0], [220, -190, 0]], false)}
${wire([[118, 50, 0], [250, 50, 0]], true)}
${wire([[-40, 118, 0], [-40, 270, 0], [-170, 270, 0]], false)}
${wire([[50, 118, 0], [50, 260, 0]], false)}
${wire([[118, 118, 0], [250, 250, 0]], false)}
<circle cx="${pulseX}" cy="${pulseY}" r="4" fill="#CBEEF8"/>
<circle cx="${pulseX}" cy="${pulseY}" r="12" fill="#3FB6D8" fill-opacity="0.5" filter="url(#soft)"/>
${machine(220, -230, false)}
${machine(250, 10, true)}
${machine(-250, 230, false)}
${machine(10, 260, false)}
${machine(250, 230, false)}
${block(-118, -118, 236, 10, { top: '#121418', left: '#0D0F12', right: '#0A0B0D' }, 'rgba(111,205,232,0.45)')}
${block(-80, -80, 160, 160, { top: 'url(#top)', left: 'url(#left)', right: 'url(#right)' }, '#CBEEF8', 2)}
<text x="${width - 36}" y="${height - 66}" text-anchor="end" font-family="Inter" font-weight="600" font-size="15" letter-spacing="5" fill="#EDEDEF" fill-opacity="0.32">ANTON</text>
<rect width="${width}" height="${height}" filter="url(#grain)"/>
</svg>`;
})();

/** The rendered wallpaper's name changes with the drawing, so a machine that rendered an older one renders the new one. */
const WALLPAPER_PNG = `wallpaper-${createHash('sha256').update(WALLPAPER).digest('hex').slice(0, 10)}.png`;

/** The programs on the taskbar, the desktop and the right-click menu. */
const APPS = [
	{ id: 'terminal', name: 'Terminal', icon: 'utilities-terminal', exec: 'lxterminal' },
	{ id: 'browser', name: 'Web Browser', icon: 'chromium', exec: 'BROWSER' },
	{ id: 'files', name: 'Files', icon: 'system-file-manager', exec: 'pcmanfm ROOT' },
	{ id: 'editor', name: 'Text Editor', icon: 'accessories-text-editor', exec: 'l3afpad' },
] as const;

/** The script that opens the sandbox's Chromium on the desktop: the one the browser tool installs, else one in the machine. */
export const browserCommand = ({ home }: LookPaths) => `${home}/bin/anton-browser`;

const browserScript = ({ home }: LookPaths) => `#!/bin/sh
b=$(NODE_PATH="$(npm root -g 2>/dev/null)" node -e "process.stdout.write(require('playwright').chromium.executablePath())" 2>/dev/null)
[ -x "$b" ] || b=$(command -v chromium || command -v chromium-browser || command -v google-chrome)
[ -n "$b" ] || { echo 'No browser in the sandbox' >&2; exit 3; }
# Its own profile, apart from the browser tool's; --test-type and no Google keys keep infobars off the page.
exec env GOOGLE_API_KEY=no GOOGLE_DEFAULT_CLIENT_ID=no GOOGLE_DEFAULT_CLIENT_SECRET=no "$b" --no-sandbox --test-type --no-first-run --no-default-browser-check --start-maximized --user-data-dir=${home}/browser "$@"
`;

/** The terminal's shell: the machine's own settings, not the desktop's, for the programs run in it (git, npm and the rest). */
const SHELL_SCRIPT = `#!/bin/sh
unset XDG_CONFIG_HOME XDG_DATA_HOME
SHELL=$(command -v bash || echo /bin/sh)
export SHELL
exec "$SHELL" "$@"
`;

const execOf = (exec: string, paths: LookPaths) => exec.replace('BROWSER', browserCommand(paths)).replace('ROOT', paths.root);

const desktopEntry = (app: (typeof APPS)[number], paths: LookPaths) => `[Desktop Entry]
Type=Application
Name=${app.name}
Exec=${execOf(app.exec, paths)}
Icon=${app.icon}
Terminal=false
`;

/** Openbox's window theme: dark, flat title bars. */
const THEMERC = `border.width: 1
padding.width: 8
padding.height: 5
window.handle.width: 0
window.client.padding.width: 0
window.client.padding.height: 0
window.active.border.color: #2C2C34
window.inactive.border.color: #1C1C21
window.active.title.separator.color: #2C2C34
window.inactive.title.separator.color: #1C1C21
window.active.title.bg: flat solid
window.active.title.bg.color: #16161A
window.inactive.title.bg: flat solid
window.inactive.title.bg.color: #101012
window.*.label.bg: parentrelative
window.active.label.text.color: #EDEDEF
window.inactive.label.text.color: #6E6E78
window.label.text.justify: center
window.*.button.*.bg: parentrelative
window.active.button.*.image.color: #C8C8CE
window.active.button.hover.bg: flat solid
window.active.button.hover.bg.color: #2C2C34
window.active.button.hover.image.color: #ffffff
window.active.button.pressed.bg: flat solid
window.active.button.pressed.bg.color: #3A3A43
window.active.button.disabled.image.color: #4A4A52
window.inactive.button.*.image.color: #4A4A52
menu.border.width: 1
menu.border.color: #2C2C34
menu.items.bg: flat solid
menu.items.bg.color: #16161A
menu.items.text.color: #EDEDEF
menu.items.disabled.text.color: #4A4A52
menu.items.active.bg: flat solid
menu.items.active.bg.color: #3FB6D8
menu.items.active.text.color: #06181F
menu.title.bg: flat solid
menu.title.bg.color: #101012
menu.title.text.color: #A0A0A8
menu.title.text.justify: center
menu.separator.color: #2C2C34
osd.border.width: 1
osd.border.color: #2C2C34
osd.bg: flat solid
osd.bg.color: #16161A
osd.label.text.color: #EDEDEF
osd.hilight.bg: flat solid
osd.hilight.bg.color: #3FB6D8
osd.unhilight.bg: flat solid
osd.unhilight.bg.color: #2C2C34
`;

const menu = (paths: LookPaths) => `<?xml version="1.0" encoding="UTF-8"?>
<openbox_menu xmlns="http://openbox.org/3.4/menu">
<menu id="root-menu" label="Computer">
${APPS.map((app) => `<item label="${app.name}"><action name="Execute"><command>${execOf(app.exec, paths)}</command></action></item>`).join('\n')}
</menu>
</openbox_menu>
`;

/** The taskbar along the bottom: launchers, the open windows, the date and time. */
const tint2rc = (paths: LookPaths) => `# 1: the bar
rounded = 0
border_width = 1
border_sides = T
border_color = #ffffff 10
background_color = #0A0A0B 92
# 2: a window
rounded = 6
border_width = 0
background_color = #ffffff 0
background_color_hover = #ffffff 8
# 3: the focused window
rounded = 6
border_width = 0
background_color = #ffffff 14
background_color_hover = #ffffff 18
# 4: a launcher
rounded = 8
border_width = 0
background_color = #ffffff 0
background_color_hover = #ffffff 14

panel_items = LTC
panel_size = 100% 44
panel_margin = 0 0
panel_padding = 10 6 12
panel_background_id = 1
panel_position = bottom center horizontal
panel_layer = top
wm_menu = 1
strut_policy = follow_size
mouse_effects = 1

launcher_padding = 2 4 6
launcher_background_id = 0
launcher_icon_background_id = 4
launcher_icon_size = 28
launcher_icon_theme = Papirus-Dark
${APPS.map((app) => `launcher_item_app = ${paths.home}/data/applications/anton-${app.id}.desktop`).join('\n')}

taskbar_mode = single_desktop
taskbar_padding = 10 0 6
taskbar_background_id = 0
taskbar_name = 0
task_text = 1
task_icon = 1
task_centered = 0
task_maximum_size = 220 32
task_padding = 8 4 8
task_font = Inter 9
task_font_color = #C8C8CE 100
task_active_font_color = #ffffff 100
task_background_id = 2
task_active_background_id = 3
mouse_left = toggle_iconify
mouse_middle = close

time1_format = %H:%M
time1_font = Inter Bold 10
time2_format = %a %d %b
time2_font = Inter 8
clock_font_color = #EDEDEF 100
clock_padding = 8 0
clock_background_id = 0
`;

const DESKTOP_ITEMS = (paths: LookPaths) => `[*]
wallpaper_mode=crop
wallpaper_common=1
wallpaper=${paths.home}/${WALLPAPER_PNG}
desktop_bg=#0A0A0B
desktop_fg=#ffffff
desktop_shadow=#000000
desktop_font=Inter 10
show_wm_menu=1
show_documents=0
show_trash=0
show_mounts=0
`;

const LIBFM = `[config]
single_click=0
quick_exec=1
[ui]
big_icon_size=48
`;

const GTK = `[Settings]
gtk-application-prefer-dark-theme=1
gtk-icon-theme-name=Papirus-Dark
gtk-font-name=Inter 10
`;

const GTK2 = `gtk-theme-name="Adwaita-dark"
gtk-icon-theme-name="Papirus-Dark"
gtk-font-name="Inter 10"
`;

/** The terminal: dark, with colours that read on it (the default blue is too dark to). */
const LXTERMINAL = `[general]
fontname=DejaVu Sans Mono 11
bgcolor=rgb(16,16,18)
fgcolor=rgb(220,225,235)
hidescrollbar=true
hidemenubar=true
geometry_columns=100
geometry_rows=30
cursorblinks=true
color_preset=Custom
palette_color_0=rgb(35,35,42)
palette_color_1=rgb(247,118,142)
palette_color_2=rgb(158,206,106)
palette_color_3=rgb(224,175,104)
palette_color_4=rgb(122,162,247)
palette_color_5=rgb(187,154,247)
palette_color_6=rgb(125,207,255)
palette_color_7=rgb(192,202,245)
palette_color_8=rgb(65,72,104)
palette_color_9=rgb(255,143,163)
palette_color_10=rgb(185,242,124)
palette_color_11=rgb(255,199,119)
palette_color_12=rgb(137,180,250)
palette_color_13=rgb(199,169,255)
palette_color_14=rgb(164,227,255)
palette_color_15=rgb(230,233,242)
`;

/** Writes the desktop's settings and renders its wallpaper: shell, run before its programs start. */
export function writeLook(paths: LookPaths, screen: { width: number; height: number }): string {
	const { home } = paths;
	const files: Array<[string, string]> = [
		[`${home}/data/themes/Anton/openbox-3/themerc`, THEMERC],
		[`${home}/config/openbox/menu.xml`, menu(paths)],
		[`${home}/config/tint2/tint2rc`, tint2rc(paths)],
		[`${home}/config/pcmanfm/anton/desktop-items-0.conf`, DESKTOP_ITEMS(paths)],
		[`${home}/config/libfm/libfm.conf`, LIBFM],
		[`${home}/config/gtk-3.0/settings.ini`, GTK],
		[`${home}/gtkrc-2.0`, GTK2],
		[`${home}/config/lxterminal/lxterminal.conf`, LXTERMINAL],
		[`${home}/config/user-dirs.dirs`, `XDG_DESKTOP_DIR="${home}/Desktop"\n`],
		[`${home}/bin/anton-browser`, browserScript(paths)],
		[`${home}/bin/anton-shell`, SHELL_SCRIPT],
		[`${home}/wallpaper.svg`, WALLPAPER],
		...APPS.flatMap((app): Array<[string, string]> => [
			[`${home}/data/applications/anton-${app.id}.desktop`, desktopEntry(app, paths)],
			[`${home}/Desktop/${app.name}.desktop`, desktopEntry(app, paths)],
		]),
	];
	const folders = [...new Set(files.map(([file]) => file.slice(0, file.lastIndexOf('/'))))];
	return [
		`mkdir -p ${folders.join(' ')}`,
		...files.map(([file, content]) => `cat > '${file}' <<'ANTON_EOF'\n${content}${content.endsWith('\n') ? '' : '\n'}ANTON_EOF`),
		`chmod +x ${home}/bin/* ${home}/Desktop/*.desktop`,
		// The task's folder on the desktop too, as a folder to open.
		`ln -sfn '${paths.root}' '${home}/Desktop/Workspace'`,
		// Openbox's own settings, with the theme above, its fonts, and one desktop.
		`sed -e 's|<name>Clearlooks</name>|<name>Anton</name>|' -e 's|<name>sans</name>|<name>Inter</name>|g' -e 's|<size>[0-9]*</size>|<size>10</size>|g' -e 's|<number>4</number>|<number>1</number>|' /etc/xdg/openbox/rc.xml > ${home}/config/openbox/rc.xml`,
		`[ -s ${home}/${WALLPAPER_PNG} ] || rsvg-convert -w ${screen.width} -h ${screen.height} ${home}/wallpaper.svg -o ${home}/${WALLPAPER_PNG}`,
	].join('\n');
}
