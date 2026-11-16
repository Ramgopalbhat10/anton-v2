import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link as RouterLink } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import type { IconComponent } from '@/lib/icons';
import { ArrowRight, Box, Brain, ChevronDown, CircleAlert, Cloud, Database, ExternalLink, Globe, GitBranch, HardDrive, Info, KeyRound, Link, Lock, Monitor, RotateCw, Search, Split, TriangleAlert, X } from '@/lib/icons';
import { Card, CardFooter, CardSection, Figure, type Part, Segmented, SegmentedItem, SplitBar, Status, type Tone } from '@/components/instrument';
import { Btn, Icon, Spinner } from '@/components/signal';
import { api, type Connection, type SetupField, type SetupOption, type SetupSlot } from '@/lib/api';
import { SERVICE_LOGOS } from '@/lib/service-logos';
import { cn } from '@/lib/utils';
import { FIELD, Note, PageHeading } from './parts';

/*
 * Settings › Connections: what Anton runs on, and on a new server where it is
 * set up. Each slot (models, code host, sandboxes, storage, and the optional
 * database, decision model and web search) picks a provider, takes the values
 * it needs, and is tested before it is saved (src/services/settings/setup.ts). A value
 * the server's environment gives shows locked with its variable's name; one
 * saved here takes its place. The live checks (`api.connections`) say how each
 * stands.
 */

/** What each provider is, in a line under the picker, and its mark: a logo, else an icon. */
const PROVIDERS: Record<string, { help: string; logo?: string; icon?: IconComponent }> = {
	'models:openrouter': { help: 'A gateway to most models, billed per token.', logo: 'openrouter' },
	'models:vercel': { help: 'Vercel’s gateway, billed per token.', logo: 'vercel' },
	'git:github': { help: 'github.com, or GitHub Enterprise with its API address.', logo: 'github' },
	'sandbox:modal': { help: 'Cloud machines, one per task.', logo: 'modal' },
	'sandbox:docker': { help: 'A container per task, on this server.', logo: 'docker' },
	'sandbox:local': { help: 'Folders under the data directory, with no isolation.', icon: Monitor },
	'store:s3': { help: 'Tigris, AWS S3, Cloudflare R2 or any S3 API.', icon: Cloud },
	'store:disk': { help: 'Files under the data directory.', icon: HardDrive },
	'database:sqlite': { help: 'A file on this server. Nothing to set up.', logo: 'sqlite' },
	'database:turso': { help: 'Hosted libSQL.', logo: 'turso' },
	'decisions:openrouter': { help: 'Uses the OpenRouter key from Models.', logo: 'openrouter' },
	'decisions:off': { help: 'Every comment wakes the agent and every pull request is reviewed.', icon: X },
	'web:parallel': { help: 'search.parallel.ai, free without a key.', icon: Search },
	'web:mcp': { help: 'Any MCP server with web_search and web_fetch.', icon: Link },
	'web:off': { help: 'The agent has no web tools.', icon: X },
};

/** What a field looks like empty, what it is for, and where to get it. */
const FIELDS: Record<string, { placeholder?: string; help?: string; link?: [string, string] }> = {
	OPENROUTER_API_KEY: { placeholder: 'sk-or-v1-…', link: ['Get a key', 'https://openrouter.ai/keys'] },
	AI_GATEWAY_API_KEY: { placeholder: 'vck_…', link: ['Get a key', 'https://vercel.com/ai-gateway'] },
	ANTON_GITHUB_TOKEN: { placeholder: 'github_pat_…', help: 'Fine-grained, with Contents and Pull requests set to read and write.', link: ['Make a token', 'https://github.com/settings/personal-access-tokens'] },
	ANTON_GITHUB_API_URL: { help: 'Only for GitHub Enterprise.' },
	MODAL_TOKEN_ID: { placeholder: 'ak-…', link: ['Make a token', 'https://modal.com/settings/tokens'] },
	MODAL_TOKEN_SECRET: { placeholder: 'as-…' },
	ANTON_MODAL_APP: { help: 'Tasks run under this Modal app.' },
	ANTON_DOCKER_NETWORK: { placeholder: 'bridge', help: 'none keeps tasks offline.' },
	TIGRIS_BUCKET: { placeholder: 'anton' },
	TIGRIS_ACCESS_KEY_ID: { placeholder: 'tid_…' },
	TIGRIS_SECRET_ACCESS_KEY: { placeholder: 'tsec_…' },
	TURSO_DATABASE_URL: { placeholder: 'libsql://anton-you.turso.io' },
	TURSO_AUTH_TOKEN: { placeholder: 'eyJ…' },
	PARALLEL_API_KEY: { placeholder: 'Free tier without one', link: ['Get a key', 'https://parallel.ai'] },
	ANTON_WEB_MCP_URL: { placeholder: 'https://…/mcp' },
};

/** What a slot is for, under its title while it is not set up. */
const WHAT: Record<string, string> = {
	models: 'Who answers: every reply, plan and review comes from here.',
	git: 'Reads your repositories and opens pull requests. Chats work without it.',
	sandbox: 'Where each task’s machine runs: its checkout, terminal and tests.',
	store: 'Keeps checkpoints, uploads and what tasks make, so a task outlives its machine.',
	database: 'Tasks, threads, settings and history.',
	decisions: 'A small model for yes-or-no calls: skips comments that ask nothing and drives the browser agent.',
	web: 'Gives the agent web_search and web_fetch.',
};

const ICONS: Record<string, IconComponent> = { models: Brain, git: GitBranch, sandbox: Box, store: HardDrive, database: Database, decisions: Split, web: Globe };

/** The live check behind each slot (src/services/settings/connections.ts). */
const CHECK_ID: Record<string, string> = { models: 'models', git: 'git', sandbox: 'sandbox', store: 'store', database: 'database', decisions: 'decisions', web: 'web' };

type State = 'ok' | 'set' | 'restart' | 'failing' | 'off' | 'optional' | 'checking';
const STATE: Record<State, { tone: Tone; label: string }> = {
	ok: { tone: 'success', label: 'Connected' },
	set: { tone: 'accent', label: 'Set up' },
	restart: { tone: 'warning', label: 'Needs a restart' },
	failing: { tone: 'danger', label: 'Failing' },
	off: { tone: 'neutral', label: 'Not set up' },
	optional: { tone: 'neutral', label: 'Optional' },
	checking: { tone: 'accent', label: 'Checking…' },
};

/** A provider's mark, bare in the text colour like every icon. */
function Mark({ slot, option, size = 16 }: { slot: string; option: string | null; size?: number }) {
	const look = option ? PROVIDERS[`${slot}:${option}`] : undefined;
	const logo = look?.logo ? SERVICE_LOGOS[look.logo] : undefined;
	if (logo) return <span aria-hidden className="flex shrink-0 text-(--text-2)" style={{ fontSize: size }} dangerouslySetInnerHTML={{ __html: logo }} />;
	return <Icon icon={look?.icon ?? ICONS[slot] ?? Link} size={size} className="text-(--text-2)" />;
}

const planNames = ['ChatGPT', 'Claude Code', 'OpenCode Go', 'Cursor'];
const PLAN_LOGOS: Record<string, string> = { ChatGPT: 'openai', 'Claude Code': 'claude-code', 'OpenCode Go': 'opencode-go', Cursor: 'cursor' };

/** How a slot stands: a value saved for the next start wins, then the live check, then whether it is needed. */
function stateOf(slot: SetupSlot, check: Connection | undefined, plans: string[], checking: boolean): State {
	if (slot.restart) return 'restart';
	if (slot.id === 'models' && plans.length && check?.state !== 'failing') return 'ok';
	if (checking && !check) return 'checking';
	if (check?.state === 'ok') return 'ok';
	if (check?.state === 'set') return 'set';
	if (check?.state === 'failing') return 'failing';
	return slot.required ? 'off' : 'optional';
}

const ready = (state: State) => state === 'ok' || state === 'set' || state === 'restart';

/** A value the page holds for a field, as typed; a locked one can be opened to type over it. */
type Draft = { provider: string; values: Record<string, string>; open: Record<string, boolean> };

function FieldInput({ field, draft, onChange, onOpen }: { field: SetupField; draft: Draft; onChange: (value: string) => void; onOpen: () => void }) {
	const look = FIELDS[field.env] ?? {};
	const id = `setup-${field.env}`;
	const typed = draft.values[field.env] ?? '';
	const locked = !draft.open[field.env] && (field.source === 'environment' || (field.source === 'saved' && field.secret));
	const help =
		look.help || look.link ? (
			<span className="flex flex-wrap gap-x-2 text-micro leading-4 text-(--text-3)">
				{look.help ? <span>{look.help}</span> : null}
				{look.link ? (
					<a href={look.link[1]} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-inner text-(--accent-text) outline-none hover:underline focus-visible:shadow-(--focus)">
						{look.link[0]} <Icon icon={ExternalLink} size={11} />
					</a>
				) : null}
			</span>
		) : null;
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<label htmlFor={id} className="text-small font-medium text-(--text-2)">
				{field.label}
				{field.optional ? <span className="font-normal text-(--text-4)"> optional</span> : null}
			</label>
			{locked ? (
				<div className="flex min-h-7 min-w-0 items-center gap-2 rounded-control bg-(--bg-active) py-0.5 pr-0.5 pl-2.5 text-small text-(--text-2)">
					<Icon icon={field.source === 'environment' ? Lock : KeyRound} size={13} />
					<span className="min-w-0 flex-1 truncate">
						{field.secret ? (
							<>
								{field.source === 'saved' ? 'Saved key ' : 'Key '}
								<code className="font-mono text-(--text)">…{field.hint ?? '····'}</code>
							</>
						) : (
							<code className="font-mono text-(--text)">{field.value}</code>
						)}
						{field.source === 'environment' ? (
							<>
								{' '}
								from <code className="font-mono text-(--text)">{field.env}</code>
							</>
						) : null}
					</span>
					<Btn size="sm" variant="ghost" onClick={onOpen}>
						{field.secret ? (field.source === 'saved' ? 'Replace key' : 'Paste a key instead') : 'Change'}
					</Btn>
				</div>
			) : (
				<input
					id={id}
					type={field.secret ? 'password' : 'text'}
					autoComplete="off"
					spellCheck={false}
					value={typed}
					placeholder={field.source === 'saved' && !field.secret ? (field.value ?? '') : look.placeholder ?? field.fallback ?? ''}
					onChange={(event) => onChange(event.target.value)}
					className={cn(FIELD, 'h-7 font-mono text-small')}
				/>
			)}
			{field.source === 'environment' && locked ? <span className="text-micro leading-4 text-(--text-3)">From the server’s environment. A value saved here takes its place.</span> : help}
		</div>
	);
}

const OPTION_NOTES: Record<string, string> = {
	'store:s3': 'Switching moves nothing: files already kept stay where they are, and new tasks use the new place.',
	'store:disk': 'Switching moves nothing: files already kept stay where they are, and new tasks use the new place.',
	'database:turso': 'The database is read before anything else, so this is kept in data/anton.env on the server. Tasks so far stay in the SQLite file; the hosted database starts empty.',
};

function SlotBody({ slot, failing, plans }: { slot: SetupSlot; failing: string | null; plans: string[] }) {
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState<Draft>(() => ({ provider: slot.provider ?? slot.options[0].id, values: {}, open: {} }));
	const [passed, setPassed] = useState<string | null>(null);
	const option: SetupOption = slot.options.find((candidate) => candidate.id === draft.provider) ?? slot.options[0];
	const input = () => ({ provider: option.id, values: Object.fromEntries(Object.entries(draft.values).filter(([env, value]) => value.trim() && option.fields.some((field) => field.env === env))) });
	const test = useMutation({ mutationFn: () => api.testSetup(slot.id, input()), onSuccess: (result) => setPassed(result.detail), onError: () => setPassed(null) });
	const save = useMutation({
		mutationFn: () => api.saveSetup(slot.id, input()),
		onSuccess: () => {
			setDraft((current) => ({ ...current, values: {}, open: {} }));
			setPassed(null);
			void queryClient.invalidateQueries({ queryKey: ['setup'] });
			void queryClient.invalidateQueries({ queryKey: ['connections'] });
		},
	});
	const clear = useMutation({
		mutationFn: () => api.clearSetup(slot.id, option.id),
		onSuccess: () => {
			save.reset();
			void queryClient.invalidateQueries({ queryKey: ['setup'] });
			void queryClient.invalidateQueries({ queryKey: ['connections'] });
		},
	});
	const change = (next: Partial<Draft>) => {
		setDraft((current) => ({ ...current, ...next }));
		setPassed(null);
		test.reset();
		save.reset();
	};
	const look = PROVIDERS[`${slot.id}:${option.id}`];
	const busy = test.isPending || save.isPending;
	const error = test.error ?? save.error ?? clear.error;
	const caption = save.isSuccess ? (
		<span className="inline-flex items-center gap-1.5 text-small text-(--text-2)">
			<span className="size-1.5 rounded-full bg-(--ok)" />
			Saved. {save.data.restart ? 'Applies after the next restart.' : save.data.detail}
		</span>
	) : passed ? (
		<span className="inline-flex items-center gap-1.5 text-small text-(--text-2)">
			<span className="size-1.5 rounded-full bg-(--ok)" />
			Test passed. {passed}
		</span>
	) : (
		<span className="text-small text-(--text-3)">{slot.live ? 'Applies as soon as it is saved.' : 'Applies after the next restart.'}</span>
	);
	return (
		<div className="px-4">
			{slot.options.length > 1 ? (
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-(--line) py-3">
					<div className="flex min-w-0 flex-1 basis-[200px] flex-col gap-0.5">
						<div id={`setup-pick-${slot.id}`} className="text-body font-medium">
							Provider
						</div>
						<div className="text-small leading-[18px] text-(--text-3)">{look?.help}</div>
					</div>
					<Segmented label={`${slot.name} provider`} role="radiogroup">
						{slot.options.map((candidate) => (
							<SegmentedItem key={candidate.id} role="radio" on={candidate.id === option.id} onClick={() => change({ provider: candidate.id, values: {}, open: {} })}>
								<Mark slot={slot.id} option={candidate.id} size={14} />
								{candidate.label}
							</SegmentedItem>
						))}
					</Segmented>
				</div>
			) : null}
			{slot.id === 'models' ? (
				<p className="m-0 flex flex-wrap items-center gap-x-2.5 gap-y-1 pb-3 text-small text-(--text-3)">
					Or a plan you already pay for:
					{planNames.map((name) => (
						<span key={name} className={cn('inline-flex items-center gap-1.5', plans.some((plan) => plan.startsWith(name)) ? 'text-(--text)' : 'text-(--text-2)')}>
							<span aria-hidden className="flex" style={{ fontSize: 14 }} dangerouslySetInnerHTML={{ __html: SERVICE_LOGOS[PLAN_LOGOS[name]] }} />
							{name}
						</span>
					))}
					<RouterLink to="/settings/$section" params={{ section: 'subscriptions' }} className="inline-flex items-center gap-1 rounded-inner text-(--accent-text) outline-none hover:underline focus-visible:shadow-(--focus)">
						Sign in under Subscriptions <Icon icon={ArrowRight} size={11} />
					</RouterLink>
				</p>
			) : null}
			{option.fields.length ? (
				<div className="grid gap-x-3.5 gap-y-3 border-t border-(--line) py-3 sm:grid-cols-2">
					{option.fields.map((field) => (
						<div key={field.env} className={cn('min-w-0', option.fields.length === 1 && 'sm:col-span-2')}>
							<FieldInput
								field={field}
								draft={draft}
								onChange={(value) => change({ values: { ...draft.values, [field.env]: value } })}
								onOpen={() => change({ open: { ...draft.open, [field.env]: true } })}
							/>
						</div>
					))}
				</div>
			) : null}
			{slot.id === 'sandbox' && option.id === 'local' ? (
				<div className="in-callout in-callout--warn mb-3 flex gap-2 px-3 py-2.5 text-small leading-[18px]">
					<Icon icon={TriangleAlert} size={14} className="mt-0.5 text-(--warn)" />
					<span>
						<b className="font-semibold">No isolation.</b> Tasks run as Anton’s own user, with nothing between them and this server. Fine for trying Anton out; use Docker or Modal for real work.
					</span>
				</div>
			) : null}
			{error || (failing && option.id === slot.provider && !passed) ? (
				<div role="alert" className="in-callout in-callout--bad mb-3 flex gap-2 px-3 py-2.5 text-small leading-[18px]">
					<Icon icon={CircleAlert} size={14} className="mt-0.5 text-(--bad)" />
					<span className="min-w-0 break-words">{error ? error.message : failing}</span>
				</div>
			) : null}
			{OPTION_NOTES[`${slot.id}:${option.id}`] ? (
				<Note className="flex gap-1.5 pb-3">
					<Icon icon={Info} size={13} className="mt-0.5 text-(--text-4)" />
					<span>{OPTION_NOTES[`${slot.id}:${option.id}`]}</span>
				</Note>
			) : null}
			<div className="flex flex-wrap items-center gap-2 border-t border-(--line) py-2.5">
				<div className="min-w-[180px] flex-1">{caption}</div>
				{slot.saved ? (
					<Btn variant="ghost" disabled={clear.isPending} onClick={() => clear.mutate()}>
						Remove saved values
					</Btn>
				) : null}
				<Btn variant="secondary" disabled={busy} onClick={() => test.mutate()}>
					{test.isPending ? 'Checking…' : 'Test'}
				</Btn>
				<Btn variant="primary" disabled={!passed || busy} title={passed ? undefined : 'Test it first'} onClick={() => save.mutate()}>
					{save.isPending ? 'Saving…' : 'Save'}
				</Btn>
			</div>
		</div>
	);
}

function SlotCard({ slot, state, detail, open, onToggle, plans }: { slot: SetupSlot; state: State; detail: string; open: boolean; onToggle: () => void; plans: string[] }) {
	const option = slot.options.find((candidate) => candidate.id === slot.provider);
	const look = STATE[state];
	const line = state === 'off' || state === 'optional' || state === 'checking' || !detail ? WHAT[slot.id] : detail;
	return (
		<section aria-label={slot.name} className={cn('in-card min-w-0', open && 'bg-(--bg-raised) shadow-[inset_0_0_0_1px_var(--line-strong)]')}>
			<button
				type="button"
				aria-expanded={open}
				onClick={onToggle}
				className="flex min-h-11 w-full items-center gap-2.5 rounded-t-card px-4 pt-3 pb-2 text-left outline-none focus-visible:shadow-(--focus-inset)"
			>
				<span className="inline-flex size-[26px] shrink-0 items-center justify-center">
					<Mark slot={slot.id} option={slot.provider} />
				</span>
				<span className="flex min-w-0 flex-1 items-baseline gap-1.5">
					<span className="shrink-0 truncate text-body leading-[18px] font-semibold text-(--text)">{slot.name}</span>
					{option ? (
						<>
							<span className="text-small text-(--text-4)">/</span>
							<span className="min-w-0 truncate text-small text-(--text-3)">{option.label.toLowerCase()}</span>
						</>
					) : null}
				</span>
				{state === 'off' || state === 'optional' ? <span className="text-small text-(--text-3)">{look.label}</span> : <Status tone={look.tone} pulse={state === 'checking'}>{look.label}</Status>}
				<Icon icon={ChevronDown} size={14} className={cn('text-(--text-4) transition-transform duration-(--t-fast)', open && 'rotate-180')} />
			</button>
			{open ? (
				<SlotBody slot={slot} failing={state === 'failing' ? detail : null} plans={plans} />
			) : (
				<div className="px-4 pt-0.5 pb-4 pl-[50px] text-small leading-[18px] text-pretty break-words text-(--text-3)">{line}</div>
			)}
		</section>
	);
}

/** Docker if it answers, else this server, and disk storage: one machine for everything but the models. */
async function everythingHere(): Promise<void> {
	const docker = await api.testSetup('sandbox', { provider: 'docker', values: {} }).then(
		() => true,
		() => false,
	);
	await api.saveSetup('sandbox', { provider: docker ? 'docker' : 'local', values: {} });
	await api.saveSetup('store', { provider: 'disk', values: {} });
}

export function ConnectionsPage() {
	const queryClient = useQueryClient();
	const setup = useQuery({ queryKey: ['setup'], queryFn: api.setup });
	const connections = useQuery({ queryKey: ['connections'], queryFn: api.connections, staleTime: 30_000 });
	// Undefined until you open or close one: then the first needed slot not set up is open.
	const [open, setOpen] = useState<string | null | undefined>(undefined);
	const preset = useMutation({
		mutationFn: everythingHere,
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: ['setup'] });
			void queryClient.invalidateQueries({ queryKey: ['connections'] });
			setOpen('models');
		},
	});
	const checks = connections.data?.connections ?? [];
	const plans = setup.data?.plans ?? [];
	const slots = (setup.data?.slots ?? []).map((slot) => {
		const check = checks.find((candidate) => candidate.id === CHECK_ID[slot.id]);
		const state = stateOf(slot, check, plans, connections.isFetching);
		const detail =
			slot.id === 'models' && plans.length ? [check?.state === 'ok' ? check.detail : null, `${plans.join(', ')} signed in.`].filter(Boolean).join(' ') : (check?.detail ?? '');
		return { slot, state, detail };
	});
	const needed = slots.filter(({ slot }) => slot.required);
	const optional = slots.filter(({ slot }) => !slot.required);
	const count = (states: State[]) => slots.filter(({ state }) => states.includes(state)).length;
	const failing = count(['failing']);
	const left = needed.filter(({ state }) => state === 'off').length;
	const parts: Part[] = [
		{ key: 'ok', label: 'Connected', value: count(['ok', 'set']), color: 'var(--ok)' },
		{ key: 'restart', label: 'Needs a restart', value: count(['restart']), color: 'var(--warn)' },
		{ key: 'failing', label: 'Failing', value: failing, color: 'var(--bad)' },
		{ key: 'off', label: 'Not set up', value: count(['off']), color: 'var(--track)' },
	];
	const shown = open === undefined ? (needed.find(({ state }) => state === 'off')?.slot.id ?? null) : open;
	const firstRun = left > 0;
	const card = (entry: (typeof slots)[number]) => (
		<SlotCard
			key={entry.slot.id}
			slot={entry.slot}
			state={entry.state}
			detail={entry.detail}
			plans={plans}
			open={shown === entry.slot.id}
			onToggle={() => setOpen(shown === entry.slot.id ? null : entry.slot.id)}
		/>
	);
	return (
		<>
			<PageHeading
				title="Connections"
				actions={
					<Btn size="sm" icon={RotateCw} disabled={connections.isFetching} onClick={() => void connections.refetch()}>
						{connections.isFetching ? 'Checking…' : 'Check again'}
					</Btn>
				}
			>
				{firstRun ? 'What Anton needs before its first task: where it runs, keeps files and gets its models. Each is tested before it is saved, and keys stay on this server.' : 'What Anton runs on, checked when this page opens.'}
			</PageHeading>
			{setup.isPending ? (
				<Spinner size={12} />
			) : setup.isError ? (
				<p className="m-0 text-small text-(--bad)">{setup.error.message}</p>
			) : (
				<>
					<Card
						icon={Link}
						label="Health"
						title="Health"
						sub={connections.isFetching ? 'checking' : 'checked just now'}
						status={
							failing ? <Status tone="danger">{failing} failing</Status> : left ? <Status tone="warning">{left} to set up</Status> : <Status tone="success">Ready for tasks</Status>
						}
						footer={
							firstRun ? (
								<CardFooter caption="Running everything on one machine?">
									<Btn variant="secondary" icon={HardDrive} disabled={preset.isPending} onClick={() => preset.mutate()}>
										{preset.isPending ? 'Setting up…' : 'Everything on this server'}
									</Btn>
								</CardFooter>
							) : undefined
						}
					>
						<CardSection ruled={false} className="pt-1">
							<Figure value={`${needed.filter(({ state }) => ready(state)).length}/${needed.length}`} unit="needed connections ready" />
							<SplitBar label="Connections by state" parts={parts} legend />
						</CardSection>
					</Card>
					<Group label="Needed">
						<div className="flex flex-col gap-2.5">{needed.map(card)}</div>
					</Group>
					<Group label="Optional">
						<div className="grid items-start gap-2.5 sm:grid-cols-2">{optional.map(card)}</div>
					</Group>
				</>
			)}
		</>
	);
}

function Group({ label, children }: { label: string; children: ReactNode }) {
	return (
		<section aria-label={label} className="flex flex-col gap-2">
			<h2 className="m-0 px-0.5 pt-2 text-small font-medium text-(--text-3)">{label}</h2>
			{children}
		</section>
	);
}
