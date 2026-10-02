import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { Plus, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Automations } from '@/components/automations';
import { MenuButton } from '@/components/nav';
import { Btn, EmptyState, IconBtn, SectionLabel, Spinner, Switch } from '@/components/signal';
import { api, type Project, type SettingsChange } from '@/lib/api';
import { useProjects } from '@/lib/projects';

/** A variable row; a stored one keeps its value unless a new one is typed. */
type Variable = { name: string; value: string; stored: boolean };

/** An MCP server row; `token` is only what was typed, since a stored token is never sent back. */
type Server = { name: string; url: string; token: string; hasAuth: boolean; tools: string };

const toServers = (project: Project): Server[] =>
	project.mcpServers.map((server) => ({ ...server, token: '', tools: server.tools.join(', ') }));

const FIELD =
	'h-8 min-w-0 rounded-lg bg-(--bg-surface) px-2.5 text-[13px] text-(--text-primary) outline-none placeholder:text-(--text-disabled) focus-visible:shadow-(--focus-ring)';

function Section({ title, help, children }: { title: string; help: ReactNode; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			<SectionLabel>{title}</SectionLabel>
			<p className="m-0 text-[12px] leading-[18px] text-pretty text-(--text-tertiary)">{help}</p>
			{children}
		</section>
	);
}

function parsePorts(text: string): number[] {
	return [...new Set(text.split(/[\s,]+/).filter(Boolean).map(Number))];
}

type Draft = { variables: Variable[]; setupScript: string; ports: string; baseImage: string; followUps: boolean; servers: Server[] };

function toChange({ variables, setupScript, ports, baseImage, followUps, servers }: Draft): SettingsChange {
	const env = Object.fromEntries(
		variables.filter((row) => row.name.trim()).map((row) => [row.name.trim(), row.stored && !row.value ? null : row.value]),
	);
	const mcpServers = servers
		.filter((row) => row.name.trim() || row.url.trim())
		.map((row) => ({
			name: row.name.trim(),
			url: row.url.trim(),
			// Null keeps a stored token; an empty one says there is none.
			auth: row.token ? row.token : row.hasAuth ? null : '',
			tools: row.tools.split(/[\s,]+/).filter(Boolean),
		}));
	return { env, setupScript, previewPorts: parsePorts(ports), baseImage: baseImage.trim() || null, followUps, mcpServers };
}

function VariablesEditor({ rows, onChange }: { rows: Variable[]; onChange: (rows: Variable[]) => void }) {
	const update = (index: number, patch: Partial<Variable>) => onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
	return (
		<div className="flex flex-col gap-1.5">
			{rows.map((row, index) => (
				<div key={index} className="flex items-center gap-1.5">
					<input
						value={row.name}
						readOnly={row.stored}
						onChange={(event) => update(index, { name: event.target.value })}
						placeholder="NAME"
						aria-label="Variable name"
						className={`${FIELD} w-[40%] font-mono read-only:text-(--text-secondary)`}
					/>
					<input
						type="password"
						autoComplete="off"
						value={row.value}
						onChange={(event) => update(index, { value: event.target.value })}
						placeholder={row.stored ? 'Saved. Type to replace' : 'value'}
						aria-label={`Value of ${row.name || 'the variable'}`}
						className={`${FIELD} flex-1 font-mono`}
					/>
					<IconBtn icon={X} size="sm" label="Remove variable" onClick={() => onChange(rows.filter((_, at) => at !== index))} />
				</div>
			))}
			<Btn
				size="sm"
				variant="ghost"
				icon={Plus}
				className="self-start"
				onClick={() => onChange([...rows, { name: '', value: '', stored: false }])}
			>
				Add a variable
			</Btn>
		</div>
	);
}

function ServersEditor({ rows, onChange }: { rows: Server[]; onChange: (rows: Server[]) => void }) {
	const update = (index: number, patch: Partial<Server>) => onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
	return (
		<div className="flex flex-col gap-2">
			{rows.map((row, index) => (
				<div key={index} className="flex items-start gap-1.5">
					<div className="grid min-w-0 flex-1 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-1.5">
						<input
							value={row.name}
							onChange={(event) => update(index, { name: event.target.value })}
							placeholder="name"
							aria-label="Server name"
							className={`${FIELD} font-mono`}
						/>
						<input
							value={row.url}
							onChange={(event) => update(index, { url: event.target.value })}
							placeholder="https://mcp.example.com/mcp"
							aria-label="Server URL"
							className={`${FIELD} font-mono`}
						/>
						<input
							type="password"
							autoComplete="off"
							value={row.token}
							onChange={(event) => update(index, { token: event.target.value })}
							placeholder={row.hasAuth ? 'Token saved. Type to replace' : 'Bearer token (optional)'}
							aria-label={`Token for ${row.name || 'the server'}`}
							className={`${FIELD} font-mono`}
						/>
						<input
							value={row.tools}
							onChange={(event) => update(index, { tools: event.target.value })}
							placeholder="All tools, or a list: search, fetch"
							aria-label={`Tools of ${row.name || 'the server'}`}
							className={`${FIELD} font-mono`}
						/>
					</div>
					<IconBtn icon={X} size="sm" label="Remove server" onClick={() => onChange(rows.filter((_, at) => at !== index))} />
				</div>
			))}
			<Btn
				size="sm"
				variant="ghost"
				icon={Plus}
				className="self-start"
				onClick={() => onChange([...rows, { name: '', url: '', token: '', hasAuth: false, tools: '' }])}
			>
				Add a server
			</Btn>
		</div>
	);
}

function SettingsForm({ project }: { project: Project }) {
	const queryClient = useQueryClient();
	const [variables, setVariables] = useState<Variable[]>(project.envKeys.map((name) => ({ name, value: '', stored: true })));
	const [setupScript, setSetupScript] = useState(project.setupScript);
	const [ports, setPorts] = useState(project.previewPorts.join(', '));
	const [baseImage, setBaseImage] = useState(project.baseImage ?? '');
	const [followUps, setFollowUps] = useState(project.followUps);
	const [servers, setServers] = useState(() => toServers(project));
	const save = useMutation({
		mutationFn: () => api.updateProjectSettings(project.id, toChange({ variables, setupScript, ports, baseImage, followUps, servers })),
		onSuccess: (saved) => {
			setVariables(saved.envKeys.map((name) => ({ name, value: '', stored: true })));
			setServers(toServers(saved));
			void queryClient.invalidateQueries({ queryKey: ['projects'] });
		},
	});

	return (
		<form
			className="flex flex-col gap-7"
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate();
			}}
		>
			<Section
				title="Environment variables"
				help="Set in every command the agent runs and in the terminal. Values are stored by Anton and never shown again. Git credentials are not needed here."
			>
				<VariablesEditor rows={variables} onChange={setVariables} />
			</Section>
			<Section
				title="Setup script"
				help="Runs in the repository each time a task's sandbox is set up, before the agent starts. Install dependencies or seed a database here. A failure stops the task's setup."
			>
				<textarea
					value={setupScript}
					onChange={(event) => setSetupScript(event.target.value)}
					rows={6}
					spellCheck={false}
					placeholder="npm ci"
					className="w-full resize-y rounded-lg bg-(--bg-surface) px-2.5 py-2 font-mono text-[12px] leading-[18px] text-(--text-primary) outline-none placeholder:text-(--text-disabled) focus-visible:shadow-(--focus-ring)"
				/>
			</Section>
			<Section title="Preview ports" help="Ports that get a public URL in the Preview panel. Up to eight, separated by commas.">
				<input value={ports} onChange={(event) => setPorts(event.target.value)} placeholder="3000, 5173" className={`${FIELD} max-w-[320px] font-mono`} />
			</Section>
			<Section
				title="Base image"
				help="A container image to build the sandbox from instead of Anton's default, for languages it does not include. Anton adds git and its tools on top."
			>
				<input
					value={baseImage}
					onChange={(event) => setBaseImage(event.target.value)}
					placeholder="Default image"
					className={`${FIELD} font-mono`}
				/>
			</Section>
			<Section
				title="Pull request follow-ups"
				help="Every five minutes Anton checks the pull requests its agents opened. Failed checks on the latest commit and new review comments go to that task's agent, up to five times per task."
			>
				<Switch checked={followUps} onChange={setFollowUps} label="Follow up on CI and reviews" className="self-start" />
			</Section>
			<Section
				title="MCP servers"
				help="Remote MCP servers the agent can call, over HTTPS. A token is sent as a bearer header and never shown again. List tool names to allow only those."
			>
				<ServersEditor rows={servers} onChange={setServers} />
			</Section>
			<div className="flex items-center gap-3">
				<Btn type="submit" variant="primary" disabled={save.isPending}>
					{save.isPending ? 'Saving…' : 'Save settings'}
				</Btn>
				{save.isSuccess && !save.isPending ? <span className="text-[12px] text-(--success-text)">Saved. New sandboxes use these settings.</span> : null}
				{save.isError ? <span className="text-[12px] text-(--danger-text)">{save.error.message}</span> : null}
			</div>
		</form>
	);
}

/** Per-repository sandbox settings; tasks already running keep theirs until their sandbox restarts. */
export function RepoSettingsPage() {
	const { projectId } = useParams({ from: '/repos/$projectId' });
	const projects = useProjects();
	const project = projects.data?.projects.find((item) => item.id === projectId);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-11 shrink-0 items-center gap-1 border-b border-(--border-subtle) pr-4 pl-2 text-[13px] font-medium text-(--text-secondary) md:pl-4">
				<MenuButton />
				{project ? `${project.repoFullName} settings` : 'Repository settings'}
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto px-4 pt-8 pb-12 md:px-6">
				<div className="mx-auto flex max-w-[660px] flex-col gap-6">
					{projects.isPending ? (
						<div className="flex items-center gap-2 text-[12px] text-(--text-tertiary)">
							<Spinner size={12} />
							Loading
						</div>
					) : project ? (
						<>
							<SettingsForm key={project.id} project={project} />
							<div className="mt-4 flex flex-col gap-2 border-t border-(--border-subtle) pt-8">
								<SectionLabel>Automations</SectionLabel>
								<p className="m-0 text-[12px] leading-[18px] text-pretty text-(--text-tertiary)">
									Tasks that start on their own, checked every five minutes. Each labeled issue becomes one task that opens a pull request; up to three start per check. Nothing starts once today's spending cap is reached.
								</p>
								<Automations projectId={project.id} />
							</div>
						</>
					) : (
						<EmptyState title="Repository not found" body={projects.error?.message} />
					)}
				</div>
			</div>
		</div>
	);
}
