import { cn } from '@/lib/utils';
import { type ClipboardEvent, type KeyboardEvent, type Ref, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';

export type DraftToken = { value: string; label: string; title: string; kind: 'file' | 'command' };
export type DraftHandle = { focus(): void; setSelectionRange(start: number, end: number): void; readonly selectionStart: number };

type Segment = { text: string; token?: DraftToken; start: number; end: number };
function segments(text: string, tokens: DraftToken[]): Segment[] {
	const out: Segment[] = [];
	let start = 0;
	for (let index = 0; index < text.length; ) {
		const token =
			(text[index] === '@' || text[index] === '/') &&
			tokens.find(
				(item) =>
					(item.kind === 'command' ? index === 0 : index === 0 || /\s/.test(text[index - 1])) &&
					text.startsWith(item.value, index) &&
					(index + item.value.length === text.length || /\s/.test(text[index + item.value.length])),
			);
		if (!token) {
			index++;
			continue;
		}
		if (index > start) out.push({ text: text.slice(start, index), start, end: index });
		out.push({ text: token.value, token, start: index, end: index + token.value.length });
		index += token.value.length;
		start = index;
	}
	if (start < text.length) out.push({ text: text.slice(start), start, end: text.length });
	return out;
}

/** The DOM shows short labels; the draft keeps the original references. */
function nodeText(node: Node): string {
	if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
	if (node instanceof HTMLElement && node.dataset.draftEnd) return '';
	if (node instanceof HTMLElement && node.dataset.value) return node.dataset.value;
	if (node.nodeName === 'BR') return '\n';
	return Array.from(node.childNodes).map(nodeText).join('');
}

function offsetAt(root: HTMLElement, node: Node, offset: number): number {
	if (node === root)
		return Array.from(root.childNodes)
			.slice(0, offset)
			.reduce((sum, item) => sum + nodeText(item).length, 0);
	let count =
		node.nodeType === Node.TEXT_NODE
			? offset
			: Array.from(node.childNodes)
					.slice(0, offset)
					.reduce((sum, item) => sum + nodeText(item).length, 0);
	let current = node;
	while (current !== root && current.parentNode) {
		if (current.parentNode instanceof HTMLElement && current.parentNode.dataset.value) count = offset ? nodeText(current.parentNode).length : 0;
		for (let before = current.previousSibling; before; before = before.previousSibling) count += nodeText(before).length;
		current = current.parentNode;
	}
	return count;
}
function selectionOf(root: HTMLElement) {
	const selection = window.getSelection();
	if (!selection?.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
	const range = selection.getRangeAt(0);
	return { start: offsetAt(root, range.startContainer, range.startOffset), end: offsetAt(root, range.endContainer, range.endOffset) };
}
function pointAt(root: HTMLElement, offset: number): [Node, number] {
	let left = offset;
	for (const [index, node] of Array.from(root.childNodes).entries()) {
		const length = nodeText(node).length;
		if (left <= length) {
			if (node.nodeType === Node.TEXT_NODE) return [node, left];
			return [root, index + (left > 0 ? 1 : 0)];
		}
		left -= length;
	}
	return [root, root.childNodes.length];
}
function select(root: HTMLElement, start: number, end: number) {
	const range = document.createRange();
	range.setStart(...pointAt(root, start));
	range.setEnd(...pointAt(root, end));
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
}

/** Plain text editing with atomic command and file chips; paste never inserts HTML. */
export function DraftInput({
	ref,
	value,
	tokens,
	onChange,
	onSelect,
	onKeyDown,
	onPaste,
	placeholder,
	autoFocus,
	className,
}: {
	ref?: Ref<DraftHandle>;
	value: string;
	tokens: DraftToken[];
	onChange: (value: string, caret: number) => void;
	onSelect: (caret: number) => void;
	onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
	onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
	placeholder: string;
	autoFocus?: boolean;
	className?: string;
}) {
	const root = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		if (autoFocus) root.current?.focus();
	}, [autoFocus]);
	const composing = useRef(false);
	const [compositionVersion, setCompositionVersion] = useState(0);
	const history = useRef([{ value, selection: { start: value.length, end: value.length } }]);
	const historyIndex = useRef(0);
	const pending = useRef<{ start: number; end: number } | null>(null);
	useImperativeHandle(ref, () => ({
		focus: () => root.current?.focus(),
		setSelectionRange: (start, end) => {
			if (root.current) select(root.current, start, end);
		},
		get selectionStart() {
			return root.current ? (selectionOf(root.current)?.start ?? value.length) : value.length;
		},
	}));
	useLayoutEffect(() => {
		const element = root.current;
		if (!element || composing.current) return;
		const selection = pending.current ?? selectionOf(element);
		pending.current = null;
		if (history.current[historyIndex.current].value !== value) {
			history.current = history.current.slice(0, historyIndex.current + 1);
			history.current.push({ value, selection: selection ?? { start: value.length, end: value.length } });
			if (history.current.length > 100) history.current.shift();
			historyIndex.current = history.current.length - 1;
		}
		const children = segments(value, tokens).map((segment) => {
			if (!segment.token) return document.createTextNode(segment.text);
			const chip = document.createElement('span');
			chip.contentEditable = 'false';
			chip.dataset.value = segment.text;
			chip.setAttribute('aria-label', `${segment.token.kind === 'file' ? 'File' : 'Command'} ${segment.token.title}`);
			chip.title = segment.token.title;
			chip.className =
				'inline-block max-w-full rounded-md border border-(--accent-border) bg-(--accent-bg-subtle) px-1.5 align-baseline font-mono text-[12px] leading-[18px] text-(--accent-text)';
			chip.textContent = segment.token.label;
			return chip;
		});
		// A trailing text node gives the caret a place after a final chip.
		element.replaceChildren(...children, document.createTextNode(''));
		// A final newline needs a visible empty line so browsers keep typing after it.
		if (value.endsWith('\n')) {
			const end = document.createElement('br');
			end.dataset.draftEnd = 'true';
			element.append(end);
		}
		if (selection && document.activeElement === element) select(element, Math.min(selection.start, value.length), Math.min(selection.end, value.length));
	}, [value, tokens, compositionVersion]);
	const update = () => {
		const element = root.current;
		if (!element) return;
		onChange(nodeText(element), selectionOf(element)?.start ?? nodeText(element).length);
	};
	const insert = (text: string) => {
		const element = root.current;
		if (!element) return;
		const range = selectionOf(element) ?? { start: value.length, end: value.length };
		pending.current = { start: range.start + text.length, end: range.start + text.length };
		onChange(value.slice(0, range.start) + text + value.slice(range.end), range.start + text.length);
	};
	const track = () => {
		if (root.current) onSelect(selectionOf(root.current)?.start ?? value.length);
	};
	return (
		<div
			ref={root}
			role="textbox"
			aria-label={placeholder}
			aria-placeholder={placeholder}
			aria-multiline
			contentEditable
			suppressContentEditableWarning
			data-placeholder={placeholder}
			className={cn(
				'sg-draft min-h-[38px] max-h-52 w-full overflow-y-auto border-0 bg-transparent p-0 text-[13px] leading-[22px] whitespace-pre-wrap break-words text-(--text-primary) outline-none',
				className,
			)}
			onInput={update}
			onMouseUp={track}
			onKeyUp={track}
			onCompositionStart={() => {
				composing.current = true;
			}}
			onCompositionEnd={() => {
				composing.current = false;
				setCompositionVersion((version) => version + 1);
				update();
			}}
			onKeyDown={(event) => {
				if (event.nativeEvent.isComposing || composing.current) return;
				const key = event.key.toLowerCase();
				if ((event.metaKey || event.ctrlKey) && !event.altKey && (key === 'z' || key === 'y')) {
					event.preventDefault();
					const redo = key === 'y' || event.shiftKey;
					const next = historyIndex.current + (redo ? 1 : -1);
					if (next >= 0 && next < history.current.length) {
						historyIndex.current = next;
						const snapshot = history.current[next];
						pending.current = snapshot.selection;
						onChange(snapshot.value, snapshot.selection.start);
					}
					return;
				}
				if (event.key === 'Enter' && event.shiftKey) {
					event.preventDefault();
					insert('\n');
					return;
				}
				const selection = root.current && selectionOf(root.current);
				if (selection && selection.start === selection.end && (event.key === 'Backspace' || event.key === 'Delete')) {
					const chip = segments(value, tokens).find(
						(segment) => segment.token && (event.key === 'Backspace' ? segment.end === selection.start : segment.start === selection.start),
					);
					if (chip) {
						event.preventDefault();
						pending.current = { start: chip.start, end: chip.start };
						onChange(value.slice(0, chip.start) + value.slice(chip.end), chip.start);
						return;
					}
				}
				onKeyDown(event);
				if (event.key === 'Enter' && !event.defaultPrevented) {
					event.preventDefault();
					insert('\n');
				}
			}}
			onCopy={(event) => {
				const selection = root.current && selectionOf(root.current);
				if (!selection || selection.start === selection.end) return;
				event.preventDefault();
				event.clipboardData.setData('text/plain', value.slice(selection.start, selection.end));
			}}
			onCut={(event) => {
				const selection = root.current && selectionOf(root.current);
				if (!selection || selection.start === selection.end) return;
				event.preventDefault();
				event.clipboardData.setData('text/plain', value.slice(selection.start, selection.end));
				pending.current = { start: selection.start, end: selection.start };
				onChange(value.slice(0, selection.start) + value.slice(selection.end), selection.start);
			}}
			onPaste={(event) => {
				onPaste?.(event);
				if (event.defaultPrevented) return;
				event.preventDefault();
				insert(event.clipboardData.getData('text/plain'));
			}}
		/>
	);
}
