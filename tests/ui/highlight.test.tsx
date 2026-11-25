import { describe, expect, it } from 'vitest';
import { highlight, highlightDiff } from '@/lib/highlight';

describe('Syntax colours', () => {
	it('paints every token with a syntax variable, so code follows the theme', async () => {
		const lines = await highlight('const total: number = add(1, "two"); // sum', 'sum.ts');
		const colours = new Map(lines!.flat().map((token) => [token.content.trim(), token.color]));
		expect(colours.get('const')).toBe('var(--syntax-keyword)');
		expect(colours.get('number')).toBe('var(--syntax-type)');
		expect(colours.get('add')).toBe('var(--syntax-function)');
		expect(colours.get('1')).toBe('var(--syntax-number)');
		expect(colours.get('"two"')).toBe('var(--syntax-string)');
		expect(colours.get('// sum')).toBe('var(--syntax-comment)');
		expect(lines!.flat().every((token) => token.color?.startsWith('var(--syntax-'))).toBe(true);
	});


	it('paints additions and context from the new side, and removals from the old side', async () => {
		const rows = await highlightDiff(
			[
				{ kind: 'context', number: 1, text: 'function value() {' },
				{ kind: 'remove', number: 2, text: '\treturn "old";' },
				{ kind: 'add', number: 2, text: '\treturn "new";' },
				{ kind: 'context', number: 3, text: '}' },
			],
			'value.ts',
		);
		const token = (row: number, content: string) => rows?.[row]?.find((part) => part.content === content);
		expect(token(0, 'function')?.color).toBe('var(--syntax-keyword)');
		expect(token(1, 'return')?.color).toBe('var(--syntax-keyword)');
		expect(token(1, '"old"')?.color).toBe('var(--syntax-string)');
		expect(token(2, 'return')?.color).toBe('var(--syntax-keyword)');
		expect(token(2, '"new"')?.color).toBe('var(--syntax-string)');
		expect(rows?.[1]?.some((part) => part.content.includes('new'))).toBe(false);
		expect(rows?.[2]?.some((part) => part.content.includes('old'))).toBe(false);
	});

	it('paints a deleted file from its old lines', async () => {
		const rows = await highlightDiff([{ kind: 'remove', number: 1, text: 'const gone = true;' }], 'gone.ts');
		expect(rows?.[0]?.find((part) => part.content === 'const')?.color).toBe('var(--syntax-keyword)');
	});

	it('leaves a file in a language it does not know as plain text', async () => {
		expect(await highlight('anything', 'notes.unknownext')).toBeNull();
	});
});
