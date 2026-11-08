# Browser and Computer panels

Linked from [AGENTS.md](../../AGENTS.md).

- `src/services/live-browser.ts` — the Browser panel: a hosted Kernel browser per task (`BrowserHost` port, on with `KERNEL_API_KEY`) driven over CDP (`src/core/cdp.ts`). Opening it never starts the sandbox.
- Gotcha: Kernel bills every second anything is connected, so Anton drops connections 15 seconds after last use, stays connected only while the live view is on screen (`watchBrowser`), and the panel pauses after five quiet minutes.
- `src/services/computer.ts` — the Computer panel: a desktop inside the task's sandbox (`src/core/desktop.ts`, look in `desktop-look.ts`, set up in its own folder so a local machine's settings are never touched), shown with noVNC through `Machine.socketUrl`. Viewing never starts the sandbox; Take over makes the agent's steps wait.
- The `computer` subagent sees through `src/services/vision.ts` (a `VisionModel` port): it names targets in words and the vision model finds them.
- `browser.ts` — the sandbox's own browser, always headless, streamed to the panel as JPEG frames while watched. One browser server runs per sandbox; Anton sends it steps over a command connection on the live-view WebSocket (`?anton=command`, with a token the server hands out), not a process per step, and falls back to a command only when that connection cannot be made. The first step checks the server's version (a hash of its script) and restarts an old one.
- `run` steps run model-written code against a Playwright-shaped page facade that allows only listed methods, with short timeouts per call. For the Browser panel the code runs in a QuickJS VM (`browser-run.ts`) that reaches nothing of Anton; in the sandbox it runs in the browser server. A click or Enter on something with a risky name pauses the run for the decision model, once per name. `evaluate` runs in the page and is not guarded.
- Full VM (`fullVm`) runs a repository's sandboxes as Modal VMs, for Docker and FUSE.
