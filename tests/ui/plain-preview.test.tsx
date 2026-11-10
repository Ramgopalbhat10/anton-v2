import { describe, expect, it } from 'vitest';
import { plainPreview } from '@/lib/format';

describe('plainPreview', () => {
	it('reads a reply as plain words for a notification', () => {
		expect(plainPreview('Scanned all 133 files under `src/web/components`.\n\n**84 hard-coded hex colour literals across 11 files.**\n\n### `src/web/components/brand-marks.tsx`')).toBe(
			'Scanned all 133 files under src/web/components. 84 hard-coded hex colour literals across 11 files. src/web/components/brand-marks.tsx',
		);
		expect(plainPreview('Done: Done. `skyLook` already had a note')).toBe('Done: skyLook already had a note');
		expect(plainPreview('- one\n- two [docs](https://x.y)')).toBe('one two docs');
		expect(plainPreview('snake_case_name stays')).toBe('snake_case_name stays');
	});
});
