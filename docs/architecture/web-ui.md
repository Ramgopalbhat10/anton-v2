# Web UI and notifications

Linked from [AGENTS.md](../../AGENTS.md).

- `src/web/` — TanStack Router UI; shadcn components in `components/ui/`, motion tokens in `instrument.css`.
- Look: near-black glass over a sky, one ion-blue accent (`--blue-*` in `styles/signal-tokens.css`). The sky is an hourly NASA picture (`lib/sky.ts`, crops in `public/sky/`) drawn as a dithered pixel mesh (`components/sky.tsx`); `<main data-sky>` veils it per page, Settings › General turns it off, and `?sky=<slug>` pins one.
- Illustrations are drawn the way the rack is (`illustrations.tsx`): flat trays and slim tiles, short rules, one light, greys plus the one accent. The mark (`Logo`), the mascot and the loader are Anton's cyan cube; run `node scripts/make-icons.ts` after changing the mark.
- Settings is a card over the page you are on (`components/settings/modal.tsx`, state in `lib/settings-modal.ts`). It runs the settings pages on its own in-memory router; the `/settings` route only opens the card and goes back, and a link inside the card to anywhere else closes it and goes there in the app.
- States stay calm: done is quiet white, anything that wants you takes the accent, only a failure is red (`--success-*`, `--warning-*`, `--danger-*`). Diffs keep green and red (`--diff-add-*`, `--diff-remove-*`).
- New tasks and threads open the moment you send, by an id the page chose (`src/web/lib/starting.ts`, `starting-task.tsx` draws the skeleton).
- Pages refetch on server events mapped in `src/web/lib/live-updates.ts`; keep sidebar rows cheap (`sameRow`).
- On a phone-width screen (`useOnePane`) a task opens on its conversation; side panels open on demand.
- `src/services/push.ts` — Web Push notifications through the `PushSender` port (`src/providers/webpush/sender.ts`), never while a page says it is in front of you. Service worker: `src/web/public/sw.js`.
- `src/services/notifications.ts` — the Notifications dialog (bell left of the sidebar toggle, `components/notifications.tsx`): only moments worth a look, each a row keyed by what it stands for in a task, so a newer one replaces it. A reply ends in one row (asked you, plan or call to approve, replied, done, failed), its sandbox in another (created, stopped once idle, failed to start) and its pull request in a third (checks failed, merged). Sandbox rows stay out of the bell's count; opening a task reads its rows.
