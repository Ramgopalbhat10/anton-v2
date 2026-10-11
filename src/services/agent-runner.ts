import { config } from '../config.ts';
import { ConflictError } from '../core/errors.ts';
import type { McpServer } from '../core/types.ts';
import { getProject } from '../db/projects.ts';
import { getSessionRecord, listSessionRecords } from '../db/sessions.ts';
import { assertWithinBudget } from './budget.ts';
import { type AgentModel, generalSettings, HELPER_AGENTS, type HelperAgent } from './general.ts';
import { findModel, reasoningFor } from './models.ts';
import { primeSkills } from './plugins.ts';
import { isRestoring } from './restore.ts';
import { type ModelChoice, primeModel } from './sessions.ts';
import { getSpace } from '../db/spaces.ts';
import { primeAllCoordinators, primeCoordinator } from './coordinator.ts';

/**
 * The agent renders synchronously, so it reads each task's MCP servers from
 * here. Filled before every message, with the model.
 */
const servers = new Map<string, McpServer[]>();

/** Web search and fetch for every task, unless turned off or a repo server already uses the name. */
function webServer(repoServers: McpServer[]): McpServer[] {
	if (config.web.mcpUrl === 'off' || repoServers.some((server) => server.name === WEB)) return [];
	return [{ name: WEB, url: config.web.mcpUrl, auth: config.web.apiKey || null, tools: ['web_search', 'web_fetch'] }];
}

const WEB = 'web';

/** The MCP servers a task's agent connects to: web search, then its repo's own. */
export function mcpServersFor(id: string): McpServer[] {
	const repoServers = servers.get(id) ?? [];
	return [...webServer(repoServers), ...repoServers];
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

/** Tasks in plan mode: the agent may look but not change anything until the plan is approved. */
const planning = new Set<string>();

export function isPlanning(id: string): boolean {
	return planning.has(id);
}

/** The General settings the agents read while they render: whether the coder gets run_script, and each helper agent's model (null for the task's own). */
export type AgentSettings = { codeMode: boolean; models: Record<HelperAgent, ModelChoice | null> };

let agentSettings: AgentSettings = { codeMode: false, models: { explorer: null, tester: null, browser: null, reviewer: null } };

export const agentSettingsNow = (): AgentSettings => agentSettings;

async function choiceFor(setting: AgentModel | null): Promise<ModelChoice | null> {
	if (!setting) return null;
	const info = await findModel(setting.model).catch(() => undefined);
	return { model: setting.model, reasoning: reasoningFor(info, setting.reasoning) };
}

async function primeAgentSettings(): Promise<void> {
	const { codeMode, agentModels } = await generalSettings();
	const models = Object.fromEntries(await Promise.all(HELPER_AGENTS.map(async (agent) => [agent, await choiceFor(agentModels[agent])] as const)));
	agentSettings = { codeMode, models: models as AgentSettings['models'] };
}

/** Loads what the agent reads while it renders: the task's model, its repo's MCP servers, notes and skills, whether it has a machine and whether it is planning. */
export async function primeAgent(id: string): Promise<void> {
	await primeModel(id);
	await primeAgentSettings();
	const session = await getSessionRecord(id);
	const project = session && (await getProject(session.projectId));
	servers.set(id, project?.mcpServers ?? []);
	memories.set(id, project?.memory ?? '');
	const space = session?.spaceId ? await getSpace(session.spaceId) : null;
	if (space) threadProjects.set(id, { id: space.id, name: space.name, goal: space.goal, instructions: space.instructions, memory: space.memory });
	else threadProjects.delete(id);
	if (session?.machineState) workspaces.add(id);
	if (session?.planMode) planning.add(id);
	else planning.delete(id);
	await primeSkills(id);
}

/**
 * Loads every task's model and MCP servers, for replies the runtime resumes
 * at startup, which reach the agent without passing through a prompt.
 */
export async function primeAllAgents(): Promise<void> {
	for (const session of await listSessionRecords()) await primeAgent(session.id).catch(() => undefined);
	await primeAllCoordinators().catch(() => undefined);
}

type Deliver = (id: string, text: string) => Promise<void>;
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
export async function sendToAgent(id: string, text: string, agent: AgentName = 'coder'): Promise<void> {
	const deliver = deliveries.get(agent);
	if (!deliver) throw new Error('Agent delivery is not set up');
	if (isRestoring(id)) throw new ConflictError('Files are being restored');
	await assertWithinBudget(id);
	if (agent === 'coordinator') await primeCoordinator(id);
	else await primeAgent(id);
	await deliver(id, text);
}
