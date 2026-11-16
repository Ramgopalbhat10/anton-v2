import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { withEnv } from '../../core/machine-env.ts';
import type { Machine } from '../../core/ports.ts';
import { redactor } from '../../core/redact.ts';
import { quote, text } from '../../core/shell.ts';
import { FILE_CHANGE_TOOLS } from '../../core/tool-profile.ts';
import { getProject } from '../../db/projects.ts';
import { getSessionRecord } from '../../db/sessions.ts';
import { digestOf, digestScript, durationText, parseInspect, type Seen } from './background-jobs.ts';
import { changeGate, gate } from '../replies/gate-state.ts';
import { repoDir } from '../git/git.ts';
import { logProblem } from '../../core/log.ts';
import { envFor, secretsToHide } from '../secrets/secrets.ts';
import { liveMachine } from './workspace.ts';

/*
 * The repository's check (a type check or lint the user sets) runs on the machine, if already running, after a quiet
 * following a file-changing tool call. It never starts a sandbox or holds the agent up. In a 20-task benchmark five
 * failures were near misses a type check would have caught. The agent hears only news, at the end of its next command's
 * result; `checkGate` sends a reply back once for a failure of its last change.
 */

/** A type check or lint takes seconds; a whole suite is what this is not for. */
export const CHECK_TIMEOUT_MS = 3 * 60_000;
/** So a step's burst of edits causes one run. */
export const QUIET_MS = 2_000;
export const CHECK_DIR = '/tmp/anton-check';
const KILL_GRACE_S = 10;
/** It rides on a command's result, and on every later model call with it. */
const NOTICE_CHARS = 1_500;
const NOTICE_PART_CHARS = 650;
export const MAX_CHECK_SENDS = 2;
const COMMAND_CHARS = 60;
const KEEP_TASKS = 200;

const TRIGGERS: ReadonlySet<string> = new Set([...FILE_CHANGE_TOOLS, 'bash']);

export type CheckSettings = { command: string; baseSha: string; env: Record<string, string> };

export type Deps = {
	/** A check never starts a sandbox. */
	live: (id: string) => Promise<Machine | null>;
	settings: (id: string) => Promise<CheckSettings | null>;
	secrets: (id: string) => Promise<Record<string, string>>;
	cwd: (machine: Machine) => string;
	dir: string;
	quietMs: number;
	timeoutMs: number;
};

/** None while planning, reviewing or on this server, which `watchRepoCheck` also rules out. */
async function settingsOf(id: string): Promise<CheckSettings | null> {
	const session = await getSessionRecord(id);
	if (!session?.projectId || session.planMode || session.review || session.runOn === 'host') return null;
	const project = await getProject(session.projectId);
	const command = project?.checkCommand.trim();
	if (!project || !command) return null;
	// The variables the agent's own commands have (`machineFor` gives its machine them); the machine found running may not carry them.
	return { command, baseSha: session.baseSha, env: await envFor(project) };
}

// Called through, not taken at load: activity.ts imports this module, and workspace.ts imports activity.ts.
const defaults: Deps = {
	live: (id) => liveMachine(id),
	settings: (id) => settingsOf(id),
	secrets: (id) => secretsToHide(id),
	cwd: (machine) => repoDir(machine),
	dir: CHECK_DIR,
	quietMs: QUIET_MS,
	timeoutMs: CHECK_TIMEOUT_MS,
};

let deps: Deps = defaults;

export function setRepoCheckDeps(next: Partial<Deps>): () => void {
	deps = { ...defaults, ...next };
	return () => {
		deps = defaults;
	};
}

type Result = {
	status: 'passed' | 'failed' | 'timed out';
	command: string;
	seen: Seen;
	log: string;
	hide: (text: string) => string;
	/** A hash of its digest without its timings, so the same failure is told once. */
	key: string;
};

type TaskCheck = {
	eligible: boolean;
	timer: ReturnType<typeof setTimeout> | null;
	run: Promise<void> | null;
	machine: Machine | null;
	again: boolean;
	/** The tree the last run's command left may hold the agent's changes made while it ran, so the next run does not skip on it. */
	mixed: boolean;
	stopping: boolean;
	last: Result | null;
	notice: { text: string; told: string | undefined } | null;
	runs: number;
};

const tasks = new Map<string, TaskCheck>();

function entryFor(id: string): TaskCheck {
	let found = tasks.get(id);
	if (found) tasks.delete(id);
	else found = { eligible: false, timer: null, run: null, machine: null, again: false, mixed: false, stopping: false, last: null, notice: null, runs: 0 };
	tasks.set(id, found);
	if (tasks.size > KEEP_TASKS) {
		const [oldest, dropped] = tasks.entries().next().value!;
		if (dropped.timer) clearTimeout(dropped.timer);
		tasks.delete(oldest);
	}
	return found;
}

/** A chat, an incognito chat, a plan or a review is never checked. */
export function watchRepoCheck(id: string, on: boolean): void {
	if (on) {
		entryFor(id).eligible = true;
		return;
	}
	const own = tasks.get(id);
	if (!own) return;
	own.eligible = false;
	if (own.timer) clearTimeout(own.timer);
	own.timer = null;
}

type ToolEvent = { type: string; instanceId?: string; agentName?: string; toolName?: string };

export function noteRepoCheckEvent(event: ToolEvent): void {
	if (event.type !== 'tool' || !event.instanceId || !event.toolName || !TRIGGERS.has(event.toolName)) return;
	// The reviewer of a task's pushes shares its id and only reads.
	if (event.agentName && /^(reviewer|coordinator)$/i.test(event.agentName)) return;
	noteRepoChange(event.instanceId);
}

export function noteRepoChange(id: string): void {
	const own = tasks.get(id);
	if (!own?.eligible) return;
	if (own.run) {
		own.again = true;
		return;
	}
	schedule(id, own);
}

function schedule(id: string, own: TaskCheck): void {
	if (own.timer) clearTimeout(own.timer);
	own.timer = setTimeout(() => begin(id, own), deps.quietMs);
	own.timer.unref?.();
}

function begin(id: string, own: TaskCheck): void {
	if (own.timer) clearTimeout(own.timer);
	own.timer = null;
	own.again = false;
	own.stopping = false;
	const mixed = own.mixed;
	own.mixed = false;
	const run = execute(id, own, mixed)
		.catch((error: unknown) => logProblem('warn', "The repository's check did not run", error, id))
		.finally(() => {
			own.run = null;
			own.machine = null;
			own.mixed ||= own.again;
			if (own.again && own.eligible && tasks.get(id) === own) schedule(id, own);
			own.again = false;
		});
	own.run = run;
}

const fileName = (id: string) => id.replace(/[^\w.-]/g, '_');

/**
 * One command. The working tree's fingerprint (commit, status, diff, untracked sizes and times) is compared with the last
 * run's before and after its command, so what the command writes (build output, caches) is no change of the agent's;
 * `mixed` means the agent changed files while that command ran. A first fingerprint at the base commit is kept without a run.
 */
export function checkScript(command: string, options: { dir: string; name: string; cwd: string; seconds: number; base: string; mixed?: boolean }): string {
	const { dir, name, cwd, seconds, base, mixed = false } = options;
	return [
		`f=${quote(`${dir}/${name}`)}; mkdir -p ${quote(dir)} || exit 1`,
		`cd ${quote(cwd)} || exit 1`,
		'h=sha1sum; command -v sha1sum >/dev/null || h=cksum',
		// Without optional locks: the check runs beside the agent's own commands, and a `git status` that took the index's lock to refresh it would make a `git add` or `git commit` of the agent's fail on it.
		"__anton_tree() { { export GIT_OPTIONAL_LOCKS=0; git rev-parse HEAD; git status --porcelain=v1 -uall; git diff HEAD --binary; git ls-files -o --exclude-standard -z | xargs -0 -r stat -c '%n %s %Y' --; } 2>&1 | $h; }",
		'fp=$(__anton_tree)',
		...(mixed ? ['rm -f "$f.after"'] : []),
		...(base ? [`if [ ! -e "$f.fp" ] && [ "$(git rev-parse HEAD 2>/dev/null)" = ${quote(base)} ] && [ -z "$(GIT_OPTIONAL_LOCKS=0 git status --porcelain 2>/dev/null)" ]; then printf '%s\\n' "$fp" > "$f.fp"; fi`] : []),
		'if [ "$(cat "$f.fp" 2>/dev/null)" = "$fp" ] || [ "$(cat "$f.after" 2>/dev/null)" = "$fp" ]; then echo unchanged=1; exit 0; fi',
		`printf '%s\\n' "$fp" > "$f.fp"; rm -f "$f.after" "$f.stopped"`,
		'z=; command -v setsid >/dev/null && z=setsid',
		`t=; command -v timeout >/dev/null && t="timeout -k ${KILL_GRACE_S} ${seconds}"`,
		`$z $t bash -lc ${quote(`cd ${quote(cwd)} || exit 1\n${command}`)} > "$f.log" 2>&1 < /dev/null &`,
		'pid=$!; echo "$pid" > "$f.pid"',
		'wait "$pid"; code=$?; rm -f "$f.pid"',
		// The tree as the command left it: what it wrote (build output, caches) is no change of the agent's either.
		'[ -e "$f.stopped" ] || __anton_tree > "$f.after"',
		'echo "exit=$code"',
		`echo "timedout=$( [ "$SECONDS" -ge ${seconds} ] && { [ "$code" = 124 ] || [ "$code" = 137 ]; } && echo 1)"`,
		'echo "stopped=$( [ -e "$f.stopped" ] && echo 1)"',
		...digestScript('"$f.log"'),
	].join('\n');
}

/** Marked first so its run is not told; its fingerprint goes, so the next change is checked. */
function killScript(dir: string, name: string): string {
	return [
		`f=${quote(`${dir}/${name}`)}; : > "$f.stopped" 2>/dev/null; rm -f "$f.fp" "$f.after"`,
		'pid=$(cat "$f.pid" 2>/dev/null); [ -n "$pid" ] || exit 0',
		'kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null',
		'for i in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done',
		'kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null',
		'exit 0',
	].join('\n');
}

/** Timings and clock times taken out, as a rerun prints them differently. */
function keyOf(seen: Seen, hide: (text: string) => string): string {
	const body = hide(`${seen.failures}\n${seen.tail}`)
		.replace(/\d+(\.\d+)?\s?(ms|s|m)\b/g, '#')
		.replace(/\d{1,2}:\d{2}(:\d{2})?(\.\d+)?/g, '#');
	return createHash('sha1').update(body).digest('hex');
}

async function execute(id: string, own: TaskCheck, mixed: boolean): Promise<void> {
	const d = deps;
	const settings = await d.settings(id);
	if (!settings || own.stopping) return;
	const found = await d.live(id).catch(() => null);
	if (!found || own.stopping) return;
	const machine = withEnv(found, settings.env);
	own.machine = machine;
	const name = fileName(id);
	const seconds = Math.max(1, Math.ceil(d.timeoutMs / 1000));
	const script = checkScript(settings.command, { dir: d.dir, name, cwd: d.cwd(found), seconds, base: settings.baseSha, mixed });
	const result = await machine.exec(script, { timeoutMs: (seconds + KILL_GRACE_S + 60) * 1000 });
	const output = text(result.stdout);
	if (output.trim() === 'unchanged=1') return;
	const seen = parseInspect(output);
	if (own.stopping) return;
	if (seen.exitCode === null) throw new Error(result.stderr.trim() || `The check script ended early (exit ${result.exitCode})`);
	own.runs += 1;
	if (seen.stopped || tasks.get(id) !== own) return;
	const hide = redactor(await d.secrets(id).catch(() => ({})));
	const status = seen.timedOut ? 'timed out' : seen.exitCode === 0 ? 'passed' : 'failed';
	const done: Result = { status, command: settings.command, seen, log: `${d.dir}/${name}.log`, hide, key: keyOf(seen, hide) };
	own.last = done;
	const told = gate(id).check.told;
	changeGate(id, (state) => {
		state.check.ran = true;
		// A pass after a timeout says nothing: the timeout was never news of the change.
		if (status === 'passed' && state.check.told === 'timeout') state.check.told = undefined;
	});
	own.notice = noticeFor(done, told);
	// A timeout is the user's to fix, in the repository's settings: it goes where Settings › Recent problems shows it. A failure is the agent's.
	if (status === 'timed out') logProblem('warn', `The repository's check took over ${durationText(d.timeoutMs)} and was stopped; a faster check command can be set in the repository's settings`, shortCommand(done), id);
	else if (status === 'failed') console.info(`[anton] The repository's check for ${id} failed with exit ${seen.exitCode} (${shortCommand(done)})`);
}

const shortCommand = (result: Pick<Result, 'command' | 'hide'>) => {
	const line = result.hide(result.command.trim().split('\n')[0]);
	return line.length > COMMAND_CHARS ? `${line.slice(0, COMMAND_CHARS - 1)}…` : line;
};

function noticeDigest(result: Result): string {
	const digest = digestOf(result.seen, result.log, result.hide, NOTICE_PART_CHARS);
	return digest.length > NOTICE_CHARS ? `${digest.slice(0, NOTICE_CHARS - 1)}…` : digest;
}

function noticeFor(result: Result, told: string | undefined): TaskCheck['notice'] {
	if (result.status === 'failed') {
		if (told === result.key) return null;
		return { text: `\n[anton] This repository's check (${shortCommand(result)}) fails after your last change:\n${noticeDigest(result)}`, told: result.key };
	}
	if (result.status === 'timed out') {
		if (told === 'timeout') return null;
		return {
			text:
				`\n[anton] This repository's check (${shortCommand(result)}) did not finish in ${durationText(deps.timeoutMs)} and was stopped, so it says nothing of your change. ` +
				'If this keeps happening, tell the user a faster check command (a type check or lint) can be set in the repository’s settings.',
			told: 'timeout',
		};
	}
	if (told && told !== 'timeout') return { text: "\n[anton] This repository's check passes again.", told: undefined };
	return null;
}

/** A failure (once for the same failure), a pass after a failure it was told of, or a timeout; empty otherwise. */
export function checkNotice(id: string): string {
	const own = tasks.get(id);
	if (!own?.notice) return '';
	const { text: line, told } = own.notice;
	own.notice = null;
	changeGate(id, (state) => {
		state.check.told = told;
	});
	return line;
}

export function startCheckGate(id: string): void {
	changeGate(id, (state) => {
		state.check = { told: state.check.told, ran: false, sent: [], sends: 0 };
	});
}

async function settle(id: string, own: TaskCheck, signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + deps.timeoutMs + (KILL_GRACE_S + 20) * 1000;
	while ((own.timer || own.run) && !signal?.aborted) {
		const left = deadline - Date.now();
		if (left <= 0) return;
		// The reply is ending: its last change is checked now, not after the quiet.
		if (own.timer && !own.run) begin(id, own);
		await Promise.race([own.run, delay(left, undefined, { signal, ref: false }).catch(() => undefined)]);
	}
}

type Call = { tool: string };

/**
 * Sends the reply back once per failure, at most `MAX_CHECK_SENDS` times, to fix what it broke or say it was there before.
 * Never on an aborted reply or one ending on `ask` or `propose_plan`; a timeout sends nothing back.
 */
export async function checkGate(id: string, calls: readonly Call[], context: { signal?: AbortSignal } = {}): Promise<string | null> {
	if (context.signal?.aborted) return null;
	const last = calls[calls.length - 1]?.tool;
	if (last === 'ask' || last === 'propose_plan') return null;
	const own = tasks.get(id);
	if (!own) return null;
	await settle(id, own, context.signal);
	if (context.signal?.aborted) return null;
	const { check } = gate(id);
	const result = own.last;
	if (!check.ran || !result || result.status !== 'failed' || check.sends >= MAX_CHECK_SENDS || check.sent.includes(result.key)) return null;
	changeGate(id, (state) => {
		state.check.sent.push(result.key);
		state.check.sends += 1;
		state.check.told = result.key;
	});
	own.notice = null;
	return (
		`This repository's check (${shortCommand(result)}) fails after your change:\n${digestOf(result.seen, result.log, result.hide)}\n` +
		'Fix what your change broke before you end. If this failure was there before your change, say so and end.'
	);
}

/** A stopped reply leaves no check running; the result of a run in flight is not told. */
export async function stopRepoCheck(id: string): Promise<void> {
	const own = tasks.get(id);
	if (!own) return;
	if (own.timer) clearTimeout(own.timer);
	own.timer = null;
	own.again = false;
	if (!own.run) return;
	own.stopping = true;
	const machine = own.machine;
	if (machine) await machine.exec(killScript(deps.dir, fileName(id)), { timeoutMs: 30_000 }).catch((error: unknown) => logProblem('warn', "Could not stop the repository's check", error, id));
	await own.run;
}

export function forgetRepoCheck(id: string): void {
	void stopRepoCheck(id);
	tasks.delete(id);
}

export async function settledRepoCheck(id: string): Promise<void> {
	const own = tasks.get(id);
	while (own && (own.timer || own.run)) await (own.run ?? delay(5));
}

export function repoCheckRuns(id: string): { runs: number; last: Result['status'] | null } {
	const own = tasks.get(id);
	return { runs: own?.runs ?? 0, last: own?.last?.status ?? null };
}

export const hasRepoCheck = (id: string): boolean => tasks.has(id);
