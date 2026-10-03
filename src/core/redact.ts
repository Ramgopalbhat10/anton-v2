/** Values this short are too likely to be ordinary text (`true`, `3000`) to hide. */
const MIN_LENGTH = 8;

/**
 * Replaces each secret's value in a text with its name, longest first so a
 * value that contains another is hidden whole.
 */
export function redactor(secrets: Record<string, string>): (text: string) => string {
	const entries = Object.entries(secrets)
		.filter(([, value]) => value.length >= MIN_LENGTH)
		.sort(([, a], [, b]) => b.length - a.length);
	return (text) => entries.reduce((out, [name, value]) => out.replaceAll(value, `[${name} hidden]`), text);
}
