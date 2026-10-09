import { useSyncExternalStore } from 'react';
import type { ImageAttachment } from '@/lib/attachments';
import type { PickedElement } from '@/lib/api';

/**
 * Things other panels hand to a task's composer: an element picked in the
 * Browser panel, or a drawing on its page. The composer takes them into its
 * draft as they arrive, where they can be removed before sending.
 */
export type InboxItem = { kind: 'element'; id: string; element: PickedElement } | { kind: 'image'; image: ImageAttachment };

const inboxes = new Map<string, InboxItem[]>();
const listeners = new Set<() => void>();
const EMPTY: InboxItem[] = [];

export function addToComposer(sessionId: string, item: InboxItem): void {
	inboxes.set(sessionId, [...(inboxes.get(sessionId) ?? []), item]);
	for (const listener of listeners) listener();
}

/** Takes everything waiting for the task's composer, leaving its inbox empty. */
export function takeFromInbox(sessionId: string): InboxItem[] {
	const items = inboxes.get(sessionId) ?? EMPTY;
	if (items.length) inboxes.delete(sessionId);
	return items;
}

/** What is waiting for the task's composer, kept current. */
export function useInbox(sessionId: string): InboxItem[] {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		() => inboxes.get(sessionId) ?? EMPTY,
	);
}

/** A task's unsent draft, kept while its composer is hidden (the workspace expanded, say) and given back when it shows again. */
export type KeptDraft = { text: string; images: ImageAttachment[]; elements: Array<Extract<InboxItem, { kind: 'element' }>> };
const drafts = new Map<string, KeptDraft>();
const BLANK: KeptDraft = { text: '', images: [], elements: [] };

export const keptDraft = (sessionId: string): KeptDraft => drafts.get(sessionId) ?? BLANK;

export function keepDraft(sessionId: string, draft: KeptDraft): void {
	if (!draft.text && !draft.images.length && !draft.elements.length) drafts.delete(sessionId);
	else drafts.set(sessionId, draft);
}

/** A picked element's label: its tag and the nearest React component, as `<button> in LoginForm`. */
export function elementLabel(element: PickedElement): string {
	const component = element.components[0]?.name;
	return `<${element.tag}>${component ? ` in ${component}` : ''}`;
}

/**
 * What the agent reads about a picked element: where it is on which page,
 * the components that render it and where they are, its key styles, and its
 * HTML. Enough to find the code without a description of the screen.
 */
export function elementContext(element: PickedElement): string {
	const lines = [`<selected_element page="${element.url}"${element.title ? ` title="${element.title.replace(/"/g, "'")}"` : ''}>`];
	lines.push(`Element: <${element.tag}> at \`${element.selector}\`${element.text ? `, text "${element.text.slice(0, 160)}"` : ''}`);
	if (element.components.length) {
		lines.push(`React components, nearest first: ${element.components.map((component) => (component.source ? `${component.name} (${component.source})` : component.name)).join(' › ')}`);
	}
	lines.push(`Box: ${Math.round(element.rect.width)}×${Math.round(element.rect.height)} at ${Math.round(element.rect.x)},${Math.round(element.rect.y)}`);
	const styles = Object.entries(element.styles)
		.filter(([, value]) => value && value !== 'normal' && value !== 'none' && value !== '0px')
		.map(([name, value]) => `${name}: ${value}`)
		.join('; ');
	if (styles) lines.push(`Styles: ${styles}`);
	lines.push('HTML:', '```html', element.html, '```', '</selected_element>');
	return lines.join('\n');
}
