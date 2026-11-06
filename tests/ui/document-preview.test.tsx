import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileView } from '@/components/file-view';
import { FileImages, Markdown } from '@/components/markdown';
import readme from '../fixtures/skills/anatomy-readme.md?raw';
import skill from '../fixtures/skills/SKILL.md?raw';

vi.mock('@/lib/highlight', () => ({ highlight: async () => null }));

function file(text: string) {
	return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
		<FileView path="SKILL.md" queryKey={['fixture']} read={async () => new TextEncoder().encode(text)} />
	</QueryClientProvider>);
}

describe('Document previews', () => {
	it('renders anatomy-style HTML and Markdown, including badges inside HTML, through the safe image provider', () => {
		const renderImage = vi.fn((src: string, alt: string | undefined) => <img src={src} alt={alt} />);
		const { container } = render(<QueryClientProvider client={new QueryClient()}><FileImages.Provider value={{ render: renderImage }}><Markdown text={readme} html /></FileImages.Provider></QueryClientProvider>);
		expect(screen.getByRole('heading', { name: 'Anatomy' }).getAttribute('align')).toBe('center');
		expect(screen.getByRole('heading', { name: 'A real instrument' })).toBeTruthy();
		expect(screen.getByRole('img', { name: 'Claude Code skill' })).toBeTruthy();
		expect(screen.getByRole('link', { name: 'Node 20.10 or later' })).toBeTruthy();
		expect(container.querySelector('details summary')?.textContent).toBe('Requirements');
		expect(container.querySelector('strong')?.textContent).toBe('precise figures');
		expect(renderImage).toHaveBeenCalledWith('assets/rig.png', 'Test rig', false);
		// Code remains code; its example image is never fetched/drawn.
		expect(screen.queryByRole('img', { name: /example/ })).toBeNull();
		expect(container.textContent).toContain('<img src="example.png"');
		expect(container.querySelector('script,style,iframe,svg a,object,embed,form')).toBeNull();
		expect(container.querySelector('[onclick],[onerror],[onload],[style],[srcdoc]')).toBeNull();
		expect(container.querySelector('a[href^="javascript:"],a[href^="data:"]')).toBeNull();
		expect(container.textContent).not.toContain('window.skillExecuted = true');
		expect(container.textContent).not.toContain('body { display: none }');
		expect(container.textContent).not.toContain('Bad SVG');
	});

	it('keeps raw HTML out of agent replies and never implicitly loads remote images', () => {
		const { container } = render(<Markdown text={'<h1 onclick="alert(1)">Not a heading</h1>\n\n![private](https://example.com/leak)'} />);
		expect(container.querySelector('h1,img')).toBeNull();
		expect(screen.getByRole('link', { name: 'private' })).toBeTruthy();
	});

	it('preserves escaped Markdown and HTML code blocks while parsing whole HTML wrappers', () => {
		const { container } = render(<QueryClientProvider client={new QueryClient()}><Markdown html text={'<div>\n\nEscaped \\*\\*not bold\\*\\*.\n\nSecond paragraph.\n\n</div>\n\n<p>**bold** and `inline`</p>\n\n<pre><code>&lt;img src="not-a-picture"&gt;</code></pre>'} /></QueryClientProvider>);
		expect(container.querySelectorAll('strong')).toHaveLength(1);
		expect(container.querySelector('strong')?.textContent).toBe('bold');
		expect(container.textContent).toContain('**not bold**');
		expect(container.querySelector('img')).toBeNull();
		expect(container.querySelector('.sg-code')?.textContent).toContain('<img src="not-a-picture">');
	});

	it('shows every nested field, folded/literal YAML, sequences and scalar values, and keeps source/preview', async () => {
		file(skill);
		const front = await screen.findByRole('region', { name: 'Frontmatter' });
		for (const value of ['author', 'wheresryan22', 'engine', 'runtime', 'node', '20', 'features', 'svg', 'webgl', 'gallery', 'true', '0', 'null', '""', '[]', '{}', 'maintainers', 'Ryan', 'a: b # not a comment', '9007199254740993', '2026-11-06']) {
			expect(front.textContent).toContain(value);
		}
		expect(front.textContent).toContain('figures that explain a technical idea');
		expect(front.textContent).toContain('Codex.\nNeeds Node.js');
		expect(await screen.findByRole('heading', { name: 'Anatomy instructions' })).toBeTruthy();
		fireEvent.click(screen.getByRole('radio', { name: 'Source' }));
		expect(screen.queryByRole('region', { name: 'Frontmatter' })).toBeNull();
		expect(screen.getByText('large-id: 9007199254740993')).toBeTruthy();
		fireEvent.click(screen.getByRole('radio', { name: 'Preview' }));
		expect(screen.getByRole('region', { name: 'Frontmatter' }).textContent).toContain('webgl');
	});

	it.each(['---\nmetadata: [broken\n---\n# Body', '---\nname: one\nname: two\n---\n# Body', '---\nloop: &loop [*loop]\n---\n# Body'])('shows invalid or cyclic YAML as source without dropping it: %s', async (text) => {
		file(text);
		const front = await screen.findByRole('region', { name: 'Frontmatter' });
		expect(within(front).getByText('Could not parse frontmatter. Showing its source.')).toBeTruthy();
		expect(front.querySelector('pre')?.textContent).toBe(text.split('---')[1].trim());
		expect(screen.getByRole('heading', { name: 'Body' })).toBeTruthy();
	});

	it.each(['\uFEFF--- \r\nname: anatomy\r\n...\r\n# Body', '---\nname: anatomy\n---'])('handles BOM, CRLF, YAML end delimiters, and EOF: %s', async (text) => {
		file(text);
		expect((await screen.findByRole('region', { name: 'Frontmatter' })).textContent).toContain('anatomy');
	});
});
