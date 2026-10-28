import * as v from 'valibot';
import { InvalidInputError } from '../core/errors.ts';
import { formulaNames, INPUT_TYPES, isInteractive, libraryPath, parseFormula, specText, UI_LIMITS, type UiNode, type UiSpec, walk } from '../core/ui-spec.ts';

/*
 * The `show` tool's check: a tree of components from the catalog in
 * src/core/ui-spec.ts, within its limits, before the thread draws it. The
 * tool's own input schema stays shallow, since some providers refuse nested
 * schemas; this check is the deep one, and what it finds goes back to the
 * agent to fix.
 */

const SHOW_TYPES = [
	'card', 'row', 'col', 'divider', 'text', 'stat', 'badge', 'list', 'code', 'diff', 'file', 'image', 'table', 'chart', 'progress', 'timeline', 'value',
	'button', 'choice', 'select', 'text_input', 'number', 'toggle', 'form',
] as const;

/** The tool's input: each component's type, its fields checked by `checkSpec`. */
export const SHOW_INPUT = v.object({
	title: v.optional(v.pipe(v.string(), v.maxLength(200))),
	// Open to each component's fields in so many words: a provider that constrains its output to the schema reads an
	// object without additionalProperties as closed, and its model can then write nothing but the type.
	children: v.pipe(v.array(v.objectWithRest({ type: v.picklist(SHOW_TYPES) }, v.unknown())), v.minLength(1)),
});

const text = (max: number = UI_LIMITS.text) => v.pipe(v.string(), v.maxLength(max));
const label = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
const name = v.pipe(v.string(), v.regex(/^[A-Za-z_]\w{0,39}$/, 'Input names are letters, digits and _, starting with a letter'));
const tone = v.optional(v.picklist(['neutral', 'accent', 'success', 'warning', 'danger']));
const format = v.optional(v.picklist(['text', 'number', 'percent', 'currency', 'duration']));
const cell = v.nullable(v.union([v.string(), v.number(), v.boolean()]));
const option = v.object({ label, value: v.optional(text(200)), detail: v.optional(text(300)) });
const options = v.pipe(v.array(option), v.minLength(1), v.maxLength(UI_LIMITS.options));
/** Paths inside the repo or the Library: no way out of either. */
const path = v.pipe(v.string(), v.minLength(1), v.maxLength(500), v.check((value) => !value.split('/').includes('..') && !value.startsWith('/'), 'Use a path relative to the repository or the Library'));
/** An image's path in the Library, read through the outputs folder the agent knows it as. */
const imagePath = v.pipe(
	v.string(),
	v.transform(libraryPath),
	v.minLength(1),
	v.maxLength(500),
	v.check((value) => !value.split('/').includes('..') && !value.startsWith('/'), "Use the image's path in the Library, such as screenshots/home.png"),
);

const node: v.GenericSchema<UiNode> = v.lazy(() =>
	v.variant('type', [
		v.object({ type: v.literal('card'), title: v.optional(label), caption: v.optional(text(300)), children: v.array(node) }),
		v.object({ type: v.literal('row'), children: v.array(node) }),
		v.object({ type: v.literal('col'), children: v.array(node) }),
		v.object({ type: v.literal('divider') }),
		v.object({ type: v.literal('text'), text: text(), muted: v.optional(v.boolean()) }),
		v.object({ type: v.literal('stat'), label, value: v.union([v.string(), v.number()]), change: v.optional(text(60)), tone, format }),
		v.object({ type: v.literal('badge'), label, tone }),
		v.object({ type: v.literal('list'), items: v.pipe(v.array(text(1000)), v.maxLength(50)), ordered: v.optional(v.boolean()) }),
		v.object({ type: v.literal('code'), code: text(), language: v.optional(text(30)) }),
		v.object({ type: v.literal('diff'), patch: text(), path: v.optional(path) }),
		v.object({ type: v.literal('file'), path, line: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))), label: v.optional(label) }),
		v.object({ type: v.literal('image'), path: imagePath, alt: v.optional(text(300)) }),
		v.object({
			type: v.literal('table'),
			columns: v.pipe(v.array(v.object({ key: label, label: v.optional(label), format, align: v.optional(v.picklist(['left', 'right'])) })), v.minLength(1), v.maxLength(12)),
			rows: v.pipe(v.array(v.record(v.string(), cell)), v.maxLength(UI_LIMITS.rows)),
		}),
		v.object({
			type: v.literal('chart'),
			kind: v.picklist(['bar', 'stacked-bar', 'line', 'area', 'donut']),
			title: v.optional(label),
			x: label,
			series: v.pipe(v.array(v.object({ key: label, label: v.optional(label) })), v.minLength(1), v.maxLength(UI_LIMITS.series)),
			data: v.pipe(v.array(v.record(v.string(), cell)), v.minLength(1), v.maxLength(UI_LIMITS.points)),
			format,
		}),
		v.object({ type: v.literal('progress'), label, value: v.number(), max: v.optional(v.pipe(v.number(), v.gtValue(0))), tone }),
		v.object({
			type: v.literal('timeline'),
			items: v.pipe(
				v.array(v.object({ title: label, time: v.optional(text(60)), detail: v.optional(text(1000)), state: v.optional(v.picklist(['done', 'active', 'pending', 'failed'])) })),
				v.minLength(1),
				v.maxLength(30),
			),
		}),
		v.object({ type: v.literal('value'), label, formula: text(500), format }),
		v.object({ type: v.literal('button'), label: v.pipe(label, v.maxLength(60)), message: v.optional(text(2000)), primary: v.optional(v.boolean()) }),
		v.object({ type: v.literal('choice'), name, label: v.optional(label), options, multiple: v.optional(v.boolean()) }),
		v.object({ type: v.literal('select'), name, label: v.optional(label), options }),
		v.object({ type: v.literal('text_input'), name, label: v.optional(label), placeholder: v.optional(text(200)), multiline: v.optional(v.boolean()) }),
		v.object({
			type: v.literal('number'),
			name,
			label: v.optional(label),
			value: v.optional(v.number()),
			min: v.optional(v.number()),
			max: v.optional(v.number()),
			step: v.optional(v.pipe(v.number(), v.gtValue(0))),
			slider: v.optional(v.boolean()),
		}),
		v.object({ type: v.literal('toggle'), name, label, value: v.optional(v.boolean()) }),
		v.object({ type: v.literal('form'), title: label, submit: v.optional(v.pipe(label, v.maxLength(40))), children: v.array(node) }),
	]),
);

const specSchema = v.object({ title: v.optional(label), children: v.pipe(v.array(node), v.minLength(1)) });

/** Where in the tree an issue is, as the agent wrote it: `children[0].children[2].rows`. */
function where(issue: v.BaseIssue<unknown>): string {
	return (issue.path ?? [])
		.map((item) => (typeof item.key === 'number' ? `[${item.key}]` : `.${String(item.key)}`))
		.join('')
		.replace(/^\./, '');
}

/** The checks the types can't make: sizes, names, formulas, and that charts and tables name real columns. */
function problems(spec: UiSpec): string[] {
	const found: string[] = [];
	let count = 0;
	let deepest = 0;
	const inputs = new Set<string>();
	walk(spec.children, (item, depth) => {
		count++;
		deepest = Math.max(deepest, depth);
		if (INPUT_TYPES.has(item.type) && 'name' in item) {
			if (inputs.has(item.name)) found.push(`Two inputs are named "${item.name}"; each needs its own name.`);
			inputs.add(item.name);
		}
		if (item.type === 'number' && item.min !== undefined && item.max !== undefined && item.min > item.max) found.push(`"${item.name}" has min above max.`);
		if (item.type === 'form') {
			walk(item.children, (inner) => {
				if (inner.type === 'form') found.push(`Form "${item.title}" holds another form; forms can't nest.`);
				if (inner.type === 'button') found.push(`Form "${item.title}" holds a button; a form has its own submit button (submit sets its label).`);
			});
		}
		if (item.type === 'chart') {
			const keys = new Set(item.data.flatMap((row) => Object.keys(row)));
			for (const key of [item.x, ...item.series.map((series) => series.key)]) {
				if (!keys.has(key)) found.push(`Chart${item.title ? ` "${item.title}"` : ''} names "${key}", which no data row has.`);
			}
			if (item.kind === 'donut' && item.series.length > 1) found.push('A donut chart shows one series; use a bar chart to compare several.');
		}
		if (item.type === 'table') {
			const keys = new Set(item.rows.flatMap((row) => Object.keys(row)));
			for (const column of item.columns) if (item.rows.length && !keys.has(column.key)) found.push(`Table column "${column.key}" is in no row.`);
		}
	});
	walk(spec.children, (item) => {
		if (item.type !== 'value') return;
		try {
			for (const used of formulaNames(parseFormula(item.formula))) {
				if (!inputs.has(used)) found.push(`The formula for "${item.label}" reads "${used}", which is not an input's name.`);
			}
		} catch (error) {
			found.push(`The formula for "${item.label}": ${(error as Error).message}.`);
		}
	});
	if (count > UI_LIMITS.nodes) found.push(`The card has ${count} components; keep it to ${UI_LIMITS.nodes}.`);
	if (deepest > UI_LIMITS.depth) found.push(`The card nests ${deepest} levels deep; keep it to ${UI_LIMITS.depth}.`);
	return found;
}

/** The tree, checked; a problem throws, saying what to fix. */
export function checkSpec(input: unknown): UiSpec {
	if (JSON.stringify(input ?? null).length > UI_LIMITS.bytes) throw new InvalidInputError(`The card is too big; keep it under ${UI_LIMITS.bytes / 1000} KB. Show fewer rows or points.`);
	const parsed = v.safeParse(specSchema, input);
	if (!parsed.success) {
		const issues = parsed.issues.slice(0, 8).map((issue) => `${where(issue) || 'the card'}: ${issue.message}`);
		throw new InvalidInputError(`The card is not valid, so the user does not see it. Fix these and call show again:\n${issues.join('\n')}`);
	}
	const found = problems(parsed.output);
	if (found.length) throw new InvalidInputError(`The card is not valid, so the user does not see it. Fix these and call show again:\n${found.slice(0, 8).join('\n')}`);
	return parsed.output;
}

/** A card whose image is not in the Library would show a broken picture; the agent hears which, and fixes the path or saves the image first. */
export async function checkImages(spec: UiSpec, inLibrary: (path: string) => Promise<boolean>): Promise<void> {
	const images: string[] = [];
	walk(spec.children, (item) => {
		if (item.type === 'image') images.push(item.path);
	});
	const missing: string[] = [];
	for (const path of images) if (!(await inLibrary(path).catch(() => false))) missing.push(path);
	if (missing.length) {
		throw new InvalidInputError(
			`The card is not valid, so the user does not see it. ${missing.map((path) => `"${path}"`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in the Library. ` +
				'Save the image in the outputs folder first (../outputs/ from your working folder), then name it by its path there, such as screenshots/home.png.',
		);
	}
}

/** What the tool tells the agent: what the user now sees, so it neither repeats it nor needs to see it. */
export function shownNote(spec: UiSpec): string {
	return [
		'The user sees this card in the thread, drawn with components:',
		specText(spec),
		'Do not repeat what it shows in your reply; add only what it does not say.',
		isInteractive(spec) ? 'When the user presses a button or submits a form, what they chose arrives as their next message. If you asked them something with it, stop and wait.' : '',
	]
		.filter(Boolean)
		.join('\n\n');
}
