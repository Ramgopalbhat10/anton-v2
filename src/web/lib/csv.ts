/** Rows shown in the Library; a bigger file is cut, and the download has the rest. */
export const MAX_ROWS = 500;

/**
 * Splits CSV (or TSV with a tab `separator`) into rows of cells, following
 * RFC 4180 quoting: a quoted cell may hold separators, line breaks and "" for a quote.
 */
export function parseCsv(text: string, separator = ',', maxRows = MAX_ROWS): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = '';
	let quoted = false;
	const endRow = () => {
		row.push(cell);
		rows.push(row);
		row = [];
		cell = '';
	};
	for (let index = 0; index < text.length && rows.length < maxRows; index += 1) {
		const char = text[index];
		if (quoted) {
			if (char !== '"') cell += char;
			else if (text[index + 1] === '"') {
				cell += '"';
				index += 1;
			} else quoted = false;
			continue;
		}
		if (char === '"' && cell === '') quoted = true;
		else if (char === separator) {
			row.push(cell);
			cell = '';
		} else if (char === '\n') endRow();
		else if (char !== '\r') cell += char;
	}
	if ((cell !== '' || row.length > 0) && rows.length < maxRows) endRow();
	return rows;
}
