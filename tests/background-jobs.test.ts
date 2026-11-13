import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Machine } from '../src/core/ports.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-jobs-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { localSandboxProvider } = await import('../src/providers/local/sandbox.ts');
const jobs = await import('../src/services/background-jobs.ts');
const { checkJob, digestOf, durationText, hasRunningJob, jobNotice, jobsGate, parseInspect, settledJobs, startJob, startJobsGate, stopReplyJobs } = jobs;

const resources = { runtime: 'container' as const, cpu: 1, memoryMiB: 1024, idleTimeoutMs: 60_000, lifetimeMs: 60_000, regions: [], allowedDomains: [] };
const { machine } = await localSandboxProvider(path.join(dir, 'data')).acquire({ key: 'jobs', state: null, image: null, baseImage: null, ports: [], resources });
mkdirSync(path.join(machine.root, 'repo'), { recursive: true });
const deps = {
	machine: async () => machine,
	live: async (): Promise<Machine | null> => machine,
	secrets: async () => ({ API_TOKEN: 'supersecretvalue' }),
	dir: path.join(dir, 'jobs'),
	limitMs: 4 * 3_600_000,
};

/** A run that fails the way a test runner does: a failure early, many lines after it, then its summary. */
const FAILING = 'echo "not ok 1 - parses dates"; for i in $(seq 40); do echo "ok $((i+1)) - case $i"; done; sleep 1.5; echo "using supersecretvalue in $(pwd)"; echo "# fail 1"; exit 3';

test('a job starts at once, runs in the working folder, and its result has its exit code and a digest of its log with secrets hidden', async () => {
	startJobsGate('t1');
	const started = Date.now();
	const job = await startJob('t1', FAILING, undefined, deps);
	assert.ok(Date.now() - started < 5_000, 'did not wait for the command');
	assert.equal(job.log, `${deps.dir}/${job.job}.log`);
	assert.match(job.output, new RegExp(`^Job ${job.job} started; its output goes to .*${job.job}\\.log\\. You will be told when it ends`));
	assert.match(await checkJob('t1', job.job, {}, deps), /is still running, \d+s so far/);
	assert.ok(hasRunningJob('t1'));
	const result = await checkJob('t1', job.job, { wait: 20 }, deps);
	assert.match(result, /exited with code 3 after/);
	assert.match(result, /Lines that look like failures \(line: text\):\n1:not ok 1 - parses dates/);
	assert.match(result, /Last lines:\n[\s\S]*# fail 1$/);
	assert.match(result, /\[API_TOKEN hidden\]/);
	assert.doesNotMatch(result, /supersecretvalue/);
	assert.ok(result.includes(`in ${machine.root}/repo`), 'ran in the repository folder');
	assert.ok(result.length < 5_000, 'a few KB at most');
	await settledJobs('t1');
	assert.equal(hasRunningJob('t1'), false);
	// It was read, so neither a notice nor the gate brings it up again.
	assert.equal(jobNotice('t1'), '');
	assert.equal(await jobsGate('t1', [{ tool: 'bash' }], {}, deps), null);
});

test('the server learns a job ended on its own, and the next command result says so once', async () => {
	startJobsGate('t2');
	const job = await startJob('t2', 'echo hi; exit 1', undefined, deps);
	await settledJobs('t2');
	const notice = jobNotice('t2');
	assert.match(notice, new RegExp(`^\\n\\[anton\\] Job ${job.job} \\(echo hi; exit 1\\) ended: exit 1 after \\d+s\\. check_job ${job.job} has its failures\\.$`));
	assert.equal(jobNotice('t2'), '', 'once a job');
});

test('a job past its time is stopped and reported as timed out', async () => {
	startJobsGate('t3');
	const job = await startJob('t3', 'echo start; sleep 30', 1, deps);
	await settledJobs('t3');
	assert.match(jobNotice('t3'), new RegExp(`Job ${job.job} \\(echo start; sleep 30\\) timed out after \\d+s and was stopped`));
	assert.match(await checkJob('t3', job.job, {}, deps), /timed out after \d+s \(its limit was 1s\) and was stopped/);
});

test('stop kills the job with everything it started', async () => {
	startJobsGate('t4');
	const job = await startJob('t4', 'sleep 31 & sleep 32; echo never', undefined, deps);
	const result = await checkJob('t4', job.job, { stop: true }, deps);
	assert.match(result, /is stopped after/);
	assert.match(result, /\nThe log is empty\.$/, 'it never got to its echo');
	await settledJobs('t4');
	const left = await machine.exec('pgrep -f "^sleep 3[12]$" || true');
	assert.equal(new TextDecoder().decode(left.stdout).trim(), '', 'its whole process group is gone');
	assert.equal(jobNotice('t4'), '', 'the agent stopped it and needs no notice');
});

test('an unknown job, or another task’s, is reported as none', async () => {
	assert.equal(await checkJob('t5', 999, {}, deps), 'No job 999 in this task.');
	const other = await startJob('t5-other', 'true', undefined, deps);
	await settledJobs('t5-other');
	assert.equal(await checkJob('t5', other.job, { stop: true }, deps), `No job ${other.job} in this task.`);
	assert.equal(await checkJob('t5', 1, {}, { ...deps, live: async () => null }), 'No job 1 is known, and the sandbox is not running.');
});

test('after a restart, a job is read back from its files', async () => {
	const job = await startJob('t6', 'echo done; exit 4', undefined, deps);
	await settledJobs('t6');
	// A second copy of the module is a server that knows none of the jobs.
	const restarted = '../src/services/background-jobs.ts?restart';
	const fresh = (await import(restarted)) as typeof jobs;
	assert.match(await fresh.checkJob('t6', job.job, {}, deps), new RegExp(`^Job ${job.job} is exited with code 4 after \\d+s\\.\\nLog: `));
});

test('the gate sends a reply back once for a job still running, and once with an unread result inline', async () => {
	startJobsGate('g1');
	const job = await startJob('g1', 'sleep 2; echo "FAIL src/a.test.ts"; exit 1', undefined, deps);
	const running = await jobsGate('g1', [{ tool: 'run_in_background' }], {}, deps);
	assert.match(running ?? '', new RegExp(`^Job ${job.job} \\(sleep 2; .*\\) is still running, \\d+s so far\\. Wait for it with check_job ${job.job} \\(wait\\)`));
	assert.equal(await jobsGate('g1', [{ tool: 'bash' }], {}, deps), null, 'once while it runs');
	await settledJobs('g1');
	const unread = await jobsGate('g1', [{ tool: 'bash' }], {}, deps);
	assert.match(unread ?? '', new RegExp(`^Job ${job.job} .* exited with code 1 after \\d+s, and you have not read its result:\\nLog: .*\\nLast lines:\\nFAIL src/a.test.ts\\nAct on it before you end\\.$`));
	assert.equal(await jobsGate('g1', [{ tool: 'bash' }], {}, deps), null, 'once with its result');
	assert.equal(jobNotice('g1'), '', 'the result reached the agent');
});

test('the gate leaves alone a reply that asks, proposes a plan or was aborted, and jobs of earlier replies', async () => {
	startJobsGate('g2');
	await startJob('g2', 'sleep 1', undefined, deps);
	for (const [calls, context] of [
		[[{ tool: 'ask' }], {}],
		[[{ tool: 'propose_plan' }], {}],
		[[{ tool: 'bash' }], { signal: AbortSignal.abort() }],
	] as const) {
		assert.equal(await jobsGate('g2', calls, context, deps), null);
	}
	startJobsGate('g2');
	assert.equal(await jobsGate('g2', [{ tool: 'bash' }], {}, deps), null, 'a new reply did not start it');
	await settledJobs('g2');
});

test('a stopped reply stops the jobs it started', async () => {
	startJobsGate('g3');
	const job = await startJob('g3', 'sleep 33', undefined, deps);
	await stopReplyJobs('g3', deps);
	await settledJobs('g3');
	assert.match(await checkJob('g3', job.job, {}, deps), /is stopped after/);
	assert.equal(await jobsGate('g3', [{ tool: 'bash' }], {}, deps), null);
});

test('a digest keeps failures and the end within a few KB', () => {
	const seen = parseInspect(
		['exit=1', 'timedout=', 'stopped=', 'alive=', 'info=t 1700000000 1800', 'now=1700000100', 'ended=1700000090', 'lines=5000', '@@fail', ...Array.from({ length: 40 }, (_, i) => `${i + 1}:\x1b[31mFAIL\x1b[0m case ${i} ${'x'.repeat(200)}`), '@@tail', 'progress 10%\rprogress 100%', '# pass 3', '# fail 1'].join('\n'),
	);
	assert.equal(seen.exitCode, 1);
	assert.equal(seen.info?.started, 1_700_000_000_000);
	const digest = digestOf(seen, '/tmp/anton-jobs/1.log', (text) => text);
	assert.ok(digest.length < 4_500, String(digest.length));
	assert.match(digest, /^Log: \/tmp\/anton-jobs\/1\.log \(5,000 lines\); grep it for more\.\nLines that look like failures \(line: text\):\n1:FAIL case 0/);
	assert.match(digest, /\n…\nLast lines:\nprogress 100%\n# pass 3\n# fail 1$/);
	assert.equal(durationText(3 * 60_000 + 12_000), '3m 12s');
	assert.equal(durationText(65 * 60_000), '1h 5m');
});

test('a job whose pipeline fails ends with the failure, not the exit code of its last command', async () => {
	startJobsGate('pipe');
	const job = await startJob('pipe', 'echo "not ok 1 - x"; false | tail -5', undefined, deps);
	await settledJobs('pipe');
	assert.match(await checkJob('pipe', job.job, {}, deps), /exited with code 1 after/);
});
