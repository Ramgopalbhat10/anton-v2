import { useQuery } from '@tanstack/react-query';
import { Blocks, FileText, SquareSlash } from 'lucide-react';
import { type KeyboardEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/signal';
import { api, type Command, type Plugin, type SkillSummary } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ARGUMENTS, matchPaths, SHOWN, type Trigger, triggerAt } from '@/lib/completion';

type Item = {
	key: string;
	label: string;
	detail: string;
	skill?: boolean;
	replace: (text: string, trigger: Trigger) => { text: string; caret: number };
};

/** Leaves `/name ` for what follows it: a skill's request, or a command's $ARGUMENTS. */
const keepName = (name: string) => (text: string, at: Trigger) => {
	const inserted = `/${name} `;
	return { text: inserted + text.slice(at.end).replace(/^ /, ''), caret: inserted.length };
};

function itemsFor(trigger: Trigger | null, paths: string[], commands: Command[], skills: SkillSummary[], keepCommands = false): Item[] {
	if (!trigger) return [];
	if (trigger.kind === '/') {
		const query = trigger.query.toLowerCase();
		const saved = commands.filter((command) => command.name.startsWith(query));
		const named = new Set(saved.map((command) => command.name));
		return [
			...saved.map((command) => ({
				key: `command:${command.name}`,
				label: `/${command.name}`,
				detail: command.prompt.split('\n')[0],
				replace:
					keepCommands || command.prompt.includes(ARGUMENTS)
						? keepName(command.name)
						: (text: string, at: Trigger) => ({ text: command.prompt + text.slice(at.end), caret: command.prompt.length }),
			})),
			...skills
				.filter((skill) => skill.name.startsWith(query) && !named.has(skill.name))
				.map((skill) => ({ key: `skill:${skill.name}`, label: `/${skill.name}`, detail: skill.description, skill: true, replace: keepName(skill.name) })),
		].slice(0, SHOWN);
	}
	return matchPaths(paths, trigger.query).map((path) => ({
		key: path,
		label: path.slice(path.lastIndexOf('/') + 1),
		detail: path,
		replace: (text, at) => {
			const inserted = `@${path} `;
			return { text: text.slice(0, at.start) + inserted + text.slice(at.end), caret: at.start + inserted.length };
		},
	}));
}

/** Skills every new task gets from the installed plugins; a task also has its repo's own. */
function activeSkills(plugins: Plugin[]): SkillSummary[] {
	return plugins.flatMap((plugin) => plugin.skills.filter((skill) => skill.active).map(({ name, description }) => ({ name, description })));
}

/**
 * Completion for a message box: `/` at the start offers saved commands and skills, `@`
 * offers files from the task or selected repository branch. Pass `onKeyDown` first in the box's key handler;
 * it returns true when it used the key.
 */
export function useSuggestions({
	text,
	setText,
	sessionId,
	projectId,
	branch,
	box,
	keepCommands = false,
}: {
	text: string;
	setText: (text: string) => void;
	sessionId?: string;
	projectId?: string;
	branch?: string;
	box: () => { focus(): void; setSelectionRange(start: number, end: number): void } | null;
	keepCommands?: boolean;
}) {
	const [caret, setCaret] = useState(0);
	const selectedCaret = useRef<number | null>(null);
	useLayoutEffect(() => {
		if (selectedCaret.current === null) return;
		const element = box();
		element?.focus();
		element?.setSelectionRange(selectedCaret.current, selectedCaret.current);
		selectedCaret.current = null;
	}, [text]);
	const [active, setActive] = useState(0);
	const [dismissed, setDismissed] = useState<string | null>(null);
	const found = triggerAt(text, Math.min(caret, text.length));
	const trigger = found && `${found.kind}${found.start}` !== dismissed ? found : null;
	const commands = useQuery({ queryKey: ['commands'], queryFn: api.commands, enabled: trigger?.kind === '/' });
	const files = useQuery<{ paths: string[] }>({
		queryKey: sessionId ? ['files', sessionId] : ['project-files', projectId, branch],
		queryFn: () => (sessionId ? api.files(sessionId) : api.projectFiles(projectId ?? '', branch)),
		enabled: Boolean(sessionId || projectId) && trigger?.kind === '@',
	});
	const skills = useQuery({
		queryKey: ['skills', sessionId ?? null],
		queryFn: async () => (sessionId ? api.sessionSkills(sessionId) : { skills: activeSkills((await api.plugins()).plugins) }),
		enabled: trigger?.kind === '/',
		staleTime: 60_000,
	});
	const items = itemsFor(trigger, files.data?.paths ?? [], commands.data?.commands ?? [], skills.data?.skills ?? [], keepCommands);
	const current = Math.min(active, Math.max(items.length - 1, 0));

	function choose(item: Item) {
		if (!trigger) return;
		const next = item.replace(text, trigger);
		selectedCaret.current = next.caret;
		setText(next.text);
		setCaret(next.caret);
		setActive(0);
	}

	function onKeyDown(event: KeyboardEvent<HTMLElement>): boolean {
		if (!trigger || items.length === 0) return false;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			setActive((current + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
		} else if (event.key === 'Enter' || event.key === 'Tab') {
			choose(items[current]);
		} else if (event.key === 'Escape') {
			setDismissed(`${trigger.kind}${trigger.start}`);
		} else return false;
		event.preventDefault();
		return true;
	}

	/** Keep in step with the caret: call from the box's onChange and onSelect. */
	const track = (element: { selectionStart: number } | number) => {
		setCaret(typeof element === 'number' ? element : element.selectionStart);
		setActive(0);
	};

	const list =
		trigger && items.length > 0 ? (
			<div role="listbox" className="flex flex-col gap-px rounded-lg border border-(--border-subtle) bg-(--bg-overlay) p-1 shadow-lg">
				{items.map((item, index) => (
					<button
						key={item.key}
						type="button"
						role="option"
						aria-selected={index === current}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => choose(item)}
						className={cn(
							'flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-left text-[12px]',
							index === current ? 'bg-(--bg-hover) text-(--text-primary)' : 'text-(--text-secondary)',
						)}
					>
						<Icon icon={item.skill ? Blocks : trigger.kind === '/' ? SquareSlash : FileText} size={12} className="shrink-0 text-(--icon-tertiary)" />
						<span className="shrink-0 font-mono">{item.label}</span>
						<span className="min-w-0 truncate text-(--text-tertiary)">{item.detail}</span>
					</button>
				))}
			</div>
		) : null;

	const fileStatus =
		trigger?.kind === '@' && Boolean(sessionId || projectId) && items.length === 0
			? files.isFetching
				? 'Loading files…'
				: files.isError
					? 'Could not list files. Try again.'
					: 'No files match.'
			: null;
	const statusList = fileStatus ? (
		<div role="status" className="rounded-lg border border-(--border-subtle) bg-(--bg-overlay) px-3 py-2 text-[12px] text-(--text-tertiary) shadow-lg">
			{fileStatus}
		</div>
	) : null;

	const tokens = useMemo(
		() =>
			[
				...(files.data?.paths ?? []).map((path) => ({ value: `@${path}`, label: `@${path.split('/').pop()}`, title: path, kind: 'file' as const })),
				...(commands.data?.commands ?? []).map((command) => ({
					value: `/${command.name}`,
					label: `/${command.name}`,
					title: `/${command.name}`,
					kind: 'command' as const,
				})),
				...(skills.data?.skills ?? []).map((skill) => ({
					value: `/${skill.name}`,
					label: `/${skill.name}`,
					title: `/${skill.name}`,
					kind: 'command' as const,
				})),
			].sort((a, b) => b.value.length - a.value.length),
		[files.data, commands.data, skills.data],
	);
	return { onKeyDown, track, list: list ?? statusList, tokens };
}
