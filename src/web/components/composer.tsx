import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, Send } from 'lucide-react';
import { useState } from 'react';
import { IconBtn, Kbd, Menu, MenuContent, MenuItem, MenuTrigger, PickerChip } from '@/components/signal';
import { api } from '@/lib/api';

export function useModels() {
	return useQuery({ queryKey: ['models'], queryFn: api.models });
}

/** Chip label: "Claude Sonnet 4" reads as "Sonnet 4". */
export function shortModel(label: string) {
	return label.replace(/^(Claude|Anthropic)\s+/i, '');
}

export function ModelPicker({
	value,
	onChange,
	height,
	side = 'top',
}: {
	value: string;
	onChange: (model: string) => void;
	height?: 26 | 28;
	side?: 'top' | 'bottom';
}) {
	const models = useModels();
	const items = models.data?.models ?? [];
	const label = items.find((item) => item.id === value)?.label ?? 'Model';
	return (
		<Menu>
			<MenuTrigger asChild>
				<PickerChip icon={Cpu} label={shortModel(label)} height={height} aria-label="Model" />
			</MenuTrigger>
			<MenuContent align="start" side={side} className="min-w-[220px]">
				{items.map((item) => (
					<MenuItem key={item.id} checked={item.id === value} onSelect={() => onChange(item.id)}>
						{item.label}
					</MenuItem>
				))}
			</MenuContent>
		</Menu>
	);
}

export function Composer({
	sessionId,
	busy,
	onSend,
}: {
	sessionId: string;
	busy?: boolean;
	onSend: (text: string) => Promise<void>;
}) {
	const [text, setText] = useState('');
	const queryClient = useQueryClient();
	const models = useModels();
	const session = useQuery({
		queryKey: ['session', sessionId],
		queryFn: () => api.session(sessionId),
	});
	const model = session.data?.model ?? models.data?.models[0]?.id ?? '';

	return (
		<form
			className="shrink-0 px-4 pt-1 pb-4"
			onSubmit={async (event) => {
				event.preventDefault();
				const message = text.trim();
				if (!message || busy) return;
				setText('');
				await onSend(message);
			}}
		>
			<div className="mx-auto flex max-w-[700px] flex-col gap-2 rounded-xl bg-(--bg-surface) px-3 pt-3 pb-2">
				<textarea
					value={text}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter' && !event.shiftKey) {
							event.preventDefault();
							event.currentTarget.form?.requestSubmit();
						}
					}}
					placeholder={busy ? 'The agent is working on your last message' : 'Ask Anton to change the workspace'}
					rows={2}
					className="w-full resize-none border-0 bg-transparent p-0 text-[13px] leading-[19px] text-(--text-primary) outline-none"
				/>
				<div className="flex flex-nowrap items-center gap-1.5">
					<ModelPicker
						value={model}
						onChange={(value) => {
							void api.setModel(sessionId, value).then(() => {
								void queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
							});
						}}
					/>
					<div className="flex min-w-0 flex-[1_1_8px] items-center justify-end gap-1.5 overflow-hidden text-[11px] whitespace-nowrap text-(--text-disabled)">
						<span className="truncate">{busy ? 'Wait for this step' : 'Send'}</span>
						<Kbd keys="enter" size="sm" />
					</div>
					<IconBtn type="submit" icon={Send} size="sm" variant="primary" label="Send message" disabled={busy} />
				</div>
			</div>
		</form>
	);
}
