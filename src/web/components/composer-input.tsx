import { ChevronDown, ChevronUp } from 'lucide-react';
import { type ClipboardEvent, useCallback, useRef } from 'react';
import { DraftInput, type DraftHandle } from '@/components/draft-input';
import { IconBtn } from '@/components/signal';
import { useSuggestions } from '@/components/suggestions';
import { useFold } from '@/lib/use-fold';
import { cn } from '@/lib/utils';

/** Lines a draft shows before it scrolls, until it is opened out to its whole height, up to most of the window. */
const FOLD = { lines: 5, cap: 0.6 };

/** The same rich draft, completion, caret and editing behavior in both task composers. */
export function ComposerInput({
	value,
	onChange,
	sessionId,
	projectId,
	branch,
	placeholder,
	autoFocus,
	className,
	submitOn = 'enter',
	suggestionsPosition = 'above',
	onPaste,
}: {
	value: string;
	onChange: (value: string) => void;
	sessionId?: string;
	projectId?: string;
	branch?: string;
	placeholder: string;
	autoFocus?: boolean;
	className?: string;
	submitOn?: 'enter' | 'mod-enter';
	suggestionsPosition?: 'above' | 'below';
	onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
}) {
	const box = useRef<DraftHandle>(null);
	const wrap = useRef<HTMLDivElement>(null);
	const draft = useCallback(() => wrap.current?.querySelector<HTMLElement>('.sg-draft') ?? null, []);
	const fold = useFold(draft, value, FOLD);
	const suggestions = useSuggestions({ text: value, setText: onChange, sessionId, projectId, branch, box: () => box.current, keepCommands: true });
	return (
		<>
			{suggestions.list ? (
				<div className={`absolute right-0 left-0 z-10 ${suggestionsPosition === 'above' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'}`}>{suggestions.list}</div>
			) : null}
			<div ref={wrap} className="relative">
				<DraftInput
					ref={box}
					value={value}
					tokens={suggestions.tokens}
					placeholder={placeholder}
					autoFocus={autoFocus}
					className={cn(className, fold.long && 'pr-8')}
					style={fold.style}
					onChange={(next, caret) => {
						onChange(next);
						suggestions.track(caret);
					}}
					onSelect={suggestions.track}
					onPaste={onPaste}
					onKeyDown={(event) => {
						if (suggestions.onKeyDown(event)) return;
						if (event.key === 'Enter' && !event.shiftKey && (submitOn === 'enter' || event.metaKey || event.ctrlKey)) {
							event.preventDefault();
							event.currentTarget.closest('form')?.requestSubmit();
						}
					}}
				/>
				{fold.long ? (
					<IconBtn
						size="xs"
						icon={fold.open ? ChevronDown : ChevronUp}
						label={fold.open ? 'Fold the message back' : 'Show the whole message'}
						aria-expanded={fold.open}
						className="absolute top-0 right-0"
						onMouseDown={(event) => event.preventDefault()}
						onClick={fold.toggle}
					/>
				) : null}
			</div>
		</>
	);
}
