import type { FlueConversationMessage, FlueConversationPart } from '@flue/react';
import { field } from '@/components/thread/tool-describe';
import { MAIL_SEND_TOOLS } from '@/components/thread/mail-card';
import { toolApprovalOf } from '@/components/thread/tool-approval-card';
import { patchedFiles } from '../../../core/apply-patch';
import { IMAGE_TOOL } from '@/lib/now-text';
import { outputLinkPath, outputLinksIn } from '../../../core/outputs';
import { asConnectorTool } from '@/lib/connector-calls';

export type ToolPart = Extract<FlueConversationPart, { type: 'dynamic-tool' }>;

export type ReasoningPart = Extract<FlueConversationPart, { type: 'reasoning' }>;

export type Step = ToolPart | ReasoningPart;

export type Block =
	| { kind: 'text'; text: string }
	| { kind: 'steps'; steps: Step[] }
	| { kind: 'plan'; part: ToolPart }
	| { kind: 'agents'; calls: ToolPart[] }
	| { kind: 'ask'; part: ToolPart }
	| { kind: 'show'; part: ToolPart }
	| { kind: 'page'; part: ToolPart }
	| { kind: 'image'; part: ToolPart }
	| { kind: 'mail'; part: ToolPart }
	| { kind: 'toolapproval'; part: ToolPart };

const PLAN_TOOL = 'propose_plan';

/** The todo list shows as the pill above the composer, not as steps in the thread. */
const TODO_TOOL = 'update_todos';

/** Tools whose calls draw in the reply itself rather than as a step; one that failed stays a step, with its error. */
const DRAWN: Record<string, 'ask' | 'show' | 'page' | 'image'> = { ask: 'ask', show: 'show', render_html: 'page', [IMAGE_TOOL]: 'image' };

export function madeImageOf(part: ToolPart): { path: string; model: string } | null {
	if (part.state !== 'output-available') return null;
	const record = part.output && typeof part.output === 'object' ? (part.output as Record<string, unknown>) : {};
	const output = record.output && typeof record.output === 'object' ? (record.output as Record<string, unknown>) : record;
	const path = field(output, 'path');
	return path ? { path, model: field(output, 'model') } : null;
}

export function pageOf(part: ToolPart): { path: string; title: string; height: number } | null {
	if (part.state !== 'output-available') return null;
	const record = part.output && typeof part.output === 'object' ? (part.output as Record<string, unknown>) : {};
	const output = record.output && typeof record.output === 'object' ? (record.output as Record<string, unknown>) : record;
	const path = field(output, 'path');
	return path ? { path, title: field(output, 'title') || 'Page', height: Number(field(output, 'height')) || 360 } : null;
}

export function proposesPlan(message: FlueConversationMessage | undefined): boolean {
	return Boolean(
		message?.role === 'assistant' &&
			message.parts.some((part) => part.type === 'dynamic-tool' && part.toolName === PLAN_TOOL && part.state === 'output-available' && field(part.input, 'plan')),
	);
}

/** The files one call wrote, edited or patched: a patch's every file, a move's both paths. */
function pathsOf(part: ToolPart): string[] {
	if (part.toolName === 'apply_patch') return patchedFiles(field(part.input, 'input')).flatMap((file) => (file.to ? [file.path, file.to] : [file.path]));
	return part.toolName === 'edit' || part.toolName === 'write' ? [field(part.input, 'path')] : [];
}

export function changedPaths(parts: FlueConversationPart[]): string[] {
	const paths: string[] = [];
	for (const part of parts) {
		if (part.type !== 'dynamic-tool' || part.state !== 'output-available') continue;
		for (const named of pathsOf(part)) {
			const path = named.replace(/^\.\//, '');
			if (path && !paths.includes(path)) paths.push(path);
		}
	}
	return paths;
}

export function openedPullRequest(parts: FlueConversationPart[]): { url: string; title: string } | null {
	for (const part of [...parts].reverse()) {
		if (part.type !== 'dynamic-tool' || part.toolName !== 'open_pull_request' || part.state !== 'output-available') continue;
		const record = part.output && typeof part.output === 'object' ? (part.output as Record<string, unknown>) : {};
		const url = field(record, 'url') || field(record.output, 'url');
		if (url) return { url, title: field(part.input, 'title') };
	}
	return null;
}

/** The screenshot and browser tools return a path relative to the repo; the Library lists it relative to outputs. */
export function screenshotPath(part: ToolPart): string {
	if (part.state !== 'output-available') return '';
	const record = part.output && typeof part.output === 'object' ? (part.output as Record<string, unknown>) : {};
	const key = part.toolName === 'browser' ? 'screenshot' : 'path';
	return (field(record, key) || field(record.output, key)).replace(/^\.\.\/outputs\//, '');
}

/** Files a reply made for you: those it links in outputs, its screenshots, and files it wrote there, not uploads/. One it saved but did not link shows only while the Library still has it (`kept`). */
export function replyOutputs(parts: FlueConversationPart[], kept: Set<string> | null, deleted: Set<string> = new Set()): string[] {
	const named: { path: string; linked: boolean }[] = [];
	const drawn = new Set(parts.flatMap((part) => (part.type === 'dynamic-tool' && part.toolName === IMAGE_TOOL ? [madeImageOf(part)?.path ?? ''] : [])));
	for (const part of parts) {
		if (part.type === 'text') for (const path of outputLinksIn(part.text)) named.push({ path, linked: true });
		if (part.type !== 'dynamic-tool' || part.state !== 'output-available') continue;
		if (part.toolName === 'screenshot' || part.toolName === 'browser') named.push({ path: screenshotPath(part), linked: false });
		if (part.toolName === 'write') named.push({ path: outputLinkPath(field(part.input, 'path')) ?? '', linked: false });
		if (part.toolName === 'apply_patch') for (const file of patchedFiles(field(part.input, 'input'))) if (file.change === 'add') named.push({ path: outputLinkPath(file.path) ?? '', linked: false });
	}
	const linked = new Set(named.filter((entry) => entry.linked).map((entry) => entry.path));
	const paths: string[] = [];
	for (const { path } of named) {
		if (!path || path.startsWith('uploads/') || drawn.has(path) || paths.includes(path)) continue;
		// One you deleted keeps its card, which says so.
		if (linked.has(path) || !kept || kept.has(path) || deleted.has(path)) paths.push(path);
	}
	return paths;
}

export function outputText(output: unknown): string {
	if (typeof output === 'string') return output;
	if (!output || typeof output !== 'object') return '';
	const record = output as Record<string, unknown>;
	if (typeof record.output === 'string') return record.output;
	if (Array.isArray(record.content)) {
		return record.content.map((item) => (item && typeof item === 'object' && 'text' in item ? String((item as { text: unknown }).text) : '')).join('\n');
	}
	return '';
}

export function toBlocks(parts: FlueConversationPart[]): Block[] {
	const blocks: Block[] = [];
	for (const each of parts) {
		const part = each.type === 'dynamic-tool' ? asConnectorTool(each) : each;
		if (part.type === 'dynamic-tool' && part.toolName === TODO_TOOL) continue;
		if (part.type === 'text') {
			if (part.text.trim()) blocks.push({ kind: 'text', text: part.text });
		} else if (part.type === 'dynamic-tool' && part.toolName === PLAN_TOOL) {
			blocks.push({ kind: 'plan', part });
		} else if (part.type === 'dynamic-tool' && MAIL_SEND_TOOLS.has(part.toolName) && part.state !== 'output-error') {
			blocks.push({ kind: 'mail', part });
		} else if (part.type === 'dynamic-tool' && toolApprovalOf(part.output) && part.state !== 'output-error') {
			blocks.push({ kind: 'toolapproval', part });
		} else if (part.type === 'dynamic-tool' && DRAWN[part.toolName] && part.state !== 'output-error') {
			blocks.push({ kind: DRAWN[part.toolName], part });
		} else if (part.type === 'dynamic-tool' && part.toolName === 'task') {
			// Work handed to subagents gets its own card, the calls of one batch together.
			const last = blocks[blocks.length - 1];
			if (last?.kind === 'agents') last.calls.push(part);
			else blocks.push({ kind: 'agents', calls: [part] });
		} else if (part.type === 'reasoning' || part.type === 'dynamic-tool') {
			const last = blocks[blocks.length - 1];
			if (last?.kind === 'steps') last.steps.push(part);
			else blocks.push({ kind: 'steps', steps: [part] });
		}
	}
	return blocks;
}

export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
	return a.length === b.length && a.every((item, index) => item === b[index]);
}
