import { AwsClient } from 'aws4fetch';
import type { ObjectStore, StoredObject } from '../../core/ports.ts';

export type S3Options = {
	endpoint: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
};

/** Any S3-compatible bucket: Tigris, R2, S3. */
export function s3Store(options: S3Options): ObjectStore {
	const client = new AwsClient({
		accessKeyId: options.accessKeyId,
		secretAccessKey: options.secretAccessKey,
		region: options.region,
		service: 's3',
	});
	const base = `${options.endpoint.replace(/\/$/, '')}/${options.bucket}`;
	const urlFor = (key: string) => `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;

	async function send(url: string, init?: RequestInit): Promise<Response> {
		const response = await client.fetch(url, init);
		if (!response.ok && response.status !== 404) {
			throw new Error(`Storage ${init?.method ?? 'GET'} failed: ${response.status} ${await response.text()}`);
		}
		return response;
	}

	async function listPage(prefix: string, token: string | null): Promise<[StoredObject[], string | null]> {
		const query = new URLSearchParams({ 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) });
		const xml = await (await send(`${base}?${query}`)).text();
		const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, body]) => ({
			key: decodeXml(/<Key>([\s\S]*?)<\/Key>/.exec(body)?.[1] ?? ''),
			size: Number(/<Size>(\d+)<\/Size>/.exec(body)?.[1] ?? 0),
			modifiedAt: Date.parse(/<LastModified>([\s\S]*?)<\/LastModified>/.exec(body)?.[1] ?? '') || 0,
		}));
		const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null;
		return [objects, next && decodeXml(next)];
	}

	return {
		name: 's3',
		async put(key, body, contentType = 'application/octet-stream') {
			await send(urlFor(key), { method: 'PUT', body, headers: { 'Content-Type': contentType } });
		},
		async get(key) {
			const response = await send(urlFor(key));
			return response.status === 404 ? null : new Uint8Array(await response.arrayBuffer());
		},
		async remove(key) {
			await send(urlFor(key), { method: 'DELETE' });
		},
		has: async (key) => (await send(urlFor(key), { method: 'HEAD' })).status !== 404,
		async list(prefix) {
			const all: StoredObject[] = [];
			let token: string | null = null;
			do {
				const [page, next] = await listPage(prefix, token);
				all.push(...page);
				token = next;
			} while (token);
			return all;
		},
	};
}

function decodeXml(value: string): string {
	return value
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&quot;', '"')
		.replaceAll('&apos;', "'")
		.replaceAll('&amp;', '&');
}
