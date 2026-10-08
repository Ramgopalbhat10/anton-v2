import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { BookOpen, Box, Plus, Trash2, Workflow, X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Automations } from '@/components/automations';
import { Block, FIELD as WELL_FIELD, PageHeading, SaveState, SubBlock } from '@/components/settings/parts';
import { Btn, EmptyState, IconBtn, Spinner, Switch } from '@/components/signal';
import { api, type Project, type SettingsChange } from '@/lib/api';
import { useProjects } from '@/lib/projects';

/** A variable row; a stored one keeps its value unless a new one is typed. */
export type Variable = { name: string; value: string; stored: boolean };

/** An MCP server row; `token` is only what was typed, since a stored token is never sent back. */
type Server = { name: string; url: string; token: string; hasAuth: boolean; tools: string };

const toServers = (project: Project): Server[] =>
	project.mcpServers.map((server) => ({ ...server, token: '', tools: server.tools.join(', ') }));

const FIELD = WELL_FIELD;

/** A textarea on the same inset well as the fields. */
const AREA =
	'w-full resize-y rounded-lg border border-(--border-subtle) bg-(--well-bg) px-2.5 py-2 text-(--text-primary) outline-none placeholder:text-(--text-disabled) focus-visible:shadow-(--focus-ring)';

function Section({ title, help, children }: { title: string; help: ReactNode; children: ReactNode }) {
	return (
		<SubBlock label={title} help={help}>
			{children}
		</SubBlock>
	);
}

function parsePorts(text: string): number[] {
	return [...new Set(text.split(/[\s,]+/).filter(Boolean).map(Number))];
}

type Draft = { variables: Variable[]; setupScript: string; ports: string; baseImage: string; followUps: boolean; servers: Server[] };

export const storedVariables = (names: string[]): Variable[] => names.map((name) => ({ name, value: '', stored: true }));

/** The rows as a change for the server: null keeps a stored value. */
export function toEnv(variables: Variable[]): Record<string, string | null> {
	const named = variables.filter((row) => row.name.trim());
	// Two rows with one name would let an empty new row replace the stored value.
	if (new Set(named.map((row) => row.name.trim())).size !== named.length) throw new Error('Each variable needs its own name.');
	return Object.fromEntries(named.map((row) => [row.name.trim(), row.stored && !row.value ? null : row.value]));
}

function toChange({ variables, setupScript, ports, baseImage, followUps, servers }: Draft): SettingsChange {
	const env = toEnv(variables);
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

export function VariablesEditor({ rows, onChange }: { rows: Variable[]; onChange: (rows: Variable[]) => void }) {
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
						autoComplete="new-password"
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
	const [variables, setVariables] = useState(() => storedVariables(project.envKeys));
	const [setupScript, setSetupScript] = useState(project.setupScript);
	const [ports, setPorts] = useState(project.previewPorts.join(', '));
	const [baseImage, setBaseImage] = useState(project.baseImage ?? '');
	const [followUps, setFollowUps] = useState(project.followUps);
	const [servers, setServers] = useState(() => toServers(project));
	const save = useMutation({
		mutationFn: async () => api.updateProjectSettings(project.id, toChange({ variables, setupScript, ports, baseImage, followUps, servers })),
		onSuccess: (saved) => {
			setVariables(storedVariables(saved.envKeys));
			setServers(toServers(saved));
			void queryClient.invalidateQueries({ queryKey: ['projects'] });
		},
	});

	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate();
			}}
		>
			<Block
				title="Every new sandbox"
				icon={Box}
				help="What a task's sandbox gets for this repository, and what the agent can reach from it."
				footer={
					<>
						<SaveState pending={save.isPending} success={save.isSuccess} error={save.error} saved="Saved. New sandboxes use these settings." />
						<Btn type="submit" size="sm" variant="primary" disabled={save.isPending}>
							{save.isPending ? 'Saving…' : 'Save settings'}
						</Btn>
					</>
				}
			>
				<Section
					title="Environment variables"
					help="Set in every command the agent runs and in the terminal, over any of the same name in Settings › Secrets. Values are stored by Anton and never shown again. Git credentials are not needed here."
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
						className={`${AREA} font-mono text-[12px] leading-[18px]`}
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
			</Block>
		</form>
	);
}

/** The repo's notes, saved on their own: the agent adds to them while the settings form is open. */
function MemoryEditor({ project }: { project: Project }) {
	const queryClient = useQueryClient();
	const [memory, setMemory] = useState(project.memory);
	const [base, setBase] = useState(project.memory);
	// Notes the agent added since the page loaded show up, unless you are editing.
	useEffect(() => {
		if (memory === base) setMemory(project.memory);
		setBase(project.memory);
	}, [project.memory]);
	const save = useMutation({
		mutationFn: () => api.saveMemory(project.id, memory),
		onSuccess: (saved) => {
			setMemory(saved.memory);
			void queryClient.invalidateQueries({ queryKey: ['projects'] });
		},
	});
	return (
		<Block
			title="Memory"
			icon={BookOpen}
			help="Notes every task's agent reads about this repository. The agent adds what it learns (how to run things, conventions, gotchas); edit or remove anything here."
			footer={
				<>
					{save.isError ? <span className="text-[12px] text-(--danger-text)">{save.error.message}</span> : null}
					<Btn size="sm" disabled={save.isPending || memory === project.memory} onClick={() => save.mutate()}>
						{save.isPending ? 'Saving…' : 'Save notes'}
					</Btn>
				</>
			}
		>
			<textarea
				value={memory}
				onChange={(event) => setMemory(event.target.value)}
				rows={6}
				placeholder="- Run the tests with npm test; they need Docker."
				className={`${AREA} text-[13px] leading-[19px]`}
			/>
		</Block>
	);
}

/** Removes the repo after a second click, since its tasks go with it. */
function RemoveRepo({ project }: { project: Project }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [confirming, setConfirming] = useState(false);
	const remove = useMutation({
		mutationFn: () => api.removeProject(project.id),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ['projects'] });
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
			void navigate({ to: '/settings/$section', params: { section: 'repos' } });
		},
	});
	return (
		<div className="flex items-center justify-end gap-3">
			<Btn
				variant="danger"
				size="sm"
				disabled={remove.isPending}
				onClick={() => (confirming ? remove.mutate() : setConfirming(true))}
				onBlur={() => setConfirming(false)}
			>
				{remove.isPending ? 'Removing…' : confirming ? 'Click again to remove' : 'Remove repository'}
			</Btn>
			{remove.isError ? <span className="text-[12px] text-(--danger-text)">{remove.error.message}</span> : null}
		</div>
	);
}

/** Per-repository sandbox settings; tasks already running keep theirs until their sandbox restarts. */
export function RepoSettingsPage() {
	const { projectId } = useParams({ from: '/settings/repos/$projectId' });
	const projects = useProjects();
	const project = projects.data?.projects.find((item) => item.id === projectId);
	if (projects.isPending) {
		return (
			<div className="flex items-center gap-2 text-[12px] text-(--text-tertiary)">
				<Spinner size={12} />
				Loading
			</div>
		);
	}
	if (!project) return <EmptyState title="Repository not found" body={projects.error?.message} />;
	return (
		<>
			<PageHeading title={project.repoFullName}>
				What every new sandbox for this repository gets. Tasks already running keep theirs until their sandbox restarts.
			</PageHeading>
			<SettingsForm key={project.id} project={project} />
			<MemoryEditor key={project.id} project={project} />
			<Block
				title="Automations"
				icon={Workflow}
				help="Tasks that start on their own, checked every five minutes. Each labeled issue becomes one task that opens a pull request; up to three start per check. Nothing starts once today's spending cap is reached."
			>
				<Automations projectId={project.id} />
			</Block>
			<Block
				title="Remove"
				icon={Trash2}
				className="border-(--danger-border)"
				help="Deletes this repository's tasks, their sandboxes and history, its automations and memory from Anton. Branches and pull requests stay on GitHub."
				footer={<RemoveRepo project={project} />}
			/>
		</>
	);
}
