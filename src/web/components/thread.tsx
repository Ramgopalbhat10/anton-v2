import { useFlueAgent } from '@flue/react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Composer } from '@/components/composer';

export function Thread({ sessionId }: { sessionId: string }) {
	const health = useQuery({ queryKey: ['health'], queryFn: api.health });
	const agent = useFlueAgent({
		url: `/api/agents/coder/${sessionId}`,
	});

	return (
		<div className="flex min-w-0 flex-1 flex-col">
			<div className="flex-1 overflow-y-auto px-6 py-6">
				{!health.data?.openRouter ? (
					<div className="mb-4 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
						Set OPENROUTER_API_KEY in .env to run the coding agent. Git, Files, and Terminal still use the local VM
						workspace.
					</div>
				) : null}
				{agent.messages.length === 0 ? (
					<p className="text-sm text-muted-foreground">Ask Anton to inspect or change the workspace on the right.</p>
				) : null}
				<div className="mx-auto flex max-w-3xl flex-col gap-4">
					{agent.messages.map((message) => (
						<article key={message.id} className="text-sm leading-6">
							{message.role === 'user' ? (
								<blockquote className="rounded-md border border-border bg-muted px-4 py-3 text-muted-foreground">
									{message.parts.map((part, index) =>
										part.type === 'text' ? <p key={index}>{part.text}</p> : null,
									)}
								</blockquote>
							) : (
								<div>
									{message.parts.map((part, index) => {
										if (part.type === 'text') {
											return (
												<p key={index} className="whitespace-pre-wrap">
													{part.text}
												</p>
											);
										}
										if (part.type === 'reasoning') {
											return (
												<p key={index} className="text-muted-foreground">
													Thought {part.text ? `· ${part.text.slice(0, 80)}` : ''}
												</p>
											);
										}
										if (part.type === 'dynamic-tool') {
											return (
												<p key={index} className="text-muted-foreground">
													Tool · {part.toolName ?? 'call'}
												</p>
											);
										}
										return null;
									})}
								</div>
							)}
						</article>
					))}
					{agent.status === 'error' ? (
						<div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
							The agent turn failed. Check OPENROUTER_API_KEY or retry from the composer.
						</div>
					) : null}
				</div>
			</div>
			<Composer
				disabled={agent.status === 'submitted' || agent.status === 'streaming'}
				onSend={async (text) => {
					await agent.sendMessage(text);
				}}
				sessionId={sessionId}
			/>
		</div>
	);
}
