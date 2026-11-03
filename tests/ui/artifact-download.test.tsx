import { expect, it, vi } from 'vitest';
import { api } from '@/lib/api';

it('hands ZIP downloads to the browser without a fetch or a buffered Blob', () => {
	const items = [{ sessionId: 's1', path: 'reports/a.txt' }, { sessionId: 's2', path: 'reports/a.txt' }];
	const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (this: HTMLFormElement) {
		expect(this.method.toLowerCase()).toBe('post');
		expect(this.getAttribute('action')).toBe('/api/artifacts/download');
		expect(this.target).toBe('_blank');
		expect(this.rel).toBe('noopener');
		expect(JSON.parse(new FormData(this).get('items') as string)).toEqual(items);
		expect(this.isConnected).toBe(true);
	});
	api.downloadArtifacts(items);
	expect(submit).toHaveBeenCalledOnce();
	expect(document.querySelector('form')).toBeNull();
	submit.mockRestore();
});
