import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';

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
	const models = useQuery({ queryKey: ['models'], queryFn: api.models });
	const session = useQuery({
		queryKey: ['session', sessionId],
		queryFn: () => api.session(sessionId),
	});
	const model = session.data?.session.model ?? models.data?.models[0]?.id;

	return (
		<form
			className="border-t border-border p-3"
			onSubmit={async (event) => {
				event.preventDefault();
				const message = text.trim();
				if (!message) return;
				setText('');
				await onSend(message);
			}}
		>
			<div className="mx-auto flex max-w-3xl flex-col gap-2 rounded-xl border border-border bg-muted px-3 py-2">
				<textarea
					value={text}
					onChange={(event) => setText(event.target.value)}
					placeholder="Add a follow up"
					rows={2}
					className="w-full resize-none bg-transparent text-sm outline-none"
				/>
				<div className="flex items-center justify-between gap-2">
					<select
						className="rounded-md bg-background px-2 py-1 text-xs"
						value={model}
						onChange={(event) => {
							void api.setModel(sessionId, event.target.value);
						}}
					>
						{(models.data?.models ?? []).map((item) => (
							<option key={item.id} value={item.id}>
								{item.label}
							</option>
						))}
					</select>
					<Button type="submit" size="sm" disabled={disabled || !text.trim()}>
						Send
					</Button>
				</div>
			</div>
		</form>
	);
}
