import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromApi, fromFeed, sized } from '../src/providers/nasa/apod.ts';

const FEED = `<?xml version="1.0"?><rss xmlns:apod="https://apod.nasa.gov/"><channel><title>APOD</title>
<item>
	<title><![CDATA[Rigel &amp; the Witch Head Nebula]]></title>
	<link>https://science.nasa.gov/apod/rigel-witch-head/</link>
	<pubDate>Mon, 09 Nov 2026 05:00:00 +0000</pubDate>
	<apod:hdurl>https://assets.science.nasa.gov/dynamicimage/assets/science/apod/witch.jpg?w=6000</apod:hdurl>
	<apod:credit>Jane  Doe</apod:credit>
</item>
<item><title>Yesterday</title></item>
</channel></rss>`;

test('the APOD feed gives the newest entry, with a web-sized picture', () => {
	assert.deepEqual(fromFeed(FEED), {
		date: '2026-11-09',
		title: 'Rigel & the Witch Head Nebula',
		credit: 'Jane Doe, via NASA APOD',
		link: 'https://science.nasa.gov/apod/rigel-witch-head/',
		imageUrl: 'https://assets.science.nasa.gov/dynamicimage/assets/science/apod/witch.jpg?w=960&fit=clip',
	});
});

test('a day whose entry is a video, or a feed without entries, has no picture', () => {
	assert.equal(fromFeed(FEED.replace('witch.jpg?w=6000', 'clip.mp4')), null);
	assert.equal(fromFeed('<rss><channel></channel></rss>'), null);
});

test('only NASA’s image service is asked for a smaller copy', () => {
	assert.equal(sized('https://apod.nasa.gov/apod/image/2611/x.jpg'), 'https://apod.nasa.gov/apod/image/2611/x.jpg');
	assert.equal(sized('not a url'), 'not a url');
});

test('the api.nasa.gov fallback turns down videos without thumbnails and its logo placeholder', () => {
	assert.deepEqual(fromApi({ date: '2026-11-09', title: ' Witch Head ', copyright: 'Jane\nDoe', media_type: 'image', url: 'https://apod.nasa.gov/apod/image/2611/w.jpg' }), {
		date: '2026-11-09',
		title: 'Witch Head',
		credit: 'Jane Doe, via NASA APOD',
		link: 'https://apod.nasa.gov/apod/ap261109.html',
		imageUrl: 'https://apod.nasa.gov/apod/image/2611/w.jpg',
	});
	assert.equal(fromApi({ date: '2026-11-09', title: 'Clip', media_type: 'video' }), null);
	assert.equal(fromApi({ date: '2026-11-09', title: 'X', media_type: 'image', url: 'https://apod.nasa.gov/nasa-logo.svg' }), null);
});
