import { describe, expect, it } from 'vitest';
import { cn, RADIUS_STEPS, TEXT_STEPS } from '@/lib/utils';

/**
 * The design system's scales are the only way to set a size, a radius or a
 * colour (styles/aura-tokens.css, docs/architecture/web-ui.md). These fail
 * on a value typed by hand, so a screen cannot drift from the others.
 */
const raw = import.meta.glob<string>('../../src/web/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true });
const files = Object.entries(raw).map(([path, text]) => ({ name: path.replace('../../src/web/', ''), text }));

/** Every match of `pattern` in the app's sources, as `file: match`, but for the files allowed to have it. */
function found(pattern: RegExp, allowed: string[] = []): string[] {
	return files.flatMap(({ name, text }) => (allowed.includes(name) ? [] : [...text.matchAll(pattern)].map((match) => `${name}: ${match[0]}`)));
}

describe('design tokens', () => {
	it('reads the app', () => {
		expect(files.length).toBeGreaterThan(100);
	});

	it('sizes text with the type steps only', () => {
		// The one logo that is sized by its font size, not a text size. A size in em follows the text it sits in, and is fine.
		expect(found(/(?<![\w-])text-\[[\d.]+(px|rem)\]/g, ['components/illustrations.tsx'])).toEqual([]);
		expect(found(/(?<![\w-])text-(xs|sm|base|lg|xl|[2-9]xl)(?![\w-])/g)).toEqual([]);
	});

	it('rounds corners with the radius steps only', () => {
		expect(found(/(?<!\w)rounded-(?:[trblse]{1,2}-)?\[[^\]]+\]/g)).toEqual([]);
		expect(found(/(?<!\w)rounded-(?:[trblse]{1,2}-)?(xs|sm|md|lg|xl|[2-9]xl)(?![\w-])/g)).toEqual([]);
	});

	it('takes colours from the tokens, not from hex values', () => {
		// Marks and drawings carry their own colours: brand logos, file-type icons, the mascot and the mark,
		// diagrams, project colours you pick, the sketch pad's inks, and the terminal's 16-colour palette.
		const drawn = [
			'components/brand-marks.tsx',
			'components/file-icons.tsx',
			'components/illustrations.tsx',
			'components/mascot.tsx',
			'components/mermaid-diagram.tsx',
			'components/project-icon.tsx',
			'components/signal.tsx',
			'components/sketch.tsx',
			'components/terminal-tab.tsx',
		];
		expect(found(/(?<![\w&])#[0-9a-fA-F]{6}\b/g, drawn).filter((hit) => !hit.includes('lib/'))).toEqual([]);
	});

	it('merges a size with a colour, and one radius with another', () => {
		expect(cn('text-small', 'text-(--text-3)')).toBe('text-small text-(--text-3)');
		expect(cn('text-body', 'text-small')).toBe('text-small');
		expect(cn('rounded-control', 'rounded-card')).toBe('rounded-card');
		expect(TEXT_STEPS).toHaveLength(9);
		expect(RADIUS_STEPS).toHaveLength(5);
	});
});
