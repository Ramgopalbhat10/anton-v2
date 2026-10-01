import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleAlert, CircleCheck, Folder, GitBranch, Play } from 'lucide-react';
import { useState } from 'react';
import { ModelPicker, useModels } from '@/components/composer';
import { MenuButton } from '@/components/nav';
import { Btn, Icon, Menu, MenuContent, MenuItem, MenuTrigger, PickerChip, SectionLabel, Spinner } from '@/components/signal';
import { api, type Session } from '@/lib/api';
import { age } from '@/lib/format';
import { useCreateChat } from '@/lib/create-chat';

function StatusIcon({ session }: { session: Session }) {
	if (session.status === 'running' || session.status === 'starting') return <Spinner />;
	if (session.status === 'error') return <Icon icon={CircleAlert} className="text-(--danger-text)" />;
	return <Icon icon={CircleCheck} className="text-(--success-text)" />;
}

/** One fixed choice shown as a picker, so repo and branch read like the other chips. */
function FixedPicker({ icon, value }: { icon: typeof Folder; value: string }) {
	return (
		<Menu>
			<MenuTrigger asChild>
				<PickerChip icon={icon} label={value} height={28} />
			</MenuTrigger>
			<MenuContent align="start" className="min-w-[200px]">
				<MenuItem checked>{value}</MenuItem>
			</MenuContent>
		</Menu>
	);
}

export function Launcher() {
	const [prompt, setPrompt] = useState('');
	const [model, setModel] = useState('');
	const create = useCreateChat();
	const models = useModels();
	const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions });
	const project = sessions.data?.project;
	const chosenModel = model || models.data?.models[0]?.id || '';
	const recent = (sessions.data?.sessions ?? []).slice(0, 6);

	function start() {
		if (create.isPending) return;
		create.mutate({ prompt, model: chosenModel || undefined });
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-11 shrink-0 items-center gap-1 border-b border-(--border-subtle) pr-4 pl-2 text-[13px] font-medium text-(--text-secondary) md:pl-4">
				<MenuButton />
				New task
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto px-4 pt-8 pb-12 md:px-6">
				<div className="mx-auto flex max-w-[660px] flex-col gap-5">
					<div className="flex flex-col gap-2">
						<h1 className="m-0 text-[24px] leading-[30px] font-semibold tracking-[-0.022em]">What should the agent do?</h1>
						<p className="m-0 text-[13px] leading-[19px] text-pretty text-(--text-tertiary)">
							Describe the outcome, not the steps. Anton works in the workspace sandbox on its own, and shows the diff, the
							terminal, and the files as it goes.
						</p>
					</div>

					<form
						className="flex flex-col gap-3 rounded-xl bg-(--bg-surface) px-4 pt-4 pb-2.5"
						onSubmit={(event) => {
							event.preventDefault();
							start();
						}}
					>
						<textarea
							autoFocus
							rows={4}
							value={prompt}
							onChange={(event) => setPrompt(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
									event.preventDefault();
									start();
								}
							}}
							placeholder="Uploads retry forever when S3 returns 503. Add capped backoff and cover it with a test."
							className="w-full resize-none border-0 bg-transparent p-0 text-[14px] leading-[21px] text-(--text-primary) outline-none"
						/>
						<div className="flex flex-wrap items-center gap-1.5">
							<FixedPicker icon={Folder} value={(project?.repoFullName ?? 'anton-v2').split('/').pop() ?? ''} />
							<FixedPicker icon={GitBranch} value={project?.defaultBranch ?? 'main'} />
							<ModelPicker value={chosenModel} onChange={setModel} height={28} side="bottom" />
							<div className="min-w-0 flex-[1_1_8px]" />
							<Btn type="submit" variant="primary" icon={Play} disabled={create.isPending}>
								{create.isPending ? 'Starting…' : 'Start task'}
							</Btn>
						</div>
					</form>
					{create.isError ? <p className="m-0 text-[12px] text-(--danger-text)">Could not start a task. Is the API server running?</p> : null}

					{recent.length > 0 ? (
						<div className="flex flex-col gap-0.5 pt-2">
							<SectionLabel className="px-2 pb-1.5">Recent tasks</SectionLabel>
							{recent.map((session) => (
								<Link
									key={session.id}
									to="/agents/$sessionId"
									params={{ sessionId: session.id }}
									search={{ app: 'code' }}
									className="flex h-11 items-center gap-2.5 rounded-lg px-2 outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
								>
									<span className="inline-flex text-(--icon-tertiary)">
										<StatusIcon session={session} />
									</span>
									<div className="flex min-w-0 flex-1 flex-col gap-px">
										<div className="truncate text-[13px] text-(--text-primary)">{session.title}</div>
										<div className="truncate text-[11px] text-(--text-disabled)">{project?.repoFullName}</div>
									</div>
									<div className="text-[11px] whitespace-nowrap text-(--text-tertiary)">
										{age(session.createdAt)}
										{session.status === 'error' ? ' · failed' : session.prUrl ? ' · PR opened' : ''}
									</div>
								</Link>
							))}
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
