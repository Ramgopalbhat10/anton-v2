import { existsSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { config } from '../config.ts';
import { ConflictError } from '../core/errors.ts';
import type { McpServer } from '../core/types.ts';
import { getProject } from '../db/projects.ts';
import { getSessionRecord, listSessionRecords } from '../db/sessions.ts';
import { assertWithinBudget } from './budget.ts';
import { type AgentModel, generalSettings, HELPER_AGENTS, type HelperAgent, type VisualReplies } from './general.ts';
import { type MailboxAccess, mailboxAccess, mailboxes } from './connectors.ts';
import { enabledMcpServers } from './mcp-servers.ts';
import { warmServerTools } from './mcp-tools.ts';
import { findModel, reasoningFor } from './models.ts';
import { primeSkills } from './plugins.ts';
import { logProblem } from './log.ts';
import { isRestoring } from './restore.ts';
import { type ModelChoice, primeModel } from './sessions.ts';
import { getSpace } from '../db/spaces.ts';
import { primeAllCoordinators, primeCoordinator } from './coordinator.ts';

/**
 * The agent renders synchronously, so it reads each task's MCP servers from
 * here: the ones on in Settings › Connectors. Filled before every message, with the model.
 */
const servers = new Map<string, McpServer[]>();

/** Web search and fetch for every task, unless turned off or an added server already uses the name. */
function webServer(added: McpServer[]): McpServer[] {
	if (config.web.mcpUrl === 'off' || added.some((server) => server.name === WEB)) return [];
	return [{ name: WEB, url: config.web.mcpUrl, auth: config.web.apiKey || null, tools: ['web_search', 'web_fetch'] }];
}

const WEB = 'web';

/** The built-in web search server: cheap to list, so its two tools stay direct even with code mode on. */
export function isWebServer(server: McpServer): boolean {
	return server.name === WEB && server.url === config.web.mcpUrl;
}

/** The MCP servers a task's agent connects to: web search, then the ones added in Settings › Connectors. */
export function mcpServersFor(id: string): McpServer[] {
	const added = servers.get(id) ?? [];
	return [...webServer(added), ...added];
}

/** The mailboxes connected in Settings › Connectors and what the agent may do in each, read while it renders. */
export type ConnectedMailbox = { id: string; name: string; access: MailboxAccess };
const mail = new Map<string, ConnectedMailbox[]>();

export function mailboxesFor(id: string): ConnectedMailbox[] {
	return mail.get(id) ?? [];
}

async function connectedMailboxes(): Promise<ConnectedMailbox[]> {
	const found = await Promise.all(mailboxes().map(async ({ id, name }) => ({ id, name, access: await mailboxAccess(id).catch(() => null) })));
	return found.filter((mailbox): mailbox is ConnectedMailbox => mailbox.access !== null);
}

/** Each task's repo notes, read into the agent's instructions. */
const memories = new Map<string, string>();

export function memoryFor(id: string): string {
	return memories.get(id) ?? '';
}

/** What a project's thread knows of its project: name, goal, instructions and memory. Empty outside a project. */
export type ThreadProject = { id: string; name: string; goal: string; instructions: string; memory: string };
const threadProjects = new Map<string, ThreadProject>();

export function threadProjectFor(id: string): ThreadProject | null {
	return threadProjects.get(id) ?? null;
}

/** Tasks that have had a machine: the agent works there rather than starting read-only. */
const workspaces = new Set<string>();

export function hasWorkspace(id: string): boolean {
	return workspaces.has(id);
}

/** Chats: tasks with no repository, which answer, browse and use a scratch sandbox rather than read and change code. */
const chats = new Set<string>();

export function isChat(id: string): boolean {
	return chats.has(id);
}

/** Tasks in plan mode: the agent may look but not change anything until the plan is approved. */
const planning = new Set<string>();

export function isPlanning(id: string): boolean {
	return planning.has(id);
}

/** Someone else's pull request a task reviews: the coder gets post_review instead of pushing. */
export type ReviewTask = { url: string; number: number; author: string };
const reviewTasks = new Map<string, ReviewTask>();

export function reviewTaskFor(id: string): ReviewTask | null {
	return reviewTasks.get(id) ?? null;
}

/** The General settings the agents read while they render: whether the coder gets run_script, and each helper agent's model (null for the task's own). */
export type AgentSettings = { codeMode: boolean; visualReplies: VisualReplies; pageNetwork: boolean; models: Record<HelperAgent, ModelChoice | null> };

let agentSettings: AgentSettings = { codeMode: true, visualReplies: 'some', pageNetwork: true, models: { explorer: null, tester: null, browser: null, computer: null, reviewer: null } };

export const agentSettingsNow = (): AgentSettings => agentSettings;

async function choiceFor(setting: AgentModel | null): Promise<ModelChoice | null> {
	if (!setting) return null;
	const info = await findModel(setting.model).catch(() => undefined);
	return { model: setting.model, reasoning: reasoningFor(info, setting.reasoning) };
}

async function primeAgentSettings(): Promise<void> {
	const { codeMode, visualReplies, pageNetwork, agentModels } = await generalSettings();
	const models = Object.fromEntries(await Promise.all(HELPER_AGENTS.map(async (agent) => [agent, await choiceFor(agentModels[agent])] as const)));
	agentSettings = { codeMode, visualReplies, pageNetwork, models: models as AgentSettings['models'] };
}

/** How long a message waits for the MCP servers to list their tools, so run_script can describe them. */
const WARM_MS = 5000;

/**
 * Loads what the agent reads while it renders: the task's model, the MCP servers that are on (and, with code mode on,
 * their tool lists), notes and skills, whether it has a machine and whether it is planning. The parts that do not
 * need each other are read at once, as a message waits for all of them before the agent starts.
 */
export async function primeAgent(id: string, { warm = true }: { warm?: boolean } = {}): Promise<void> {
	const [session, added, mailboxes] = await Promise.all([
		getSessionRecord(id),
		enabledMcpServers(),
		connectedMailboxes(),
		primeModel(id),
		primeAgentSettings(),
		primeSkills(id),
	]);
	const [project, space] = await Promise.all([session && getProject(session.projectId), session?.spaceId ? getSpace(session.spaceId) : null]);
	servers.set(id, added);
	mail.set(id, mailboxes);
	if (warm && agentSettings.codeMode) await warmServerTools(mcpServersFor(id).filter((server) => server.codeMode !== false && !isWebServer(server)), WARM_MS);
	memories.set(id, project?.memory ?? '');
	if (space) threadProjects.set(id, { id: space.id, name: space.name, goal: space.goal, instructions: space.instructions, memory: space.memory });
	else threadProjects.delete(id);
	if (session?.machineState) workspaces.add(id);
	if (session && !session.projectId) chats.add(id);
	else chats.delete(id);
	if (session?.planMode) planning.add(id);
	else planning.delete(id);
	if (session?.review && session.prUrl) reviewTasks.set(id, { url: session.prUrl, number: session.review.number, author: session.review.author });
	else reviewTasks.delete(id);
}

/** The tasks whose replies the runtime will pick up again: those with a message it has not settled. Null when its record cannot be read. */
export async function unsettledTasks(file = path.join(config.dataDir, 'flue.db')): Promise<Set<string> | null> {
	if (!existsSync(file)) return new Set();
	const flue = createClient({ url: `file:${file}` });
	try {
		const rows = (await flue.execute("SELECT DISTINCT session_key FROM flue_agent_submissions WHERE status IN ('queued', 'running', 'terminalizing', 'joining', 'joined')")).rows;
		// `agent-session:["Coder","<task id>","default","default"]`; the reviewer's are named by the task too.
		return new Set(rows.map((row) => String((JSON.parse(String(row.session_key).replace(/^agent-session:/, '')) as string[])[1])));
	} catch (error) {
		logProblem('warn', 'Could not read which replies the runtime will resume', error);
		return null;
	} finally {
		flue.close();
	}
}

/** How many of the other tasks are primed at a time once startup is done. */
const PRIME_AT_ONCE = 4;

/**
 * Loads the model and MCP servers of each task the runtime will resume at startup, whose replies reach the agent
 * without passing through a prompt; startup waits for only these. Every other task is primed by its next message,
 * and also here behind startup, a few at a time, for anything that reads them sooner.
 */
export async function primeAllAgents(file?: string): Promise<void> {
	const sessions = await listSessionRecords();
	const resumed = await unsettledTasks(file);
	const first = resumed ? sessions.filter((session) => resumed.has(session.id)) : sessions;
	// Tool lists are read when a message needs them, not for every task at startup.
	await Promise.all(first.map((session) => primeAgent(session.id, { warm: false }).catch(() => undefined)));
	await primeAllCoordinators().catch(() => undefined);
	const rest = sessions.filter((session) => !first.includes(session));
	void (async () => {
		for (let at = 0; at < rest.length; at += PRIME_AT_ONCE) {
			await Promise.all(rest.slice(at, at + PRIME_AT_ONCE).map((session) => primeAgent(session.id, { warm: false }).catch(() => undefined)));
		}
	})();
}

/** An image handed to the agent with a message, as the runtime takes it: a thread's brief carries the pictures attached to it. */
export type DeliveredImage = { type: 'image'; data: string; mimeType: string; filename?: string };
type Deliver = (id: string, text: string, images?: DeliveredImage[]) => Promise<void>;
/**
 * The agents a task has: the coder it talks to, and the reviewer that reads its pull requests, both on the
 * task's machine and caps; and a project's coordinator, addressed by the project's id, which has no machine.
 */
export type AgentName = 'coder' | 'reviewer' | 'coordinator';
const deliveries = new Map<AgentName, Deliver>();

/** The app registers how to deliver a message to each agent, so services never import the agent modules. */
export function setAgentDelivery(next: Deliver, agent: AgentName = 'coder'): void {
	deliveries.set(agent, next);
}

/** Sends a message nobody typed (an issue, a schedule, a failed check, a review request) to one of a task's agents, within the caps. */
export async function sendToAgent(id: string, text: string, agent: AgentName = 'coder', images: DeliveredImage[] = []): Promise<void> {
	const deliver = deliveries.get(agent);
	if (!deliver) throw new Error('Agent delivery is not set up');
	if (isRestoring(id)) throw new ConflictError('Files are being restored');
	await assertWithinBudget(id);
	if (agent === 'coordinator') await primeCoordinator(id);
	else await primeAgent(id);
	await deliver(id, text, images);
}
