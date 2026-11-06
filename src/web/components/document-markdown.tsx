import { Frontmatter, useFrontmatter } from '@/components/frontmatter';
import { FileImages, Markdown, type FileImages as FileImagesValue } from '@/components/markdown';
import { cn } from '@/lib/utils';

/** A document's complete frontmatter and sanitized Markdown, identical in Overview and Files. */
export function DocumentMarkdown({ text, images, className }: { text: string; images?: FileImagesValue | null; className?: string }) {
	const front = useFrontmatter(text);
	return (
		<div className={cn('flex min-w-0 flex-col gap-4', className)}>
			<Frontmatter front={front} />
			<FileImages.Provider value={images ?? null}>
				<Markdown text={front.body} html />
			</FileImages.Provider>
		</div>
	);
}
