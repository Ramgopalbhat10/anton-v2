# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Anton v2 is currently a personal, single-user product for its owner: a technical user who wants to delegate computer work from the browser and inspect, steer, and approve what the agent does. The confirmed future ambition is broader multi-user SaaS, but multi-tenancy is not a current product commitment or license to weaken the existing personal-deployment and security model.

## Product Purpose

Anton is a coding-first personal work agent. It turns a described outcome into supervised work across code, research, documents, web automation, and artifacts. For repository work, Anton works on its own branch in its own environment and produces reviewable output such as commits and pull requests. For broader work, it can research, draft, build pages or charts, use connectors, and produce reusable artifacts.

Success means the user can hand off meaningful work, understand what is happening, intervene when judgment or approval is needed, and receive output they can inspect and use.

## Positioning

Anton is not primarily a chat interface and not only a coding assistant. Its distinct mechanism is a personal operations agent that combines:

- isolated execution environments for untrusted work;
- repository/branch/pull-request workflows for coding tasks;
- projects, threads, memory, artifacts, and task state for continuity;
- connectors and web/browser/computer capability for broader digital work;
- explicit user control before consequential actions such as host execution, external writes, sends, and approved plans.

A neighboring chat product cannot truthfully copy the same position without this combination of execution isolation, continuity, reviewable outputs, and approval boundaries.

## Operating Context

- The product is used in a browser on desktop and phone widths.
- The current deployment is personal and single-user, hosted behind an access proxy; Anton has no login system of its own.
- Repository tasks revolve around GitHub repositories, branches, checks, reviews, and pull requests.
- Tasks can run in isolated sandboxes or, for trusted tasks only, on the host server.
- Users move between starting work, monitoring running work, answering questions, approving plans/actions, reviewing pull requests, and reusing artifacts.
- Keyboard-first operation, command-palette navigation, dense information, and fast scanning are part of normal use.
- Notifications and an inbox matter because agent work continues outside the user's immediate attention.

## Capabilities and Constraints

Confirmed capabilities include:

- repository coding tasks on isolated branches with pull requests;
- chats with no repository for research, writing, web work, and artifact production;
- incognito chats that keep nothing persistent;
- projects/spaces with coordinated threads, queues, memory, files, and to-dos;
- model, reasoning, provider/route, context, and plan-mode controls;
- sandboxed command execution, browser use, computer use, background jobs, and checkpoints;
- attachments, artifacts, rendered pages, documents, images, and output reuse;
- connectors, including approval-gated external writes where applicable;
- usage, budget, spend, notification, inbox, and review surfaces.

Confirmed constraints:

- Preserve strong isolation and secret/security boundaries.
- Preserve user control and approval over consequential agent actions.
- Preserve the current personal/single-user deployment model unless the product direction is explicitly changed later.
- Preserve developer-tool density and keyboard-first operation.
- Preserve the Aura visual identity and restrained dark-first aesthetic.
- Local/non-isolated execution is accepted only as a trusted or development-oriented mode, not as the default trust model.

Open product facts:

- The timing, shape, and scope of any future multi-user SaaS are undecided.
- The boundary between coding-first positioning and broader personal-work positioning should be evaluated surface by surface; coding remains the first wedge.

## Brand Commitments

- Product name: Anton.
- Visual identity: the existing Aura design system, restrained accent use, dark-first aesthetic, and precise developer-tool presentation are binding.
- Interaction identity: dense, keyboard-capable, professional, operational, and quiet rather than playful or marketing-led.
- The mascot is an existing product asset; whether it is a binding long-term brand element is undecided.

## Evidence on Hand

- `README.md` — product overview, setup, deployment, and operating model.
- `SECURITY_MODEL.md` — threat model, trust boundaries, critical assets, accepted risks, and security constraints.
- `AGENTS.md` and `docs/architecture/` — implementation architecture and product behavior.
- `src/web/styles/aura-tokens.css` and `src/web/styles/aura-components.css` — incumbent Aura visual system.
- `src/web/components/pages/launcher.tsx` and `src/web/components/pages/home-dashboard.tsx` — current homepage and product surface evidence.
- `.impeccable/audit/2026-11-26T10-08-26Z__src-web-components-pages-launcher-tsx.md` — Impeccable v4.11.1 homepage technical audit.

No external customer testimonials, pricing, public launch claims, or multi-user deployment evidence are on hand; future work must not fabricate them.

## Product Principles

1. **Outcomes become inspectable work.** Every task should produce state, evidence, artifacts, or reviewable changes rather than opaque chat output.
2. **Isolation is the default trust boundary.** Broader capability never justifies weakening sandbox, secret, credential, or host boundaries.
3. **Consequential action requires user control.** External writes, host execution, sensitive connector actions, and plan-gated code changes need explicit approval or clear user intent.
4. **Density should increase signal, not noise.** Anton is a professional tool for people who scan, compare, decide, and act quickly.
5. **Continuity compounds value.** Projects, memory, artifacts, branches, reviews, and reusable outputs should make later work easier than starting over.
