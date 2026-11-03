# Replies, artifacts and attachments

Linked from [AGENTS.md](../../AGENTS.md).

- Replies render markdown with Shiki (`code-block.tsx`), mermaid (`mermaid-diagram.tsx`), `path:line` links into Files, `ask` cards (`reply-cards.tsx`) and output cards from `../outputs/…` (`src/core/outputs.ts`, viewer in `output-viewer.tsx`).
- `show` draws a card from a fixed catalog (`src/core/ui-spec.ts`, checked by `src/services/show.ts`). `render_html` saves one page under `renders/` (`src/services/renders.ts`).
- A rendered page reaches no network itself: it runs under a CSP that allows no requests, talks to the thread over the MCP Apps postMessage protocol, and its `fetch()` goes through Anton (`page-fetch.ts`: public addresses only, no cookies, size and time limits). Its state lives on the server (`src/db/pages.ts`), so every copy shows the same state.
- `generate_image` (`src/services/images.ts`, `ImageModel` port) needs an OpenRouter key; images are kept under `images/`.
- The Artifacts page (`artifacts-page.tsx`, `src/services/artifacts.ts`) lists what agents made, indexed in `output_index`. Deleting one (`removeOutput` in `files.ts`) records it in `deleted_outputs`, and replies that showed it say so rather than break.
- Attachments (`attachments.tsx`, `src/services/attachments.ts`, `documents.ts`): non-image files are saved under `uploads/` and read as text, cut at 20,000 characters in the message; the agent reads the rest with `read_attachment`.
