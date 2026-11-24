import { registerRoutedModels } from '../../core/routed-models.ts';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { config } from '../../config.ts';
import { ConflictError } from '../../core/errors.ts';
import type { McpServer } from '../../core/types.ts';
import { getProject } from '../../db/projects.ts';
import { getSessionRecord, listSessionRecords } from '../../db/sessions.ts';
import { assertWithinBudget } from '../models/budget.ts';
import { type AgentModel, generalSettings, HELPER_AGENTS, type HelperAgent, type VisualReplies } from '../models/general.ts';
import { type SetUpConnector, setUpConnectors } from '../connectors/connector-tools.ts';
import { enabledMcpServers } from '../connectors/mcp-servers.ts';
import { type SealedSecretBrief, sealedSecretBriefs } from '../secrets/sealed-secrets.ts';
import { serverTools } from '../connectors/mcp-tools.ts';
import { findModel, reasoningFor } from '../models/models.ts';
import { primeSkills } from '../settings/plugins.ts';
import { logProblem } from '../../core/log.ts';
import { isRestoring } from '../git/restore.ts';
import { type ModelChoice, primeModel } from './sessions.ts';
import { getSpace, type Space } from '../../db/spaces.ts';
import { primeAllCoordinators, primeCoordinator } from '../projects/coordinator.ts';

/**
 * The agent renders synchronously, so it reads the set-up connectors from here; filled before every message.
 * Its connector tools read whether each is on as they run, so turning one on or off never changes the prompt.
 */
const connectors = new Map<string, SetUpConnector[]>();

export function connectorsFor(id: string): SetUpConnector[] {
	return connectors.get(id) ?? [];
}

const onHost = new Set<string>();

export const runsOnHost = (id: string): boolean => onHost.has(id);

const sealedSecrets = new Map<string, SealedSecretBrief[]>();

export function sealedSecretsFor(id: string): SealedSecretBrief[] {
	return sealedSecrets.get(id) ?? [];
}

const WEB = 'web';

function webServer(id: string): McpServer[] {
	if (config.web.mcpUrl === 'off' || connectorsFor(id).some((connector) => connector.kind === 'mcp' && connector.name === WEB)) return [];
	return [{ name: WEB, url: config.web.mcpUrl, auth: config.web.apiKey || null, tools: ['web_search', 'web_fetch'] }];
}

/** Cheap to list, so its two tools stay direct even with code mode on. */
export function isWebServer(server: McpServer): boolean {
	return server.name === WEB && server.url === config.web.mcpUrl;
}

/** Connectors' servers are reached on demand through the connector tools, not here. */
export function mcpServersFor(id: string): McpServer[] {
	return webServer(id);
}

/** Read once, when the task's agent first starts on this server: a note saved later would change the system prompt and lose its cache. */
const memories = new Map<string, string>();

export function memoryFor(id: string): string {
	return memories.get(id) ?? '';
}

export type ThreadProject = { id: string; name: string; goal: string; instructions: string; memory: string };
const threadProjects = new Map<string, ThreadProject>();

export function threadProjectFor(id: string): ThreadProject | null {
	return threadProjects.get(id) ?? null;
}

const workspaces = new Set<string>();

export function hasWorkspace(id: string): boolean {
	return workspaces.has(id);
}

export function noteWorkspace(id: string): void {
	workspaces.add(id);
}

/** A thread moved to another repository reads that repository's memory and starts without a workspace. */
export function forgetRepoContext(id: string): void {
	memories.delete(id);
	workspaces.delete(id);
}

const chats = new Set<string>();

export function isChat(id: string): boolean {
	return chats.has(id);
}

const planning = new Set<string>();

export function isPlanning(id: string): boolean {
	return planning.has(id);
}

export type ReviewTask = { url: string; number: number; author: string };
const reviewTasks = new Map<string, ReviewTask>();

export function reviewTaskFor(id: string): ReviewTask | null {
	return reviewTasks.get(id) ?? null;
}

export type AgentSettings = { codeMode: boolean; visualReplies: VisualReplies; pageNetwork: boolean; models: Record<HelperAgent, ModelChoice | null> };

let agentSettings: AgentSettings = { codeMode: true, visualReplies: 'some', pageNetwork: true, models: { explorer: null, tester: null, browser: null, computer: null, reviewer: null } };

export const agentSettingsNow = (): AgentSettings => agentSettings;

const threadHelperModels = new Map<string, Record<HelperAgent, ModelChoice | null>>();

export function helperModelFor(id: string, agent: HelperAgent): ModelChoice | null {
	return threadHelperModels.get(id)?.[agent] ?? agentSettings.models[agent];
}

async function choiceFor(setting: AgentModel | null): Promise<ModelChoice | null> {
	if (!setting) return null;
	const info = await findModel(setting.model).catch(() => undefined);
	return { model: setting.model, reasoning: reasoningFor(info, setting.reasoning) };
}

async function primeAgentSettings(): Promise<void> {
	const { codeMode, visualReplies, pageNetwork, agentModels } = await generalSettings();
	const models = Object.fromEntries(await Promise.all(HELPER_AGENTS.map(async (agent) => [agent, await choiceFor(agentModels[agent])] as const)));
	agentSettings = { codeMode, visualReplies, pageNetwork, models: models as AgentSettings['models'] };
	registerRoutedModels('helpers:general', Object.values(agentSettings.models).map((choice) => choice?.model));
}

async function helperModelsOf(space: Space): Promise<Record<HelperAgent, ModelChoice | null>> {
	return Object.fromEntries(await Promise.all(HELPER_AGENTS.map(async (agent) => [agent, await choiceFor(space.agentModels[agent])] as const))) as Record<HelperAgent, ModelChoice | null>;
}

/** The parts that do not need each other are read at once, as a message waits for all of them before the agent starts. */
export async function primeAgent(id: string, { warm = true }: { warm?: boolean } = {}): Promise<void> {
	const [session, setUp, sealed] = await Promise.all([
		getSessionRecord(id),
		setUpConnectors(),
		sealedSecretBriefs().catch(() => []),
		primeModel(id),
		primeAgentSettings(),
		primeSkills(id),
	]);
	const [project, space] = await Promise.all([session && getProject(session.projectId), session?.spaceId ? getSpace(session.spaceId) : null]);
	connectors.set(id, setUp);
	sealedSecrets.set(id, sealed);
	// The servers that are on start listing their tools behind the message, so the agent's first look is quick; nothing waits for them.
	if (warm && setUp.some((connector) => connector.kind === 'mcp')) void enabledMcpServers()
			.then((servers) => servers.forEach((server) => void serverTools(server).catch(() => undefined)))
			.catch(() => undefined);
	if (!memories.has(id)) memories.set(id, project?.memory ?? '');
	// The project's memory is kept as first read too, for the same reason; its name, goal and instructions follow edits.
	if (space) {
		threadProjects.set(id, { id: space.id, name: space.name, goal: space.goal, instructions: space.instructions, memory: threadProjects.get(id)?.id === space.id ? threadProjects.get(id)!.memory : space.memory });
		threadHelperModels.set(id, await helperModelsOf(space));
	} else {
		threadProjects.delete(id);
		threadHelperModels.delete(id);
	}
	registerRoutedModels(`helpers:${id}`, Object.values(threadHelperModels.get(id) ?? {}).map((choice) => choice?.model));
	if (session?.machineState) workspaces.add(id);
	if (session?.runOn === 'host') onHost.add(id);
	else onHost.delete(id);
	if (session && !session.projectId) chats.add(id);
	else chats.delete(id);
	if (session?.planMode) planning.add(id);
	else planning.delete(id);
	if (session?.review && session.prUrl) reviewTasks.set(id, { url: session.prUrl, number: session.review.number, author: session.review.author });
	else reviewTasks.delete(id);
}

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

const PRIME_AT_ONCE = 4;

/** Startup waits only for the tasks the runtime resumes, whose replies reach the agent without a prompt; the rest prime behind it, a few at a time. */
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

export type DeliveredImage = { type: 'image'; data: string; mimeType: string; filename?: string };

export async function primeIncognito(id: string): Promise<void> {
	const [setUp, sealed] = await Promise.all([setUpConnectors(), sealedSecretBriefs().catch(() => [])]);
	connectors.set(id, setUp);
	sealedSecrets.set(id, sealed);
	await primeAgentSettings();
	chats.add(id);
	if (!memories.has(id)) memories.set(id, '');
}

export function releaseIncognito(id: string): void {
	connectors.delete(id);
	sealedSecrets.delete(id);
	memories.delete(id);
	workspaces.delete(id);
	onHost.delete(id);
	chats.delete(id);
	planning.delete(id);
	reviewTasks.delete(id);
	threadProjects.delete(id);
	threadHelperModels.delete(id);
}
type Deliver = (id: string, text: string, images?: DeliveredImage[]) => Promise<string | void>;
export type AgentName = 'coder' | 'reviewer' | 'coordinator';
const deliveries = new Map<AgentName, Deliver>();

/** Registered by the app, so services never import the agent modules. */
export function setAgentDelivery(next: Deliver, agent: AgentName = 'coder'): void {
	deliveries.set(agent, next);
}

export async function sendToAgent(id: string, text: string, agent: AgentName = 'coder', images: DeliveredImage[] = []): Promise<string | undefined> {
	const deliver = deliveries.get(agent);
	if (!deliver) throw new Error('Agent delivery is not set up');
	if (isRestoring(id)) throw new ConflictError('Files are being restored');
	await assertWithinBudget(id);
	if (agent === 'coordinator') await primeCoordinator(id);
	else await primeAgent(id);
	return (await deliver(id, text, images)) ?? undefined;
}
