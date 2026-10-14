/*
 * The components the agent can put in a reply with its `show` tool: a small
 * tree of cards, text, figures, tables, charts and inputs, drawn in the
 * thread with Anton's own components. The server checks a tree against these
 * types and limits before the user sees it (src/services/show.ts); the page
 * draws it (src/web/components/show-card.tsx). Both read this file, so it
 * imports nothing.
 */

export type UiTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
export type UiFormat = 'text' | 'number' | 'percent' | 'currency' | 'duration';
export type UiOption = { label: string; value?: string; detail?: string };
export type UiCell = string | number | boolean | null;

export type UiNode =
	| { type: 'card'; title?: string; caption?: string; children: UiNode[] }
	| { type: 'row'; children: UiNode[] }
	| { type: 'col'; children: UiNode[] }
	| { type: 'divider' }
	| { type: 'text'; text: string; muted?: boolean }
	| { type: 'stat'; label: string; value: string | number; change?: string; tone?: UiTone; format?: UiFormat }
	| { type: 'badge'; label: string; tone?: UiTone }
	| { type: 'list'; items: string[]; ordered?: boolean }
	| { type: 'code'; code: string; language?: string }
	| { type: 'diff'; patch: string; path?: string }
	| { type: 'file'; path: string; line?: number; label?: string }
	| { type: 'image'; path: string; alt?: string }
	| { type: 'table'; columns: Array<{ key: string; label?: string; format?: UiFormat; align?: 'left' | 'right' }>; rows: Array<Record<string, UiCell>> }
	| {
			type: 'chart';
			kind: 'bar' | 'stacked-bar' | 'line' | 'area' | 'donut';
			title?: string;
			x: string;
			series: Array<{ key: string; label?: string }>;
			data: Array<Record<string, UiCell>>;
			format?: UiFormat;
	  }
	| { type: 'progress'; label: string; value: number; max?: number; tone?: UiTone }
	| { type: 'timeline'; items: Array<{ title: string; time?: string; detail?: string; state?: 'done' | 'active' | 'pending' | 'failed' }> }
	| { type: 'value'; label: string; formula: string; format?: UiFormat }
	| { type: 'button'; label: string; message?: string; primary?: boolean }
	| { type: 'choice'; name: string; label?: string; options: UiOption[]; multiple?: boolean }
	| { type: 'select'; name: string; label?: string; options: UiOption[] }
	| { type: 'text_input'; name: string; label?: string; placeholder?: string; multiline?: boolean }
	| { type: 'number'; name: string; label?: string; value?: number; min?: number; max?: number; step?: number; slider?: boolean }
	| { type: 'toggle'; name: string; label: string; value?: boolean }
	| { type: 'form'; title: string; submit?: string; children: UiNode[] };

export type UiSpec = { title?: string; children: UiNode[] };

export type UiNodeType = UiNode['type'];

/** Limits that keep a card small enough to read and to draw quickly. */
export const UI_LIMITS = {
	nodes: 300,
	depth: 6,
	rows: 200,
	points: 500,
	series: 5,
	options: 12,
	text: 8000,
	/** The whole tree as JSON. */
	bytes: 60_000,
} as const;

/** Inputs whose values a form sends and formulas read. */
export const INPUT_TYPES = new Set<UiNodeType>(['choice', 'select', 'text_input', 'number', 'toggle']);

export function childrenOf(node: UiNode): UiNode[] {
	return 'children' in node ? node.children : [];
}

/** Every node in the tree, parents before their children. */
export function walk(nodes: UiNode[], visit: (node: UiNode, depth: number) => void, depth = 1): void {
	for (const node of nodes) {
		visit(node, depth);
		walk(childrenOf(node), visit, depth + 1);
	}
}

/** Whether pressing something in the tree sends a message to the agent. */
export function isInteractive(spec: UiSpec): boolean {
	let found = false;
	walk(spec.children, (node) => {
		if (node.type === 'button' || node.type === 'form') found = true;
	});
	return found;
}

/* Formulas: arithmetic over the card's inputs, worked out in the browser. */

type Token = { kind: 'num'; value: number } | { kind: 'name'; value: string } | { kind: 'op'; value: string };

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
	min: Math.min,
	max: Math.max,
	round: (value, digits = 0) => Math.round(value * 10 ** digits) / 10 ** digits,
	floor: Math.floor,
	ceil: Math.ceil,
	abs: Math.abs,
	sqrt: Math.sqrt,
	pow: Math.pow,
};

function tokenize(formula: string): Token[] {
	const tokens: Token[] = [];
	const pattern = /\s*(?:(\d+(?:\.\d+)?|\.\d+)|([A-Za-z_][\w]*)|(\*\*|[-+*/%(),?:]|[<>]=?|==|!=))/y;
	let at = 0;
	while (at < formula.length) {
		if (!formula.slice(at).trim()) break;
		pattern.lastIndex = at;
		const match = pattern.exec(formula);
		if (!match) throw new Error(`Unexpected "${formula.slice(at).trim()[0]}" in the formula`);
		if (match[1] !== undefined) tokens.push({ kind: 'num', value: Number(match[1]) });
		else if (match[2] !== undefined) tokens.push({ kind: 'name', value: match[2] });
		else tokens.push({ kind: 'op', value: match[3] });
		at = pattern.lastIndex;
	}
	return tokens;
}

type Expr = { kind: 'num'; value: number } | { kind: 'name'; name: string } | { kind: 'call'; name: string; args: Expr[] } | { kind: 'unary'; op: string; arg: Expr } | { kind: 'binary'; op: string; left: Expr; right: Expr } | { kind: 'if'; test: Expr; then: Expr; else: Expr };

const PRECEDENCE: Record<string, number> = { '==': 1, '!=': 1, '<': 2, '<=': 2, '>': 2, '>=': 2, '+': 3, '-': 3, '*': 4, '/': 4, '%': 4, '**': 5 };

/** Parses a formula such as `round(price * qty * (1 - discount / 100), 2)`; throws with a reason when it can't. */
export function parseFormula(formula: string): Expr {
	if (formula.length > 500) throw new Error('A formula can be up to 500 characters');
	const tokens = tokenize(formula);
	let at = 0;
	const peek = () => tokens[at];
	const take = (op?: string) => {
		const token = tokens[at];
		if (op && !(token?.kind === 'op' && token.value === op)) throw new Error(`Expected "${op}" in the formula`);
		at++;
		return token;
	};
	const primary = (): Expr => {
		const token = take();
		if (!token) throw new Error('The formula ends too soon');
		if (token.kind === 'num') return { kind: 'num', value: token.value };
		if (token.kind === 'name') {
			if (peek()?.kind === 'op' && peek()?.value === '(') {
				if (!(token.value in FUNCTIONS)) throw new Error(`Unknown function ${token.value}; use ${Object.keys(FUNCTIONS).join(', ')}`);
				take('(');
				const args: Expr[] = [];
				if (!(peek()?.kind === 'op' && peek()?.value === ')')) {
					args.push(conditional());
					while (peek()?.kind === 'op' && peek()?.value === ',') {
						take(',');
						args.push(conditional());
					}
				}
				take(')');
				return { kind: 'call', name: token.value, args };
			}
			return { kind: 'name', name: token.value };
		}
		if (token.value === '(') {
			const inner = conditional();
			take(')');
			return inner;
		}
		if (token.value === '-' || token.value === '+') return { kind: 'unary', op: token.value, arg: binary(5) };
		throw new Error(`Unexpected "${token.value}" in the formula`);
	};
	const binary = (min: number): Expr => {
		let left = primary();
		for (;;) {
			const token = peek();
			if (token?.kind !== 'op') return left;
			const precedence = PRECEDENCE[token.value];
			if (precedence === undefined || precedence < min) return left;
			take();
			// ** groups to the right; the rest to the left.
			const right = binary(token.value === '**' ? precedence : precedence + 1);
			left = { kind: 'binary', op: token.value, left, right };
		}
	};
	const conditional = (): Expr => {
		const test = binary(1);
		if (peek()?.kind === 'op' && peek()?.value === '?') {
			take('?');
			const then = conditional();
			take(':');
			return { kind: 'if', test, then, else: conditional() };
		}
		return test;
	};
	const expr = conditional();
	if (at < tokens.length) throw new Error('The formula has more after its end');
	return expr;
}

/** The input names a formula reads. */
export function formulaNames(expr: Expr): string[] {
	switch (expr.kind) {
		case 'num':
			return [];
		case 'name':
			return [expr.name];
		case 'call':
			return expr.args.flatMap(formulaNames);
		case 'unary':
			return formulaNames(expr.arg);
		case 'binary':
			return [...formulaNames(expr.left), ...formulaNames(expr.right)];
		case 'if':
			return [...formulaNames(expr.test), ...formulaNames(expr.then), ...formulaNames(expr.else)];
	}
}

export function evaluate(expr: Expr, values: Record<string, number>): number {
	switch (expr.kind) {
		case 'num':
			return expr.value;
		case 'name':
			return values[expr.name] ?? Number.NaN;
		case 'call':
			return FUNCTIONS[expr.name](...expr.args.map((arg) => evaluate(arg, values)));
		case 'unary':
			return expr.op === '-' ? -evaluate(expr.arg, values) : evaluate(expr.arg, values);
		case 'if':
			return evaluate(expr.test, values) ? evaluate(expr.then, values) : evaluate(expr.else, values);
		case 'binary': {
			const a = evaluate(expr.left, values);
			const b = evaluate(expr.right, values);
			switch (expr.op) {
				case '+':
					return a + b;
				case '-':
					return a - b;
				case '*':
					return a * b;
				case '/':
					return a / b;
				case '%':
					return a % b;
				case '**':
					return a ** b;
				case '<':
					return Number(a < b);
				case '<=':
					return Number(a <= b);
				case '>':
					return Number(a > b);
				case '>=':
					return Number(a >= b);
				case '==':
					return Number(a === b);
				default:
					return Number(a !== b);
			}
		}
	}
}

/** What an input counts as in a formula: a number, a toggle's 1 or 0, a choice's option value when it is numeric. */
export function numberOf(value: unknown): number {
	if (typeof value === 'number') return value;
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return Number.NaN;
}

/* Text: what the card says, for the agent (the tool's result), for Copy response and for screen readers. */

export function formatValue(value: UiCell | undefined, format: UiFormat = 'text'): string {
	if (value === null || value === undefined || value === '') return '';
	if (typeof value === 'boolean') return value ? 'Yes' : 'No';
	const number = typeof value === 'number' ? value : Number(value);
	if (format === 'text' || !Number.isFinite(number)) return String(value);
	switch (format) {
		case 'percent':
			return `${(Math.abs(number) <= 1 && !Number.isInteger(number) ? number * 100 : number).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
		case 'currency':
			return number.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: Math.abs(number) < 1 ? 4 : 2 });
		case 'duration': {
			if (number < 1000) return `${Math.round(number)} ms`;
			if (number < 60_000) return `${(number / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} s`;
			return `${Math.floor(number / 60_000)} min ${Math.round((number % 60_000) / 1000)} s`;
		}
		default:
			return number.toLocaleString('en-US', { maximumFractionDigits: 2 });
	}
}

export const optionValue = (option: UiOption) => option.value ?? option.label;

function nodeText(node: UiNode, depth: number): string[] {
	const pad = '  '.repeat(Math.max(0, depth - 1));
	const inner = (children: UiNode[]) => children.flatMap((child) => nodeText(child, depth + 1));
	switch (node.type) {
		case 'card':
			return [`${pad}${node.title ? `## ${node.title}` : ''}${node.caption ? ` (${node.caption})` : ''}`.trimEnd(), ...inner(node.children)].filter((line) => line.trim());
		case 'row':
		case 'col':
			return node.children.flatMap((child) => nodeText(child, depth));
		case 'divider':
			return [];
		case 'text':
			return [`${pad}${node.text}`];
		case 'stat':
			return [`${pad}${node.label}: ${formatValue(node.value, node.format)}${node.change ? ` (${node.change})` : ''}`];
		case 'badge':
			return [`${pad}[${node.label}]`];
		case 'list':
			return node.items.map((item, index) => `${pad}${node.ordered ? `${index + 1}.` : '-'} ${item}`);
		case 'code':
			return [`${pad}\`\`\`${node.language ?? ''}`, node.code, `${pad}\`\`\``];
		case 'diff':
			return [`${pad}Diff${node.path ? ` of ${node.path}` : ''}:`, node.patch];
		case 'file':
			return [`${pad}${node.label ? `${node.label}: ` : ''}${node.path}${node.line ? `:${node.line}` : ''}`];
		case 'image':
			return [`${pad}Image ${node.path}${node.alt ? ` (${node.alt})` : ''}`];
		case 'table': {
			const shown = node.rows.slice(0, 20);
			const lines = [
				`${pad}| ${node.columns.map((column) => column.label ?? column.key).join(' | ')} |`,
				`${pad}|${node.columns.map(() => ' --- |').join('')}`,
				...shown.map((row) => `${pad}| ${node.columns.map((column) => formatValue(row[column.key], column.format)).join(' | ')} |`),
			];
			if (node.rows.length > shown.length) lines.push(`${pad}(${node.rows.length - shown.length} more rows)`);
			return lines;
		}
		case 'chart':
			return [
				`${pad}${node.kind} chart${node.title ? ` "${node.title}"` : ''} of ${node.series.map((series) => series.label ?? series.key).join(', ')} by ${node.x}, ${node.data.length} points`,
			];
		case 'progress':
			return [`${pad}${node.label}: ${node.value} of ${node.max ?? 100}`];
		case 'timeline':
			return node.items.map((item) => `${pad}- ${item.title}${item.time ? ` (${item.time})` : ''}${item.state ? ` [${item.state}]` : ''}${item.detail ? `: ${item.detail}` : ''}`);
		case 'value':
			return [`${pad}${node.label} = ${node.formula}`];
		case 'button':
			return [`${pad}[Button: ${node.label}]`];
		case 'choice':
		case 'select':
			return [`${pad}${node.label ?? node.name}: ${node.options.map((option) => option.label).join(' / ')}`];
		case 'text_input':
			return [`${pad}${node.label ?? node.name}: text field`];
		case 'number':
			return [`${pad}${node.label ?? node.name}: ${node.slider ? 'slider' : 'number'}${node.min !== undefined || node.max !== undefined ? ` ${node.min ?? ''}–${node.max ?? ''}` : ''}${node.value !== undefined ? `, now ${node.value}` : ''}`];
		case 'toggle':
			return [`${pad}${node.label}: ${node.value ? 'on' : 'off'}`];
		case 'form':
			return [`${pad}Form "${node.title}":`, ...inner(node.children), `${pad}[Button: ${node.submit ?? 'Submit'}]`];
	}
}

/** The card as plain text, Markdown where it helps. */
export function specText(spec: UiSpec): string {
	return [spec.title ? `## ${spec.title}` : '', ...spec.children.flatMap((node) => nodeText(node, 1))].filter(Boolean).join('\n');
}

/* What pressing something sends: the user's next message, in their words as far as possible. */

/** What a button sends. */
export function buttonMessage(node: Extract<UiNode, { type: 'button' }>): string {
	return node.message?.trim() || node.label;
}

/** An input's value as words: the chosen options' labels, a toggle's on or off. */
export function inputText(node: UiNode, value: unknown): string {
	if (node.type === 'choice' || node.type === 'select') {
		const chosen = Array.isArray(value) ? value : value === undefined || value === '' ? [] : [value];
		return chosen.map((item) => node.options.find((option) => optionValue(option) === item)?.label ?? String(item)).join(', ') || 'none';
	}
	if (node.type === 'toggle') return value ? 'on' : 'off';
	if (value === undefined || value === null || value === '') return 'blank';
	return String(value);
}

/** What submitting a form sends: its title, then each input as "label: value". */
export function formMessage(node: Extract<UiNode, { type: 'form' }>, values: Record<string, unknown>): string {
	const lines: string[] = [];
	walk(node.children, (child) => {
		if (!INPUT_TYPES.has(child.type) || !('name' in child)) return;
		const label = ('label' in child && child.label) || child.name;
		lines.push(`- ${label}: ${inputText(child, values[child.name])}`);
	});
	return `Submitted "${node.title}"${lines.length ? `:\n${lines.join('\n')}` : ''}`;
}

