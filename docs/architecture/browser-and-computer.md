# Browser and Computer panels

Linked from [AGENTS.md](../../AGENTS.md).

- `src/services/live-browser.ts` — the Browser panel: a hosted Kernel browser per task (`BrowserHost` port, on with `KERNEL_API_KEY`) driven over CDP (`src/core/cdp.ts`). Opening it never starts the sandbox.
- Gotcha: Kernel bills every second anything is connected, so Anton drops connections 15 seconds after last use, stays connected only while the live view is on screen (`watchBrowser`), and the panel pauses after five quiet minutes.
- `src/services/computer.ts` — the Computer panel: a desktop inside the task's sandbox (`src/core/desktop.ts`, look in `desktop-look.ts`, set up in its own folder so a local machine's settings are never touched), shown with noVNC through `Machine.socketUrl`. Viewing never starts the sandbox; Take over makes the agent's steps wait.
- The `computer` subagent sees through `src/services/vision.ts` (a `VisionModel` port): it names targets in words and the vision model finds them.
- `browser.ts` — the sandbox's own browser, always headless, streamed to the panel as JPEG frames while watched.
- Full VM (`fullVm`) runs a repository's sandboxes as Modal VMs, for Docker and FUSE.
