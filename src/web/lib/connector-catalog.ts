/**
 * What Settings › Connectors says about the connectors it offers: Gmail, and
 * remote MCP servers that sign in with OAuth, added with a click. A server you
 * add by its own address is described by its address alone.
 */

export type CatalogEntry = {
	/** `gmail`, or the name an MCP server is added under. */
	id: string;
	name: string;
	by: string;
	tagline: string;
	description: string;
	category: string;
	/** An MCP server's address; Gmail has none. */
	url?: string;
	docs?: string;
};

export const GMAIL_ENTRY: CatalogEntry = {
	id: 'gmail',
	name: 'Gmail',
	by: 'Google',
	tagline: 'Search, read and draft email, and send it when you press Send',
	description:
		'Connect Gmail so a task can search your mail, read whole conversations, and write drafts in your Drafts folder. ' +
		'When the agent wants to send one, the thread shows you the email as it will go with Send and Don’t send; nothing leaves until you press Send, and a draft changed after you saw it is not sent. ' +
		'Anton signs in on an OAuth client of your own and keeps the sign-in on its server: it never reaches a sandbox or the model.',
	category: 'Email',
	docs: 'https://developers.google.com/gmail/api',
};

/** Gmail's tools, by what the sign-in and switches allow. */
export const GMAIL_TOOLS = [
	{ name: 'gmail_search', needs: 'read', about: 'Search with Gmail’s search syntax, newest first' },
	{ name: 'gmail_read_thread', needs: 'read', about: 'Read a conversation in full' },
	{ name: 'gmail_draft', needs: 'draft', about: 'Write or rewrite a draft; sends nothing' },
	{ name: 'gmail_send', needs: 'send', about: 'Ask you to send a draft; it goes when you press Send' },
] as const;

export const MCP_CATALOG: CatalogEntry[] = [
	{
		id: 'linear',
		name: 'Linear',
		by: 'Linear',
		tagline: 'Find, create and update issues, projects and comments',
		description: 'Connect Linear so a task can look up issues, file new ones from what it finds, update status and leave comments as it works.',
		category: 'Project management',
		url: 'https://mcp.linear.app/mcp',
		docs: 'https://linear.app/docs/mcp',
	},
	{
		id: 'notion',
		name: 'Notion',
		by: 'Notion',
		tagline: 'Search, read and update pages and databases',
		description: 'Connect Notion so a task can search your workspace, read specs and notes, and write pages or database entries back.',
		category: 'Docs and notes',
		url: 'https://mcp.notion.com/mcp',
		docs: 'https://developers.notion.com/docs/mcp',
	},
	{
		id: 'atlassian',
		name: 'Atlassian',
		by: 'Atlassian',
		tagline: 'Jira issues and Confluence pages',
		description: 'Connect Jira and Confluence so a task can read and update issues, search pages and write documentation.',
		category: 'Project management',
		url: 'https://mcp.atlassian.com/v1/mcp',
		docs: 'https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/',
	},
	{
		id: 'sentry',
		name: 'Sentry',
		by: 'Sentry',
		tagline: 'Errors, stack traces and releases',
		description: 'Connect Sentry so a task can pull an issue’s stack trace and events while it fixes the bug, and check releases.',
		category: 'Monitoring',
		url: 'https://mcp.sentry.dev/mcp',
		docs: 'https://docs.sentry.io/product/sentry-mcp/',
	},
	{
		id: 'stripe',
		name: 'Stripe',
		by: 'Stripe',
		tagline: 'Customers, payments and the Stripe docs',
		description: 'Connect Stripe so a task can look up customers, products and payments, and search Stripe’s documentation.',
		category: 'Payments',
		url: 'https://mcp.stripe.com',
		docs: 'https://docs.stripe.com/mcp',
	},
	{
		id: 'vercel',
		name: 'Vercel',
		by: 'Vercel',
		tagline: 'Projects, deployments and build logs',
		description: 'Connect Vercel so a task can list projects and deployments, and read a failed build’s logs.',
		category: 'Hosting',
		url: 'https://mcp.vercel.com',
		docs: 'https://vercel.com/docs/mcp',
	},
	{
		id: 'supabase',
		name: 'Supabase',
		by: 'Supabase',
		tagline: 'Tables, SQL, migrations and logs',
		description: 'Connect Supabase so a task can read your schema, run SQL, apply migrations and check logs.',
		category: 'Databases',
		url: 'https://mcp.supabase.com/mcp',
		docs: 'https://supabase.com/docs/guides/getting-started/mcp',
	},
];

/** The catalog entry for an added server: the one at its address, if Anton offers it. */
export function catalogEntryFor(url: string): CatalogEntry | undefined {
	const origin = URL.canParse(url) ? new URL(url).origin : url;
	return MCP_CATALOG.find((entry) => entry.url && new URL(entry.url).origin === origin);
}
