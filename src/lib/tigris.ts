import { env, hasTigris } from './env.ts';

export async function putArtifact(key: string, body: string | Buffer): Promise<string | null> {
	if (!hasTigris()) return null;
	const url = `${env.tigrisEndpoint.replace(/\/$/, '')}/${env.tigrisBucket}/${key}`;
	const response = await fetch(url, {
		method: 'PUT',
		headers: {
			'Content-Type': 'application/octet-stream',
		},
		body,
	});
	if (!response.ok) return null;
	return key;
}
