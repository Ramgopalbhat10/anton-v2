import { type ClipboardEvent, useRef } from 'react';
import { DraftInput, type DraftHandle } from '@/components/draft-input';
import { useSuggestions } from '@/components/suggestions';

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
	const suggestions = useSuggestions({ text: value, setText: onChange, sessionId, projectId, branch, box: () => box.current, keepCommands: true });
	return (
		<>
			{suggestions.list ? (
				<div className={`absolute right-0 left-0 z-10 ${suggestionsPosition === 'above' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'}`}>{suggestions.list}</div>
			) : null}
			<DraftInput
				ref={box}
				value={value}
				tokens={suggestions.tokens}
				placeholder={placeholder}
				autoFocus={autoFocus}
				className={className}
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
		</>
	);
}
