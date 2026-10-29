/** The single Library path component used for an uploaded file. */
export function uploadName(name: string): string {
	const base = name.split(/[\\/]/).pop()?.replace(/[^\w.\- ]+/g, '_').trim() || 'file';
	return base === '.' || base === '..' ? 'file' : base;
}

/** Reserve a unique normalized name for each item in an upload batch. */
export function uniqueUploadNames(names: string[]): string[] {
	const used = new Set<string>();
	return names.map((raw) => {
		const name = uploadName(raw);
		const dot = name.lastIndexOf('.');
		const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
		let next = name;
		for (let index = 2; used.has(next); index++) next = `${base}-${index}${ext}`;
		used.add(next);
		return next;
	});
}
