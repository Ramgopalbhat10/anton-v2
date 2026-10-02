import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Send, Square } from 'lucide-react';
import { useState } from 'react';
import { ModelPicker, useModels } from '@/components/model-picker';
import { IconBtn, Kbd } from '@/components/signal';
import { api, type Session } from '@/lib/api';
import { askToNotify } from '@/lib/notifications';

/**
 * Messages sent while the agent works join its current turn: it reads them
 * after the step it is on, so they redirect it without stopping it.
 */
export function Composer({
	sessionId,
	busy,
	onSend,
	onStop,
}: {
	sessionId: string;
	busy?: boolean;
	onSend: (text: string) => Promise<void>;
	onStop: () => Promise<void>;
}) {
	const [text, setText] = useState('');
	const [stopping, setStopping] = useState(false);
	const stop = async () => {
		setStopping(true);
		await onStop().finally(() => setStopping(false));
	};
	const queryClient = useQueryClient();
	const models = useModels();
	const session = useQuery({
		queryKey: ['session', sessionId],
		queryFn: () => api.session(sessionId),
	});
	const choice = { model: session.data?.model ?? models.data?.default ?? '', reasoning: session.data?.reasoning ?? null };

	return (
		<form
			className="shrink-0 px-4 pt-1 pb-4"
			onSubmit={async (event) => {
				event.preventDefault();
				const message = text.trim();
				if (!message) return;
				askToNotify();
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
					placeholder={busy ? 'Add to what the agent is doing' : 'Ask Anton to change the workspace'}
					rows={2}
					className="w-full resize-none border-0 bg-transparent p-0 text-[13px] leading-[19px] text-(--text-primary) outline-none"
				/>
				<div className="flex flex-nowrap items-center gap-1.5">
					<ModelPicker
						value={choice}
						onChange={(change) => {
							// Show the choice at once; the server's copy replaces it when it lands.
							queryClient.setQueryData<Session>(['session', sessionId], (current) => current && { ...current, ...change });
							void api.editSession(sessionId, change).then((updated) => queryClient.setQueryData(['session', sessionId], updated));
						}}
					/>
					<div className="flex min-w-0 flex-[1_1_8px] items-center justify-end gap-1.5 overflow-hidden text-[11px] whitespace-nowrap text-(--text-disabled)">
						<span className="truncate">{busy ? 'Send to the running agent' : 'Send'}</span>
						<Kbd keys="enter" size="sm" />
					</div>
					{busy ? (
						<IconBtn icon={Square} size="sm" variant="secondary" label="Stop the agent" onClick={() => void stop()} disabled={stopping} />
					) : null}
					<IconBtn type="submit" icon={Send} size="sm" variant="primary" label="Send message" disabled={!text.trim()} />
				</div>
			</div>
		</form>
	);
}
