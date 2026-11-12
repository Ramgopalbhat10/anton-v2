import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { withEnv } from '../core/machine-env.ts';
import type { Machine } from '../core/ports.ts';
import { redactor } from '../core/redact.ts';
import { quote, text } from '../core/shell.ts';
import { FILE_CHANGE_TOOLS } from '../core/tool-profile.ts';
import { getProject } from '../db/projects.ts';
import { getSessionRecord } from '../db/sessions.ts';
import { digestOf, digestScript, durationText, parseInspect, type Seen } from './background-jobs.ts';
import { changeGate, gate } from './gate-state.ts';
import { repoDir } from './git.ts';
import { logProblem } from './log.ts';
import { envFor, secretsToHide } from './secrets.ts';
import { liveMachine } from './workspace.ts';

/*
 * The repository's check: a command the user sets per repository (a type check
 * or lint), run in the task's sandbox after the agent changes files. The prompts
 * ask the agent to check its work, but nothing ran a check by itself: in a
 * 20-task benchmark five failures were near misses a type check would have
 * caught, and the agent found a type error it made only when it next chose to
 * run the checker, often many steps later, having built on the mistake.
 *
 * It never starts a sandbox and never holds the agent up: a finished `edit`,
 * `write`, `apply_patch` or `bash` call (the main agent's or a subagent's, from
 * the runtime's events) marks the task changed, and after a short quiet the
 * check runs on the machine if it is already running, in the server's
 * background. One runs at a time; a change while it runs makes it run once
 * more after. The script compares a fingerprint of the working tree with the
 * one the last run saw before it runs the command, so a `bash` that only read
 * costs one short command and no check. The agent hears only of a failure (once
 * for the same failure), a pass after a failure it was told of, and a timeout,
 * at the end of its next command's result; nothing at all with no command set.
 * At the end of a reply that changed files, `checkGate` waits for the check of
 * the last change and sends the reply back once for a failure.
 */

/** How long the check runs before it is stopped: a type check or lint takes seconds; a whole suite is what this is not for. */
export const CHECK_TIMEOUT_MS = 3 * 60_000;
/** The check starts this long after the last change, so a step's burst of edits causes one run. */
export const QUIET_MS = 2_000;
/** Where each task's fingerprint, process id and log are kept, in the machine. */
export const CHECK_DIR = '/tmp/anton-check';
/** How long `timeout` gives the check to end after its TERM before it is killed. */
const KILL_GRACE_S = 10;
/** A notice's digest, at most: it rides on a command's result, and on every later model call with it. */
const NOTICE_CHARS = 1_500;
/** Each of a notice digest's two parts, the failure-looking lines and the last lines. */
const NOTICE_PART_CHARS = 650;
/** Times a reply is sent back for the check's failures, at most. */
export const MAX_CHECK_SENDS = 2;
/** A command as a notice names it. */
const COMMAND_CHARS = 60;
/** Tasks whose check state is kept in memory; the oldest go first. */
const KEEP_TASKS = 200;

/** The tool calls that may have changed the task's files: the file tools of either profile, and any command. */
const TRIGGERS: ReadonlySet<string> = new Set([...FILE_CHANGE_TOOLS, 'bash']);

/** What a task's check needs of its repository and record, or null when it has none to run. */
export type CheckSettings = { command: string; baseSha: string; env: Record<string, string> };

export type Deps = {
	/** The task's machine only if it is running: a check never starts a sandbox. */
	live: (id: string) => Promise<Machine | null>;
	settings: (id: string) => Promise<CheckSettings | null>;
	secrets: (id: string) => Promise<Record<string, string>>;
	cwd: (machine: Machine) => string;
	dir: string;
	quietMs: number;
	timeoutMs: number;
};

/** A repository task's check command, unless it is planning, reviewing or on this server, which `watchRepoCheck` also rules out. */
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

/** Replaces what the check runs on (tests give it a local machine and short times); returns what puts the defaults back. */
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
	/** The failure, by a hash of its digest without its timings, so the same failure is told once. */
	key: string;
};

type TaskCheck = {
	/** A repository task with its sandbox, outside plan mode and review and not on this server, as its agent last rendered. */
	eligible: boolean;
	/** The quiet before the next run, while it waits. */
	timer: ReturnType<typeof setTimeout> | null;
	/** The run in flight, and the machine it runs on, to stop it. */
	run: Promise<void> | null;
	machine: Machine | null;
	/** The task changed while a run was in flight: it runs once more after. */
	again: boolean;
	/** The tree the last run's command left may hold the agent's changes made while it ran, so the next run does not skip on it. */
	mixed: boolean;
	/** The run in flight was stopped: its result is not told. */
	stopping: boolean;
	/** The latest run that ran the command. */
	last: Result | null;
	/** What the next command result ends with, and what the agent has then been told. */
	notice: { text: string; told: string | undefined } | null;
	/** Runs that ran the command, for tests. */
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

/**
 * Whether the task's changes are checked, from its agent as it renders: a repository task outside plan mode and review
 * that does not run on this server. A chat, an incognito chat, a plan or a review is never checked.
 */
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

/** A runtime event: a finished call of a tool that may change files marks its task changed. Runs in the event observer; never throws. */
export function noteRepoCheckEvent(event: ToolEvent): void {
	if (event.type !== 'tool' || !event.instanceId || !event.toolName || !TRIGGERS.has(event.toolName)) return;
	// The reviewer of a task's pushes shares its id and only reads.
	if (event.agentName && /^(reviewer|coordinator)$/i.test(event.agentName)) return;
	noteRepoChange(event.instanceId);
}

/** The task's files may have changed: its check runs after a quiet, or once more after the run in flight. */
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
 * The check as the machine runs it, in one command: a fingerprint of the working tree (its commit, its status with
 * untracked files, its diff, and its untracked files' sizes and times) is compared with the ones the last run saw,
 * and when it is the same the script says so and ends. Else the fingerprint is kept before the command runs, and
 * another after it: what a command writes (build output, caches) is no change of the agent's, so the next run is
 * skipped when the tree is as the agent left it for the last run or as that run's command left it, unless the agent
 * changed files while that command ran (`mixed`), when the tree it left holds the agent's changes too. A
 * task's first fingerprint, on a tree still at its base commit with nothing changed, is kept without a run: there
 * is no change of the agent's to check yet. The command runs in a session of its own under `timeout`, which stops
 * its whole process group at the limit; its output goes to a log, and the script prints its exit code, whether it
 * timed out or was stopped, and the log's digest, as background jobs do.
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

/** Stops a running check's whole process group, marked first so its run is not told; its fingerprint goes, so the next change is checked. */
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

/** A failure's identity: its digest with timings and clock times taken out, as a rerun prints them differently. */
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

/** The digest a notice carries, within its bound. */
function noticeDigest(result: Result): string {
	const digest = digestOf(result.seen, result.log, result.hide, NOTICE_PART_CHARS);
	return digest.length > NOTICE_CHARS ? `${digest.slice(0, NOTICE_CHARS - 1)}…` : digest;
}

/** What the next command result says of a run, given what the agent was last told: only news, and never good news it did not need. */
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

/**
 * The line a command's result ends with when the check has news since the agent last heard: a failure (once for the
 * same failure), a pass after a failure it was told of, or a timeout; empty otherwise, and always with no check command.
 */
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

/** A new reply: whether it changed the tree, and what it was sent back for, start over. What the agent was told stays. */
export function startCheckGate(id: string): void {
	changeGate(id, (state) => {
		state.check = { told: state.check.told, ran: false, sent: [], sends: 0 };
	});
}

/** Waits for the quiet and the run in flight, and the run a change during it causes, at most the check's own time and a little more. */
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
 * At the end of a reply that changed the tree: waits for the check of its last change, and when that fails sends the
 * reply back with the digest, to fix what the change broke or say the failure was there before it. Once a reply for a
 * failure and at most `MAX_CHECK_SENDS` times a reply; never on an aborted reply or one that ends on `ask` or
 * `propose_plan`. A timeout is not a failure of the change and sends nothing back. Null at once with no check.
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

/** Stops the task's check: the quiet and a run in flight, whose result is not told. A stopped reply leaves no check running. */
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

/** Forgets a deleted task's check, stopping one in flight; nothing of it stays in memory. */
export function forgetRepoCheck(id: string): void {
	void stopRepoCheck(id);
	tasks.delete(id);
}

/** Settles once the task has no check waiting or running: for tests. */
export async function settledRepoCheck(id: string): Promise<void> {
	const own = tasks.get(id);
	while (own && (own.timer || own.run)) await (own.run ?? delay(5));
}

/** How many times the task's check ran its command, and its latest result: for tests. */
export function repoCheckRuns(id: string): { runs: number; last: Result['status'] | null } {
	const own = tasks.get(id);
	return { runs: own?.runs ?? 0, last: own?.last?.status ?? null };
}

/** Whether the task's check state is in memory: for tests. */
export const hasRepoCheck = (id: string): boolean => tasks.has(id);
