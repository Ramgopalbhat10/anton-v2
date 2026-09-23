import { useFlueAgent } from '@flue/react';
import { useQuery } from '@tanstack/react-query';
import { Composer } from '@/components/composer';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { api } from '@/lib/api';

export function Thread({ sessionId }: { sessionId: string }) {
	const health = useQuery({ queryKey: ['health'], queryFn: api.health });
	const agent = useFlueAgent({
		url: `/api/agents/coder/${sessionId}`,
	});

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-6">
				<div className="mx-auto flex max-w-3xl flex-col gap-4">
					{!health.data?.openRouter ? (
						<Alert className="border-transparent bg-muted">
							<AlertDescription>
								Set OPENROUTER_API_KEY in .env to run the coding agent. Git, Files, and Terminal still use the local VM.
							</AlertDescription>
						</Alert>
					) : null}
					{agent.messages.length === 0 ? (
						<Empty className="border-0">
							<EmptyHeader>
								<EmptyTitle>Workspace is ready</EmptyTitle>
								<EmptyDescription>Ask Anton to inspect or change the workspace on the right.</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : null}
					{agent.messages.map((message) => (
						<article key={message.id} className="text-[13px] leading-5">
							{message.role === 'user' ? (
								<div className="rounded-lg bg-muted px-3 py-2 text-foreground/90">
									{message.parts.map((part, index) =>
										part.type === 'text' ? (
											<p key={index} className="whitespace-pre-wrap">
												{part.text}
											</p>
										) : null,
									)}
								</div>
							) : (
								<div className="flex flex-col gap-2 px-1">
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
													Thought{part.text ? ` · ${part.text.slice(0, 80)}` : ''}
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
					{agent.status === 'submitted' || agent.status === 'streaming' ? (
						<p className="px-1 text-[12px] text-muted-foreground">Working…</p>
					) : null}
					{agent.status === 'error' ? (
						<Alert variant="destructive" className="border-transparent bg-destructive/10">
							<AlertDescription>
								The agent turn failed. Check OPENROUTER_API_KEY or retry from the composer.
							</AlertDescription>
						</Alert>
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
