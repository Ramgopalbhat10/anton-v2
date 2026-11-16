import { defineTool, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { agentSettingsNow } from '../../../services/tasks/agent-runner.ts';
import { noteAsk } from '../../../services/replies/asks.ts';
import { checkImages, checkSpec, SHOW_INPUT, shownNote } from '../../../services/artifacts/show.ts';
import { readOutputFile } from '../../../services/artifacts/files.ts';
import { pageGuide, saveRender } from '../../../services/artifacts/renders.ts';
import { generateImage, MAX_REFERENCES } from '../../../services/artifacts/images.ts';
import { UI_LIMITS } from '../../../core/ui-spec.ts';

/** A question with options to tap, for a decision only the user can make; the thread shows it as a card and marks the task waiting on you. */
export function useAsk(id: string) {
	useTool(
		defineTool({
			name: 'ask',
			description:
				'Ask the user to decide something only they can, with two to four options they tap to answer (they can also type their own). ' +
				'Use it instead of ending your reply with a question. Ask one thing at a time, then stop and wait for their answer.',
			input: v.object({
				question: v.pipe(v.string(), v.minLength(1), v.maxLength(300), v.description('The question, one sentence naming what to decide')),
				options: v.pipe(
					v.array(
						v.object({
							label: v.pipe(v.string(), v.minLength(1), v.maxLength(60), v.description('The answer as the user would say it, a few words')),
							detail: v.optional(v.pipe(v.string(), v.maxLength(200), v.description('What happens if they pick it, one line'))),
						}),
					),
					v.minLength(2),
					v.maxLength(4),
				),
				recommended: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(3), v.description('Index of the option you recommend'))),
			}),
			run: async ({ data }) => {
				noteAsk(id, data.question);
				// The reply ends here: another model call would only write an empty message after the card.
				return { output: 'The user sees your question with its options and answers with their next message. Stop here and wait; write nothing after this.', terminate: true };
			},
		}),
	);
}

/** The catalog, as the agent reads it; src/core/ui-spec.ts has the types. */
const SHOW_DESCRIPTION = [
	'Show the user components in your reply, drawn in the thread with Anton\'s own look: figures, tables, charts, timelines, and inputs they press.',
	'children is a list of components; each is an object with a type and the fields below ("?" is optional). Containers hold children.',
	'Layout: card {title?, caption?, children} · row {children} (side by side, wraps on phones) · col {children} · divider.',
	'Content: text {text (Markdown), muted?} · stat {label, value, change? ("+12%"), tone?, format?} · badge {label, tone?} · list {items (Markdown), ordered?} · code {code, language?} · diff {patch (unified diff), path?} · file {path (in the repository), line?, label?} opens it in the Files panel · image {path (in the Library, e.g. a screenshot you saved), alt?}.',
	`Data: table {columns: [{key, label?, format?, align?}], rows: [{key: value}]} (sortable, up to ${UI_LIMITS.rows} rows) · chart {kind: bar|stacked-bar|line|area|donut, title?, x (the key of the label or category), series: [{key, label?}] (up to ${UI_LIMITS.series}), data: [{x key and series keys: values}], format?} · progress {label, value, max? (100)} · timeline {items: [{title, time?, detail?, state?: done|active|pending|failed}]}.`,
	'Inputs (each needs a unique name): choice {name, label?, options: [{label, value?, detail?}], multiple?} · select {name, label?, options} · text_input {name, label?, placeholder?, multiline?} · number {name, label?, value?, min?, max?, step?, slider?} · toggle {name, label, value?}.',
	'value {label, formula, format?} works out a formula over the inputs\' names in the browser as the user changes them, e.g. "round(price * seats * (1 - discount / 100), 2)": + - * / % ** ( ) comparisons, a ? b : c, and min max round floor ceil abs sqrt pow. Use it for calculators.',
	'Actions: button {label, message?, primary?} sends message (or its label) as the user\'s next message · form {title, submit?, children} gathers the inputs inside it and sends their values when submitted. Sorting, sliders and formulas need no message.',
	'tone is neutral|accent|success|warning|danger; format is text|number|percent|currency|duration (milliseconds).',
	'Put related things in one card rather than many. The result says what the user sees; do not repeat it in your reply.',
].join('\n');

export function useShow(id: string) {
	useTool(
		defineTool({
			name: 'show',
			description: SHOW_DESCRIPTION,
			input: SHOW_INPUT,
			run: async ({ data }) => {
				const spec = checkSpec(data);
				await checkImages(spec, async (path) => (await readOutputFile(id, path)) !== null);
				return { output: shownNote(spec) };
			},
		}),
	);
}

/** An open-ended page, for what the catalog can't draw: shown in the thread, in a sandbox that reaches the web only through Anton, and kept in the Library. */
export function useRenderHtml(id: string) {
	useTool(
		defineTool({
			name: 'render_html',
			description:
				'Show a page you write in HTML in the thread, above your reply: an interactive explainer, a diagram, a UI mockup, a small tool or game. ' +
				`Prefer show for figures, tables, charts and forms; use this only for what its components can't express. ${pageGuide(agentSettingsNow().pageNetwork)} ` +
				'The page is also saved in the Library. Your reply should not announce it or restate it.',
			input: v.object({
				title: v.pipe(v.string(), v.minLength(1), v.maxLength(120), v.description('A short name for the page')),
				html: v.pipe(v.string(), v.minLength(1), v.description('The complete HTML document')),
				height: v.optional(v.pipe(v.number(), v.description('The frame height in pixels until the page reports its own, 80-1600'))),
			}),
			run: async ({ data }) => {
				const page = await saveRender(id, data);
				return { output: { ...page, note: `The user sees the page "${page.title}" in the thread; it is saved in the Library as ${page.path}.` } };
			},
		}),
	);
}

const ASPECT_RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'] as const;

/** Images drawn by an image model through Anton, whatever model the task runs on: shown in the thread and kept in the Library. */
export function useGenerateImage(id: string) {
	useTool(
		defineTool({
			name: 'generate_image',
			description:
				'Make an image with an image model and show it to the user in the thread: an illustration, a photo, a logo, an icon, a poster, a mockup, a picture for a page. ' +
				'Write prompt as a full description: the subject, style, composition, colours, lighting, and any text in the image word for word. ' +
				`To change an image or work from one (an image you made, a screenshot, one the user attached), pass its Library path in from, up to ${MAX_REFERENCES}, and say in prompt what to change or keep. ` +
				'Returns the image\'s path in the Library. Takes up to a minute.',
			input: v.object({
				prompt: v.pipe(v.string(), v.minLength(1), v.maxLength(4000), v.description('What the image shows, in full')),
				name: v.optional(v.pipe(v.string(), v.maxLength(60), v.description('A short file name, without extension'))),
				from: v.optional(
					v.pipe(v.array(v.string()), v.maxLength(MAX_REFERENCES), v.description('Library paths of images to start from or edit, such as images/logo-a1b2c3.png or uploads/photo.jpg')),
				),
				aspect_ratio: v.optional(v.pipe(v.picklist(ASPECT_RATIOS), v.description('The shape, width:height (default square or the model\'s own)'))),
				transparent: v.optional(v.pipe(v.boolean(), v.description('Leave the background transparent, for a logo or icon, where the model can'))),
			}),
			run: async ({ data, signal }) => ({ output: await generateImage(id, data, signal) }),
		}),
	);
}
