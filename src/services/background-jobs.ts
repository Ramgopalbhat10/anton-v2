import { config } from '../config.ts';
import type { Machine } from '../core/ports.ts';
import { redactor } from '../core/redact.ts';
import { quote, text } from '../core/shell.ts';
import { repoDir } from './git.ts';
import { logProblem } from './log.ts';
import { secretsToHide } from './secrets.ts';
import { liveMachine, machineFor } from './workspace.ts';

/*
 * Commands the agent runs in the background in its sandbox: a test suite, a
 * build, a type check. A benchmark run spent a third of its time with the
 * agent blocked on its tests (4,127 s in the tester subagent over 13,646 s);
 * told to run suites in the background, the agent had only `nohup … &` in
 * bash, and then polled the log with `sleep 30; tail`, a model call a poll,
 * with no exit code and nothing to say the suite had ended.
 *
 * A job runs detached in the machine (its own session, so neither the exec
 * that started it nor a stopped command takes it down), its output in one log
 * under /tmp/anton-jobs and its exit code in a file beside it once it ends, so
 * the result is there to read after this server restarts. The machine's own
 * `timeout` stops it at its time limit. The server learns that it ended
 * through one exec per job held open until the exit file appears (or its time
 * is up): no model call, and on Modal an exec in flight is what keeps a
 * sandbox from its idle timeout while a job outlives the reply.
 */

/** A job's time limit when the agent names none. */
export const DEFAULT_TIMEOUT_MS = 30 * 60_000;
/** The longest one `check_job` waits. The agent asks for the wait, as it names a command's timeout, so it may pass the 3 minutes a command gets without one (`COMMAND_TIMEOUT_MS`). */
export const MAX_WAIT_S = 300;
/** Where the logs and exit codes are, in the machine. */
export const JOBS_DIR = '/tmp/anton-jobs';
/** How long `timeout` gives a job to end after its TERM before it is killed. */
const KILL_GRACE_S = 10;
/** Lines of the log's end in a digest: test runners print their summary last. */
const TAIL_LINES = 30;
/** Lines that look like failures, from before the end, at most. */
const FAILURE_LINES = 40;
/** Each part of a digest, at most, so the whole is a few KB. */
const PART_CHARS = 2_000;
/** Each line of a digest, at most. */
const LINE_CHARS = 300;
/** A command as a notice names it. */
const COMMAND_CHARS = 60;
/** Tasks whose jobs are kept, and jobs a task keeps; the oldest go first. */
const KEEP_TASKS = 200;
const KEEP_JOBS = 20;

/**
 * Lines that read as failures in the common runners, and no parser for any: node:test (`not ok`, ✖), vitest and
 * jest (FAIL, ×, ✕), pytest (FAILED, ERROR, `E   ` lines, Traceback), go test (`--- FAIL`), cargo (panicked,
 * `error[E…]`), tsc (`error TS…`) and npm (`ERR!`).
 */
const FAILURE = String.raw`FAIL|ERROR|Error|error( TS[0-9]|\[E[0-9]|:)|panicked|Traceback|not ok |✖|✕|×|✗|^E +|ERR!`;

export type JobStatus = 'running' | 'exited' | 'timed out' | 'stopped' | 'unknown';

type Job = {
	number: number;
	command: string;
	log: string;
	startedAt: number;
	timeoutMs: number;
	status: JobStatus;
	exitCode: number | null;
	endedAt: number | null;
	/** Why its state is unknown, when it is. */
	lost: string | null;
	/** The agent was told it ended, by a notice or a result. */
	told: boolean;
	/** The agent got its result after it ended: from `check_job`, or inline when the reply was sent back. */
	read: boolean;
	/** The reply was sent back once for it while it ran, and once with its unread result. */
	sentRunning: boolean;
	sentUnread: boolean;
	hide: (text: string) => string;
	/** The held exec that learns it ended; settles once it has. */
	watched: Promise<void>;
};

type TaskJobs = { jobs: Map<number, Job>; reply: Set<number> };

export type Deps = {
	/** The task's machine for a new job; started if it is not running, as the agent's own commands do. */
	machine: (id: string) => Promise<Machine>;
	/** The task's machine only if it is running, for reading a job: viewing never starts a sandbox. */
	live: (id: string) => Promise<Machine | null>;
	secrets: (id: string) => Promise<Record<string, string>>;
	cwd: (machine: Machine) => string;
	dir: string;
	limitMs: number;
	now: () => number;
};

// Called through, not taken at load: activity.ts imports this module, and workspace.ts imports activity.ts.
const defaults: Deps = {
	machine: (id) => machineFor(id),
	live: (id) => liveMachine(id),
	secrets: (id) => secretsToHide(id),
	cwd: (machine) => repoDir(machine),
	dir: JOBS_DIR,
	limitMs: config.replyTimeoutMs,
	now: () => Date.now(),
};

const tasks = new Map<string, TaskJobs>();

function jobsOf(id: string): TaskJobs {
	let found = tasks.get(id);
	if (found) tasks.delete(id);
	else found = { jobs: new Map(), reply: new Set() };
	tasks.set(id, found);
	if (tasks.size > KEEP_TASKS) tasks.delete(tasks.keys().next().value!);
	return found;
}

/** `12s`, `3m 12s` or `1h 5m`. */
export function durationText(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ''}`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const shortCommand = (job: Job) => {
	const line = job.hide(job.command.trim().split('\n')[0]);
	return line.length > COMMAND_CHARS ? `${line.slice(0, COMMAND_CHARS - 1)}…` : line;
};

const paths = (dir: string, number: number) => ({ log: `${dir}/${number}.log`, base: `${dir}/${number}` });

/**
 * What runs the job, detached: the command under `timeout` in a session of its own (so stopping it reaches every
 * process it started), its output appended to the log, then its exit code written beside it, whole or not at all.
 * A job that hit its limit is marked so, as `timeout` exits 124 (137 once it had to kill).
 */
const RUNNER = [
	'b=$1; s=$2',
	't=; command -v timeout >/dev/null && t="timeout -k ' + KILL_GRACE_S + ' $s"',
	'z=; command -v setsid >/dev/null && z=setsid',
	'$z $t bash -l "$b.sh" >> "$b.log" 2>&1 < /dev/null &',
	'pid=$!',
	'echo "$pid" > "$b.pid"',
	'wait "$pid"; code=$?',
	'if [ "$SECONDS" -ge "$s" ] && { [ "$code" = 124 ] || [ "$code" = 137 ]; }; then : > "$b.timeout"; fi',
	'echo "$code" > "$b.exit.part" && mv "$b.exit.part" "$b.exit"',
].join('\n');

/** Picks the next free number (the log is made only if it is not there, so two jobs started at once never share one), and starts the runner. */
function startScript(dir: string, first: number, id: string, cwd: string, command: string, seconds: number): string {
	return [
		`d=${quote(dir)}; mkdir -p "$d" || exit 1`,
		`n=${first}`,
		'set -C; until { : > "$d/$n.log"; } 2>/dev/null; do n=$((n+1)); [ "$n" -gt 99999 ] && exit 1; done; set +C',
		'b="$d/$n"',
		`printf '%s %s %s\\n' ${quote(id)} "$(date +%s)" ${seconds} > "$b.info"`,
		`printf 'cd %s || exit 1\\n%s\\n' ${quote(quote(cwd))} ${quote(command)} > "$b.sh"`,
		'z=; command -v setsid >/dev/null && z=setsid',
		`$z nohup bash -c ${quote(RUNNER)} anton-job "$b" ${seconds} < /dev/null > /dev/null 2>&1 &`,
		// Its pid is written before this returns, so a stop that comes at once finds it.
		'for i in $(seq 50); do [ -s "$b.pid" ] && break; sleep 0.1; done',
		'echo "$n"',
	].join('\n');
}

/** What is known of a job in the machine, after waiting up to `wait` seconds for it to end; with `digest`, its log's digest too. */
function inspectScript(dir: string, number: number, wait: number, digest: boolean): string {
	const lines = [
		`b=${quote(paths(dir, number).base)}`,
		'[ -e "$b.log" ] || { echo state=none; exit 0; }',
		`w=${Math.max(0, Math.floor(wait))}; end=$((SECONDS+w))`,
		'while [ "$w" -gt 0 ] && [ ! -e "$b.exit" ] && [ "$SECONDS" -lt "$end" ]; do sleep 1; done',
		'pid=$(cat "$b.pid" 2>/dev/null)',
		'alive=; [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && alive=1',
		// Between the job's end and its exit file there is a moment with neither: it is waited out.
		'[ -z "$alive" ] && [ ! -e "$b.exit" ] && sleep 1',
		'echo "exit=$(cat "$b.exit" 2>/dev/null)"',
		'echo "timedout=$([ -e "$b.timeout" ] && echo 1)"',
		'echo "stopped=$([ -e "$b.stopped" ] && echo 1)"',
		'echo "alive=$alive"',
		'echo "info=$(cat "$b.info" 2>/dev/null)"',
		'echo "now=$(date +%s)"',
		'echo "ended=$(stat -c %Y "$b.exit" 2>/dev/null)"',
	];
	if (digest) lines.push(...digestScript('"$b.log"'));
	return lines.join('\n');
}

/**
 * The lines of a script that print what `digestOf` is made from, for the log at `log` (a shell word): its line count,
 * then its lines that look like failures before its end, then its end. Last in a script, as `parseInspect` reads
 * everything after them as the log's. The repository's check (`repo-check.ts`) digests its log the same way.
 */
export function digestScript(log: string): string[] {
	return [
		`total=$(wc -l < ${log})`,
		'echo "lines=$total"',
		'echo @@fail',
		`head -n "$((total > ${TAIL_LINES} ? total - ${TAIL_LINES} : 0))" ${log} | grep -n -E -e ${quote(FAILURE)} | head -n ${FAILURE_LINES} | cut -c1-${LINE_CHARS}`,
		'echo @@tail',
		`tail -n ${TAIL_LINES} ${log} | cut -c1-${LINE_CHARS}`,
	];
}

export type Seen = {
	none: boolean;
	exitCode: number | null;
	timedOut: boolean;
	stopped: boolean;
	alive: boolean;
	info: { task: string; started: number; seconds: number } | null;
	now: number | null;
	ended: number | null;
	lines: number | null;
	failures: string;
	tail: string;
};

/** Terminal colours and progress bars redrawn with \r, as a log keeps them, read as the line they end as. */
const plain = (line: string) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\r').filter(Boolean).pop() ?? '';

export function parseInspect(output: string): Seen {
	const lines = output.split('\n');
	const fail = lines.indexOf('@@fail');
	const end = lines.indexOf('@@tail');
	const head = fail < 0 ? lines : lines.slice(0, fail);
	const failures = fail < 0 ? '' : lines.slice(fail + 1, end < 0 ? undefined : end).join('\n');
	const tail = end < 0 ? '' : lines.slice(end + 1).join('\n');
	const fields = new Map(head.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const));
	const num = (key: string) => (fields.get(key)?.trim() ? Number(fields.get(key)) : null);
	const [task, started, seconds] = (fields.get('info') ?? '').trim().split(' ');
	return {
		none: fields.get('state') === 'none',
		exitCode: num('exit'),
		timedOut: fields.get('timedout') === '1',
		stopped: fields.get('stopped') === '1',
		alive: fields.get('alive') === '1',
		info: task && started ? { task, started: Number(started) * 1000, seconds: Number(seconds) } : null,
		now: num('now') === null ? null : num('now')! * 1000,
		ended: num('ended') === null ? null : num('ended')! * 1000,
		lines: num('lines'),
		failures: failures.split('\n').map(plain).filter((line) => line.trim()).join('\n'),
		tail: tail.split('\n').map(plain).join('\n').trimEnd(),
	};
}

/** The first lines that fit in `chars`, or the last ones with `fromEnd`. */
function within(textIn: string, chars: number, fromEnd = false): string {
	if (textIn.length <= chars) return textIn;
	const lines = textIn.split('\n');
	const kept: string[] = [];
	let size = 0;
	for (const line of fromEnd ? lines.reverse() : lines) {
		if (size + line.length + 1 > chars) break;
		kept.push(line);
		size += line.length + 1;
	}
	return (fromEnd ? kept.reverse() : kept).join('\n');
}

/**
 * A log as the agent reads it without any model: its failure-looking lines, then its end, a few KB at most, secrets
 * hidden. `partChars` bounds each of the two parts, for a shorter digest.
 */
export function digestOf(seen: Pick<Seen, 'failures' | 'tail' | 'lines'>, log: string, hide: (text: string) => string, partChars = PART_CHARS): string {
	const failures = within(hide(seen.failures), partChars);
	const tail = within(hide(seen.tail), partChars, true);
	return [
		`Log: ${log}${seen.lines === null ? '' : ` (${seen.lines.toLocaleString('en-US')} lines)`}; grep it for more.`,
		failures ? `Lines that look like failures (line: text):\n${failures}${failures.length < seen.failures.length ? '\n…' : ''}` : '',
		tail ? `Last lines:\n${tail}` : 'The log is empty.',
	]
		.filter(Boolean)
		.join('\n');
}

/** The job's state from what the machine shows, for a job this server watches. */
function settle(job: Job, seen: Seen, now: number): void {
	if (job.status !== 'running') return;
	if (seen.exitCode !== null) {
		job.exitCode = seen.exitCode;
		job.status = seen.stopped ? 'stopped' : seen.timedOut ? 'timed out' : 'exited';
		job.endedAt = now;
	} else if (seen.none || (!seen.alive && seen.info)) {
		job.status = 'unknown';
		job.lost = 'it ended with no exit code written';
		job.endedAt = now;
	}
}

/** Its state in a few words: `exited with code 1 after 3m 12s`. */
function stateText(job: Job, now: number): string {
	const ran = durationText((job.endedAt ?? now) - job.startedAt);
	switch (job.status) {
		case 'running':
			return `still running, ${ran} so far`;
		case 'exited':
			return `exited with code ${job.exitCode} after ${ran}`;
		case 'timed out':
			return `timed out after ${ran} (its limit was ${durationText(job.timeoutMs)}) and was stopped`;
		case 'stopped':
			return `stopped after ${ran}`;
		case 'unknown':
			return `in an unknown state: ${job.lost ?? 'its sandbox is not running'}`;
	}
}

/**
 * Holds one exec open until the job's exit file appears or its time is up, then notes how it ended. Past its time
 * with no exit code (a machine without `timeout`), it is stopped here. A machine that stopped leaves it unknown;
 * an exec cut short on a machine still running is held again.
 */
async function watch(id: string, job: Job, machine: Machine, d: Deps): Promise<void> {
	for (let failures = 0; job.status === 'running'; ) {
		const left = Math.max(1, Math.ceil((job.startedAt + job.timeoutMs - d.now()) / 1000) + KILL_GRACE_S + 5);
		let problem: unknown = null;
		try {
			const result = await machine.exec(inspectScript(d.dir, job.number, left, false), { timeoutMs: (left + 30) * 1000 });
			settle(job, parseInspect(text(result.stdout)), d.now());
			if (job.status !== 'running') return;
			if (d.now() >= job.startedAt + job.timeoutMs + KILL_GRACE_S * 1000) {
				await kill(machine, d.dir, job.number, 'timeout').catch(() => undefined);
				job.status = 'timed out';
				job.endedAt = d.now();
				return;
			}
			problem = new Error(result.stderr.trim() || `The watch ended early (exit ${result.exitCode})`);
		} catch (error) {
			problem = error;
		}
		failures += 1;
		if (!(await d.live(id).catch(() => null)) || failures > 3) {
			job.status = 'unknown';
			job.lost = 'its sandbox stopped before it ended';
			job.endedAt = d.now();
			if (failures > 3) logProblem('warn', 'Lost track of a background job', problem, id);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 5_000));
	}
}

/** Stops the job's whole process group, marked first so a reading after a restart says why it ended. */
async function kill(machine: Machine, dir: string, number: number, why: 'stopped' | 'timeout'): Promise<void> {
	const b = quote(paths(dir, number).base);
	await machine.exec(
		[
			// A job that has ended keeps its own exit code and is not marked.
			`b=${b}; pid=$(cat "$b.pid" 2>/dev/null); [ -n "$pid" ] && [ ! -e "$b.exit" ] || exit 0`,
			`: > "$b.${why}"`,
			'kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null',
			'for i in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done',
			'kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null',
			'for i in $(seq 30); do [ -e "$b.exit" ] && break; sleep 0.1; done',
		].join('\n'),
		{ timeoutMs: 60_000 },
	);
}

export type Started = { job: number; log: string; output: string };

/**
 * Starts `command` detached in the task's working folder, with the environment its shell has, and returns at once
 * with its number and log. `timeoutS` sets its limit (30 minutes by default, never past a reply's).
 */
export async function startJob(id: string, command: string, timeoutS: number | undefined, deps: Partial<Deps> = {}): Promise<Started> {
	const d = { ...defaults, ...deps };
	const timeoutMs = Math.min(Math.max(1_000, timeoutS ? timeoutS * 1000 : DEFAULT_TIMEOUT_MS), d.limitMs);
	const [machine, secrets] = await Promise.all([d.machine(id), d.secrets(id)]);
	const own = jobsOf(id);
	const first = Math.max(0, ...own.jobs.keys()) + 1;
	const result = await machine.exec(startScript(d.dir, first, id, d.cwd(machine), command, Math.ceil(timeoutMs / 1000)), { timeoutMs: 60_000 });
	const number = Number(text(result.stdout).trim().split('\n').pop());
	if (result.exitCode !== 0 || !Number.isInteger(number) || number < 1) {
		throw new Error(`The job did not start: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
	}
	const { log } = paths(d.dir, number);
	const job: Job = {
		number,
		command,
		log,
		startedAt: d.now(),
		timeoutMs,
		status: 'running',
		exitCode: null,
		endedAt: null,
		lost: null,
		told: false,
		read: false,
		sentRunning: false,
		sentUnread: false,
		hide: redactor(secrets),
		watched: Promise.resolve(),
	};
	own.jobs.set(number, job);
	if (own.jobs.size > KEEP_JOBS) own.jobs.delete(own.jobs.keys().next().value!);
	own.reply.add(number);
	job.watched = watch(id, job, machine, d).catch((error: unknown) => logProblem('warn', 'Lost track of a background job', error, id));
	return {
		job: number,
		log,
		output: `Job ${number} started; its output goes to ${log}. You will be told when it ends: go on with other work meanwhile, and call check_job ${number} for its exit code and failures.`,
	};
}

/** A job of an earlier run of this server, read back from its files, for `check_job` on a number it does not know. */
function recovered(number: number, seen: Seen, dir: string): Job {
	const startedAt = seen.info!.started;
	const now = seen.now ?? startedAt;
	const status: JobStatus = seen.exitCode !== null ? (seen.stopped ? 'stopped' : seen.timedOut ? 'timed out' : 'exited') : seen.alive ? 'running' : 'unknown';
	return {
		number,
		command: '',
		log: paths(dir, number).log,
		startedAt,
		timeoutMs: seen.info!.seconds * 1000,
		status,
		exitCode: seen.exitCode,
		endedAt: status === 'running' ? null : (seen.ended ?? now),
		lost: status === 'unknown' ? 'it ended with no exit code written' : null,
		told: true,
		read: true,
		sentRunning: true,
		sentUnread: true,
		hide: (textIn) => textIn,
		watched: Promise.resolve(),
	};
}

export type CheckOptions = { wait?: number; stop?: boolean; signal?: AbortSignal };

/**
 * A job's status, exit code, time and log digest, after waiting up to `wait` seconds (at most `MAX_WAIT_S`) for it
 * to end, in one exec; with `stop`, after stopping it. Reads only a running machine. A number this server does not
 * know (it restarted) is read back from the job's files, when they are this task's.
 */
export async function checkJob(id: string, number: number, options: CheckOptions = {}, deps: Partial<Deps> = {}): Promise<string> {
	const d = { ...defaults, ...deps };
	const known = tasks.get(id)?.jobs.get(number);
	const machine = await d.live(id).catch(() => null);
	if (!machine) {
		if (!known) return `No job ${number} is known, and the sandbox is not running.`;
		if (known.status === 'running') {
			known.status = 'unknown';
			known.lost = 'its sandbox is not running';
			known.endedAt = d.now();
		}
		known.told = known.read = true;
		return `Job ${number} (${shortCommand(known)}) is ${stateText(known, d.now())}. Its log was ${known.log}.`;
	}
	const wait = options.stop ? 0 : Math.min(Math.max(0, options.wait ?? 0), MAX_WAIT_S);
	const inspect = async (seconds: number, digest: boolean) =>
		parseInspect(text((await machine.exec(inspectScript(d.dir, number, seconds, digest), { timeoutMs: (seconds + 60) * 1000, signal: options.signal })).stdout));
	// A number this server does not know is read first, so a stop never reaches another task's job (local tasks share /tmp).
	const before = known ? null : await inspect(0, false);
	if (before && (before.none || before.info?.task !== id)) return `No job ${number} in this task.`;
	if (options.stop && (known ? known.status === 'running' : before!.exitCode === null)) await kill(machine, d.dir, number, 'stopped');
	const seen = await inspect(wait, true);
	if (seen.none) return `No job ${number} in this task.`;
	const job = known ?? recovered(number, seen, d.dir);
	const hide = known ? job.hide : redactor(await d.secrets(id).catch(() => ({})));
	if (options.stop && job.status === 'running') {
		job.status = 'stopped';
		job.exitCode = seen.exitCode;
		job.endedAt = d.now();
	}
	settle(job, seen, d.now());
	if (job.status !== 'running') job.told = job.read = true;
	const now = known ? d.now() : (seen.now ?? d.now());
	const name = job.command ? ` (${shortCommand(job)})` : '';
	return `Job ${number}${name} is ${stateText(job, now)}.\n${digestOf(seen, job.log, hide)}`;
}

/**
 * The line a `bash` result ends with for each job of the task that ended since the agent last heard of it, once
 * a job; empty when none did. The same kind of line as the reply clock's (`reply-clock.ts`).
 */
export function jobNotice(id: string, now = Date.now()): string {
	const own = tasks.get(id);
	if (!own) return '';
	const lines: string[] = [];
	for (const job of own.jobs.values()) {
		if (job.status === 'running' || job.told) continue;
		job.told = true;
		const ran = durationText((job.endedAt ?? now) - job.startedAt);
		const what =
			job.status === 'exited'
				? `ended: exit ${job.exitCode} after ${ran}. check_job ${job.number} has its ${job.exitCode === 0 ? 'summary' : 'failures'}.`
				: job.status === 'timed out'
					? `timed out after ${ran} and was stopped. check_job ${job.number} has its log.`
					: job.status === 'stopped'
						? // A command run beside the check_job that stops the job can end before that call has its result.
							`was stopped after ${ran}.`
						: `ended in an unknown state (${job.lost}). check_job ${job.number} has what is known.`;
		lines.push(`\n[anton] Job ${job.number} (${shortCommand(job)}) ${what}`);
	}
	return lines.join('');
}

/** A new reply: the jobs it starts are the ones its end is checked for. */
export function startJobsGate(id: string): void {
	tasks.get(id)?.reply.clear();
}

/** Whether a job of the task is running and within its time, so the idle stop leaves its sandbox up until it ends. */
export function hasRunningJob(id: string, now = Date.now()): boolean {
	for (const job of tasks.get(id)?.jobs.values() ?? []) {
		if (job.status === 'running' && now < job.startedAt + job.timeoutMs + KILL_GRACE_S * 1000 + 60_000) return true;
	}
	return false;
}

/** Stops the jobs the reply in hand started that still run: a reply stopped by the user leaves nothing running. */
export async function stopReplyJobs(id: string, deps: Partial<Deps> = {}): Promise<void> {
	const d = { ...defaults, ...deps };
	const own = tasks.get(id);
	const running = [...(own?.reply ?? [])].map((number) => own!.jobs.get(number)).filter((job): job is Job => job?.status === 'running');
	if (!running.length) return;
	const machine = await d.live(id).catch(() => null);
	await Promise.all(
		running.map(async (job) => {
			if (machine) await kill(machine, d.dir, job.number, 'stopped').catch((error: unknown) => logProblem('warn', 'Could not stop a background job', error, id));
			job.status = 'stopped';
			job.endedAt = d.now();
			job.told = job.read = true;
		}),
	);
}

type Call = { tool: string };

/**
 * At the end of a reply: a job it started that still runs sends it back to wait for the job (or stop it), and a job
 * that ended with its result never read sends it back with that result inline. Each job is the cause of at most one
 * send-back each way, so this never loops. Never on an aborted reply or one that ends on `ask` or `propose_plan`.
 */
export async function jobsGate(id: string, calls: readonly Call[], context: { signal?: AbortSignal } = {}, deps: Partial<Deps> = {}): Promise<string | null> {
	const d = { ...defaults, ...deps };
	if (context.signal?.aborted) return null;
	const last = calls[calls.length - 1]?.tool;
	if (last === 'ask' || last === 'propose_plan') return null;
	const own = tasks.get(id);
	if (!own?.reply.size) return null;
	const parts: string[] = [];
	for (const number of own.reply) {
		const job = own.jobs.get(number);
		if (!job) continue;
		if (job.status === 'running') {
			if (job.sentRunning) continue;
			job.sentRunning = true;
			parts.push(
				`Job ${number} (${shortCommand(job)}) is still running, ${durationText(d.now() - job.startedAt)} so far. ` +
					`Wait for it with check_job ${number} (wait) and act on its result before you end, or stop it (stop: true) if its result no longer matters.`,
			);
		} else if (!job.read && !job.sentUnread) {
			job.sentUnread = true;
			job.told = job.read = true;
			const digest = await readDigest(id, job, d);
			parts.push(`Job ${number} (${shortCommand(job)}) ${stateText(job, d.now())}, and you have not read its result:\n${digest}\nAct on it before you end.`);
		}
	}
	return parts.length ? parts.join('\n\n') : null;
}

async function readDigest(id: string, job: Job, d: Deps): Promise<string> {
	const machine = await d.live(id).catch(() => null);
	if (!machine) return `Its log, ${job.log}, cannot be read: the sandbox is not running.`;
	try {
		const result = await machine.exec(inspectScript(d.dir, job.number, 0, true), { timeoutMs: 60_000 });
		return digestOf(parseInspect(text(result.stdout)), job.log, job.hide);
	} catch (error) {
		logProblem('warn', 'Could not read a background job’s log', error, id);
		return `Its log is ${job.log}.`;
	}
}

/** Settles once every watch of the task's jobs has: for tests. */
export async function settledJobs(id: string): Promise<void> {
	await Promise.all([...(tasks.get(id)?.jobs.values() ?? [])].map((job) => job.watched));
}
