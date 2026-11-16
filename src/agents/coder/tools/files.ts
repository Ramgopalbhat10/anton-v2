import { defineTool, useSkill, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { skillsFor } from '../../../services/settings/plugins.ts';
import { readProjectFileForAgent } from '../../../services/projects/space-files.ts';
import { readAttachment } from '../../../services/artifacts/attachments.ts';

/** A thread reads the project's Library here, as text; with a sandbox the originals are in ../project-files too. */
export function useProjectFiles(id: string) {
	useTool(
		defineTool({
			name: 'read_project_file',
			description: "Read a file from the project's Library, which the user added for every thread, as text: PDFs, Word, PowerPoint, Excel and OpenDocument files are converted. Without a path, lists the files.",
			input: v.object({
				path: v.optional(v.pipe(v.string(), v.description('File name as listed'))),
				offset: v.optional(v.pipe(v.number(), v.description('Character to start from, for the next part of a long file'))),
			}),
			run: async ({ data }) => ({ output: await readProjectFileForAgent(id, data.path, data.offset) }),
		}),
	);
}

/** Files the user attaches arrive as <attachment> blocks with their text, cut when long; this reads the rest, with or without a sandbox. */
export function useReadAttachment(id: string) {
	useTool(
		defineTool({
			name: 'read_attachment',
			description:
				'Read a file the user attached to a message (the path in its <attachment> block, under uploads/) as text, from an offset: PDFs, Word, PowerPoint, Excel and OpenDocument files are converted. ' +
				'Use it for the rest of an attachment whose text was cut.',
			input: v.object({
				path: v.pipe(v.string(), v.minLength(1), v.description('The path from the <attachment> block, such as uploads/report.pdf')),
				offset: v.optional(v.pipe(v.number(), v.description('Character to start from'))),
			}),
			run: async ({ data }) => ({ output: await readAttachment(id, data.path, data.offset) }),
		}),
	);
}

/** The repo's own skills and the installed plugins' skills; the agent loads one when a task matches its description. */
export function useSkills(id: string, workspace: boolean) {
	for (const skill of skillsFor(id, workspace)) useSkill(skill);
}
