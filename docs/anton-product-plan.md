# Anton → Product: paths, architecture, cost, and build plan

**Status:** working document synthesizing the analysis through October 2026.
**Author context:** solo builder, keeping a day job; zero-audience distribution; product is a personal coding-agent desk (`anton-v2`).

---

## 1. What Anton actually is

Anton v2 is a **personal agent desk in the browser**, not a chat wrapper and not a Cursor clone. You point it at a GitHub repo and branch; a task works on its own branch in its own sandbox. The thread is the product surface: plan, terminal, files, library, browser, desktop, artifacts.

Built on **Flue 2.0** (agent runtime) with a React 19 + Hono UI. Model calls are routed through OpenRouter or Vercel AI Gateway, or run on the user's own **ChatGPT, Claude Code, OpenCode Go, or Cursor** subscription — those plan calls are recorded at $0.

**Shipped capabilities:**

- Plan mode with approve-then-build gate
- Second-pass reviewer that follows `REVIEW.md`, posts line comments, stops after three automatic passes
- A browser and a full sandbox desktop you can watch and take over; a click that would buy/send/post/delete stops for confirmation
- Code-mode (Pi's `pi-codemode`) — one script calls many tools, only the result returns
- Jev decision model (TypeSafe) driving browser autopilot, "your turn" detection, docs-only review skipping, risky-click gating
- Projects = multiple repos + shared memory + a coordinator that starts threads
- Rendered artifacts and stateful mini-apps with `window.anton.setState`
- Spending caps (default $10/day), idle-stop, per-repo memory, phone push, Gmail connector, skill/plugin marketplaces

**What it is not:** multi-tenant, authenticated, or billed. One database, one GitHub token, no login. It expects an access proxy in front.

---

## 2. Competitive landscape

| Product | Position | Price signal |
|---|---|---|
| Cursor | IDE with cloud agents | $8–30 entry, Ultra $200; third-party models billed separately |
| Claude Code | Terminal agent inside Claude plans | Max $100 / $200 per month |
| Codex | Rides the ChatGPT plan | Bundled in ChatGPT |
| Devin | Autonomous engineer in a cloud VM | Pro $20, Max $200; model included |
| Amp | Web desk, BYOK, pay for the machine | Hobby $0; Megawatt $20 = 45k orb-minutes; a1.tiny 1 CPU/2 GB at $0.08/hr |
| AQ | Web harness running every agent CLI on the user's plan | Free solo sandbox (early access); team Pro listed ~$50/user |

**Conclusion:** the "web cloud coding desk on the user's own plan" category already exists. Anton's defensible value is not raw hours or model bundling — it is the **desk behavior**: plan gate, coordinator across repos, `REVIEW.md` review loop, browser/desktop takeover with safety stops, artifacts, and spend visibility.

---

## 3. Product evolution paths

### Path A — Self-hosted / open personal product
Ship the repo as-is for people to run on their own machines, with a license or "support me" path.
- **Pros:** zero infra cost, fits current code, builds audience.
- **Cons:** tiny revenue, public repo is the free substitute, hard to convert to paid SaaS later.

### Path B — Hosted desk, per-customer isolation (recommended first)
Host the app; each customer brings their own model plan/key and pays for the machine + desk.
- **Pros:** preserves Node SDKs, matches Amp/AQ, high margin if tokens stay on the user's plan.
- **Cons:** must build auth, per-tenant secrets, billing, metering before first dollar.

### Path C — Multi-tenant pooled SaaS
One shared control plane, pooled agent workers, shared database with tenant filters.
- **Pros:** best unit economics at scale.
- **Cons:** requires rewriting single-user in-memory state (event bus, timers, SDK processes) before it is safe; slow to launch.

### Path D — Narrow B2B hand-sold products (parallel, not a rewrite)
Use Anton as the engine behind a specific paid outcome: docs answer engine that opens PRs, or review-as-a-service for teams. Sold by hand, not self-serve.
- **Pros:** fastest revenue, no audience needed.
- **Cons:** separate from the "platform" ambition.

**Recommendation:** Path B first, with Path D as the near-term revenue experiment. Do not attempt Path C until the state problems in §6 are fixed.

---

## 4. Tech stack

### Current

| Layer | Today |
|---|---|
| Agent runtime | Flue 2.0 |
| UI | React 19, Vite, Tailwind, TanStack Router/Query |
| HTTP | Hono on Node |
| App DB | Turso/libSQL (`TURSO_DATABASE_URL`) |
| Conversations | Local `flue.db` (SQLite) |
| Sandbox | Modal (1 core / 2 GiB, ~$0.19/hr) or local |
| Object store | Tigris (S3) or disk |
| Model gateways | OpenRouter, Vercel AI Gateway |
| Plans | ChatGPT, Claude Code, OpenCode Go, Cursor SDK |
| Decision model | Jev via OpenRouter |
| Browser | Kernel (hosted) + in-sandbox Chromium |
| Code-mode | `@earendil-works/pi-codemode` |

### Target (initial 10–100 DAU, all-Cloudflare)

| Concern | Service |
|---|---|
| UI + static assets | Cloudflare Workers + Static Assets |
| API/control plane | Cloudflare Workers |
| Auth | Clerk (identity only) |
| Realtime + tenant ownership | Durable Objects (WebSocket hibernation) |
| Dispatch | Cloudflare Queues + dead-letter queue |
| Node agent runtime | Cloudflare Containers (standard-2: 1 vCPU / 6 GiB), scale-to-zero |
| Coding workspace | Cloudflare Sandbox, or external provider behind the interface |
| Database | D1 (per-tenant) — or Turso via `@flue/libsql` |
| Files/objects | R2 (or Tigris) |
| Billing | Paddle (subject to approval) |
| Email | Resend |

**Key architectural decision:** keep a **trusted Node runtime** (Flue + SDKs + credentials) separate from the **untrusted coding sandbox** (repo commands, builds, tests) — or merge them per-customer only with strict credential scoping. Separate is safer; merged is simpler and cheaper at small scale.

---

## 5. Sandbox provider economics (1 vCPU / 2 GiB)

| Provider | Per hour | Notes |
|---|---|---|
| Agent37 standard | ~$0.0075 | Cheapest; shared host; no subscription floor |
| Agent37 full VM | ~$0.0165 | Own kernel; Docker |
| boat.dev small | $0.018 | Full Ubuntu VM, Docker preinstalled; $20/mo floor, unused expires |
| Cloudflare Containers | ~$0.075 (merged 1vCPU/6GiB) | Provisioned memory while running; scale-to-zero; $5 plan |
| Daytona / E2B | ~$0.083 | Agent-native, proven |
| Modal sandbox | $0.19 | Current default |

**Rule:** profit lives in the desk subscription, not compute resale. Choose the provider that matches the cost shape — Cloudflare for scale-to-zero + integration; boat.dev/Agent37 for cheaper per-running-hour at heavy usage.

---

## 6. Missing features / build checklist (in order)

1. **Authentication** — Clerk; derive tenant from the authenticated identity, never trust a browser-supplied ID.
2. **Per-tenant secrets isolation** — one database, storage prefix, and credential set per customer; no shared platform secrets in customer runtimes.
3. **Billing + metering** — Paddle webhooks (signed, deduped), usage ledger with separate meters: sandbox time, runtime time, browser, storage, managed inference.
4. **Externalize both databases** — replace `src/db.ts` local `flue.db` with the `@flue/libsql` adapter (or D1); `TURSO_DATABASE_URL` currently moves app metadata only.
5. **Durable job ownership** — move authoritative task state, deadlines, and wake-ups out of in-process maps; one live owner per conversation; lease + fencing.
6. **Realtime event outbox** — replace the in-process `EventEmitter` (`src/core/changes.ts`) with a durable event stream so a browser reconnect recovers missed updates.
7. **Durable scheduler** — replace `setInterval` automations/cleanup with durable alarms + job records.
8. **Artifact/state APIs on Workers** — serving a saved mini-app must not wake a Node container.
9. **Sandbox provider abstraction** — add boat.dev and Agent37 behind `src/providers/`; keep Modal/Daytona as fallback.
10. **Lifecycle correctness** — idle-stop + keep-alive rules so a closed browser stops a *viewer*, not an *accepted job*.
11. **Snapshot/retention policy** — expiring provider snapshots (`ttlMs: null` today) must not accumulate; define deletion and reconstruct-from-GitHub/checkpoints.
12. **Gmail public app** — "bring your own OAuth client" is not a verified public Gmail app; that has its own approval cost.
13. **Spending caps → resource meters** — the $10/day model cap is not the same as compute-hour and storage allowances; add atomic reservations and hard stops.

---

## 7. Pricing model

| Plan | Price | Included | Model |
|---|---|---|---|
| Hobby | $0 | Pay-as-you-go, prepaid credit blocks | Customer's own plan/key, or managed-inference balance |
| Starter | $19/mo | 20 active workspace-hours, 1 concurrent | Separate from model |
| Pro | $49/mo | 50 active hours, 2 concurrent, browser/storage allowances | Separate from model |
| Overage | ~$1/hr prepaid | — | Hard stop when empty |

**Principles:**

- Meter **active time** (5-minute idle grace), not wall-clock — this is Amp's model and what makes the allowance feel generous.
- Keep **managed inference separate** and prepaid; never float tokens on a card you can't recover.
- Target **70–80% contribution margin**, **50–65% cash operating margin** at launch — not 80% from day one.

---

## 8. Milestones

1. **Cloud-compat spike** — one real Flue session per supported SDK in a Cloudflare Container; remote DB; cold start; credential renewal.
2. **Tenant isolation** — two customers prove they cannot reach each other's DB, files, credentials, terminals, or sandboxes.
3. **Lifecycle correctness** — close browser, restart runtime, interrupt a tool call, replay a webhook, exhaust budget; verify no duplicate charges or PRs.
4. **Paid pilot** — meter everything; compare estimated vs actual cost per customer; tune allowances, then raise or lower price on evidence.

---

## 9. Risks and open questions

- **Category is occupied and subsidized** — Amp's agent is free, AQ's sandbox is free in early access; winning requires the desk's behavior to matter to a real buyer.
- **Anthropic/OpenAI terms** — customer plans are personal-use; each user connects their own account. Reselling one shared login is prohibited.
- **Provider longevity** — Agent37 and boat.dev are cheap but young; keep a fallback behind the provider interface.
- **Cloudflare per-hour vs floor trade-off** — Cloudflare is idle-free but bills provisioned memory while running; boat.dev has a $20 floor; Agent37 has neither but is early-stage.
- **Distribution** — zero audience; the first ten paying customers come from hand-sold outcomes (Path D), not a launch.

---

**Bottom line:** Anton is a real, differentiated desk. The path to a product is Path B — hosted per-customer isolation with the user's own model plan — on an all-Cloudflare control plane, with sandbox providers swapped behind the existing interface, priced as a desk subscription metered on active time. The blockers are not the agent capabilities; they are authentication, per-tenant secrets, durable job ownership, and billing.
