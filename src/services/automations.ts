import { InvalidInputError, NotFoundError } from '../core/errors.ts';
import type { Issue, Reasoning } from '../core/ports.ts';
import type { Project } from '../core/types.ts';
import { describeSchedule, nextRun, normalizeSchedule, type Schedule, type ScheduleInput, scheduleProblem } from '../core/schedule.ts';
import {
	type Automation,
	claimIssue,
	deleteAutomation,
	getAutomation,
	insertAutomation,
	issueTasks,
	listAutomations,
	listSpaceAutomations,
	type NewAutomation,
	releaseIssue,
	setIssueTask,
	updateAutomation,
} from '../db/automations.ts';
import { getProject } from '../db/projects.ts';
import { getSpace } from '../db/spaces.ts';
import { getProviders } from '../providers/index.ts';
import { isWorking } from './activity.ts';
import { sendToAgent } from './agent-runner.ts';
import { budget } from './budget.ts';
import { createSession, deleteSession } from './sessions.ts';
import { startThread } from './spaces.ts';
import { logProblem } from './log.ts';
import { threadStarted } from './thread-reports.ts';
import { type ShortTitle, shortTitle, titleFrom } from './titles.ts';
import { recordUsage } from './usage.ts';

/** At most this many issue tasks of a repo work at once, so labeling a backlog does not start them all together. */
const ISSUES_AT_ONCE = 3;
/** A scheduled run that could not start tries again this much later, rather than at every check. */
const RETRY_MS = 5 * 60_000;

export type AutomationInput = {
	kind: Automation['kind'];
	label?: string | null;
	schedule?: ScheduleInput | null;
	prompt: string;
	model?: string | null;
	reasoning?: Reasoning | null;
	planFirst?: boolean;
	/** A project to start its tasks in, as threads; the repository must be one of the project's. */
	spaceId?: string | null;
};

/**
 * An automation's settings once checked: on a repository, or with `projectId` null a project's routine whose
 * threads start as chats. Those need the project, and can only run on a schedule, since labeled issues belong
 * to a repository.
 */
async function checked(projectId: string | null, input: AutomationInput): Promise<NewAutomation> {
	if (projectId && !(await getProject(projectId))) throw new NotFoundError('Project not found');
	if (!projectId && !input.spaceId) throw new InvalidInputError('Pick a repository');
	if (!projectId && input.kind === 'issues') throw new InvalidInputError('Labeled issues need a repository');
	if (input.spaceId) {
		const space = await getSpace(input.spaceId);
		if (!space) throw new NotFoundError('Project not found');
		if (projectId && !space.repoIds.includes(projectId)) throw new InvalidInputError('That repository is not in this project');
	}
	const label = input.label?.trim() || null;
	if (input.kind === 'issues' && !label) throw new InvalidInputError('Name the label that marks issues for Anton');
	const schedule = input.kind === 'schedule' && input.schedule ? normalizeSchedule(input.schedule) : null;
	if (input.kind === 'schedule') {
		if (!schedule) throw new InvalidInputError('Pick when the routine runs');
		const problem = scheduleProblem(schedule);
		if (problem) throw new InvalidInputError(problem);
		if (!input.prompt.trim()) throw new InvalidInputError('A schedule needs instructions');
	}
	return {
		projectId: projectId ?? '',
		kind: input.kind,
		label: input.kind === 'issues' ? label : null,
		schedule,
		// Counted from now: a new or changed schedule runs at its next time, never for times already past.
		nextRunAt: schedule ? upcoming(schedule, Date.now()) : null,
		prompt: input.prompt.trim(),
		model: input.model || null,
		reasoning: input.model ? (input.reasoning ?? null) : null,
		planFirst: input.planFirst ?? false,
		spaceId: input.spaceId ?? null,
	};
}

/** Adds an automation on a repository, or with `projectId` null a project's routine whose threads start as chats. */
export async function addAutomation(projectId: string | null, input: AutomationInput): Promise<Automation> {
	return insertAutomation(await checked(projectId, input));
}

/**
 * Changes what an automation does, checked as when it was added. It stays where it is: a repository's on that
 * repository, a project's routine in its project, where `projectId` picks its repository (null for chats) and
 * leaving it out keeps the one it has. Its runs, and the issues it picked up, are kept.
 */
export async function editAutomation(id: string, input: Omit<AutomationInput, 'spaceId'> & { projectId?: string | null }): Promise<Automation> {
	const automation = await existing(id);
	const projectId = automation.spaceId && input.projectId !== undefined ? input.projectId || null : automation.projectId || null;
	const { spaceId: _space, ...change } = await checked(projectId, {
		...input,
		planFirst: input.planFirst ?? automation.planFirst,
		spaceId: automation.spaceId,
	});
	// New instructions are named again at the next run.
	await updateAutomation(id, { ...change, ...(change.prompt !== automation.prompt ? { title: null } : {}) });
	return existing(id);
}

export const automations = (projectId: string) => listAutomations(projectId);
export const spaceAutomations = (spaceId: string) => listSpaceAutomations(spaceId);

async function existing(id: string): Promise<Automation> {
	const automation = await getAutomation(id);
	if (!automation) throw new NotFoundError('Automation not found');
	return automation;
}

export async function setAutomationEnabled(id: string, enabled: boolean): Promise<Automation> {
	const automation = await existing(id);
	// Turned back on, a schedule picks up at its next time rather than making up for the runs it was off for.
	const resumed = enabled && !automation.enabled && automation.schedule ? { nextRunAt: upcoming(automation.schedule, Date.now()) } : {};
	await updateAutomation(id, { enabled, ...resumed });
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

/**
 * Creates a task and gives its agent the instructions, the same as typing them on the launcher. A project's
 * routine starts it as one of the project's threads instead, which waits its turn when the project is busy.
 */
async function startTask(automation: Automation, title: string, prompt: string): Promise<string> {
	if (automation.spaceId) {
		const thread = await startThread(automation.spaceId, {
			projectId: automation.projectId || null,
			title,
			brief: prompt,
			automationId: automation.id,
			model: automation.model ?? undefined,
			reasoning: automation.reasoning ?? undefined,
			planMode: automation.planFirst,
		});
		// The coordinator did not start it, so it hears of it, and its feed shows it as it starts.
		await threadStarted(thread.id, { by: 'routine', routine: automation.schedule ? describeSchedule(automation.schedule) : `on issues labeled “${automation.label}”` });
		return thread.id;
	}
	if (!automation.projectId) throw new NotFoundError('Project not found');
	const session = await createSession({
		projectId: automation.projectId,
		title,
		automationId: automation.id,
		model: automation.model ?? undefined,
		reasoning: automation.reasoning ?? undefined,
		planMode: automation.planFirst,
	});
	// A task its agent never heard about would only clutter the list; the next run tries again.
	await sendToAgent(session.id, prompt).catch(async (error: unknown) => {
		await deleteSession(session.id);
		throw error;
	});
	return session.id;
}

/** The day a run started on its schedule's clock, as its thread's title ends: runs of one routine read apart in lists and in the project's Library. */
const runDay = (now: number, timeZone?: string) => new Date(now).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone });

/** A schedule's next run after `now`, as kept on the automation. */
const upcoming = (schedule: Schedule, now: number) => nextRun(schedule, new Date(now))?.toISOString() ?? null;

/**
 * When a schedule is due: its next run as kept, or for one kept before next runs were (an "every N hours"
 * routine moved to a schedule), the first after its last run, else after it was added.
 */
function dueAt(automation: Automation & { schedule: Schedule }): number {
	if (automation.nextRunAt) return Date.parse(automation.nextRunAt);
	const next = nextRun(automation.schedule, new Date(automation.lastRunAt ?? automation.createdAt));
	return next ? next.getTime() : Number.POSITIVE_INFINITY;
}

/**
 * A routine's short name, its runs' title: written once from its instructions by the title model and kept on it
 * (until they change), or the start of them without one. `spent` is the model's call, counted on the run it names.
 */
async function routineName(automation: Automation): Promise<{ name: string; spent: ShortTitle | null }> {
	if (automation.title) return { name: automation.title, spent: null };
	const named = await shortTitle(automation.prompt).catch((error: unknown) => {
		logProblem('warn', 'Could not name the routine', error);
		return null;
	});
	if (!named) return { name: titleFrom(automation.prompt) || 'Routine', spent: null };
	await updateAutomation(automation.id, { title: named.title });
	return { name: named.title, spent: named };
}

type Run = { now: number; force: boolean };

const running = new Set<string>();

/** Each kind starts what is due and returns what to remember about this run. */
const runners: Record<Automation['kind'], (automation: Automation, project: Project | null, run: Run) => Promise<Partial<Automation>>> = {
	async issues(automation, project, { now }) {
		if (!project) throw new InvalidInputError('Labeled issues need a repository');
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
		const { schedule } = automation;
		if (!schedule) throw new InvalidInputError('Pick when the routine runs');
		// Run now starts one early; the schedule's next time stands. A run missed while Anton was down starts once.
		if (!force && dueAt({ ...automation, schedule }) > now) return {};
		const { name, spent } = await routineName(automation);
		const id = await startTask(automation, `${name} · ${runDay(now, schedule.timeZone)}`, automation.prompt).catch(async (error: unknown) => {
			if (!force) await updateAutomation(automation.id, { nextRunAt: new Date(now + RETRY_MS).toISOString() });
			throw error;
		});
		if (spent) await recordUsage(id, spent.usage, spent.model);
		return { lastRunAt: new Date(now).toISOString(), nextRunAt: upcoming(schedule, now) };
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
		// A project's routine without a repository starts its threads as chats.
		const project = automation.projectId ? await getProject(automation.projectId) : null;
		if (automation.projectId && !project) throw new NotFoundError('Project not found');
		const update = await runners[automation.kind](automation, project, { now, force });
		await updateAutomation(id, { lastError: null, ...update });
	} catch (error) {
		await updateAutomation(id, { lastError: error instanceof Error ? error.message : String(error) });
	} finally {
		running.delete(id);
	}
	return existing(id);
}

/** Runs every enabled automation (of `kind`, if given) that is due; nothing starts while today's spending cap is reached. */
export async function runDueAutomations(now = Date.now(), kind?: Automation['kind']): Promise<void> {
	if ((await budget()).blocked) return;
	for (const automation of await listAutomations()) {
		if (automation.enabled && (!kind || automation.kind === kind)) await runAutomation(automation.id, { now });
	}
}
