import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
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
	const model = session.data?.session.model ?? models.data?.models[0]?.id ?? '';

	return (
		<form
			className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 px-4 pb-4 pt-2"
			onSubmit={async (event) => {
				event.preventDefault();
				const message = text.trim();
				if (!message || disabled) return;
				setText('');
				await onSend(message);
			}}
		>
			<Textarea
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
			/>
			<div className="flex items-center justify-between gap-2">
				<Select
					value={model}
					onValueChange={(value) => {
						void api.setModel(sessionId, value).then(() => {
							void queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
						});
					}}
				>
					<SelectTrigger size="sm" aria-label="Model" className="w-44">
						<SelectValue placeholder="Model" />
					</SelectTrigger>
					<SelectContent>
						<SelectGroup>
							{(models.data?.models ?? []).map((item) => (
								<SelectItem key={item.id} value={item.id}>
									{item.label}
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
				<Button type="submit" size="icon-sm" disabled={disabled || !text.trim()} aria-label="Send">
					<ArrowUp />
				</Button>
			</div>
		</form>
	);
}
