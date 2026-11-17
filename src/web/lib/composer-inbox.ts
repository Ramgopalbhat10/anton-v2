import { useSyncExternalStore } from 'react';
import type { ImageAttachment } from '@/lib/attachments';
import type { PickedElement } from '@/lib/api/workspace';

/** What other panels hand to a task's composer (a picked element, a drawing, text from a page), taken into its draft as it arrives. */
export type InboxItem = { kind: 'element'; id: string; element: PickedElement } | { kind: 'image'; image: ImageAttachment } | { kind: 'text'; text: string };

const inboxes = new Map<string, InboxItem[]>();
const listeners = new Set<() => void>();
const EMPTY: InboxItem[] = [];

export function addToComposer(sessionId: string, item: InboxItem): void {
	inboxes.set(sessionId, [...(inboxes.get(sessionId) ?? []), item]);
	for (const listener of listeners) listener();
}

export function takeFromInbox(sessionId: string): InboxItem[] {
	const items = inboxes.get(sessionId) ?? EMPTY;
	if (items.length) inboxes.delete(sessionId);
	return items;
}

export function useInbox(sessionId: string): InboxItem[] {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		() => inboxes.get(sessionId) ?? EMPTY,
	);
}

/** A picked element's label: its tag and the nearest React component, as `<button> in LoginForm`. */
export function elementLabel(element: PickedElement): string {
	const component = element.components[0]?.name;
	return `<${element.tag}>${component ? ` in ${component}` : ''}`;
}

/** What the agent reads about a picked element: enough to find the code without a description of the screen. */
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
