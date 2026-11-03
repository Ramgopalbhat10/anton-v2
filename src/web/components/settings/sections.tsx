import type { LucideIcon } from 'lucide-react';
import { Activity, BellRing, Blocks, Box, Cpu, CreditCard, Folder, HardDrive, KeyRound, Layers, Link, Plug, Settings2, ShieldCheck, SquareTerminal, TriangleAlert } from 'lucide-react';
import type { ComponentType } from 'react';
import { CommandsPage } from './commands';
import { ComputePage } from './compute';
import { ConnectionsPage } from './connections';
import { ConnectorsPage } from './connectors';
import { GeneralPage } from './general';
import { GuardrailsPage } from './guardrails';
import { ImagesPage } from './images';
import { NotificationsPage } from './notifications';
import { ProblemsPage } from './problems';
import { RepositoriesPage } from './repositories';
import { SandboxesPage } from './sandboxes';
import { SecretsPage } from './secrets';
import { SkillsPage } from './skills';
import { StoragePage } from './storage';
import { SubscriptionsPage } from './subscriptions';
import { UsagePage } from './usage';

export type SectionGroup = 'anton' | 'infrastructure' | 'agent';

export const GROUPS: Array<{ id: SectionGroup; label: string; desc: string }> = [
	{ id: 'anton', label: 'Anton', desc: 'Connections, spend and problems' },
	{ id: 'infrastructure', label: 'Infrastructure', desc: 'Where tasks run and what is kept' },
	{ id: 'agent', label: 'Agent', desc: 'What the agent may use, and your prompts' },
];

export type SettingsSection = { id: string; group: SectionGroup; label: string; icon: LucideIcon; desc: string; Page: ComponentType };

/** Every settings page, in nav order. A new page is one entry here. */
export const SECTIONS: SettingsSection[] = [
	{ id: 'general', group: 'anton', label: 'General', icon: Settings2, desc: 'The model and mode new tasks start with', Page: GeneralPage },
	{ id: 'subscriptions', group: 'anton', label: 'Subscriptions', icon: CreditCard, desc: 'Plans you already pay for, and your gateway keys', Page: SubscriptionsPage },
	{ id: 'notifications', group: 'anton', label: 'Notifications', icon: BellRing, desc: 'Hear when a task needs you', Page: NotificationsPage },
	{ id: 'connections', group: 'anton', label: 'Connections', icon: Link, desc: 'GitHub, Modal, storage and models, checked live', Page: ConnectionsPage },
	{ id: 'usage', group: 'anton', label: 'Usage and limits', icon: Activity, desc: 'Model spend and the caps that stop it', Page: UsagePage },
	{ id: 'problems', group: 'anton', label: 'Recent problems', icon: TriangleAlert, desc: 'Warnings and errors from work that runs on its own', Page: ProblemsPage },
	{ id: 'compute', group: 'infrastructure', label: 'Compute', icon: Box, desc: 'Where sandboxes run, and which are running now', Page: ComputePage },
	{ id: 'sandboxes', group: 'infrastructure', label: 'Sandboxes', icon: Cpu, desc: 'Machine size, region, timeouts and allowed domains', Page: SandboxesPage },
	{ id: 'images', group: 'infrastructure', label: 'Images', icon: Layers, desc: 'The base image, and each repository’s prepared image', Page: ImagesPage },
	{ id: 'storage', group: 'infrastructure', label: 'Storage', icon: HardDrive, desc: 'Checkpoints, diffs and Library files, and their cleanup', Page: StoragePage },
	{ id: 'repos', group: 'agent', label: 'Repositories', icon: Folder, desc: 'What tasks can work on, each with its own settings', Page: RepositoriesPage },
	{ id: 'secrets', group: 'agent', label: 'Secrets', icon: KeyRound, desc: 'Environment variables for sandboxes', Page: SecretsPage },
	{ id: 'guardrails', group: 'agent', label: 'Guardrails', icon: ShieldCheck, desc: 'What the agent cannot see or do', Page: GuardrailsPage },
	{ id: 'connectors', group: 'agent', label: 'Connectors', icon: Plug, desc: 'Gmail and MCP servers for every task', Page: ConnectorsPage },
	{ id: 'skills', group: 'agent', label: 'Skills', icon: Blocks, desc: 'Skills and plugins from GitHub and marketplaces', Page: SkillsPage },
	{ id: 'commands', group: 'agent', label: 'Commands', icon: SquareTerminal, desc: 'Saved prompts you type as /name', Page: CommandsPage },
];

export const sectionById = (id: string | undefined) => SECTIONS.find((section) => section.id === id);
