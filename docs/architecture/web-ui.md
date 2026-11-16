# Web UI and notifications

Linked from [AGENTS.md](../../AGENTS.md). Paths below are under `src/web/` unless they start with `src/`.

## Design system (Aura)

- TanStack Router UI. Tokens in `styles/aura-tokens.css`, component classes in `styles/aura-components.css` and `styles/instrument.css`. Dark is `:root`; `[data-theme='light']` gives the same names light values.
- Two token tiers: primitives (`--n-*`, `--a-*`, state hues) and semantic names (`--bg-*`, `--line*`, `--text*`, `--accent*`, `--ok`/`--warn`/`--bad`/`--info`, `--merged`, `--conflict`). A component never reads a primitive.
- Every size, corner, fill and shadow comes from a token step, never a typed value: `tests/ui/design-tokens.test.tsx` fails on `text-[13px]`, `rounded-[6px]`, Tailwind's own `text-sm`/`rounded-md`, and a hex colour outside a drawing. Text steps (`text-nano` … `text-display`) set no line height, so `leading-*` goes beside them. Corners: `rounded-mark`, `-inner`, `-control`, `-card`, `-dialog`, `-full`. Fills step forward: `--bg-app`, `--bg-panel`, `--bg-surface`, `--bg-raised`, `--bg-overlay`; `--bg-hover`/`--bg-active` are translucent. Control heights `--h-sm`/`--h-md`/`--h-lg`. Shadows only `--sh-1`, `--sh-2`, `--sh-3`, `--sh-composer` (no raw `rgba` shadows); `--sh-2`/`--sh-3` carry their own edge, so floating layers have no border.
- Import `cn` from `lib/utils.ts`: it knows the step names, so a size merges with a colour and one radius replaces another.
- One control per job, so a pick looks the same everywhere: `Tabs`/`Tab` and `PanelTabs`/`PanelTab` (`components/instrument.tsx`), `Segmented`/`SegmentedItem`, `FilterChip`/`FilterMenu` and `SearchField` (`components/signal.tsx`), `Btn` (`primary` for the one main action, `secondary`, `ghost`, `inverse`, `danger`), `StatusDot`/`Status`, `SectionLabel`, `EmptyState`/`EmptyLine`. Build with `signal.tsx` and `instrument.tsx` first; `components/ui/` keeps only the shadcn pieces in use. Text fields share `.sg-field`.
- Whatever is chosen (tab, segment, chip, open file or task) takes `.in-chosen`. The accent is reserved for focus, the main action and live agent work. Amber (`--warn`) is waiting on you or a caution; only a failure is red (`--bad`); diffs use `--diff-add`/`--diff-del`. Keyboard focus is one ring: `--focus`, or `--focus-inset` where a ring would be clipped.
- Group labels are sentence case; uppercase only for keys. Inter in 400/500/600; JetBrains Mono only for what the agent reads and writes (code, diffs, files, terminal, paths, branches). Aligned numbers use `.in-num`, not the mono face.
- Cards are a fill one step up with an inset 1px line (`box-shadow: inset 0 0 0 1px var(--line)`), so the line never changes size or gets clipped: `.in-card`, `.in-tile`. A card whose rows take a hover fill clips them (`overflow-hidden`). Decisions and errors in a reply are `.in-callout`. Popovers and menus are solid (`.in-pop`); sticky headers inside them use `.sticky-veil` (fills with `--surface-fill`). Tips (`.tip`) are `width: max-content`; `components/title-tips.tsx` draws the shared tip for any plain `title`.
- Illustrations (`components/illustrations.tsx`) sit on nothing: no well, fill or glow behind them.
- PR state colours are read only through `prTone()`, `prColor()` and `prChipStyle()` in `components/pr-status.tsx`.
- Icons: Hugeicons stroke-rounded, re-exported from `lib/icons.tsx` under app names (`Check`, `GitBranch`); components never import `@hugeicons/*`, so an icon is swapped in one line.
- Task and thread state is one drawn mark everywhere (`Glyph` in `components/thread-glyph.tsx`), told apart by shape as well as colour.
- The logo (`Logo`, `.anton-logo` in `styles/instrument.css`) uses fixed hex values so the favicon and app icons match; run `node scripts/make-icons.ts` after changing it.
- Theme (`lib/theme.ts`): dark by default; the choice is in `localStorage` (`anton.theme`), else the system preference; `index.html` sets `data-theme` before paint, and artifact frames follow it.

## App structure

- Shell: `components/shell.tsx`, sidebar `components/chat-sidebar.tsx` (width in `localStorage` `anton.sidebarWidth`, read through `--nav-w`), pages under `TopBar` (`components/page-frame.tsx`). `C` starts a new task unless focus is in a field, menu, dialog, the terminal or the Computer panel.
- Settings is a card over the current page (`components/settings/modal.tsx`, state in `lib/settings-modal.ts`) running the settings pages on its own in-memory router; `/settings` only opens it, and a link to elsewhere closes it and navigates. Project settings work the same way (`ProjectSettingsModal` in `components/project-settings.tsx`, `lib/project-settings-modal.ts`, `/projects/<id>/settings`).
- Settings › Connections (`components/settings/connections.tsx`) is the health board and first-run setup (server side in [server-and-providers](server-and-providers.md)). Save unlocks only after a passing Test. Until a model can answer, Home shows `components/setup-card.tsx` instead of the composer.
- New tasks and threads open the moment you send, by an id the page chose (`lib/starting.ts`, skeleton in `components/starting-task.tsx`).
- Phone width (`useOnePane`, `lib/one-pane.ts`): a task opens on its conversation, side panels on demand; below `md` the sidebar is a drawer and `components/mobile-nav.tsx` is the bottom bar.

## Data and performance rules

- Pages refetch on server events mapped in `lib/live-updates.ts`. A model turn sends `usage`, each tool call `files`, a reply start or end `state`. Only open queries refetch, so a query a page reads constantly must not be one every tool call marks stale: the thread's file links read the cached list and refetch only on open and at reply start and end. Keep sidebar rows cheap (`sameRow`); Recent draws 50 at a time.
- A task's queries come from `taskQueries` in `lib/task-queries.ts`, never an inline `queryFn`: the cache keeps the last reader's options for `gcTime`, and an inline arrow would keep the component's scope and the page's DOM alive after you leave. Hooks that hold a DOM node in a ref (`useFollowLatest`) clear it on cleanup.
- Long conversations: settled rows carry `.thread-row-settled` (`content-visibility: auto`). A conversation redraws on every streamed chunk, so what sits beside it is memoized (`ChatNavigation`, `JumpToLatest`, `Waiting`, `ReadNotificationsOf`, the mascot, the sidebar opener in `NavContext`). A disclosure that follows a step's running state sets it while drawing, not from an effect. The model picker's rows are memoized with stable handlers and open on their first 40.
- Code splitting: Home and a task are in the first download; other pages (`lazyRouteComponent` in `main.tsx`), most workspace panels (`lazy` in `components/vm-panel.tsx`) and the settings cards (`components/settings/card.tsx`, `components/project-settings-modal.tsx`) load on first open. Keep what the first page needs out of them: the command palette reads `components/settings/section-list.ts`, the launcher `components/settings/general-settings.ts`.
- `ErrorBoundary` and `LazyPart` (`components/error-boundary.tsx`) wrap the sidebar, each workspace panel, the message box, each reply and dialogs, so a throwing part shows a notice instead of taking the app down; a part whose code vanished after a release offers Reload.

## Notifications

- `src/services/notify/push.ts`: Web Push through the `PushSender` port (`src/providers/webpush/sender.ts`), never while a page says it is in front of you. Service worker `public/sw.js`. Sent when a task asks something, has a plan to approve or fails (and on finish, if enabled); iOS delivers only to the home-screen app (16.4+). Push services see only encrypted payloads.
- `src/services/notify/notifications.ts` backs the Inbox (`components/inbox-page.tsx`; bell and read marking in `components/notifications.tsx`). Each row is keyed by what it stands for in a task, so a newer moment replaces it: one row for the reply's outcome, one for its sandbox, one for its pull request. Sandbox rows stay out of the unread count; opening a task reads its rows.

## Other panels

- The Agents panel shows a subagent run as one trace (`Transcript` in `components/agents-tab.tsx`).
- The coordinator's quiet actions that carry text (a message to a thread, a memory note) are one collapsed pill (`NoteRow` in `components/project-feed.tsx`), so a long message never fills the conversation.
