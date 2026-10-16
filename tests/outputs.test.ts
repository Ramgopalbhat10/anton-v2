import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outputLinkPath, outputLinksIn } from '../src/core/outputs.ts';

test('a link into the outputs folder names the Library file, however the agent wrote the path', () => {
	assert.equal(outputLinkPath('../outputs/stream-architecture.png'), 'stream-architecture.png');
	assert.equal(outputLinkPath('outputs/screenshots/home 1.png'), 'screenshots/home 1.png');
	assert.equal(outputLinkPath('/workspace/outputs/reports/q3%20summary.md'), 'reports/q3 summary.md');
	assert.equal(outputLinkPath('./outputs/data.csv?raw=1#top'), 'data.csv');
});

test('anything else is left as written: other sites, anchors, the repo, and paths that climb out', () => {
	for (const href of ['https://example.com/outputs/x.png', '//cdn.example.com/outputs/x.png', '#thread-abc', 'src/app.ts', '../outputs/', '../outputs/../secret', 'mailto:me@example.com', '']) {
		assert.equal(outputLinkPath(href), null, href);
	}
});

test('a reply\'s links and images into the outputs folder, in order and each once', () => {
	const text = 'Made [the SVG](../outputs/a.svg) and ![preview](../outputs/a.png "PNG"), see [docs](https://x.dev) and [again](../outputs/a.svg).';
	assert.deepEqual(outputLinksIn(text), ['a.svg', 'a.png']);
});
