import { config } from '../config.ts';
import { ConflictError } from '../core/errors.ts';
import type { McpServer } from '../core/types.ts';
import { getProject } from '../db/projects.ts';
import { getSessionRecord, listSessionRecords } from '../db/sessions.ts';
import { assertWithinBudget } from './budget.ts';
import { isRestoring } from './restore.ts';
import { primeModel } from './sessions.ts';

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

/** Tasks that have had a machine: the agent works there rather than starting read-only. */
const workspaces = new Set<string>();

export function hasWorkspace(id: string): boolean {
	return workspaces.has(id);
}

/** Loads what the agent reads while it renders: the task's model, its repo's MCP servers and whether it has a machine. */
export async function primeAgent(id: string): Promise<void> {
	await primeModel(id);
	const session = await getSessionRecord(id);
	const project = session && (await getProject(session.projectId));
	servers.set(id, project?.mcpServers ?? []);
	if (session?.machineState) workspaces.add(id);
}

/**
 * Loads every task's model and MCP servers, for replies the runtime resumes
 * at startup, which reach the agent without passing through a prompt.
 */
export async function primeAllAgents(): Promise<void> {
	for (const session of await listSessionRecords()) await primeAgent(session.id).catch(() => undefined);
}

type Deliver = (id: string, text: string) => Promise<void>;
let deliver: Deliver | null = null;

/** The app registers how to deliver a message to the agent, so services never import the agent module. */
export function setAgentDelivery(next: Deliver): void {
	deliver = next;
}

/** Sends a message nobody typed (an issue, a schedule, a failed check) to a task's agent, within the caps. */
export async function sendToAgent(id: string, text: string): Promise<void> {
	if (!deliver) throw new Error('Agent delivery is not set up');
	if (isRestoring(id)) throw new ConflictError('Files are being restored');
	await assertWithinBudget(id);
	await primeAgent(id);
	await deliver(id, text);
}
