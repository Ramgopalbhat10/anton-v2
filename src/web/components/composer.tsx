import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

export function Composer({
	sessionId,
	disabled,
	onSend,
}: {
	sessionId: string;
	disabled?: boolean;
	onSend: (text: string) => Promise<void>;
}) {
	const [text, setText] = useState('');
	const queryClient = useQueryClient();
	const models = useQuery({ queryKey: ['models'], queryFn: api.models });
	const session = useQuery({
		queryKey: ['session', sessionId],
		queryFn: () => api.session(sessionId),
	});
	const model = session.data?.session.model ?? models.data?.models[0]?.id;
	const label = models.data?.models.find((item) => item.id === model)?.label ?? 'Model';

	return (
		<form
			className="shrink-0 px-4 pb-4 pt-2"
			onSubmit={async (event) => {
				event.preventDefault();
				const message = text.trim();
				if (!message || disabled) return;
				setText('');
				await onSend(message);
			}}
		>
			<div className="mx-auto flex max-w-3xl flex-col rounded-xl border border-border bg-muted">
				<textarea
					value={text}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter' && !event.shiftKey) {
							event.preventDefault();
							event.currentTarget.form?.requestSubmit();
						}
					}}
					placeholder="Ask Anton to change the workspace"
					rows={2}
					className="w-full resize-none bg-transparent px-3 pt-3 text-[13px] leading-5 outline-none placeholder:text-muted-foreground"
				/>
				<div className="flex h-10 items-center justify-between gap-2 px-2">
					<label className="min-w-0">
						<span className="sr-only">Model</span>
						<select
							className="h-7 max-w-[11rem] truncate rounded-md bg-transparent px-2 text-[12px] text-muted-foreground outline-none hover:bg-accent"
							value={model}
							aria-label={`Model ${label}`}
							onChange={(event) => {
								void api.setModel(sessionId, event.target.value).then(() => {
									void queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
								});
							}}
						>
							{(models.data?.models ?? []).map((item) => (
								<option key={item.id} value={item.id}>
									{item.label}
								</option>
							))}
						</select>
					</label>
					<Button type="submit" size="icon" disabled={disabled || !text.trim()} aria-label="Send">
						<ArrowUp className="size-4" />
					</Button>
				</div>
			</div>
		</form>
	);
}
