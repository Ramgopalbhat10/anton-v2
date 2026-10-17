import type { MailAttachment, MailDraft, MailDraftInput, Mailbox, MailMessage, MailThread, MailThreadSummary } from '../../core/ports.ts';

const TIMEOUT_MS = 20_000;
/** The most a message's text is kept to, so one long newsletter does not fill the agent's context. */
const MAX_BODY = 20_000;

type Header = { name: string; value: string };
type Part = { mimeType?: string; filename?: string; headers?: Header[]; body?: { size?: number; data?: string; attachmentId?: string }; parts?: Part[] };
type GmailMessage = { id: string; threadId: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: Part };
type GmailThread = { id: string; messages?: GmailMessage[] };
type GmailDraft = { id: string; message?: GmailMessage };

const header = (part: Part | undefined, name: string) => part?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ?? '';
const decode = (data: string) => Buffer.from(data, 'base64url').toString('utf8');

/** HTML as plain text: tags gone, blocks on their own lines, entities read. */
export function htmlText(html: string): string {
	return html
		.replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** The message's own words: quoted earlier messages are left out, since the thread has them already. */
export function withoutQuotes(text: string): string {
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const quoteStart = lines.findIndex((line, index) => index > 0 && /^On .{4,200} wrote:\s*$/.test(line.trim()));
	const kept = (quoteStart > 0 ? lines.slice(0, quoteStart) : lines).filter((line) => !line.startsWith('>'));
	const result = kept.join('\n').trim();
	return result || text.trim();
}

function walk(part: Part | undefined, visit: (part: Part) => void) {
	if (!part) return;
	visit(part);
	for (const child of part.parts ?? []) walk(child, visit);
}

function bodyOf(payload: Part | undefined): string {
	let plain = '';
	let html = '';
	walk(payload, (part) => {
		if (part.filename || !part.body?.data) return;
		if (part.mimeType === 'text/plain' && !plain) plain = decode(part.body.data);
		if (part.mimeType === 'text/html' && !html) html = decode(part.body.data);
	});
	const text = plain || (html ? htmlText(html) : '');
	return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n[… cut at ${MAX_BODY} characters]` : text;
}

function attachmentsOf(payload: Part | undefined): MailAttachment[] {
	const found: MailAttachment[] = [];
	walk(payload, (part) => {
		if (part.filename && part.body?.attachmentId) found.push({ name: part.filename, mimeType: part.mimeType ?? 'application/octet-stream', size: part.body.size ?? 0 });
	});
	return found;
}

function toMessage(message: GmailMessage): MailMessage {
	const payload = message.payload;
	return {
		id: message.id,
		from: header(payload, 'From'),
		to: header(payload, 'To'),
		cc: header(payload, 'Cc'),
		date: header(payload, 'Date'),
		subject: header(payload, 'Subject'),
		body: withoutQuotes(bodyOf(payload)),
		attachments: attachmentsOf(payload),
	};
}

function toSummary(thread: GmailThread): MailThreadSummary {
	const messages = thread.messages ?? [];
	const first = messages[0];
	const latest = messages[messages.length - 1];
	return {
		id: thread.id,
		subject: header(first?.payload, 'Subject') || '(no subject)',
		from: header(latest?.payload, 'From'),
		date: header(latest?.payload, 'Date'),
		snippet: latest?.snippet ?? '',
		messages: messages.length,
		unread: messages.some((message) => message.labelIds?.includes('UNREAD')),
		labels: [...new Set(messages.flatMap((message) => message.labelIds ?? []))],
	};
}

const addresses = (value: string) =>
	value
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);

/** A header value with no line breaks, so nothing the agent writes adds headers of its own. */
const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();

/** A header in RFC 2047 words when it is not plain ASCII. */
const encodedWord = (value: string) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`);

/** The draft as an RFC 2822 message, its text in base64 lines. */
export function rawMessage(draft: MailDraftInput, reply: { inReplyTo: string; references: string } | null): string {
	const lines = [
		draft.to.length ? `To: ${draft.to.map(oneLine).join(', ')}` : '',
		draft.cc.length ? `Cc: ${draft.cc.map(oneLine).join(', ')}` : '',
		draft.bcc.length ? `Bcc: ${draft.bcc.map(oneLine).join(', ')}` : '',
		`Subject: ${encodedWord(oneLine(draft.subject))}`,
		reply?.inReplyTo ? `In-Reply-To: ${oneLine(reply.inReplyTo)}` : '',
		reply?.references ? `References: ${oneLine(reply.references)}` : '',
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset="UTF-8"',
		'Content-Transfer-Encoding: base64',
	].filter(Boolean);
	const body = Buffer.from(draft.body.replace(/\r?\n/g, '\r\n'), 'utf8')
		.toString('base64')
		.replace(/.{1,76}/g, (line) => `${line}\r\n`);
	return Buffer.from(`${lines.join('\r\n')}\r\n\r\n${body}`, 'utf8').toString('base64url');
}

/** Gmail through its REST API, as the signed-in account. */
export function gmailMailbox({ apiUrl = 'https://gmail.googleapis.com/gmail/v1' }: { apiUrl?: string } = {}): Mailbox {
	async function call<T>(token: string, path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
		const timeout = AbortSignal.timeout(TIMEOUT_MS);
		const response = await fetch(`${apiUrl}/users/me${path}`, {
			...init,
			headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			let detail = text.slice(0, 300);
			try {
				detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? detail;
			} catch {
				// Not JSON; the text says it.
			}
			const hint = response.status === 403 && /insufficient|scope/i.test(detail) ? ' Connect Gmail again with drafts and sending allowed.' : '';
			throw new Error(`Gmail answered ${response.status}: ${detail}${hint}`);
		}
		return (await response.json()) as T;
	}

	function toDraft(draft: GmailDraft): MailDraft {
		const payload = draft.message?.payload;
		return {
			id: draft.id,
			messageId: draft.message?.id ?? '',
			threadId: draft.message?.threadId ?? null,
			to: addresses(header(payload, 'To')),
			cc: addresses(header(payload, 'Cc')),
			bcc: addresses(header(payload, 'Bcc')),
			subject: header(payload, 'Subject'),
			body: bodyOf(payload).replace(/\r\n/g, '\n').trimEnd(),
		};
	}

	/** What a reply needs from the conversation's latest message: the ids it answers, and the subject. */
	async function replyHeaders(token: string, threadId: string, signal?: AbortSignal) {
		const thread = await call<GmailThread>(token, `/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject`, {}, signal);
		const latest = thread.messages?.[thread.messages.length - 1];
		const messageId = header(latest?.payload, 'Message-ID');
		const references = [header(latest?.payload, 'References'), messageId].filter(Boolean).join(' ');
		return { inReplyTo: messageId, references, subject: header(thread.messages?.[0]?.payload, 'Subject') };
	}

	return {
		id: 'gmail',
		name: 'Gmail',
		account: 'google',
		scopes: {
			read: ['https://www.googleapis.com/auth/gmail.readonly'],
			draft: ['https://www.googleapis.com/auth/gmail.compose'],
		},

		async search(token, query, max, signal) {
			const listed = await call<{ threads?: Array<{ id: string }> }>(token, `/threads?${new URLSearchParams({ q: query, maxResults: String(max) })}`, {}, signal);
			const metadata = 'format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date';
			const threads = await Promise.all((listed.threads ?? []).map((thread) => call<GmailThread>(token, `/threads/${thread.id}?${metadata}`, {}, signal)));
			return threads.map(toSummary);
		},

		async thread(token, id, signal) {
			const thread = await call<GmailThread>(token, `/threads/${encodeURIComponent(id)}?format=full`, {}, signal);
			const messages = (thread.messages ?? []).map(toMessage);
			return { id: thread.id, subject: messages[0]?.subject || '(no subject)', messages };
		},

		async saveDraft(token, draft, draftId, signal) {
			const reply = draft.threadId ? await replyHeaders(token, draft.threadId, signal) : null;
			const subject = draft.subject || (reply?.subject ? (/^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`) : '');
			const message = { raw: rawMessage({ ...draft, subject }, reply), ...(draft.threadId ? { threadId: draft.threadId } : {}) };
			const saved = await call<GmailDraft>(
				token,
				draftId ? `/drafts/${encodeURIComponent(draftId)}` : '/drafts',
				{ method: draftId ? 'PUT' : 'POST', body: JSON.stringify(draftId ? { id: draftId, message } : { message }) },
				signal,
			);
			return toDraft(await call<GmailDraft>(token, `/drafts/${encodeURIComponent(saved.id)}?format=full`, {}, signal));
		},

		async draft(token, id, signal) {
			return toDraft(await call<GmailDraft>(token, `/drafts/${encodeURIComponent(id)}?format=full`, {}, signal));
		},

		async sendDraft(token, id, signal) {
			const sent = await call<GmailMessage>(token, '/drafts/send', { method: 'POST', body: JSON.stringify({ id }) }, signal);
			return { id: sent.id, threadId: sent.threadId };
		},
	};
}
