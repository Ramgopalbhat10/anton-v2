# Anton 2.1 — release notes

This is the launch release of Anton. It is about seeing what your agents are
doing while they do it, letting your browser work without paying for it when it
is idle, and making fewer of the small things get in your way.

## Added

- **Watch every subagent work, live.** A task that hands part of the job to a
  subagent now shows it in the thread as it happens, one line per subagent with
  its kind, steps, time and tokens. Open that line and the Agents panel shows
  the whole story: what each subagent was asked, every step it took and what it
  found, for the ones still working and the ones that have finished. The steps
  read the same in the thread and in the panel, so you can follow one place and
  pick up in the other.
- **Let the browser agent drive the page for you.** Give the browser agent an
  outcome — "sign up for the free plan", "find the cheapest option and stop
  before checkout" — and it now works through the page one action at a time:
  which element to use, what to type in each field, then whether it is done or
  stuck. It runs in the Browser panel's browser or in the sandbox, so you can
  watch it. Before any click that might buy, send, post or delete something, it
  stops and asks you first. Every action it took, how confident it was and what
  it cost is recorded and can be opened from the Agents panel.
- **A task tells you when it is waiting on you.** When a reply asks you
  something, the task is marked as asking: an icon in the sidebar, a "Your turn"
  cue with the question itself, a **Needs you** filter to find every task like
  it, and a notification that says what it asks. Your next message clears it.
- **A redesigned Library.** Grid and list views, folders as cards with how many
  things they hold, files as thumbnails or type badges, and breadcrumbs when you
  are in a folder. The tree shows when each file was last changed and how big it
  is. Every item has Open, Copy path, Download and Delete, and you can upload
  files of up to 20 MB.
- **The browser remembers pages.** When the browser agent visits a page it has
  already seen, it gets back "unchanged" or just a diff with some surrounding
  context instead of the whole page again. A long page comes back with only the
  parts its brief needs.
- **Sign-in walls and human checks come to you.** If a page needs you to sign in
  or prove you are a person, Anton says so in the Browser panel and stops the
  subagent instead of having it guess its way around.

## Changed

- **You only pay for the hosted browser while it is in use.** Anton now lets go
  of its connections 15 seconds after the last one was used, so the browser
  waits, unbilled, with its pages and sign-ins intact; reconnecting takes about
  a quarter of a second. It also follows the page only while the panel's live
  view is actually on screen, and pauses that view in a hidden window or after
  five quiet minutes. A browser open for 123 seconds with one navigation used to
  be billed for all 123 seconds; now it is billed for 55.
- **Browsing costs fewer tokens.** Before a sandbox starts, a read-only explorer
  subagent reads the repository for the agent, so wide reading no longer fills
  the agent's context. The browser tool also trims and remembers pages it has
  read. On a live test, the same seven-step job on Hacker News fell from 92–105K
  tokens to 56K.
- **Outputs save even without a sandbox.** A task that never started its sandbox
  now keeps screenshots and other outputs straight to storage, and they appear
  in the Library beside the files a machine saves.

## Fixed

- Going back in the agent's browsers no longer stalls for up to 30 seconds on
  pages restored from the browser's cache — back is instant again.
