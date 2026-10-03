import { useQuery } from '@tanstack/react-query';
import { FileText, SquareSlash } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { Icon } from '@/components/signal';
import { api, type Command } from '@/lib/api';
import { cn } from '@/lib/utils';
import { matchPaths, SHOWN, type Trigger, triggerAt } from '@/lib/completion';

type Item = { key: string; label: string; detail: string; replace: (text: string, trigger: Trigger) => { text: string; caret: number } };

function itemsFor(trigger: Trigger | null, paths: string[], commands: Command[]): Item[] {
	if (!trigger) return [];
	if (trigger.kind === '/') {
		return commands
			.filter((command) => command.name.startsWith(trigger.query.toLowerCase()))
			.slice(0, SHOWN)
			.map((command) => ({
				key: command.name,
				label: `/${command.name}`,
				detail: command.prompt.split('\n')[0],
				replace: (text, at) => ({ text: command.prompt + text.slice(at.end), caret: command.prompt.length }),
			}));
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

/**
 * Completion for a message box: `/` at the start offers saved commands, `@`
 * offers the task's files. Pass `onKeyDown` first in the box's key handler;
 * it returns true when it used the key.
 */
export function useSuggestions({
	text,
	setText,
	sessionId,
	box,
}: {
	text: string;
	setText: (text: string) => void;
	sessionId?: string;
	box: () => HTMLTextAreaElement | null;
}) {
	const [caret, setCaret] = useState(0);
	const [active, setActive] = useState(0);
	const [dismissed, setDismissed] = useState<string | null>(null);
	const found = triggerAt(text, Math.min(caret, text.length));
	const trigger = found && `${found.kind}${found.start}` !== dismissed ? found : null;
	const commands = useQuery({ queryKey: ['commands'], queryFn: api.commands, enabled: trigger?.kind === '/' });
	const files = useQuery({ queryKey: ['files', sessionId], queryFn: () => api.files(sessionId ?? ''), enabled: Boolean(sessionId) && trigger?.kind === '@' });
	const items = itemsFor(trigger, files.data?.paths ?? [], commands.data?.commands ?? []);
	const current = Math.min(active, Math.max(items.length - 1, 0));

	function choose(item: Item) {
		if (!trigger) return;
		const next = item.replace(text, trigger);
		setText(next.text);
		setCaret(next.caret);
		setActive(0);
		requestAnimationFrame(() => {
			const element = box();
			element?.focus();
			element?.setSelectionRange(next.caret, next.caret);
		});
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
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
	const track = (element: HTMLTextAreaElement) => {
		setCaret(element.selectionStart);
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
						<Icon icon={trigger.kind === '/' ? SquareSlash : FileText} size={12} className="shrink-0 text-(--icon-tertiary)" />
						<span className="shrink-0 font-mono">{item.label}</span>
						<span className="min-w-0 truncate text-(--text-tertiary)">{item.detail}</span>
					</button>
				))}
			</div>
		) : null;

	return { onKeyDown, track, list };
}
