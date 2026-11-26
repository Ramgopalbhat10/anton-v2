import { ThreadGlyph } from '@/components/marks/thread-glyph';
import type { Session } from '@/lib/api/sessions';

export function ThreadStateIcon({ thread, size = 13 }: { thread: Session; size?: number }) {
	return <ThreadGlyph thread={thread} size={size} />;
}
