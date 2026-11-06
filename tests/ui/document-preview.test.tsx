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

	it('keeps footnote references and backlinks matched to their sanitized IDs', () => {
		const { container } = render(<Markdown html text={'A claim.[^1] Another claim.[^1]\n\n[^1]: The source.'} />);
		const references = container.querySelectorAll('a[data-footnote-ref]');
		const backlinks = container.querySelectorAll('a[data-footnote-backref]');
		expect(references).toHaveLength(2);
		expect(backlinks).toHaveLength(2);
		for (const link of [...references, ...backlinks]) {
			const fragment = link.getAttribute('href')!;
			const target = document.getElementById(decodeURIComponent(fragment.slice(1)));
			expect(target).not.toBeNull();
			expect(container.contains(target)).toBe(true);
			expect(link.getAttribute('target')).toBeNull();
		}
		expect(references[0].getAttribute('href')).toBe('#user-content-user-content-fn-1');
		expect(backlinks[0].getAttribute('href')).toBe('#user-content-user-content-fnref-1');
		// Accessible footnote labels must still resolve as well.
		for (const reference of references) {
			expect(document.getElementById(reference.getAttribute('aria-describedby')!)).not.toBeNull();
		}
	});

	it('matches HTML IDs and named anchors, preserves encoded fragments, and retains clobbering protection', () => {
		const { container } = render(<Markdown html text={`
<a href="#requirements">Requirements</a><h2 id="requirements">Requirements target</h2>
<a href="#legacy">Legacy</a><a name="legacy">Legacy target</a>
<a href="#user-content-existing">Prefixed</a><p id="user-content-existing">Prefixed target</p>
<a href="#r%C3%A9sum%C3%A9%20%25">Encoded</a><p id="résumé %">Encoded target</p>
<a href="#location">Clobber test</a><p id="location">Safe target</p>
<a href="#">Top</a><a href="other.md#requirements">Other file</a>
<a href="https://example.com/#requirements">External</a>
`} />);
		for (const label of ['Requirements', 'Legacy', 'Prefixed', 'Encoded', 'Clobber test']) {
			const link = screen.getByRole('link', { name: label });
			const fragment = decodeURIComponent(link.getAttribute('href')!.slice(1));
			const target = [...container.querySelectorAll('[id],a[name]')].find((element) => element.id === fragment || element.getAttribute('name') === fragment);
			expect(target).toBeTruthy();
			expect(link.getAttribute('target')).toBeNull();
		}
		expect(container.querySelector('[id="location"],[name="legacy"]')).toBeNull();
		expect(container.querySelector('[id="user-content-location"]')).not.toBeNull();
		expect(screen.getByRole('link', { name: 'Encoded' }).getAttribute('href')).toBe('#user-content-r%C3%A9sum%C3%A9%20%25');
		expect(screen.getByRole('link', { name: 'Top' }).getAttribute('href')).toBe('#');
		expect(screen.getByRole('link', { name: 'Other file' }).getAttribute('href')).toBe('other.md#requirements');
		expect(screen.getByRole('link', { name: 'External' }).getAttribute('href')).toBe('https://example.com/#requirements');
		expect(screen.getByRole('link', { name: 'External' }).getAttribute('target')).toBe('_blank');
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
