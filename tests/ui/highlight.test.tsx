import { describe, expect, it } from 'vitest';
import { highlight } from '@/lib/highlight';

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

	it('leaves a file in a language it does not know or plain text as plain text', async () => {
		expect(await highlight('anything', 'notes.unknownext')).toBeNull();
		expect(await highlight('hello world', 'notes.txt')).toBeNull();
	});
});
