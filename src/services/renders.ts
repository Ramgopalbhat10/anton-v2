import { randomBytes } from "node:crypto";
import { announce } from "../core/changes.ts";
import { InvalidInputError, NotFoundError } from "../core/errors.ts";
import { getSessionRecord } from "../db/sessions.ts";
import { readOutput, saveOutput } from "./checkpoints.ts";

/*
 * Pages the agent writes with `render_html`: one self-contained HTML document,
 * shown in the thread and kept in the Library under renders/. A page never
 * reaches the network, since anything the agent read could otherwise leave in
 * a request it makes:
 *
 * - The page is served with a CSP that sandboxes it (a unique origin, no
 *   cookies, no popups) and allows no requests: inline script and style, and
 *   data: or blob: images and fonts.
 * - It sits in a frame inside a small frame page of Anton's own, whose CSP
 *   lets its frame load only this origin, so the page can't send anything out
 *   by moving itself to another address either.
 *
 * The frame page passes messages between the page and the thread, in the MCP
 * Apps protocol's terms (JSON-RPC over postMessage): the page's height, links
 * to open (the thread asks first), and text for the composer.
 */

export const RENDER_DIR = "renders";
export const MAX_RENDER_BYTES = 512 * 1024;
const RENDER_PATH = /^renders\/[a-z0-9][a-z0-9-]{0,60}\.html$/;

export const PAGE_CSP = [
  "sandbox allow-scripts allow-forms",
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

export const frameCsp = (nonce: string) =>
  [
    "default-src 'none'",
    "frame-src 'self'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join("; ");

/** What a page can rely on from the thread: the theme as CSS variables, and the rules of its frame. */
export const PAGE_GUIDE = [
  "Write one complete, self-contained HTML document with inline <style> and <script>.",
  "It has no network: no CDN scripts, fonts, images or fetch calls. Draw charts with inline SVG or <canvas>, and embed any image as a data: URL.",
  "The page sits in the thread on its background, as wide as the reply (about 700px, 360px on phones): leave html and body without a background, use a fluid width with no outer padding, and no outer card or banner title.",
  "Give charts fixed pixel heights, and let content set the height: no 100vh or height:100% on html or body. The frame grows to fit the page.",
  "Anton sets these CSS variables on :root: --text-primary, --text-secondary, --text-tertiary, --accent, --accent-text, --border, --surface (a card), --surface-inset, --success, --warning, --danger, --data-1 … --data-5 (series colours), --radius, --font-sans, --font-mono. Use them rather than your own colours.",
  'Links open in a new tab after the user agrees. To hand the user text to send you, call window.anton.send("text"): it goes into their message box, and they send it.',
].join(" ");

/** Variables the page gets before the thread sends its own, so its first paint is already right. */
const FALLBACK_THEME: Record<string, string> = {
  "--text-primary": "#ededed",
  "--text-secondary": "#a1a1a1",
  "--text-tertiary": "#7a7a7a",
  "--accent": "#22c3e6",
  "--accent-text": "#5fd4ee",
  "--border": "#2a2a2a",
  "--surface": "#121212",
  "--surface-inset": "#0b0b0b",
  "--success": "#35c88a",
  "--warning": "#e3a63f",
  "--danger": "#ef5f5f",
  "--data-1": "#3fb6d8",
  "--data-2": "#a78bfa",
  "--data-3": "#e3a63f",
  "--data-4": "#35c88a",
  "--data-5": "#f472b6",
  "--radius": "10px",
  "--font-sans":
    "'Geist Variable', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  "--font-mono":
    "'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace",
};

const BASE_CSS =
  `:root{color-scheme:dark;${Object.entries(FALLBACK_THEME)
    .map(([key, value]) => `${key}:${value}`)
    .join(
      ";",
    )}}html,body{margin:0;background:transparent;color:var(--text-primary);font:13px/1.55 var(--font-sans)}` +
  // Plain controls look like Anton's until the page styles them; :where keeps these weaker than any rule of its own.
  ":where(button,input,select,textarea){font:inherit;color:inherit}" +
  ":where(button){background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:5px 11px;cursor:pointer}:where(button:hover){border-color:var(--text-tertiary)}" +
  ":where(input:not([type=range],[type=checkbox],[type=radio]),select,textarea){background:var(--surface-inset);border:1px solid var(--border);border-radius:8px;padding:5px 8px}" +
  ":where(input,progress){accent-color:var(--accent)}:where(a){color:var(--accent-text)}" +
  ":where(table){border-collapse:collapse}:where(th,td){padding:6px 10px;border-bottom:1px solid var(--border);text-align:left}:where(th){color:var(--text-secondary);font-weight:500}";

/**
 * Runs first in the page: applies the thread's theme, reports the page's
 * height as it changes, sends link clicks to the thread to open, and gives
 * the page `window.anton.send`.
 */
const BOOTSTRAP = `(function(){var p=window.parent,s=document.getElementById("anton-theme"),n=0,h=-1;function post(m,q){p.postMessage({jsonrpc:"2.0",method:m,params:q},"*")}function theme(v){if(!v||typeof v!=="object")return;var c=":root{";for(var k in v){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(v[k]).replace(/[;{}<>]/g,"")+";"}s.textContent=c+"}"}window.addEventListener("message",function(e){if(e.source!==p)return;var d=e.data;if(d&&d.jsonrpc==="2.0"&&d.method==="ui/notifications/host-context-changed"&&d.params&&d.params.styles)theme(d.params.styles.variables)});function size(){var r=document.documentElement,v=Math.ceil(Math.max(r.scrollHeight,document.body?document.body.scrollHeight:0));if(v===h)return;h=v;post("ui/notifications/size-changed",{height:v})}if(window.ResizeObserver){var o=new ResizeObserver(size);o.observe(document.documentElement);document.addEventListener("DOMContentLoaded",function(){if(document.body)o.observe(document.body)})}window.addEventListener("load",size);document.addEventListener("DOMContentLoaded",size);document.addEventListener("click",function(e){if(!e.isTrusted)return;var a=e.target&&e.target.closest?e.target.closest("a[href]"):null,u;if(!a)return;try{u=new URL(a.getAttribute("href"),document.baseURI)}catch(x){return}if(u.href.split("#")[0]===location.href.split("#")[0])return;e.preventDefault();if(/^https?:$/.test(u.protocol))post("ui/open-link",{url:u.href})},true);window.anton={send:function(t){if(typeof t==="string"&&t.trim())post("ui/message",{role:"user",content:[{type:"text",text:t.slice(0,4000)}]})}};post("ui/notifications/initialized",{})})();`;

/** Puts the theme and the bootstrap first in the document, ahead of anything the page has, so its own styles still win. */
export function injectBootstrap(html: string): string {
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${BASE_CSS}</style><style id="anton-theme"></style><script>${BOOTSTRAP}</script>`;
  const opening = /<head(\s[^>]*)?>/i.exec(html);
  if (opening)
    return (
      html.slice(0, opening.index + opening[0].length) +
      head +
      html.slice(opening.index + opening[0].length)
    );
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const at = doctype ? doctype[0].length : 0;
  return `${html.slice(0, at)}<head>${head}</head>${html.slice(at)}`;
}

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "page"
  );
}

export type RenderRef = { path: string; title: string; height: number };

/** Keeps the page in the Library and returns where the thread finds it. */
export async function saveRender(
  id: string,
  input: { title: string; html: string; height?: number },
): Promise<RenderRef> {
  if (!(await getSessionRecord(id)))
    throw new NotFoundError("Session not found");
  const bytes = new TextEncoder().encode(input.html);
  if (bytes.length > MAX_RENDER_BYTES)
    throw new InvalidInputError(
      `The page is ${Math.round(bytes.length / 1024)} KB; keep it under ${MAX_RENDER_BYTES / 1024} KB.`,
    );
  if (
    !/<(html|body|div|svg|canvas|main|section|table|p|h[1-6])[\s>]/i.test(
      input.html,
    )
  )
    throw new InvalidInputError("Write a complete HTML document.");
  const path = `${RENDER_DIR}/${slug(input.title)}-${randomBytes(3).toString("hex")}.html`;
  await saveOutput(id, path, bytes, "text/html");
  announce({ kind: "task", id, what: "files" });
  const height = Math.round(Math.min(1600, Math.max(80, input.height ?? 360)));
  return { path, title: input.title.trim().slice(0, 120), height };
}

export function isRenderPath(path: string): boolean {
  return RENDER_PATH.test(path);
}

/** The page, ready to serve: its bootstrap added. */
export async function renderPage(id: string, path: string): Promise<string> {
  if (!isRenderPath(path)) throw new NotFoundError("Not a page");
  const bytes = await readOutput(id, path);
  if (!bytes) throw new NotFoundError("Page not found");
  return injectBootstrap(new TextDecoder().decode(bytes));
}

/** The frame page around a page: it holds the page in a sandboxed frame and passes messages between it and the thread. */
export function renderFrame(
  id: string,
  path: string,
): { html: string; csp: string } {
  if (!isRenderPath(path)) throw new NotFoundError("Not a page");
  const nonce = randomBytes(16).toString("base64");
  const src = `/api/sessions/${encodeURIComponent(id)}/render?path=${encodeURIComponent(path)}`;
  const relay = `(function(){window.addEventListener("message",function(e){var f=document.getElementById("page");if(!f)return;if(e.source===f.contentWindow){if(window.parent!==window)window.parent.postMessage(e.data,"*");else if(e.data&&e.data.method==="ui/open-link"&&e.data.params&&/^https?:/.test(e.data.params.url))window.open(e.data.params.url,"_blank","noopener")}else if(e.source===window.parent&&e.origin===location.origin){f.contentWindow.postMessage(e.data,"*")}})})();`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${path.slice(RENDER_DIR.length + 1)}</title><style>html,body{margin:0;height:100%;background:transparent}body{background:#0b0b0b}html.framed body{background:transparent}iframe{display:block;border:0;width:100%;height:100%;color-scheme:dark}</style></head><body><script nonce="${nonce}">if(window.parent!==window)document.documentElement.className="framed";${relay}</script><iframe id="page" title="Page" sandbox="allow-scripts allow-forms" src="${src}"></iframe></body></html>`;
  return { html, csp: frameCsp(nonce) };
}
