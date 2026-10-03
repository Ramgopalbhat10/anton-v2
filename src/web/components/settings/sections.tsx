import type { LucideIcon } from 'lucide-react';
import { Activity, Folder, HardDrive, SquareTerminal, TriangleAlert } from 'lucide-react';
import type { ComponentType } from 'react';
import { CommandsPage } from './commands';
import { ProblemsPage } from './problems';
import { RepositoriesPage } from './repositories';
import { StoragePage } from './storage';
import { UsagePage } from './usage';

export type SectionGroup = 'anton' | 'infrastructure' | 'agent';

export const GROUPS: Array<{ id: SectionGroup; label: string; desc: string }> = [
	{ id: 'anton', label: 'Anton', desc: 'What Anton spends, and what went wrong' },
	{ id: 'infrastructure', label: 'Infrastructure', desc: 'Where tasks run, and what is kept between them' },
	{ id: 'agent', label: 'Agent', desc: 'What the agent may work on, and the prompts you reuse' },
];

export type SettingsSection = { id: string; group: SectionGroup; label: string; icon: LucideIcon; desc: string; Page: ComponentType };

/** Every settings page, in nav order. A new page is one entry here. */
export const SECTIONS: SettingsSection[] = [
	{ id: 'usage', group: 'anton', label: 'Usage and limits', icon: Activity, desc: 'Model spend and the caps that stop it', Page: UsagePage },
	{ id: 'problems', group: 'anton', label: 'Recent problems', icon: TriangleAlert, desc: 'Warnings and errors from work that runs on its own', Page: ProblemsPage },
	{ id: 'storage', group: 'infrastructure', label: 'Storage', icon: HardDrive, desc: 'Checkpoints, diffs and Library files, and their cleanup', Page: StoragePage },
	{ id: 'repos', group: 'agent', label: 'Repositories', icon: Folder, desc: 'What tasks can work on, each with its own settings', Page: RepositoriesPage },
	{ id: 'commands', group: 'agent', label: 'Commands', icon: SquareTerminal, desc: 'Saved prompts you type as /name', Page: CommandsPage },
];

export const sectionById = (id: string | undefined) => SECTIONS.find((section) => section.id === id);
