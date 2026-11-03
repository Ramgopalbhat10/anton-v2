# Web UI and notifications

Linked from [AGENTS.md](../../AGENTS.md).

- `src/web/` — TanStack Router UI; shadcn components in `components/ui/`, motion tokens in `instrument.css`.
- New tasks and threads open the moment you send, by an id the page chose (`src/web/lib/starting.ts`, `starting-task.tsx` draws the skeleton).
- Pages refetch on server events mapped in `src/web/lib/live-updates.ts`; keep sidebar rows cheap (`sameRow`).
- On a phone-width screen (`useOnePane`) a task opens on its conversation; side panels open on demand.
- `src/services/push.ts` — Web Push notifications through the `PushSender` port (`src/providers/webpush/sender.ts`), never while a page says it is in front of you. Service worker: `src/web/public/sw.js`.
