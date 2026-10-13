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
 * Debian's PCManFM is.
 */
export const lookEnv = ({ home }: LookPaths) =>
	`XDG_CONFIG_HOME=${home}/config XDG_DATA_HOME=${home}/data XDG_CACHE_HOME=${home}/cache GTK_THEME=Adwaita:dark GTK2_RC_FILES=${home}/gtkrc-2.0 NO_AT_BRIDGE=1`;

/** A small seeded random, so the stars sit in the same places on every machine. */
function seeded(seed: number) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function stars(): string {
	const random = seeded(7);
	return Array.from({ length: 90 }, () => {
		const x = Math.round(random() * 1280);
		const y = Math.round(random() * 430);
		const r = [0.6, 0.8, 1, 1.2, 1.6][Math.floor(random() * 5)];
		const opacity = [0.35, 0.5, 0.7, 0.9][Math.floor(random() * 4)];
		return `<circle cx="${x}" cy="${y}" r="${r}" fill-opacity="${opacity}"/>`;
	}).join('');
}

/** An aurora over mountains at night, drawn as SVG at 1280×800 and rendered in the machine with rsvg-convert to the screen's size. */
export const WALLPAPER = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#04060f"/><stop offset="0.6" stop-color="#0b1233"/><stop offset="1" stop-color="#1a1240"/></linearGradient>
<filter id="glow" filterUnits="userSpaceOnUse" x="-400" y="-400" width="2080" height="1600"><feGaussianBlur stdDeviation="60"/></filter>
<filter id="ribbon" filterUnits="userSpaceOnUse" x="-400" y="-400" width="2080" height="1600"><feGaussianBlur stdDeviation="14"/></filter>
<filter id="haze" filterUnits="userSpaceOnUse" x="-400" y="-400" width="2080" height="1600"><feGaussianBlur stdDeviation="4"/></filter>
<linearGradient id="aurora" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2dd4bf"/><stop offset="0.5" stop-color="#818cf8"/><stop offset="1" stop-color="#e879f9"/></linearGradient>
<linearGradient id="far" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e1b4b"/><stop offset="1" stop-color="#0f0d2e"/></linearGradient>
<linearGradient id="near" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0c0a24"/><stop offset="1" stop-color="#05040f"/></linearGradient>
<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.04 0"/></filter>
</defs>
<rect width="1280" height="800" fill="url(#sky)"/>
<g fill="#ffffff">${stars()}</g>
<g filter="url(#glow)">
<ellipse cx="640" cy="330" rx="560" ry="120" fill="#4f46e5" fill-opacity="0.45" transform="rotate(-10 640 330)"/>
<ellipse cx="330" cy="420" rx="300" ry="90" fill="#14b8a6" fill-opacity="0.45" transform="rotate(-14 330 420)"/>
<ellipse cx="1000" cy="230" rx="300" ry="90" fill="#c026d3" fill-opacity="0.35" transform="rotate(-8 1000 230)"/>
</g>
<g fill="none" stroke="url(#aurora)" stroke-linecap="round">
<path filter="url(#ribbon)" d="M -60 470 C 200 380, 420 430, 640 330 S 1060 170, 1340 150" stroke-width="40" stroke-opacity="0.55"/>
<path filter="url(#haze)" d="M -60 470 C 200 380, 420 430, 640 330 S 1060 170, 1340 150" stroke-width="3" stroke-opacity="0.8"/>
<path filter="url(#ribbon)" d="M -60 520 C 240 430, 470 480, 700 380 S 1100 250, 1340 240" stroke-width="22" stroke-opacity="0.35"/>
</g>
<path d="M0 800 L0 565 L70 535 L130 552 L210 472 L262 506 L320 488 L400 545 L470 515 L545 452 L602 500 L652 488 L722 543 L800 502 L862 428 L930 492 L992 470 L1062 528 L1132 482 L1202 512 L1280 474 L1280 800 Z" fill="url(#far)"/>
<path d="M0 800 L0 650 Q 120 606 240 644 T 480 636 T 720 656 T 960 622 T 1200 652 T 1440 634 L1280 800 Z" fill="url(#near)"/>
<rect width="1280" height="800" filter="url(#grain)"/>
</svg>`;

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
window.active.border.color: #2b3245
window.inactive.border.color: #1a1e2b
window.active.title.separator.color: #2b3245
window.inactive.title.separator.color: #1a1e2b
window.active.title.bg: flat solid
window.active.title.bg.color: #161a26
window.inactive.title.bg: flat solid
window.inactive.title.bg.color: #10131c
window.*.label.bg: parentrelative
window.active.label.text.color: #e6e9f2
window.inactive.label.text.color: #7c8499
window.label.text.justify: center
window.*.button.*.bg: parentrelative
window.active.button.*.image.color: #c3c9d9
window.active.button.hover.bg: flat solid
window.active.button.hover.bg.color: #2b3245
window.active.button.hover.image.color: #ffffff
window.active.button.pressed.bg: flat solid
window.active.button.pressed.bg.color: #3b4460
window.active.button.disabled.image.color: #4a5166
window.inactive.button.*.image.color: #5c6378
menu.border.width: 1
menu.border.color: #2b3245
menu.items.bg: flat solid
menu.items.bg.color: #161a26
menu.items.text.color: #e6e9f2
menu.items.disabled.text.color: #5c6378
menu.items.active.bg: flat solid
menu.items.active.bg.color: #6d5df6
menu.items.active.text.color: #ffffff
menu.title.bg: flat solid
menu.title.bg.color: #10131c
menu.title.text.color: #9aa3b8
menu.title.text.justify: center
menu.separator.color: #2b3245
osd.border.width: 1
osd.border.color: #2b3245
osd.bg: flat solid
osd.bg.color: #161a26
osd.label.text.color: #e6e9f2
osd.hilight.bg: flat solid
osd.hilight.bg.color: #6d5df6
osd.unhilight.bg: flat solid
osd.unhilight.bg.color: #2b3245
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
background_color = #0b0f1c 92
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
task_font_color = #c3c9d9 100
task_active_font_color = #ffffff 100
task_background_id = 2
task_active_background_id = 3
mouse_left = toggle_iconify
mouse_middle = close

time1_format = %H:%M
time1_font = Inter Bold 10
time2_format = %a %d %b
time2_font = Inter 8
clock_font_color = #e6e9f2 100
clock_padding = 8 0
clock_background_id = 0
`;

const DESKTOP_ITEMS = (paths: LookPaths) => `[*]
wallpaper_mode=crop
wallpaper_common=1
wallpaper=${paths.home}/wallpaper.png
desktop_bg=#04060f
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
bgcolor=rgb(13,17,30)
fgcolor=rgb(220,225,235)
hidescrollbar=true
hidemenubar=true
geometry_columns=100
geometry_rows=30
cursorblinks=true
color_preset=Custom
palette_color_0=rgb(27,31,46)
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
		[`${home}/wallpaper.svg`, WALLPAPER],
		...APPS.flatMap((app): Array<[string, string]> => [
			[`${home}/data/applications/anton-${app.id}.desktop`, desktopEntry(app, paths)],
			[`${home}/Desktop/${app.name}.desktop`, desktopEntry(app, paths)],
		]),
	];
	const folders = [...new Set(files.map(([file]) => file.slice(0, file.lastIndexOf('/'))))];
	return [
		`mkdir -p ${folders.join(' ')} ${home}/cache`,
		...files.map(([file, content]) => `cat > '${file}' <<'ANTON_EOF'\n${content}${content.endsWith('\n') ? '' : '\n'}ANTON_EOF`),
		`chmod +x ${home}/bin/anton-browser ${home}/Desktop/*.desktop`,
		// The task's folder on the desktop too, as a folder to open.
		`ln -sfn '${paths.root}' '${home}/Desktop/Workspace'`,
		// Openbox's own settings, with the theme above, its fonts, and one desktop.
		`sed -e 's|<name>Clearlooks</name>|<name>Anton</name>|' -e 's|<name>sans</name>|<name>Inter</name>|g' -e 's|<size>[0-9]*</size>|<size>10</size>|g' -e 's|<number>4</number>|<number>1</number>|' /etc/xdg/openbox/rc.xml > ${home}/config/openbox/rc.xml`,
		`[ -s ${home}/wallpaper.png ] || rsvg-convert -w ${screen.width} -h ${screen.height} ${home}/wallpaper.svg -o ${home}/wallpaper.png`,
	].join('\n');
}
