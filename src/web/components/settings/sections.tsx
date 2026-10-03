import type { LucideIcon } from 'lucide-react';
import { Activity, Box, Cpu, Folder, HardDrive, KeyRound, Layers, Link, Settings2, ShieldCheck, SquareTerminal, TriangleAlert } from 'lucide-react';
import type { ComponentType } from 'react';
import { CommandsPage } from './commands';
import { ComputePage } from './compute';
import { ConnectionsPage } from './connections';
import { GeneralPage } from './general';
import { GuardrailsPage } from './guardrails';
import { ImagesPage } from './images';
import { ProblemsPage } from './problems';
import { RepositoriesPage } from './repositories';
import { SandboxesPage } from './sandboxes';
import { SecretsPage } from './secrets';
import { StoragePage } from './storage';
import { UsagePage } from './usage';

export type SectionGroup = 'anton' | 'infrastructure' | 'agent';

export const GROUPS: Array<{ id: SectionGroup; label: string; desc: string }> = [
	{ id: 'anton', label: 'Anton', desc: 'What Anton is connected to, what it spends, and what went wrong' },
	{ id: 'infrastructure', label: 'Infrastructure', desc: 'Where tasks run, and what is kept between them' },
	{ id: 'agent', label: 'Agent', desc: 'What the agent may work on and see, and the prompts you reuse' },
];

export type SettingsSection = { id: string; group: SectionGroup; label: string; icon: LucideIcon; desc: string; Page: ComponentType };

/** Every settings page, in nav order. A new page is one entry here. */
export const SECTIONS: SettingsSection[] = [
	{ id: 'general', group: 'anton', label: 'General', icon: Settings2, desc: 'The model and mode new tasks start with', Page: GeneralPage },
	{ id: 'connections', group: 'anton', label: 'Connections', icon: Link, desc: 'GitHub, Modal, storage, models and web search, checked live', Page: ConnectionsPage },
	{ id: 'usage', group: 'anton', label: 'Usage and limits', icon: Activity, desc: 'Model spend and the caps that stop it', Page: UsagePage },
	{ id: 'problems', group: 'anton', label: 'Recent problems', icon: TriangleAlert, desc: 'Warnings and errors from work that runs on its own', Page: ProblemsPage },
	{ id: 'compute', group: 'infrastructure', label: 'Compute', icon: Box, desc: 'Where sandboxes run, and which are running now', Page: ComputePage },
	{ id: 'sandboxes', group: 'infrastructure', label: 'Sandboxes', icon: Cpu, desc: 'Machine size, region, timeouts and allowed domains', Page: SandboxesPage },
	{ id: 'images', group: 'infrastructure', label: 'Images', icon: Layers, desc: 'The base image, and each repository’s prepared image', Page: ImagesPage },
	{ id: 'storage', group: 'infrastructure', label: 'Storage', icon: HardDrive, desc: 'Checkpoints, diffs and Library files, and their cleanup', Page: StoragePage },
	{ id: 'repos', group: 'agent', label: 'Repositories', icon: Folder, desc: 'What tasks can work on, each with its own settings', Page: RepositoriesPage },
	{ id: 'secrets', group: 'agent', label: 'Secrets', icon: KeyRound, desc: 'Variables for every repository’s sandboxes, and each one’s own', Page: SecretsPage },
	{ id: 'guardrails', group: 'agent', label: 'Guardrails', icon: ShieldCheck, desc: 'What the agent cannot see or do', Page: GuardrailsPage },
	{ id: 'commands', group: 'agent', label: 'Commands', icon: SquareTerminal, desc: 'Saved prompts you type as /name', Page: CommandsPage },
];

export const sectionById = (id: string | undefined) => SECTIONS.find((section) => section.id === id);
