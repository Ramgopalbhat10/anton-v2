# Changelog

All notable changes to Anton are recorded in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-10-11

Browser watching, subagent visibility and the Library. Covers pull requests
#41–#44.

### Added

- **Agents panel and a live agents card in the thread.** Each task's subagent
  runs are recorded from the runtime's events — brief and label, every tool
  step with its input, model, tokens and the answer — and shown as a live card
  in the thread, one row per subagent with its kind, steps, time and tokens,
  that opens into the Agents panel: Working and Finished runs with step ticks
  and the full transcript. Steps read the same in both places. (#41)
- **Jev drives the browser.** With a decision model, the browser subagent's
  `do` step names an outcome and Jev drives the page there one round per action
  (which element, which field for each value, done or stuck), in the Browser
  panel's browser or the sandbox. A click that may buy, send, post or delete
  stops for the agent to confirm first. Each driven step records its actions,
  their probabilities and what it spent, and opens from the Agents panel. (#44)
- **A task says when it waits on you.** A reply that asks something marks the
  task as asking, with a sidebar icon, a "Your turn" cue showing the question,
  a "Needs you" filter and a notification saying what it asks; your next
  message clears it. (#42)
- **Library redesign.** Grid and list views: folders as cards with item counts,
  files as thumbnails or type badges, breadcrumbs, a Pierre tree with modified
  and size columns, and Open, Copy path, Download and Delete per item, plus
  uploads of up to 20 MB. (#42)
- **Page memory and page judging.** A page the browser subagent has seen comes
  back as unchanged or as a diff with context, and a long page comes back with
  only the parts its brief needs. (#42)
- **Sign-in walls and human checks are handed to you.** The panel says so and
  the subagent stops instead of guessing. (#42)

### Changed

- **The Kernel browser is billed only while it is used.** Anton releases its
  DevTools and Playwright connections 15 seconds after their last use, so the
  browser stands by unbilled with its pages and sign-ins (reconnecting takes
  about 0.4s); it follows the page only while the panel's live view is on
  screen, and pauses the live view in a hidden window or after five quiet
  minutes. A browser open 123s with one navigation was billed 55s, against 123s
  before. (#43)
- **Fewer tokens spent browsing.** A read-only explorer subagent reads the same
  repo snapshot as the agent before the sandbox starts, keeping wide reading
  out of its context, and the browser tool trims and remembers pages — a live
  Hacker News job fell from 92–105K tokens to 56K for the same seven steps.
  (#42)
- **Outputs save without a sandbox.** A task that never started its sandbox now
  keeps shared-browser screenshots and other outputs straight to storage,
  listed in the Library beside the machine's outputs. (#42)

### Fixed

- Going back in the agent's browsers no longer waits out a 30-second timeout on
  pages restored from the back-forward cache. (#41)
