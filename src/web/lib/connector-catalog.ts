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
	/** The logo an apps platform hosts for it, drawn when its address names no product Anton knows. */
	logo?: string;
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

/**
 * Apps connected through Composio: `id` is the toolkit's slug at Composio,
 * `url` the app's own address so its mark is the product's. Composio hosts
 * each sign-in and runs each tool; Anton shows the app as a connector like
 * any other. Apps with a first-party MCP server above are not repeated here.
 */
export const COMPOSIO_CATALOG: CatalogEntry[] = [
	{
		id: 'slack',
		name: 'Slack',
		by: 'Slack',
		tagline: 'Channels, messages, threads and canvases',
		description: 'Connect Slack so a task can read channels and threads, search messages, post updates and reply where you say.',
		category: 'Communication',
		url: 'https://slack.com',
		docs: 'https://docs.composio.dev/toolkits/slack',
	},
	{
		id: 'github',
		name: 'GitHub',
		by: 'GitHub',
		tagline: 'Repos, issues, pull requests and code search',
		description: 'Connect GitHub so a task can read issues and pull requests, search code and leave comments as it works.',
		category: 'Developer tools',
		url: 'https://github.com',
		docs: 'https://docs.composio.dev/toolkits/github',
	},
	{
		id: 'googlecalendar',
		name: 'Google Calendar',
		by: 'Google',
		tagline: 'Events, calendars and availability',
		description: 'Connect Google Calendar so a task can check your schedule, find free times and create or update events when you approve.',
		category: 'Productivity',
		url: 'https://calendar.google.com',
		docs: 'https://docs.composio.dev/toolkits/googlecalendar',
	},
	{
		id: 'googledrive',
		name: 'Google Drive',
		by: 'Google',
		tagline: 'Files, folders and shared drives',
		description: 'Connect Google Drive so a task can find, read and organize files in your Drive.',
		category: 'Productivity',
		url: 'https://drive.google.com',
		docs: 'https://docs.composio.dev/toolkits/googledrive',
	},
	{
		id: 'googlesheets',
		name: 'Google Sheets',
		by: 'Google',
		tagline: 'Spreadsheets, ranges and rows',
		description: 'Connect Google Sheets so a task can read and update spreadsheet data.',
		category: 'Productivity',
		url: 'https://sheets.google.com',
		docs: 'https://docs.composio.dev/toolkits/googlesheets',
	},
	{
		id: 'hubspot',
		name: 'HubSpot',
		by: 'HubSpot',
		tagline: 'Contacts, companies, deals and tickets',
		description: 'Connect HubSpot so a task can look up and update CRM records when you approve each change.',
		category: 'CRM',
		url: 'https://hubspot.com',
		docs: 'https://docs.composio.dev/toolkits/hubspot',
	},
	{
		id: 'asana',
		name: 'Asana',
		by: 'Asana',
		tagline: 'Tasks, projects and teams',
		description: 'Connect Asana so a task can file issues it finds as tasks and update their status.',
		category: 'Project management',
		url: 'https://asana.com',
		docs: 'https://docs.composio.dev/toolkits/asana',
	},
	{
		id: 'trello',
		name: 'Trello',
		by: 'Trello',
		tagline: 'Boards, lists and cards',
		description: 'Connect Trello so a task can read boards and move or create cards.',
		category: 'Project management',
		url: 'https://trello.com',
		docs: 'https://docs.composio.dev/toolkits/trello',
	},
	{
		id: 'clickup',
		name: 'ClickUp',
		by: 'ClickUp',
		tagline: 'Tasks, docs and goals',
		description: 'Connect ClickUp so a task can read and update tasks and docs.',
		category: 'Project management',
		url: 'https://clickup.com',
		docs: 'https://docs.composio.dev/toolkits/clickup',
	},
	{
		id: 'todoist',
		name: 'Todoist',
		by: 'Todoist',
		tagline: 'Tasks and projects',
		description: 'Connect Todoist so a task can read and create tasks.',
		category: 'Productivity',
		url: 'https://todoist.com',
		docs: 'https://docs.composio.dev/toolkits/todoist',
	},
	{
		id: 'airtable',
		name: 'Airtable',
		by: 'Airtable',
		tagline: 'Bases, tables and records',
		description: 'Connect Airtable so a task can read and update records in your bases.',
		category: 'Databases',
		url: 'https://airtable.com',
		docs: 'https://docs.composio.dev/toolkits/airtable',
	},
	{
		id: 'figma',
		name: 'Figma',
		by: 'Figma',
		tagline: 'Files, comments and components',
		description: 'Connect Figma so a task can read files and leave comments.',
		category: 'Design',
		url: 'https://figma.com',
		docs: 'https://docs.composio.dev/toolkits/figma',
	},
	{
		id: 'miro',
		name: 'Miro',
		by: 'Miro',
		tagline: 'Whiteboards and boards',
		description: 'Connect Miro so a task can read and update boards.',
		category: 'Design',
		url: 'https://miro.com',
		docs: 'https://docs.composio.dev/toolkits/miro',
	},
	{
		id: 'intercom',
		name: 'Intercom',
		by: 'Intercom',
		tagline: 'Conversations, contacts and tickets',
		description: 'Connect Intercom so a task can read and reply to conversations when you approve.',
		category: 'Support',
		url: 'https://intercom.com',
		docs: 'https://docs.composio.dev/toolkits/intercom',
	},
	{
		id: 'shopify',
		name: 'Shopify',
		by: 'Shopify',
		tagline: 'Orders, products and customers',
		description: 'Connect Shopify so a task can look up orders, products and customers.',
		category: 'Commerce',
		url: 'https://shopify.com',
		docs: 'https://docs.composio.dev/toolkits/shopify',
	},
	{
		id: 'calendly',
		name: 'Calendly',
		by: 'Calendly',
		tagline: 'Scheduling and bookings',
		description: 'Connect Calendly so a task can check availability and manage scheduled events.',
		category: 'Productivity',
		url: 'https://calendly.com',
		docs: 'https://docs.composio.dev/toolkits/calendly',
	},
	{
		id: 'zoom',
		name: 'Zoom',
		by: 'Zoom',
		tagline: 'Meetings, recordings and webinars',
		description: 'Connect Zoom so a task can schedule meetings and read recordings.',
		category: 'Communication',
		url: 'https://zoom.us',
		docs: 'https://docs.composio.dev/toolkits/zoom',
	},
	{
		id: 'discord',
		name: 'Discord',
		by: 'Discord',
		tagline: 'Servers, channels and messages',
		description: 'Connect Discord so a task can read channels and post messages when you approve.',
		category: 'Communication',
		url: 'https://discord.com',
		docs: 'https://docs.composio.dev/toolkits/discord',
	},
	{
		id: 'telegram',
		name: 'Telegram',
		by: 'Telegram',
		tagline: 'Chats, channels and messages',
		description: 'Connect Telegram so a task can read and send messages when you approve.',
		category: 'Communication',
		url: 'https://telegram.org',
		docs: 'https://docs.composio.dev/toolkits/telegram',
	},
	{
		id: 'dropbox',
		name: 'Dropbox',
		by: 'Dropbox',
		tagline: 'Files, folders and sharing',
		description: 'Connect Dropbox so a task can find and organize files.',
		category: 'Productivity',
		url: 'https://dropbox.com',
		docs: 'https://docs.composio.dev/toolkits/dropbox',
	},
	{
		id: 'box',
		name: 'Box',
		by: 'Box',
		tagline: 'Files and collaboration',
		description: 'Connect Box so a task can read and organize files.',
		category: 'Productivity',
		url: 'https://box.com',
		docs: 'https://docs.composio.dev/toolkits/box',
	},
	{
		id: 'spotify',
		name: 'Spotify',
		by: 'Spotify',
		tagline: 'Playlists, library and search',
		description: 'Connect Spotify so a task can search music and manage playlists.',
		category: 'Media',
		url: 'https://spotify.com',
		docs: 'https://docs.composio.dev/toolkits/spotify',
	},
	{
		id: 'youtube',
		name: 'YouTube',
		by: 'YouTube',
		tagline: 'Videos, playlists and comments',
		description: 'Connect YouTube so a task can read videos and channel activity.',
		category: 'Media',
		url: 'https://youtube.com',
		docs: 'https://docs.composio.dev/toolkits/youtube',
	},
	{
		id: 'reddit',
		name: 'Reddit',
		by: 'Reddit',
		tagline: 'Posts, comments and communities',
		description: 'Connect Reddit so a task can read posts and comments.',
		category: 'Social',
		url: 'https://reddit.com',
		docs: 'https://docs.composio.dev/toolkits/reddit',
	},
	{
		id: 'twitter',
		name: 'X',
		by: 'X',
		tagline: 'Posts, timelines and mentions',
		description: 'Connect X so a task can read timelines and post when you approve.',
		category: 'Social',
		url: 'https://x.com',
		docs: 'https://docs.composio.dev/toolkits/twitter',
	},
];

/** The catalog entry for an app connected through Composio, by its toolkit slug. */
export function composioEntryFor(toolkit: string): CatalogEntry | undefined {
	return COMPOSIO_CATALOG.find((entry) => entry.id === toolkit);
}
