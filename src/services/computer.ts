import { announce } from '../core/changes.ts';
import { browserCommand } from '../core/desktop-look.ts';
import { desktopEnv, desktopLayout, desktopRunning, ENSURE_DESKTOP, SCREEN, startDesktop, stopDesktop } from '../core/desktop.ts';
import { ConflictError, InvalidInputError, NotFoundError } from '../core/errors.ts';
import { writeMachineFile } from '../core/machine-fs.ts';
import type { Machine } from '../core/ports.ts';
import { quote, run, text } from '../core/shell.ts';
import { getSessionRecord } from '../db/sessions.ts';
import { browse, BrowserStopError, closeBrowser, type BrowserInput, type BrowserState } from './browser.ts';
import { addressToUrl, screenshotFile } from './browser-step.ts';
import { liveMachine, machineFor } from './workspace.ts';
import { untilAborted } from './step-deadline.ts';

/**
 * The Computer panel and the agent's computer: a desktop inside the task's
 * sandbox, one screen that you watch and take over, and that the agent's
 * computer subagent drives with xdotool. Viewing never starts the sandbox;
 * Start computer, the agent, or Resume does.
 */

export type ComputerView = {
	/** The task's sandbox runs. */
	live: boolean;
	/** Its desktop runs. */
	running: boolean;
	screen: { width: number; height: number };
	/** The agent is using the computer, or did a moment ago. */
	agentBusy: boolean;
	/** You took over: agent steps stop until you hand it back. */
	userControl: boolean;
};

/** The view, with a fresh address to connect to: a credential, so only Anton's own UI gets it. */
export type ComputerConnection = ComputerView & { url: string };

const changed = (id: string) => announce({ kind: 'task', id, what: 'computer' });

async function requireTask(id: string) {
	if (!(await getSessionRecord(id))) throw new NotFoundError('Session not found');
}

/** Whether the machine's desktop runs, in one command. */
export async function isDesktopRunning(machine: Machine, signal?: AbortSignal): Promise<boolean> {
	signal?.throwIfAborted();
	return (await machine.exec(desktopRunning(desktopLayout(machine.root)), { signal })).exitCode === 0;
}

/**
 * Starts the machine's desktop unless it runs, installing it first in a
 * machine from before it was in the image. The sandbox's own browser started
 * headless before the desktop existed, so it is closed, to open again on the
 * screen at the agent's next step.
 */
const desktopStarts = new Map<string, Promise<void>>();

export async function ensureDesktop(machine: Machine, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	const key = `${machine.id}:${machine.root}`;
	const existing = desktopStarts.get(key);
	if (existing) return existing;
	const start = (async () => {
		if (await isDesktopRunning(machine, signal)) return;
		signal?.throwIfAborted();
		await run(machine, ENSURE_DESKTOP, { timeoutMs: 10 * 60_000, signal });
		signal?.throwIfAborted();
		await run(machine, startDesktop(desktopLayout(machine.root)), { timeoutMs: 60_000, signal });
		signal?.throwIfAborted();
		await closeBrowser(machine).catch(() => undefined);
	})();
	desktopStarts.set(key, start);
	try { await start; } finally { if (desktopStarts.get(key) === start) desktopStarts.delete(key); }
}

/** Start the screen for an agent and let an already-open Computer panel find it. */
export async function ensureAgentDesktop(id: string, machine: Machine, signal?: AbortSignal): Promise<void> {
	await ensureDesktop(machine, signal);
	signal?.throwIfAborted();
	changed(id);
}

/** The display the machine's desktop is on, for programs started on it. */
export const displayOf = (machine: Machine): string => desktopLayout(machine.root).display;

// ---- Who drives ----

const userControl = new Set<string>();
// A takeover waits for the active step before the panel gives the user input.
const takingControl = new Set<string>();
// If cancellation cannot confirm the browser stopped, never hand the screen to another driver.
const unsafeScreens = new Set<string>();

// While the agent acts, and for a few seconds after, the panel says it is using the computer.
const BUSY_MS = 8_000;
const agentSteps = new Map<string, { running: number; at: number; quiet?: ReturnType<typeof setTimeout> }>();

export function agentBusy(id: string): boolean {
	const step = agentSteps.get(id);
	return Boolean(step && (step.running > 0 || Date.now() - step.at < BUSY_MS));
}

export const userHasControl = (id: string): boolean => userControl.has(id) || takingControl.has(id) || unsafeScreens.has(id);

/** Each task's last step, so the next waits for it. */
const queues = new Map<string, Promise<unknown>>();

/**
 * Runs one agent step with the panel told the agent is at the computer: when
 * the first starts, and once the quiet spell after the last ends. Steps run one
 * at a time in the order they were called: a model may call several at once,
 * and their clicks and keystrokes must not interleave.
 */
export async function asAgentStep<T>(id: string, work: () => Promise<T>): Promise<T> {
	const step = agentSteps.get(id) ?? { running: 0, at: 0 };
	clearTimeout(step.quiet);
	const wasBusy = agentBusy(id);
	step.running += 1;
	agentSteps.set(id, step);
	if (!wasBusy) changed(id);
	const previous = queues.get(id) ?? Promise.resolve();
	const turn = previous.catch(() => undefined).then(work);
	queues.set(id, turn);
	try {
		return await turn;
	} finally {
		if (queues.get(id) === turn) queues.delete(id);
		step.running -= 1;
		step.at = Date.now();
		if (step.running === 0) {
			step.quiet = setTimeout(() => {
				agentSteps.delete(id);
				changed(id);
			}, BUSY_MS + 100);
			step.quiet.unref?.();
		}
	}
}

/** Run a sandbox browser action on the same screen and in the same queue as computer actions. */
export function browseOnComputer(
	id: string,
	getMachine: () => Promise<Machine>,
	command: BrowserInput,
	stopped: () => boolean,
	services: { desktop: typeof ensureAgentDesktop; browser: typeof browse } = { desktop: ensureAgentDesktop, browser: browse },
	signal?: AbortSignal,
): Promise<BrowserState> {
	return asAgentStep(id, async () => {
		const held = (): BrowserState => ({ url: command.url ?? '', title: '', status: null, problem: 'The user has taken over the computer or the browser step was stopped. Stop and report; continue after the computer is handed back.', errors: [], screenshot: null, snapshot: '' });
		if (stopped() || userHasControl(id)) return held();
		const machine = await untilAborted(getMachine(), signal);
		if (stopped() || userHasControl(id)) return held();
		let notice: string | undefined;
		try {
			await services.desktop(id, machine, signal);
		} catch (error) {
			if (stopped() || userHasControl(id)) return held();
			notice = `The Computer screen could not start; this browser step runs headless and cannot be watched in Computer. ${error instanceof Error ? error.message : String(error)}`;
		}
		if (stopped() || userHasControl(id)) return held();
		try {
			const result = await services.browser(machine, command, signal);
			return notice ? { ...result, notice } : result;
		} catch (error) {
			if (error instanceof BrowserStopError) unsafeScreens.add(id);
			throw error;
		}
	});
}

// ---- What the routes call ----

async function viewOf(id: string, machine: Machine | null): Promise<ComputerView> {
	const running = machine ? await isDesktopRunning(machine).catch(() => false) : false;
	return { live: Boolean(machine), running, screen: { ...SCREEN }, agentBusy: agentBusy(id), userControl: userControl.has(id) };
}

/** The panel's view. Never starts the sandbox or the desktop. */
export async function computerView(id: string): Promise<ComputerView> {
	await requireTask(id);
	return viewOf(id, await liveMachine(id));
}

async function connection(id: string, machine: Machine): Promise<ComputerConnection> {
	await ensureDesktop(machine);
	const url = await machine.socketUrl(desktopLayout(machine.root).socketPort);
	if (!url) throw new ConflictError('This sandbox provider has no way to show its screen');
	changed(id);
	return { ...(await viewOf(id, machine)), url };
}

/** Start computer: starts the sandbox if it is not running, then its desktop, and connects. */
export async function startComputer(id: string): Promise<ComputerConnection> {
	await requireTask(id);
	return connection(id, await machineFor(id));
}

/** A fresh address for the panel to connect to the running sandbox's desktop, starting the desktop if needed. */
export async function connectComputer(id: string): Promise<ComputerConnection> {
	await requireTask(id);
	const machine = await liveMachine(id);
	if (!machine) throw new ConflictError('The sandbox is not running. Start the computer first.');
	return connection(id, machine);
}

/**
 * Turn off: closes the desktop and everything open on it, while the sandbox
 * runs on for the task. With nothing else running, the sandbox then stops
 * itself after the idle minutes in Settings, as it does without a desktop.
 * Not while the agent is using the computer.
 */
export async function stopComputer(id: string): Promise<ComputerView> {
	await requireTask(id);
	const machine = await liveMachine(id);
	if (!machine) return viewOf(id, null);
	if (agentBusy(id)) throw new ConflictError('The agent is using the computer. Stop the task, or wait until it is done.');
	userControl.delete(id);
	// The sandbox's browser is on the screen; closed, it opens headless at the agent's next step.
	await closeBrowser(machine);
	await run(machine, stopDesktop(desktopLayout(machine.root)), { timeoutMs: 30_000 });
	unsafeScreens.delete(id);
	changed(id);
	return viewOf(id, machine);
}

/** Take over (you drive, the agent waits) or hand back to the agent. */
export async function setComputerControl(id: string, driver: 'user' | 'agent', maxWaitMs = 15_000): Promise<ComputerView> {
	await requireTask(id);
	if (driver === 'user') {
		if (unsafeScreens.has(id)) throw new ConflictError('The browser could not be stopped. Turn off the computer before taking over.');
		takingControl.add(id);
		// New queued steps see takingControl; do not grant input until the in-flight step is quiescent.
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				queues.get(id)?.catch(() => undefined),
				new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ConflictError('The agent is still stopping its computer step. Try Take over again shortly.')), maxWaitMs); }),
			]);
			if (unsafeScreens.has(id)) throw new ConflictError('The browser could not be stopped. Turn off the computer before taking over.');
			if (takingControl.delete(id)) userControl.add(id);
		} catch (error) {
			takingControl.delete(id);
			throw error;
		} finally { clearTimeout(timer); }
	} else {
		takingControl.delete(id);
		userControl.delete(id);
	}
	changed(id);
	return viewOf(id, await liveMachine(id));
}

/** The screen as you see it, to draw on: a PNG, base64. */
export async function computerScreenshot(id: string): Promise<{ data: string; width: number; height: number }> {
	await requireTask(id);
	const machine = await liveMachine(id);
	if (!machine || !(await isDesktopRunning(machine))) throw new ConflictError('The computer is not running');
	return { data: Buffer.from(await captureScreen(machine)).toString('base64'), ...SCREEN };
}

// ---- The agent's hands ----

export const COMPUTER_ACTIONS = ['look', 'open', 'click', 'double_click', 'right_click', 'move', 'drag', 'type', 'key', 'scroll', 'wait', 'launch'] as const;
export type ComputerAction = (typeof COMPUTER_ACTIONS)[number];

/** One step, with every position already in screen pixels. */
export type ComputerInput = {
	action: ComputerAction;
	x?: number;
	y?: number;
	/** For drag: where to let go. */
	toX?: number;
	toY?: number;
	text?: string;
	/** For key: xdotool key names joined by +, such as ctrl+s, Return or alt+F4. */
	keys?: string;
	direction?: 'up' | 'down' | 'left' | 'right';
	/** For scroll: wheel clicks. */
	amount?: number;
	ms?: number;
	/** For open: a web page to show in a browser window on the screen. */
	url?: string;
	/** For launch: a program to start on the screen, such as `xterm`. */
	command?: string;
};

/** Opens a page in a browser window on the screen, the desktop's Web Browser. */
const openPage = (machine: Machine, url: string) => `${quote(browserCommand(desktopLayout(machine.root)))} ${quote(url)}`;

const within = (value: number, max: number) => Math.min(max - 1, Math.max(0, Math.round(value)));

function point(input: ComputerInput, x = input.x, y = input.y): string {
	if (x === undefined || y === undefined) throw new InvalidInputError(`${input.action} needs a position on the screen`);
	return `${within(x, SCREEN.width)} ${within(y, SCREEN.height)}`;
}

const WHEEL = { up: 4, down: 5, left: 6, right: 7 } as const;

/** The xdotool command for one step; look and wait do nothing on the screen. */
export function inputCommand(input: ComputerInput): string | null {
	switch (input.action) {
		case 'look':
		case 'wait':
		case 'open':
			return null;
		case 'move':
			return `xdotool mousemove ${point(input)}`;
		case 'click':
			return `xdotool mousemove ${point(input)} click 1`;
		case 'double_click':
			return `xdotool mousemove ${point(input)} click --repeat 2 --delay 80 1`;
		case 'right_click':
			return `xdotool mousemove ${point(input)} click 3`;
		case 'drag':
			return `xdotool mousemove ${point(input)} mousedown 1 sleep 0.2 mousemove ${point(input, input.toX, input.toY)} sleep 0.2 mouseup 1`;
		case 'type':
			if (!input.text) throw new InvalidInputError('type needs text');
			return `xdotool type --delay 15 -- ${quote(input.text)}`;
		case 'key':
			if (!input.keys?.trim()) throw new InvalidInputError('key needs keys, such as ctrl+s or Return');
			return `xdotool key -- ${input.keys.trim().split(/\s+/).map(quote).join(' ')}`;
		case 'scroll': {
			const clicks = Math.min(25, Math.max(1, Math.round(input.amount ?? 5)));
			const at = input.x !== undefined && input.y !== undefined ? `mousemove ${point(input)} ` : '';
			return `xdotool ${at}click --repeat ${clicks} --delay 30 ${WHEEL[input.direction ?? 'down']}`;
		}
		case 'launch':
			if (!input.command?.trim()) throw new InvalidInputError('launch needs a command');
			return null;
	}
}

/** The program a step starts on the screen, for open and launch. */
function programOf(machine: Machine, input: ComputerInput): string | null {
	if (input.action === 'open') {
		if (!input.url?.trim()) throw new InvalidInputError('open needs a url');
		return openPage(machine, addressToUrl(input.url));
	}
	return input.action === 'launch' ? (input.command ?? null) : null;
}

/** The whole screen as a PNG. */
export async function captureScreen(machine: Machine, signal?: AbortSignal): Promise<Uint8Array> {
	signal?.throwIfAborted();
	const result = await machine.exec(`import -silent -window root -display ${displayOf(machine)} png:-`, { timeoutMs: 30_000, signal });
	if (result.exitCode !== 0 || result.stdout.length === 0) throw new Error(`Could not capture the screen: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
	return result.stdout;
}

/** The title of the window that has the focus, or null. */
export async function focusedWindow(machine: Machine): Promise<string | null> {
	const result = await machine.exec(`DISPLAY=${displayOf(machine)} xdotool getactivewindow getwindowname 2>/dev/null`);
	return result.exitCode === 0 ? text(result.stdout).trim() || null : null;
}

/** How long the screen gets to settle after an action before its picture is taken. */
const SETTLE_MS = { open: 3000, launch: 2500, type: 300, key: 600 } as Partial<Record<ComputerAction, number>>;

/**
 * Does one step on the machine's desktop (started if needed), then returns
 * the screen as it is now. Positions are screen pixels.
 */
export async function act(machine: Machine, input: ComputerInput, signal?: AbortSignal): Promise<{ png: Uint8Array; window: string | null }> {
	await ensureDesktop(machine, signal);
	signal?.throwIfAborted();
	const display = displayOf(machine);
	const command = inputCommand(input);
	const program = programOf(machine, input);
	if (command) await run(machine, `DISPLAY=${display} ${command}`, { timeoutMs: 60_000, signal });
	signal?.throwIfAborted();
	if (program) {
		// Its own session, out of the step's reach, so a program left open stays open; with the desktop's theme.
		await run(machine, `cd ${quote(machine.root)} && ${desktopEnv(desktopLayout(machine.root))} env -u ANTON_EXEC setsid nohup bash -lc ${quote(program)} > /tmp/anton-launch.log 2>&1 < /dev/null &`, { signal });
	}
	const settle = input.action === 'wait' ? Math.min(Math.max(input.ms ?? 1000, 0), 15_000) : input.action === 'look' ? 0 : (SETTLE_MS[input.action] ?? 400);
	if (settle) await new Promise((resolve) => setTimeout(resolve, settle));
	signal?.throwIfAborted();
	const [png, window] = await Promise.all([captureScreen(machine, signal), focusedWindow(machine)]);
	return { png, window };
}

/** Saves a screen to the task's outputs, for the Library; returns its path as the agent sees it. */
export async function saveScreen(machine: Machine, name: string, png: Uint8Array): Promise<string> {
	const file = screenshotFile(name);
	await machine.exec(`mkdir -p ${quote(`${machine.root}/outputs/screenshots`)}`);
	await writeMachineFile(machine, `${machine.root}/outputs/${file}`, png);
	return `../outputs/${file}`;
}
