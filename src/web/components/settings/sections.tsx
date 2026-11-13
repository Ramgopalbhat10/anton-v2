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

import { GROUPS, SECTION_LIST, type SectionInfo } from './section-list';

export { GROUPS };
export type { SectionGroup } from './section-list';

export type SettingsSection = SectionInfo & { Page: ComponentType };

const PAGES: Record<string, ComponentType> = {
	general: GeneralPage,
	subscriptions: SubscriptionsPage,
	notifications: NotificationsPage,
	connections: ConnectionsPage,
	usage: UsagePage,
	problems: ProblemsPage,
	compute: ComputePage,
	sandboxes: SandboxesPage,
	images: ImagesPage,
	storage: StoragePage,
	repos: RepositoriesPage,
	secrets: SecretsPage,
	guardrails: GuardrailsPage,
	connectors: ConnectorsPage,
	skills: SkillsPage,
	commands: CommandsPage,
};

/** Every settings page, in nav order, with its page. */
export const SECTIONS: SettingsSection[] = SECTION_LIST.map((section) => ({ ...section, Page: PAGES[section.id] }));

export const sectionById = (id: string | undefined) => SECTIONS.find((section) => section.id === id);
