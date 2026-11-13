import type { LucideIcon } from 'lucide-react';
import { Activity, BellRing, Blocks, Box, Cpu, CreditCard, Folder, HardDrive, KeyRound, Layers, Link, Plug, Settings2, ShieldCheck, SquareTerminal, TriangleAlert } from 'lucide-react';

export type SectionGroup = 'anton' | 'infrastructure' | 'agent';

export const GROUPS: Array<{ id: SectionGroup; label: string; desc: string }> = [
	{ id: 'anton', label: 'Anton', desc: 'Connections, spend and problems' },
	{ id: 'infrastructure', label: 'Infrastructure', desc: 'Where tasks run and what is kept' },
	{ id: 'agent', label: 'Agent', desc: 'What the agent may use, and your prompts' },
];

/** What names a settings page, without the page: the command palette lists these without loading any settings code. */
export type SectionInfo = { id: string; group: SectionGroup; label: string; icon: LucideIcon; desc: string };

/** Every settings page, in nav order. A new page is one entry here and its page in `sections.tsx`. */
export const SECTION_LIST: SectionInfo[] = [
	{ id: 'general', group: 'anton', label: 'General', icon: Settings2, desc: 'The model and mode new tasks start with' },
	{ id: 'subscriptions', group: 'anton', label: 'Subscriptions', icon: CreditCard, desc: 'Plans you already pay for, and your gateway keys' },
	{ id: 'notifications', group: 'anton', label: 'Notifications', icon: BellRing, desc: 'Hear when a task needs you' },
	{ id: 'connections', group: 'anton', label: 'Connections', icon: Link, desc: 'GitHub, Modal, storage and models, checked live' },
	{ id: 'usage', group: 'anton', label: 'Usage and limits', icon: Activity, desc: 'Model spend and the caps that stop it' },
	{ id: 'problems', group: 'anton', label: 'Recent problems', icon: TriangleAlert, desc: 'Warnings and errors from work that runs on its own' },
	{ id: 'compute', group: 'infrastructure', label: 'Compute', icon: Box, desc: 'Where sandboxes run, and which are running now' },
	{ id: 'sandboxes', group: 'infrastructure', label: 'Sandboxes', icon: Cpu, desc: 'Machine size, region, timeouts and allowed domains' },
	{ id: 'images', group: 'infrastructure', label: 'Images', icon: Layers, desc: 'The base image, and each repository’s prepared image' },
	{ id: 'storage', group: 'infrastructure', label: 'Storage', icon: HardDrive, desc: 'Checkpoints, diffs and Library files, and their cleanup' },
	{ id: 'repos', group: 'agent', label: 'Repositories', icon: Folder, desc: 'What tasks can work on, each with its own settings' },
	{ id: 'secrets', group: 'agent', label: 'Secrets', icon: KeyRound, desc: 'Environment variables for sandboxes' },
	{ id: 'guardrails', group: 'agent', label: 'Guardrails', icon: ShieldCheck, desc: 'What the agent cannot see or do' },
	{ id: 'connectors', group: 'agent', label: 'Connectors', icon: Plug, desc: 'Gmail and MCP servers for every task' },
	{ id: 'skills', group: 'agent', label: 'Skills', icon: Blocks, desc: 'Skills and plugins from GitHub and marketplaces' },
	{ id: 'commands', group: 'agent', label: 'Commands', icon: SquareTerminal, desc: 'Saved prompts you type as /name' },
];
