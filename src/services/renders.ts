import { randomBytes } from "node:crypto";
import { announce } from "../core/changes.ts";
import { InvalidInputError, NotFoundError } from "../core/errors.ts";
import { safeRelativePath } from "../core/shell.ts";
import { getPageState, getPageTitle, notePage, putPageState } from "../db/pages.ts";
import { getSessionRecord } from "../db/sessions.ts";
import { readOutput, saveOutput } from "./checkpoints.ts";
import { inlineAssets } from "./page-assets.ts";

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
 *
 * A page keeps its state on Anton's side, so every copy of it shows the same
 * thing: the one in the thread, one opened in a tab of its own, and the one in
 * the Library. The page sets and reads it through `window.anton` (or, when it
 * keeps none, its form fields are kept for it); the frame page saves it and,
 * told of a save by another copy (by the thread, or by the server's events
 * when it has a tab of its own), hands the page the new state. The page itself
 * still reaches nothing: the frame page, Anton's own, does the requests.
 */

export const RENDER_DIR = "renders";
export const MAX_RENDER_BYTES = 512 * 1024;
/** The most a page's state takes, its value and fields together. */
export const MAX_STATE_BYTES = 256 * 1024;

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
    // Its own requests, for the page's state: the page inside has none of its own.
    "connect-src 'self'",
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
  "The page is a small app the user comes back to, and every copy of it (in the thread, in a tab of its own, in the Library) shows the same state. Keep whatever the user does that should last (entries, choices, progress, a game's score) with window.anton.setState(value), any JSON value; start from window.anton.state (null at first), and redraw from window.anton.onStateChange(function (state) { … }) when another copy changes it. localStorage is kept with the page the same way, so a page written for it works too; cookies are not available. A page that keeps no state either way has its form fields' values kept for it.",
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

// Both documents are dark like the frames that hold them: a browser paints a frame whose document's
// color scheme differs from its <iframe>'s on an opaque canvas, white for a light one, under the page.
const BASE_CSS =
  `:root{color-scheme:dark!important;${Object.entries(FALLBACK_THEME)
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

/**
 * Runs next: `window.anton.state`, `setState` and `onStateChange`, starting
 * from the state served with the page. A page that never uses them has its
 * form fields kept instead: their values are saved after you change them, and
 * set (with input and change events, so the page redraws) when it opens or
 * another copy changes them. Changes from elsewhere wait while one of yours is
 * on its way, so typing is never overwritten.
 *
 * A sandboxed page has no localStorage of its own (reading it throws), and an
 * app written for a browser often keeps everything there. So the page gets one
 * that is kept with its state: it starts from what was saved, saves each
 * change, and takes other copies' changes with a storage event, as a browser
 * tells other tabs. sessionStorage lasts as long as the page is open.
 */
const STATE_BOOTSTRAP = `(function(){
var p=window.parent,a=window.anton,seed=window.__antonPage||{},state=seed.state===undefined?null:seed.state,fields=seed.fields||{},own=false,applying=false,listeners=[],timer=0;
try{delete window.__antonPage}catch(x){}
function post(m,q){p.postMessage({jsonrpc:"2.0",method:m,params:q},"*")}
function same(x,y){return JSON.stringify(x)===JSON.stringify(y)}
var SKIP=/^(password|file|hidden|button|submit|reset|image)$/;
function box(el){return el.type==="checkbox"||el.type==="radio"}
function controls(){var all=document.querySelectorAll("input,select,textarea"),seen={},out=[];for(var i=0;i<all.length;i++){var el=all[i];if(SKIP.test(String(el.type||"").toLowerCase())||(el.closest&&el.closest("[data-anton-sync=off]")))continue;var base=el.id?"#"+el.id:el.name?"@"+el.name:el.tagName.toLowerCase(),n=seen[base]||0;seen[base]=n+1;out.push([n?base+"~"+n:base,el])}return out}
function read(){var out={},list=controls();for(var i=0;i<list.length;i++){var el=list[i][1];out[list[i][0]]=box(el)?el.checked:String(el.value).slice(0,20000)}return out}
function fire(el){el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}))}
function apply(next){applying=true;try{var list=controls();for(var i=0;i<list.length;i++){var k=list[i][0],el=list[i][1];if(!Object.prototype.hasOwnProperty.call(next,k))continue;var v=next[k];if(box(el)){if(el.checked!==!!v){el.checked=!!v;fire(el)}}else if(typeof v==="string"&&el.value!==v){el.value=v;fire(el)}}}finally{applying=false}}
function noteFields(){if(own||applying)return;clearTimeout(timer);timer=setTimeout(function(){timer=0;if(own)return;var now=read();if(same(now,fields))return;fields=now;post("anton/state/set",{fields:now})},250)}
["input","change","click","keyup"].forEach(function(t){document.addEventListener(t,function(e){if(e.isTrusted)noteFields()},true)});
Object.defineProperty(a,"state",{get:function(){return state},enumerable:true});
a.setState=function(v){own=true;var c=JSON.parse(JSON.stringify(v===undefined?null:v));state=c;if(!applying)post("anton/state/set",{state:c})};
a.onStateChange=function(f){own=true;if(typeof f==="function")listeners.push(f);return function(){listeners=listeners.filter(function(g){return g!==f})}};
var store=seed.storage&&typeof seed.storage==="object"?seed.storage:{},stimer=0,LIMIT=200000,has=function(o,k){return Object.prototype.hasOwnProperty.call(o,k)};
function saveStore(){clearTimeout(stimer);stimer=setTimeout(function(){stimer=0;post("anton/state/set",{storage:JSON.parse(JSON.stringify(store))})},50)}
function storage(data,save){function use(){if(save)own=true}var api={getItem:function(k){use();k=String(k);return has(data,k)?data[k]:null},setItem:function(k,v){use();k=String(k);v=String(v);var old=has(data,k)?data[k]:null;data[k]=v;if(save&&JSON.stringify(data).length>LIMIT){if(old===null)delete data[k];else data[k]=old;throw new DOMException("This page keeps up to 200 KB in localStorage.","QuotaExceededError")}if(save&&old!==v)save()},removeItem:function(k){use();k=String(k);if(has(data,k)){delete data[k];if(save)save()}},clear:function(){use();var any=false;for(var k in data)if(has(data,k)){delete data[k];any=true}if(any&&save)save()},key:function(i){use();var l=Object.keys(data);return i>=0&&i<l.length?l[i]:null}};Object.defineProperty(api,"length",{get:function(){use();return Object.keys(data).length},configurable:true});if(!window.Proxy)return api;return new Proxy(api,{get:function(t,k){if(typeof k==="symbol"||k in t)return t[k];use();return has(data,k)?data[k]:undefined},set:function(t,k,v){if(typeof k!=="symbol"&&!(k in t))api.setItem(k,v);return true},deleteProperty:function(t,k){if(typeof k!=="symbol"&&!(k in t))api.removeItem(k);return true},has:function(t,k){return k in t||(typeof k!=="symbol"&&has(data,k))},ownKeys:function(){return Object.keys(data)},getOwnPropertyDescriptor:function(t,k){if(typeof k!=="symbol"&&has(data,k))return{value:data[k],writable:true,enumerable:true,configurable:true}}})}
function install(name,value){try{Object.defineProperty(window,name,{value:value,configurable:true,enumerable:true})}catch(x){}}
install("localStorage",storage(store,saveStore));install("sessionStorage",storage({},null));
function takeStore(next){var before={},seen={},k;for(k in store)if(has(store,k)){before[k]=store[k];delete store[k]}for(k in next)if(has(next,k)&&typeof next[k]==="string")store[k]=next[k];var all=Object.keys(before).concat(Object.keys(store));for(var i=0;i<all.length;i++){k=all[i];if(seen[k])continue;seen[k]=1;var o=has(before,k)?before[k]:null,n=has(store,k)?store[k]:null;if(o!==n)try{window.dispatchEvent(new StorageEvent("storage",{key:k,oldValue:o,newValue:n,url:location.href}))}catch(x){}}}
window.addEventListener("message",function(e){if(e.source!==p)return;var d=e.data;if(!d||d.jsonrpc!=="2.0"||d.method!=="anton/state/changed"||!d.params)return;var q=d.params;if(q.storage&&typeof q.storage==="object"&&!stimer&&!same(q.storage,store))takeStore(q.storage);if(Object.prototype.hasOwnProperty.call(q,"state")&&!same(q.state,state)){state=q.state;applying=true;try{for(var i=0;i<listeners.length;i++){try{listeners[i](state)}catch(x){setTimeout(function(){throw x})}}}finally{applying=false}}if(q.fields&&!own&&!timer&&!same(q.fields,fields)){fields=q.fields;apply(fields)}});
window.addEventListener("load",function(){setTimeout(function(){if(!own&&Object.keys(fields).length)apply(fields);post("anton/state/ready",{version:Number(seed.version)||0})},0)});
})();`.replace(/\n/g, "");

/** What a page starts from: its saved state, as a script that can't end early or be read as markup. */
type Seed = { state: unknown; fields: Record<string, unknown>; storage?: Record<string, string>; version: number };

function seedScript(seed: Seed): string {
  const json = JSON.stringify(seed).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `<script>window.__antonPage=${json}</script>`;
}

/** Puts the theme and the bootstrap first in the document, ahead of anything the page has, so its own styles still win. */
export function injectBootstrap(html: string, seed: Seed = { state: null, fields: {}, storage: {}, version: 0 }): string {
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${BASE_CSS}</style><style id="anton-theme"></style>${seedScript(seed)}<script>${BOOTSTRAP}</script><script>${STATE_BOOTSTRAP}</script>`;
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
  const title = input.title.trim().slice(0, 120);
  await saveOutput(id, path, bytes, "text/html");
  await notePage(id, path, title);
  announce({ kind: "task", id, what: "files" });
  const height = Math.round(Math.min(1600, Math.max(80, input.height ?? 360)));
  return { path, title, height };
}

/** Any HTML file in a task's Library shows as a page: the agent's under renders/, and any other it or you saved. */
export function isRenderPath(path: string): boolean {
  if (path.length > 400 || !/\.html?$/i.test(path)) return false;
  try {
    return safeRelativePath(path) === path;
  } catch {
    return false;
  }
}

/** A name for a page with no title kept: the file's, without the suffix render_html adds. */
export function pageTitle(path: string): string {
  const name = (path.split("/").pop() ?? path)
    .replace(/\.html?$/i, "")
    .replace(/-[0-9a-f]{6}$/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return name ? name[0].toUpperCase() + name.slice(1) : "Page";
}

/** The page, ready to serve: the files it names from its Library put into it, its bootstrap added, and its state as it stands. */
export async function renderPage(id: string, path: string): Promise<string> {
  if (!isRenderPath(path)) throw new NotFoundError("Not a page");
  const [bytes, saved] = await Promise.all([readOutput(id, path), getPageState(id, path)]);
  if (!bytes) throw new NotFoundError("Page not found");
  const html = await inlineAssets(new TextDecoder().decode(bytes), path, (file) => readOutput(id, file));
  return injectBootstrap(html, saved);
}

/** A page's state, for a copy that heard it changed. */
export async function pageState(id: string, path: string) {
  if (!isRenderPath(path)) throw new NotFoundError("Not a page");
  return getPageState(id, path);
}

/** Field values a page's form controls hold: strings or checked states, by a key the page's bootstrap gives each. */
function checkFields(value: unknown): Record<string, string | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidInputError("Fields are an object.");
  const entries = Object.entries(value);
  if (entries.length > 2000) throw new InvalidInputError("Too many fields.");
  for (const [key, field] of entries) {
    if (key.length > 300 || (typeof field !== "string" && typeof field !== "boolean")) throw new InvalidInputError("Each field is a string or a checked state.");
  }
  return value as Record<string, string | boolean>;
}

/** What a page put in its localStorage: string values by key. */
function checkStorage(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidInputError("Storage is an object.");
  const entries = Object.entries(value);
  if (entries.length > 5000) throw new InvalidInputError("Too many storage keys.");
  for (const [key, item] of entries) {
    if (key.length > 1000 || typeof item !== "string") throw new InvalidInputError("Each stored value is a string.");
  }
  return value as Record<string, string>;
}

/**
 * Saves a copy's change to the page's state and tells every other copy, by
 * `from`, the id the saving copy gave itself, so it can skip its own echo.
 */
export async function savePageState(id: string, path: string, body: unknown): Promise<{ version: number }> {
  if (!isRenderPath(path)) throw new NotFoundError("Not a page");
  if (!(await getSessionRecord(id))) throw new NotFoundError("Session not found");
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const change: { state?: unknown; fields?: Record<string, string | boolean>; storage?: Record<string, string> } = {};
  if ("state" in input) change.state = input.state ?? null;
  if ("fields" in input) change.fields = checkFields(input.fields);
  if ("storage" in input) change.storage = checkStorage(input.storage);
  if (new TextEncoder().encode(JSON.stringify(change)).length > MAX_STATE_BYTES)
    throw new InvalidInputError(`A page keeps up to ${MAX_STATE_BYTES / 1024} KB of state.`);
  const from = typeof input.from === "string" ? input.from.slice(0, 40) : "";
  const version = await putPageState(id, path, change, pageTitle(path));
  announce({ kind: "page", id, path, version, from });
  return { version };
}

/**
 * Runs in the frame page: passes messages between the page and whatever holds
 * it, and keeps the page's state. Saves are batched (a burst of typing is one
 * request) and sent on as the frame closes. A change elsewhere is fetched and
 * handed to the page, except while a save of this copy's is waiting or on its
 * way: that save is newer, and the copy fetches again once it lands. Inside
 * Anton the thread says when the state changed; in a tab of its own the frame
 * page listens to the server's events itself.
 */
const FRAME_SCRIPT = `var f=document.getElementById("page"),url="/api/sessions/"+encodeURIComponent(PAGE.id)+"/page-state?path="+encodeURIComponent(PAGE.path),me=Math.random().toString(36).slice(2),known=-1,pending=null,flying=false,stale=false,timer=0,alone=window.parent===window;
function toPage(m,q){if(f.contentWindow)f.contentWindow.postMessage({jsonrpc:"2.0",method:m,params:q},"*")}
function pull(){if(pending||flying){stale=true;return}fetch(url,{cache:"no-store"}).then(function(r){return r.ok?r.json():null}).then(function(s){if(!s||!(s.version>known))return;if(pending||flying){stale=true;return}known=s.version;toPage("anton/state/changed",{state:s.state,fields:s.fields,storage:s.storage})}).catch(function(){})}
function flush(keep){clearTimeout(timer);timer=0;if(!pending||flying)return;var body=pending;pending=null;flying=true;body.from=me;fetch(url,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(body),keepalive:keep===true}).then(function(r){return r.ok?r.json():null}).then(function(s){if(s&&s.version>known)known=s.version}).catch(function(){}).then(function(){flying=false;if(pending)flush();else if(stale){stale=false;pull()}})}
function queue(q){pending=pending||{};if(Object.prototype.hasOwnProperty.call(q,"state"))pending.state=q.state;if(q.fields&&typeof q.fields==="object")pending.fields=q.fields;if(q.storage&&typeof q.storage==="object")pending.storage=q.storage;clearTimeout(timer);timer=setTimeout(flush,150)}
function changed(q){if(q&&q.from!==me&&q.version>known)pull()}
window.addEventListener("pagehide",function(){flush(true)});
window.addEventListener("message",function(e){var d=e.data;if(e.source===f.contentWindow){if(d&&d.jsonrpc==="2.0"&&typeof d.method==="string"&&d.method.indexOf("anton/state/")===0){var q=d.params||{};if(d.method==="anton/state/set")queue(q);else if(d.method==="anton/state/ready"){if(known<0)known=Number(q.version)||0;pull()}return}if(!alone)window.parent.postMessage(d,"*");else if(d&&d.method==="ui/open-link"&&d.params&&/^https?:/.test(d.params.url))window.open(d.params.url,"_blank","noopener")}else if(e.source===window.parent&&e.origin===location.origin){if(d&&d.method==="anton/page-changed"){changed(d.params);return}if(f.contentWindow)f.contentWindow.postMessage(d,"*")}});
if(alone&&window.EventSource){var events=new EventSource("/api/events"),dropped=false;events.onmessage=function(e){var c;try{c=JSON.parse(e.data)}catch(x){return}if(c&&c.kind==="page"&&c.id===PAGE.id&&c.path===PAGE.path)changed(c)};events.onerror=function(){dropped=true};events.onopen=function(){if(dropped){dropped=false;pull()}}}`;

const escapeHtml = (value: string) => value.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);

/** The frame page around a page: it holds the page in a sandboxed frame, passes messages between it and the thread, and keeps its state. */
export function renderFrame(
  id: string,
  path: string,
  title = pageTitle(path),
): { html: string; csp: string } {
  if (!isRenderPath(path)) throw new NotFoundError("Not a page");
  const nonce = randomBytes(16).toString("base64");
  const src = `/api/sessions/${encodeURIComponent(id)}/render?path=${encodeURIComponent(path)}`;
  const page = JSON.stringify({ id, path }).replace(/</g, "\\u003c");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>:root{color-scheme:dark}html,body{margin:0;height:100%;background:transparent}body{background:#0b0b0b}html.framed body{background:transparent}iframe{display:block;border:0;width:100%;height:100%;color-scheme:dark}html:not(.framed) body{box-sizing:border-box;padding:28px 20px}html:not(.framed) iframe{max-width:960px;margin:0 auto}</style><script nonce="${nonce}">if(window.parent!==window)document.documentElement.className="framed"</script></head><body><iframe id="page" title="Page" sandbox="allow-scripts allow-forms" src="${src}"></iframe><script nonce="${nonce}">(function(){var PAGE=${page};${FRAME_SCRIPT}})();</script></body></html>`;
  return { html, csp: frameCsp(nonce) };
}

/** The frame page, named for its page: the title the agent gave it, or its file's. */
export async function pageFrame(id: string, path: string): Promise<{ html: string; csp: string }> {
  if (!isRenderPath(path)) throw new NotFoundError("Not a page");
  return renderFrame(id, path, (await getPageTitle(id, path)) ?? pageTitle(path));
}
