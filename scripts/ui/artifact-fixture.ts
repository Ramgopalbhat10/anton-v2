const image = '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="2200" viewBox="0 0 1600 2200"><rect width="1600" height="2200" fill="#17252f"/><circle cx="800" cy="800" r="480" fill="#6197ac"/><text x="800" y="1500" text-anchor="middle" fill="white" font-size="80">Artifact layout fixture</text></svg>';
const text = '# Artifact report\n\n' + Array.from({ length: 100 }, (_, i) => `## Section ${i + 1}\n\nA long report to check independent scrolling in the artifact viewer.\n\n`).join('');
const code = '// Verify that wide lines scroll without wrapping.\n\n' + Array.from({ length: 120 }, (_, i) => `const row${i + 1} = { index: ${i + 1}, description: "${'This line extends past the preview. '.repeat(5)}End of line" };\n`).join('');
const stream = 'BT /F1 24 Tf 72 720 Td (Artifact viewer PDF fixture) Tj ET';
const objects = [
	'<< /Type /Catalog /Pages 2 0 R >>',
	'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
	'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
	'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
	`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
];
let pdf = '%PDF-1.4\n';
const offsets = [0];
for (const [index, object] of objects.entries()) {
	offsets.push(pdf.length);
	pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
}
const xref = pdf.length;
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

export const viewerPdfPath = 'reports/resume-final-expanded.pdf';

export const viewerArtifacts = new Map([
	[`images/${'long-filename-'.repeat(12)}preview.svg`, { type: 'image/svg+xml', body: image }],
	[viewerPdfPath, { type: 'application/pdf', body: pdf }],
	['reports/layout-report.md', { type: 'text/markdown', body: text }],
	['scripts/layout-fixture.js', { type: 'text/javascript', body: code }],
]);
