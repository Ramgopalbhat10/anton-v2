import { AppWindow, Bot, FileDiff, Files, GitPullRequest, Globe, History, Library, Monitor, SquareTerminal } from '@/lib/icons';

export const panels = [
	{ name: 'Changes', icon: FileDiff, desc: 'What the agent changed that GitHub does not have yet, as a diff' },
	{ name: 'PR', icon: GitPullRequest, desc: "The thread's pull requests: checks, discussion, diff, and Merge" },
	{ name: 'Agents', icon: Bot, desc: 'The subagents the agent hands work to, live, step by step' },
	{ name: 'Terminal', icon: SquareTerminal, desc: 'The sandbox shell and its command output' },
	{ name: 'Files', icon: Files, desc: 'Browse the repository on the task branch' },
	{ name: 'Preview', icon: Globe, desc: 'The app the agent is running, live from the sandbox' },
	{ name: 'Browser', icon: AppWindow, desc: 'A real browser for any site; pick elements or draw for the agent' },
	{ name: 'Computer', icon: Monitor, desc: "Watch the agent test local apps on the sandbox's screen, or take over" },
	{ name: 'Library', icon: Library, desc: 'Reports, screenshots and exports the agent saved' },
	{ name: 'History', icon: History, desc: 'Earlier states of the files, to compare or restore' },
] as const;

export type PanelName = (typeof panels)[number]['name'];
