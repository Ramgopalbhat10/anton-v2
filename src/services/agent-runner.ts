import type { McpServer } from '../core/types.ts';
import { getProject } from '../db/projects.ts';
import { getSessionRecord } from '../db/sessions.ts';
import { assertWithinBudget } from './budget.ts';
import { primeModel } from './sessions.ts';

/**
 * The agent renders synchronously, so it reads each task's MCP servers from
 * here. Filled before every message, with the model.
 */
const servers = new Map<string, McpServer[]>();

export function mcpServersFor(id: string): McpServer[] {
	return servers.get(id) ?? [];
}

/** Loads what the agent reads while it renders: the task's model and its repo's MCP servers. */
export async function primeAgent(id: string): Promise<void> {
	await primeModel(id);
	const session = await getSessionRecord(id);
	const project = session && (await getProject(session.projectId));
	servers.set(id, project?.mcpServers ?? []);
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
	await assertWithinBudget(id);
	await primeAgent(id);
	await deliver(id, text);
}
