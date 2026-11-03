import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChartCandlestick, Network } from 'lucide-react';
import { useState } from 'react';
import { Status } from '@/components/instrument';
import { Btn, Spinner, Switch } from '@/components/signal';
import { api, type BrokerSettingsChange, type BrokerView } from '@/lib/api';
import { FIELD, Block, PageHeading, SaveState, SettingRow, SubBlock } from './parts';

const time = (at: string) => new Date(at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** A secret's input: empty keeps what is saved, typed text replaces it, and Remove clears it on save. */
function SecretField({ field, value, removed, onChange, onRemove }: {
	field: BrokerView['fields'][number];
	value: string;
	removed: boolean;
	onChange: (value: string) => void;
	onRemove: () => void;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<div className="flex min-w-0 items-end gap-2">
				<label className="flex min-w-0 flex-1 flex-col gap-1">
					<span className="text-[12px] font-medium text-(--text-secondary)">{field.label}</span>
					<input
						type={field.secret ? 'password' : 'text'}
						autoComplete="off"
						spellCheck={false}
						value={value}
						onChange={(event) => onChange(event.target.value)}
						placeholder={field.set && !removed ? 'Saved; type to replace' : 'Not set'}
						className={`${FIELD} font-mono`}
					/>
				</label>
				{field.set && !removed && !value ? (
					<Btn type="button" size="sm" variant="ghost" aria-label={`Remove ${field.label}`} onClick={onRemove}>
						Remove
					</Btn>
				) : null}
			</div>
			<span className="text-[11.5px] leading-[17px] text-pretty text-(--text-disabled)">{removed ? 'Removed when you save.' : field.help}</span>
		</div>
	);
}

function BrokerForm({ broker }: { broker: BrokerView }) {
	const queryClient = useQueryClient();
	const [enabled, setEnabled] = useState(broker.enabled);
	const [trading, setTrading] = useState(broker.trading);
	const [values, setValues] = useState<Record<string, string>>({});
	const [removed, setRemoved] = useState<Set<string>>(new Set());
	const [proxy, setProxy] = useState('');
	const [proxyRemoved, setProxyRemoved] = useState(false);
	const [maxOrderValue, setMaxOrderValue] = useState(String(broker.maxOrderValue));
	const [maxOrdersPerDay, setMaxOrdersPerDay] = useState(String(broker.maxOrdersPerDay));
	const save = useMutation({
		mutationFn: () => {
			const credentials: Record<string, string | null> = {};
			for (const field of broker.fields) credentials[field.key] = values[field.key]?.trim() ? values[field.key]!.trim() : removed.has(field.key) ? '' : null;
			const change: BrokerSettingsChange = { enabled, trading, credentials, maxOrderValue: Number(maxOrderValue), maxOrdersPerDay: Number(maxOrdersPerDay) };
			if (proxy.trim()) change.proxy = proxy.trim();
			else if (proxyRemoved) change.proxy = '';
			return api.saveBroker(broker.id, change);
		},
		onSuccess: (saved) => {
			setValues({});
			setRemoved(new Set());
			setProxy('');
			setProxyRemoved(false);
			queryClient.setQueryData<{ brokers: BrokerView[] }>(['trading'], (current) => (current ? { brokers: current.brokers.map((each) => (each.id === saved.id ? saved : each)) } : current));
		},
	});
	const check = useMutation({ mutationFn: () => api.checkBroker(broker.id), onSettled: () => void queryClient.invalidateQueries({ queryKey: ['trading'] }) });
	const status = broker.sessionEndsAt ? (
		<Status tone="success">Signed in until {time(broker.sessionEndsAt)}</Status>
	) : broker.ready ? (
		<Status tone="neutral">Signs in on first use</Status>
	) : (
		<Status tone="warning">Not set up</Status>
	);
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate();
			}}
		>
			<Block
				title={broker.name}
				icon={ChartCandlestick}
				aside={status}
				help="Read the account, portfolio, quotes and orders, and ask you to place orders."
				info="Every call runs on Anton's server with what you save here. None of it reaches a sandbox, a page or the model, and saved values are never shown again."
				footer={
					<>
						<SaveState pending={save.isPending} success={save.isSuccess} error={save.error} saved="Saved." />
						<Btn type="button" size="sm" variant="ghost" disabled={check.isPending || !broker.ready} onClick={() => check.mutate()}>
							{check.isPending ? 'Checking…' : 'Check'}
						</Btn>
						<Btn type="submit" size="sm" variant="primary" disabled={save.isPending}>
							{save.isPending ? 'Saving…' : 'Save changes'}
						</Btn>
					</>
				}
			>
				{check.data ? (
					<p className={`m-0 mb-2 rounded-[10px] border px-3 py-2 text-[12px] ${check.data.problem ? 'border-(--danger-border) text-(--danger-text)' : 'border-(--border-subtle) text-(--text-secondary)'}`}>
						{check.data.problem ?? `Signed in as ${check.data.name}.`}{' '}
						{check.data.address ? `${broker.name} sees calls from ${check.data.address}; that is the IP to allow for orders.` : 'Could not tell which address calls leave from.'}
					</p>
				) : null}
				<SettingRow title="On" help="Off leaves its tools out of every task.">
					<Switch checked={enabled} onChange={setEnabled} label={<span className="sr-only">On</span>} />
				</SettingRow>
				<SettingRow title="Agent may ask to place orders" help="Each order still waits for your Place in the thread. Off, the agent can only read.">
					<Switch checked={trading} onChange={setTrading} label={<span className="sr-only">Agent may ask to place orders</span>} />
				</SettingRow>
				<SubBlock label="Sign-in" help="Stored on this server and used only here." info="With the TOTP secret, Anton signs in again by itself when the day's token ends.">
					<div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-x-4 gap-y-3 pt-1">
						{broker.fields.map((field) => (
							<SecretField
								key={field.key}
								field={field}
								value={values[field.key] ?? ''}
								removed={removed.has(field.key)}
								onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
								onRemove={() => setRemoved((current) => new Set(current).add(field.key))}
							/>
						))}
					</div>
				</SubBlock>
				<SubBlock
					label="Fixed-IP proxy"
					help={broker.proxy && !proxyRemoved ? `Calls go through ${broker.proxy}.` : 'None: calls leave from this server’s own address.'}
					info={`A forward proxy with the static IP ${broker.name} allows orders from, such as the Lightsail box scripts/trading-proxy/lightsail-launch.sh sets up. Calls cross it in an encrypted tunnel, so it never reads them. It must let calls through to ${broker.hosts.join(', ')} and checkip.amazonaws.com.`}
				>
					<div className="flex min-w-0 items-center gap-2">
						<input
							type="password"
							autoComplete="off"
							spellCheck={false}
							value={proxy}
							onChange={(event) => setProxy(event.target.value)}
							placeholder={broker.proxy && !proxyRemoved ? 'Saved; type to replace' : 'https://anton:password@13-233-10-20.sslip.io'}
							aria-label="Proxy address"
							className={`${FIELD} flex-1 font-mono`}
						/>
						{broker.proxy && !proxyRemoved && !proxy ? (
							<Btn type="button" size="sm" variant="ghost" icon={Network} onClick={() => setProxyRemoved(true)}>
								Remove
							</Btn>
						) : null}
					</div>
				</SubBlock>
				<SubBlock label="Limits" help="Checked when the agent asks and again when you press Place." info={`A market order is valued at the live price. The day runs on ${broker.timeZone} time and counts orders from every task.`}>
					<div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-x-4 gap-y-3 pt-1">
						<label className="flex flex-col gap-1">
							<span className="text-[12px] font-medium text-(--text-secondary)">Most an order may be worth (₹)</span>
							<input type="number" min={1} value={maxOrderValue} onChange={(event) => setMaxOrderValue(event.target.value)} className={FIELD} />
						</label>
						<label className="flex flex-col gap-1">
							<span className="text-[12px] font-medium text-(--text-secondary)">New orders a day</span>
							<input type="number" min={1} step={1} value={maxOrdersPerDay} onChange={(event) => setMaxOrdersPerDay(event.target.value)} className={FIELD} />
						</label>
					</div>
				</SubBlock>
			</Block>
		</form>
	);
}

export function TradingPage() {
	const view = useQuery({ queryKey: ['trading'], queryFn: api.trading });
	return (
		<>
			<PageHeading title="Trading" info="The agent reaches a broker through its connector tools. Reads are its own; every order, change or cancel waits for your Place in the thread, within the limits here.">
				Brokers the agent can read and ask to trade through. Credentials stay on this server.
			</PageHeading>
			{view.data ? (
				view.data.brokers.map((broker) => <BrokerForm key={broker.id} broker={broker} />)
			) : (
				<Spinner size={12} />
			)}
		</>
	);
}
