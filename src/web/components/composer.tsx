import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupTextarea,
} from '@/components/ui/input-group';
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
	const label = models.data?.models.find((item) => item.id === model)?.label ?? 'Model';

	return (
		<form
			className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4 pt-2"
			onSubmit={async (event) => {
				event.preventDefault();
				const message = text.trim();
				if (!message || disabled) return;
				setText('');
				await onSend(message);
			}}
		>
			<InputGroup className="border-transparent bg-muted dark:bg-muted">
				<InputGroupTextarea
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
				<InputGroupAddon align="block-end" className="justify-between">
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<InputGroupButton aria-label="Model">
								{label}
								<ChevronDown />
							</InputGroupButton>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" side="top">
							<DropdownMenuRadioGroup
								value={model}
								onValueChange={(value) => {
									void api.setModel(sessionId, value).then(() => {
										void queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
									});
								}}
							>
								{(models.data?.models ?? []).map((item) => (
									<DropdownMenuRadioItem key={item.id} value={item.id}>
										{item.label}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuContent>
					</DropdownMenu>
					<InputGroupButton
						type="submit"
						variant="default"
						size="icon-xs"
						disabled={disabled || !text.trim()}
						aria-label="Send"
					>
						<ArrowUp />
					</InputGroupButton>
				</InputGroupAddon>
			</InputGroup>
		</form>
	);
}
