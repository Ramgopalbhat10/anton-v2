import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Activity, ArrowUpRight, ChevronRight, Globe, ListChecks, type LucideIcon, ShieldCheck } from 'lucide-react';
import { Status } from '@/components/instrument';
import { Icon, Spinner, Switch } from '@/components/signal';
import { api } from '@/lib/api';
import { Block, List, PageHeading, RowIcon, SaveState, SettingRow } from './parts';

/** What else keeps the agent in bounds, and where each is set. */
const ELSEWHERE: Array<{ section: string; icon: LucideIcon; title: string; body: string }> = [
	{ section: 'usage', icon: Activity, title: 'Spending caps', body: 'A task or the day stops when it reaches its cap.' },
	{ section: 'sandboxes', icon: Globe, title: 'Allowed domains', body: 'Which sites a sandbox can reach.' },
	{ section: 'general', icon: ListChecks, title: 'Plan mode', body: 'New tasks change nothing until you approve a plan.' },
];

export function GuardrailsPage() {
	const queryClient = useQueryClient();
	const settings = useQuery({ queryKey: ['guardrails'], queryFn: api.guardrails });
	const save = useMutation({
		mutationFn: api.saveGuardrails,
		onSuccess: (saved) => queryClient.setQueryData(['guardrails'], saved),
	});
	return (
		<>
			<PageHeading title="Guardrails">
				What the agent cannot see or do. Git credentials never enter a sandbox the agent uses: Anton clones before the agent starts and pushes
				through the GitHub API.
			</PageHeading>
			{settings.data ? (
				<Block
					title="Secrets"
					icon={ShieldCheck}
					aside={settings.data.hideSecrets ? <Status tone="success">Hidden</Status> : <Status tone="warning">Shown</Status>}
				>
					<SettingRow
						title="Hide secret values from the agent"
						help="Command output shows [NAME hidden] in place of a variable's value, so a value a command prints does not end up in a reply, commit or pull request. Values shorter than eight characters, and files the agent reads, are left as they are."
					>
						<Switch
							checked={settings.data.hideSecrets}
							disabled={save.isPending}
							onChange={(hideSecrets) => save.mutate({ hideSecrets })}
							label={<span className="sr-only">Hide secret values from the agent</span>}
						/>
					</SettingRow>
					<SaveState pending={save.isPending} success={save.isSuccess} error={save.error} saved="Saved. Applies from the agent's next message." />
				</Block>
			) : (
				<Spinner size={12} />
			)}
			<Block title="Set elsewhere" icon={ArrowUpRight} help="The other limits that keep the agent in bounds, each on its own page.">
				<List>
					{ELSEWHERE.map((item) => (
						<Link
							key={item.section}
							to="/settings/$section"
							params={{ section: item.section }}
							className="flex min-h-11 items-center gap-3 rounded-lg px-2.5 py-1.5 outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
						>
							<RowIcon icon={item.icon} />
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<div className="text-[13px] font-medium">{item.title}</div>
								<div className="text-[12px] text-(--text-tertiary)">{item.body}</div>
							</div>
							<Icon icon={ChevronRight} size={12} className="text-(--icon-disabled)" />
						</Link>
					))}
				</List>
			</Block>
		</>
	);
}
