import { InvalidInputError, NotFoundError } from '../core/errors.ts';
import type { Issue, Reasoning } from '../core/ports.ts';
import type { Project } from '../core/types.ts';
import {
	type Automation,
	claimIssue,
	deleteAutomation,
	getAutomation,
	insertAutomation,
	issueTasks,
	listAutomations,
	releaseIssue,
	setIssueTask,
	updateAutomation,
} from '../db/automations.ts';
import { getProject } from '../db/projects.ts';
import { getProviders } from '../providers/index.ts';
import { isWorking } from './activity.ts';
import { sendToAgent } from './agent-runner.ts';
import { budget } from './budget.ts';
import { createSession, deleteSession } from './sessions.ts';

/** At most this many issue tasks of a repo work at once, so labeling a backlog does not start them all together. */
const ISSUES_AT_ONCE = 3;
const HOUR_MS = 60 * 60_000;

export type AutomationInput = { kind: Automation['kind']; label?: string | null; everyHours?: number | null; prompt: string; model?: string | null; reasoning?: Reasoning | null };

export async function addAutomation(projectId: string, input: AutomationInput): Promise<Automation> {
	if (!(await getProject(projectId))) throw new NotFoundError('Project not found');
	const label = input.label?.trim() || null;
	if (input.kind === 'issues' && !label) throw new InvalidInputError('Name the label that marks issues for Anton');
	if (input.kind === 'schedule' && !(input.everyHours && input.prompt.trim())) throw new InvalidInputError('A schedule needs hours and instructions');
	return insertAutomation({
		projectId,
		kind: input.kind,
		label: input.kind === 'issues' ? label : null,
		everyHours: input.kind === 'schedule' ? (input.everyHours ?? null) : null,
		prompt: input.prompt.trim(),
		model: input.model || null,
		reasoning: input.model ? (input.reasoning ?? null) : null,
	});
}

export const automations = (projectId: string) => listAutomations(projectId);

async function existing(id: string): Promise<Automation> {
	const automation = await getAutomation(id);
	if (!automation) throw new NotFoundError('Automation not found');
	return automation;
}

export async function setAutomationEnabled(id: string, enabled: boolean): Promise<Automation> {
	await existing(id);
	await updateAutomation(id, { enabled });
	return existing(id);
}

export async function removeAutomation(id: string): Promise<void> {
	await existing(id);
	await deleteAutomation(id);
}

function issuePrompt(issue: Issue, extra: string): string {
	return [
		`Resolve GitHub issue #${issue.number}: ${issue.title}`,
		issue.url,
		'',
		issue.body.trim() || '(The issue has no description.)',
		...(extra ? ['', extra] : []),
		'',
		`When the change is done and checked, call open_pull_request with a clear title and a description that includes "Closes #${issue.number}".`,
	].join('\n');
}

/** Creates a task and gives its agent the instructions, the same as typing them on the launcher. */
async function startTask(automation: Automation, title: string, prompt: string): Promise<string> {
	const session = await createSession({ projectId: automation.projectId, title, model: automation.model ?? undefined, reasoning: automation.reasoning ?? undefined });
	// A task its agent never heard about would only clutter the list; the next run tries again.
	await sendToAgent(session.id, prompt).catch(async (error: unknown) => {
		await deleteSession(session.id);
		throw error;
	});
	return session.id;
}

type Run = { now: number; force: boolean };

const running = new Set<string>();

/** Each kind starts what is due and returns what to remember about this run. */
const runners: Record<Automation['kind'], (automation: Automation, project: Project, run: Run) => Promise<Partial<Automation>>> = {
	async issues(automation, project, { now }) {
		const issues = await getProviders().git.listIssues(project.repoFullName, automation.label ?? '');
		const taken = await issueTasks(project.id);
		const room = ISSUES_AT_ONCE - taken.sessions.filter(isWorking).length;
		for (const issue of issues.filter((item) => !taken.issues.has(item.number)).slice(0, Math.max(room, 0))) {
			// Claimed first, so another automation, a recreated one or Run now never starts a second task for it.
			if (!(await claimIssue(project.id, issue.number, automation.id))) continue;
			const id = await startTask(automation, `#${issue.number} ${issue.title}`.slice(0, 200), issuePrompt(issue, automation.prompt)).catch(
				async (error: unknown) => {
					await releaseIssue(project.id, issue.number);
					throw error;
				},
			);
			await setIssueTask(project.id, issue.number, id);
		}
		return { lastRunAt: new Date(now).toISOString() };
	},
	async schedule(automation, _project, { now, force }) {
		// The first run comes one interval after the schedule is added; Run now starts one sooner.
		const since = Date.parse(automation.lastRunAt ?? automation.createdAt);
		const due = force || now - since >= (automation.everyHours ?? 24) * HOUR_MS;
		if (!due) return {};
		await startTask(automation, automation.prompt.split('\n')[0].slice(0, 80), automation.prompt);
		return { lastRunAt: new Date(now).toISOString() };
	},
};

/**
 * Starts the tasks an automation is due to start; `force` runs a schedule
 * early. Errors are kept on the automation for the settings page.
 */
export async function runAutomation(id: string, { now = Date.now(), force = false } = {}): Promise<Automation> {
	// Run now and the timer can meet; one run at a time, reading the automation only once it holds the turn.
	if (running.has(id)) return existing(id);
	running.add(id);
	try {
		const automation = await existing(id);
		const project = await getProject(automation.projectId);
		if (!project) throw new NotFoundError('Project not found');
		const update = await runners[automation.kind](automation, project, { now, force });
		await updateAutomation(id, { lastError: null, ...update });
	} catch (error) {
		await updateAutomation(id, { lastError: error instanceof Error ? error.message : String(error) });
	} finally {
		running.delete(id);
	}
	return existing(id);
}

/** Runs every enabled automation that is due; nothing starts while today's spending cap is reached. */
export async function runDueAutomations(now = Date.now()): Promise<void> {
	if ((await budget()).blocked) return;
	for (const automation of await listAutomations()) {
		if (automation.enabled) await runAutomation(automation.id, { now });
	}
}
