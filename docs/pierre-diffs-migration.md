# `@pierre/highlights` & `@pierre/diffs` Migration Roadmap

This document describes the overall objective for adopting `@pierre/highlights` and `@pierre/diffs` across Anton v2, what was delivered in Phases 1–3, and the implementation plan for the remaining phases (Phases 4–5).

---

## 1. Main Requirement & Architectural Goals

### Main Requirement
Replace Anton's custom syntax highlighter and bespoke HTML-table diff renderer with [`@pierre/highlights`](https://www.npmjs.com/package/@pierre/highlights) and [`@pierre/diffs`](https://www.npmjs.com/package/@pierre/diffs) (pairing with `@pierre/trees`, which already powers file icons and tree primitives), while preserving Anton's Aura design system, keyboard accessibility, review workflows, and sandbox lifecycle guarantees.

### Core Objectives
1. **CSS-Variable Syntax Theming Without Re-tokenization**: Tokenize source code and diffs using Zed-compatible TextMate/Tree-sitter grammars painted exclusively via Aura's `--syntax-*` CSS variables so dark/light theme switches happen instantaneously in CSS without re-highlighting.
2. **Off-Main-Thread Worker Tokenization & Intra-line Diffs**: Offload patch parsing, AST/syntax highlighting, and word/character diff emphasis (`word-alt`, `word`, `char`) to a dedicated `@pierre/diffs` Web Worker pool (`preferredDiffLib: '@pierre/patches'`).
3. **Virtualized Shadow DOM Diff & Code Rendering**: Mount only visible line slices in long diffs and files via `<Virtualizer>` so multi-thousand-line changes scroll and respond to keyboard input smoothly without layout stalls.
4. **On-Demand Full-File Context Expansion**: Allow users to expand unmodified context lines (`expandUnchanged` / `loadDiffFiles`) in Changes, Pull Request, and History diffs directly from live sandboxes, stored checkpoints, or GitHub without waking stopped sandboxes.
5. **Unified Foundation for Diffs, Files & Rich Code Review**: Converge Changes, PR, History, thread `show` diff cards, and the Files / artifact source viewers onto shared theming, worker pools, and line/range selection primitives.

### Non-Negotiable Anton Invariants
- **Aura Tokens Only**: Components and Shadow DOM overrides must consume tier-2 semantic tokens (`--bg-*`, `--line*`, `--text*`, `--syntax-*`, `--diff-*`, `--accent*`), never raw primitives or arbitrary Tailwind sizes/colors (enforced by `tests/ui/design-tokens.test.tsx`).
- **Stopped Sandboxes Stay Stopped**: Reading diffs, file trees, or expansion context for a stopped task must read saved checkpoint blobs and the git host (`AGENTS.md`), never acquiring or booting a sandbox.
- **ES-Module Worker Bundling**: Both `vite.config.ui.ts` and `scripts/perf/vite.config.ts` must configure `worker: { format: 'es' }` so Vite bundles `@pierre/diffs/worker/worker.js` cleanly for production and perf builds.
- **Stable Parsed Metadata Across Polling**: Live task polling refetches patches frequently; `getCachedFileDiffMetadata` maintains an LRU cache keyed by `(path, length, hash)` so unchanged files keep identical `FileDiffMetadata` object references, preserving expanded context and worker caches.
- **Accessibility & Narrow-Pane Usability**: Full keyboard navigation, focus restoration without scroll jumps, and zero clipped controls down to the split-pane minimum width (~206 px).

---

## 2. Phase 1 — Core `@pierre/highlights` & `@pierre/diffs` Adoption (Completed, PR #354)

Phase 1 replaced the legacy highlighting engine and rewrote the primary workspace diff viewer (`DiffLines`) around `@pierre/diffs`.

### Dependencies & Build Configuration
- **`package.json` & `package-lock.json`**: Added `@pierre/highlights@^0.6.0` and `@pierre/diffs@^1.7.2` (removing the older highlighter package).
- **`vite.config.ui.ts` & `scripts/perf/vite.config.ts`**: Configured `worker: { format: 'es' }` so the `@pierre/diffs` Web Worker bundles as an ES module without Rollup IIFE worker errors.

### Syntax Highlighting (`src/web/lib/highlight.ts`)
- Replaced the custom highlighter with `@pierre/highlights/core` (`createHighlighter`, `isSupportedLanguage`) and `@pierre/highlights/langs`.
- Added `createAuraZedTheme(appearance)` mapping Zed syntax scopes (`comment`, `keyword`, `string`, `number`, `function`, `type`, `tag`, `attribute`, `property`, `variable`, etc.) to `--syntax-*` CSS variables.
- Preserved lazy grammar loading, `MAX_CHARS` (300,000), `MAX_LINE_CHARS` (4,000), and `hashText` (53-bit `cyrb53`).
- Updated `docs/architecture/replies-and-artifacts.md` and `tests/ui/highlight.test.tsx`.

### Aura Diff Tokens, Theme Registration & Worker Helpers
- **`src/web/styles/aura-tokens.css`**: Added `--diff-add-emphasis` and `--diff-del-emphasis` tokens for both dark and light themes.
- **`src/web/styles/aura-components.css`**: Added `.anton-diff` (`position: relative; z-index: 0; isolation: isolate`) and mapped `--diffs-*` CSS custom properties (`--diffs-font-family`, `--diffs-bg-context-override`, `--diffs-bg-addition-override`, `--diffs-bg-deletion-override`, `--diffs-selection-color-override`, etc.) to Aura semantic tokens.
- **`src/web/lib/pierre-diffs.ts`**:
  - Implemented `ensureAuraDiffThemes()` registering `aura-dark` and `aura-light` via `registerCustomTheme(..., 'diffs')`.
  - Added `ANTON_DIFF_UNSAFE_CSS` for Shadow DOM split dividers and gutter-utility slot alignment.
  - Built persistent diff display preferences (`DiffViewPrefs`, `DEFAULT_DIFF_PREFS`, `PREFS_KEY = 'anton.diff.prefs'`, `useDiffViewPrefs`, `setDiffViewPrefs`).
  - Added `getCachedFileDiffMetadata` (500-entry LRU cache), `getLineTextFromDiff`, `resolveCommentTarget`, and `getDiffCommentTargets`.
  - Built `DiffWorkerProvider` (`WorkerPoolContextProvider` + `WorkerPoolOptionsSync`) using `@pierre/diffs/worker/worker.js` and `preferredDiffLib: '@pierre/patches'`, falling back gracefully in SSR/JSDOM/happy-dom environments.

### Workspace Diff Component & Keyboard Commenting
- **`src/web/lib/diff.ts`**: Extended `parsePatch` to capture raw per-file `patch` slices (`FileDiff.patch`) and rename `prevPath` (`rename from` / `--- a/` vs `+++ b/`), covered in `tests/diff.test.ts`.
- **`src/web/components/workspace/diff-list.tsx` & `git-tab.tsx`**:
  - Migrated `DiffLines` to `<PierreFileDiff>` inside `<DiffScrollContainer>` (`<Virtualizer>` when browser `IntersectionObserver` and `ResizeObserver` exist).
  - Kept per-file `draft` and `draftText` local to `DiffLines` so deleting another comment preserves an active unsaved draft.
  - Grouped outdated comments at line `0` using `getLineTextFromDiff`.
  - Added Split / Stacked layout toggle (auto-stacking below `SPLIT_MIN_WIDTH = 720`), `Diff display options` menu (indicators, inline diff mode, line backgrounds, word wrap, line numbers), and keyboard navigation/commenting (`ArrowDown`/`j`, `ArrowUp`/`k`, `Home`, `End`, `Enter`/`c`, `Escape`) with tests in `tests/ui/pierre-diffs.test.tsx` and `tests/ui/changes-pr.test.tsx`.

---

## 3. Phase 2 — On-Demand Context Expansion & PR #354 Review Fixes (Completed, This Branch)

Phase 2 wires `@pierre/diffs`'s `loadDiffFiles` context-expansion pipeline end-to-end across backend routes, GitHub/sandbox providers, UI tabs, and the mock fixture API, and resolves all five review findings surfaced on PR #354.

### On-Demand Context Expansion (`loadDiffFiles`)
1. **GitHub Base SHA Support (`src/core/ports.ts`, `src/providers/github/host.ts`)**:
   - Added optional `baseSha?: string` to `PullRequestInfo` (and inherited by `PullRequestDetail`), populated from `pull.base.sha` in `pullRequest` and `pullRequestDetail`.
2. **Backend Diff-Files Services (`src/services/artifacts/files.ts`, `src/services/git/pull-requests.ts`)**:
   - Added `MAX_DIFF_CONTEXT_BYTES` (2 MiB), `DiffFileContents` (`{ oldText: string | null; newText: string | null }`), `decodeDiffText` (size cap + NUL-byte binary guard), and `hostFileOrNull`.
   - Added `diffFilesView(id, { path, prevPath, scope })`:
     - **Live sandbox**: reads old contents via `git cat-file blob` (respecting `scope: 'unpushed' | 'branch'` and `prevPath` on renames) and new contents from the live working file.
     - **Stopped task**: reads old contents from the git host and new contents from `checkpoint.files` blobs (`savedFileBytes`) or `baseSha`, **never waking a stopped sandbox**.
   - Added `checkpointDiffFilesView(id, at, { path, prevPath })` reading `checkpoint.baseSha` vs checkpoint snapshot blobs.
   - Added `pullRequestDiffFiles(id, number, { path, prevPath })` comparing the 3-dot `git.mergeBase(repo, baseSha, headSha)` (falling back to `baseSha` or `baseBranch`) against `headSha`.
3. **API Routes, Client & UI Fixture (`src/routes/sessions.ts`, `src/web/lib/api/workspace.ts`, `scripts/perf/mock-api.ts`)**:
   - Added `GET /api/sessions/:id/diff-files`, `GET /api/sessions/:id/pulls/:number/diff-files`, and `GET /api/sessions/:id/checkpoints/:at/diff-files` (validating `path` via `requiredPath` and enforcing path traversal checks via `safeRelativePath`).
   - Added `workspaceApi.diffFiles`, `workspaceApi.pullDiffFiles`, and `workspaceApi.checkpointDiffFiles`.
   - Added mocked `diff-files` and `pulls/12/diff-files` handlers in `scripts/perf/mock-api.ts` backed by `git show`.
4. **Frontend Loader, Stale-Patch Guard & Error Surface (`src/web/lib/pierre-diffs.ts`, `diff-list.tsx`, `git-tab.tsx`, `pr-tab.tsx`, `history-tab.tsx`)**:
   - Added `filesMatchDiffMetadata` to verify fetched `oldText`/`newText` lines match the displayed hunks (including gap, hunk, and tail lines) so edits made after the patch loaded cannot be mislabeled as unchanged context; `createDiffFilesLoader` triggers `onStale` to invalidate/refresh stale `changes` or `pullDiff` queries and throws an explanatory message.
   - Added `createDiffFilesLoader` translating `{ oldText, newText }` into `@pierre/diffs` `FileDiffContentsLoader` entries with content-hashed `cacheKey`s, handling `rename-pure` (`oldFile: null`) and rejecting missing contents for edits.
   - Wrapped `loadDiffFiles` in `DiffLines` so expansion rejections (e.g., 2 MiB limit, binary guard, or stale refresh) render a dismissible `role="alert"` banner above `<PierreFileDiff>` while preserving the original hunks.
   - Styled `[data-separator='line-info']` and `[data-expand-button]` in `ANTON_DIFF_UNSAFE_CSS` with Aura tokens.
   - Wired `loadDiffFiles` through `GitTab`, `PullChanges` (`pr-tab.tsx`), `CheckpointView` (`history-tab.tsx`), `DiffList`, `ChangeList`, and `DiffLines`.

### PR #354 Review Fixes
1. **Virtualized Keyboard Scrolling (`src/web/components/workspace/diff-list.tsx`)**:
   - Captured the rendered `PierreFileDiff` instance via `onPostRender` (`handlePostRender`) and scrolled keyboard targets via `virtualizer.scrollSpanIntoView` using mounted line offsets when present or `VirtualizedFileDiff.getLinePosition(lineNumber, side)` when off-screen (accounting for `STICKY_HEADER_HEIGHT = 32`). Verified in Chromium with a 2,000-line diff (`End` -> `Enter` opens a visible focused composer).
2. **Narrow-Pane Toolbar Responsiveness (`src/web/components/workspace/diff-list.tsx`, `git-tab.tsx`)**:
   - Added `TOOLBAR_COMPACT_WIDTH = 460` (`isDiffToolbarCompact`) and `TOOLBAR_TIGHT_WIDTH = 380` (`isDiffToolbarTight`).
   - When compact, Split/Stacked moves into the `Diff display options` menu under a `Layout` group; when tight, `FilesSummary` is hidden and `Diff display options` / `ExpandAll` remain `shrink-0`, keeping both controls reachable at ~200 px pane width.
3. **Focus Restoration After Saving a Comment (`src/web/components/workspace/diff-list.tsx`)**:
   - `closeDraft(true)` now restores focus to the diff region (`diffContainerRef.current?.focus({ preventScroll: true })` guarded by `restoringFocusRef`) on both Cancel and Save (`Ctrl+Enter` or `Add comment`), preserving scroll position and enabling immediate `ArrowDown`/`ArrowUp` navigation.
4. **Hunk-Aware Patch Header Parsing (`src/web/lib/diff.ts`)**:
   - Added `inHunk` state in `parsePatch` so `--- a/` and `+++ b/` lines are parsed as file headers only before the first `@@` hunk and counted as normal removals/additions inside hunks (covered by SQL diff regression test in `tests/diff.test.ts`).
5. **Consistent CRLF Comment Matching (`src/web/lib/pierre-diffs.ts`, `src/web/components/workspace/diff-list.tsx`)**:
   - Extracted `normalizeDiffLine = (text: string) => text.replace(/\r?\n?$/, '')` and applied it to both `comment.code` and `currentCode` during comparison, keeping pre-upgrade CRLF `sessionStorage` comments attached inline.

### Phase 2 Tests
- **`tests/diff-files.test.ts`**: Covers `diffFilesView` (live & stopped, `branch` & `unpushed`, added/deleted/renamed files, stopped-sandbox guarantee), path traversal/binary/size rejection, `checkpointDiffFilesView`, and `pullRequestDiffFiles` 3-dot `mergeBase`.
- **`tests/diff.test.ts`**, **`tests/github-host.test.ts`**, **`tests/ui/pierre-diffs.test.tsx`**, **`scripts/ui/diff-virtualized-keyboard.cjs`**: Regression tests for hunk-interior `--- a/`/`+++ b/` lines, `baseSha`, compact toolbar layout, `Ctrl+Enter` focus restoration, CRLF comment matching, `createDiffFilesLoader`, stale-patch detection, inline expansion error banners, live DOM context expansion, and a checked-in Chromium Playwright script for 2,000-line virtualized `End` + `Enter`.

---

## 4. Phase 3 — Remaining Diff Surfaces, PR/History Virtualization & Legacy Cleanup (Completed)

Phase 3 finished moving Anton's patch rendering surfaces to `@pierre/diffs` and removed the legacy diff highlighter.

### Thread `show` Diff Cards
- **`src/web/components/thread/show-card.tsx`**: Replaced the manual `<pre>` line loop with read-only `@pierre/diffs` rendering inside `.anton-diff` + `DiffWorkerProvider`. Single-file git patches render through `<PatchDiff>`; multi-file or concatenated patches render each parsed `FileDiffMetadata` through `<PierreFileDiff>`.
- Diff cards use unified layout, `AURA_DIFF_THEMES`, word-alt intra-line diffs, `max-h-80 overflow-auto`, and `disableFileHeader` when `node.path` already labels the card. Headerless or malformed patches for which `parsePatchFiles` returns zero files keep a plain `<pre>` fallback.
- **`scripts/ui/chat-sdk.ts`**: Added the `?show-diff` fixture conversation so the thread card can be checked in a real browser.

### PR & History Virtualization
- **`src/web/components/workspace/diff-list.tsx`**: `DiffList` now accepts a bounded mode. Bounded lists enable `useOpenFiles(files, { virtualized: true })` and wrap `ChangeList` in `<DiffScrollContainer className="min-h-0 flex-1 overflow-auto">` beneath the toolbar.
- **`src/web/components/workspace/pr-tab.tsx` / `vm-panel.tsx`**: Workspace PR panels are bounded flex columns. The Changes section owns the virtualized diff scroll while Description, Discussion, Commits, and Checks scroll inside the panel; Reviews page mode remains unbounded because that page already owns its outer scroll.
- **`src/web/components/workspace/history-tab.tsx` / `vm-panel.tsx`**: Checkpoint diffs use the same bounded virtualized path, while the checkpoint list scrolls inside the History panel.

### Post-Hydration Annotation Sync
- **`src/web/components/workspace/diff-list.tsx`**: `DiffLines` watches `onPostRender` for a `FileDiffMetadata.isPartial === true` to `false` transition and increments a hydration revision included in `commentTargets` and `lineAnnotations`. Comments on lines hidden before expansion therefore move from the file-level outdated state back onto their hydrated line immediately.

### Legacy Cleanup
- **`src/web/lib/highlight.ts` / `tests/ui/highlight.test.tsx`**: Removed `highlightDiff`, `highlightHunk`, their private line types, and their tests. `highlight`, `languageFor`, `createAuraZedTheme`, and `hashText` remain for code blocks and file viewers until Phase 4.

### Phase 3 Tests
- **`tests/ui/show-card.test.tsx`**: Valid git patches render in the Shadow DOM diff renderer; malformed/headerless snippets keep the `<pre>` fallback.
- **`tests/ui/pierre-diffs.test.tsx`**: Covers annotation re-sync after context hydration.
- **`tests/ui/changes-pr.test.tsx` / `tests/ui/history.test.tsx`**: Cover the bounded virtualized PR and checkpoint diff containers.
- Verification ran: `npm run check:types`, `npm run lint:hooks`, `npm run build`, `npm test`, `npm run test:ui`, the targeted diff suites, the checked-in virtualized keyboard Playwright script, and Chromium checks for 2,000-line PR/checkpoint virtualization plus `show` diff cards in dark and light themes.

---

## 4a. Phase 4 — Shared Worker Pool & Worker-Backed `<File>` Viewer (Completed)

### Shared Worker Pool Hoist
- **`src/web/components/shell/task-workspace.tsx`**: Mounted one shared `DiffWorkerProvider` around the workspace content (thread + panels). Because `@pierre/diffs`'s `WorkerPoolContextProvider` reference-counts a module-level singleton, this hoisted provider keeps the worker pool, tokenizer, and AST caches alive when switching between Changes, PR, History, and Files panels; the pool now survives any combination of tab switches and only the original mount/unmount of the workspace itself registers instances.
- **`src/web/components/content/diff-scroll-container.tsx`**: Extracted `DiffScrollContainer` out of `diff-list.tsx` into its own module so both the diff lists and the Files viewer share the `<Virtualizer>` wrapper without a circular import.
- Nested `DiffWorkerProvider` fallbacks remain inside `ChangeList`, `ShowPanel` diff cards, and the Files `SourceView` so those surfaces still work when rendered outside the workspace shell (worker instances reference-count, so nesting costs nothing).

### Files Tab `<File>` Migration (`src/web/components/content/file-view.tsx`)
- Replaced main-thread `highlight()` + per-line `<div>` rendering in `FileView`'s source mode with `@pierre/diffs/react`'s `<File>` inside `DiffScrollContainer`'s `<Virtualizer>`, using `AURA_DIFF_THEMES`, the current `themeType`, `preferredHighlighter: 'highlights'`, `disableFileHeader: true` (the surrounding panels draw their own path headers), and `tokenizeMaxLineLength: 4000` matching the legacy guard.
- Preserved behaviors:
  - `structuralSharing` byte-equality on file queries is unchanged, so live polling does not re-render unchanged files.
  - `path:line` deep links pass `selectedLines: { start: line, end: line }` and scroll the virtualized viewer to the line via `VirtualizedFile.scrollToLine(line, 'center')` (retried across post-render phases until measured, with a `scrollIntoView` fallback).
  - Markdown `Source`/`Preview` toggle, image object-URL previews, and binary-file messages are untouched.
  - Syntax tokens paint through `--diffs-token-*` CSS variables bound to Aura `--syntax-*` tokens, so dark/light theme switches stay pure-CSS with zero re-tokenization.
- Browser-measured virtualization: a 10,000+ line `package-lock.json` mounts ~100 rows initially, deep scrolling mounts later slices on demand, and the line-number gutter stays sticky during horizontal scrolling.

### Artifact Source Preview Evaluation — Decision: Not Migrated
`CodeBlock`'s `source={true}` mode (used by `Source`/`SourceAt` in `file-previews.tsx`) was evaluated against `<File>` and **kept on the main-thread `@pierre/highlights` path**, because the migration cannot preserve the invariant documented in `docs/architecture/replies-and-artifacts.md` ("the gutter stays pinned while scrolling horizontally and the horizontal scrollbar sits below the visible code, not below the file's last line"):
- `<File>` renders `[data-code]` as a full-content-height element with internal `overflow-x: scroll`; measured in-browser at 2,008 px tall inside a 640 px viewport, its horizontal scrollbar lands at the bottom of the entire file rather than the viewport.
- Vertical scrolling in `<Virtualizer>` belongs to an outer container, so the two axes cannot share one viewport scroller.
- Pierre does pin the gutter (sticky) — but both scrollbar-placement aspects of the invariant regress. Inline fenced blocks (`source={false}`) were never in scope, per plan.

### Phase 4 Tests
- **`tests/ui/file-view.test.tsx`**: New — shadow-DOM source rendering, deep-linked `path:line` selection painting (`data-selected-line` on the correct row), and binary-file messaging.
- **`tests/ui/render.tsx`**: Added `shadowCodeText()` helper awaiting text inside `<diffs-container>` shadow roots.
- **`tests/ui/files-tab.test.tsx`, `tests/ui/document-preview.test.tsx`, `tests/ui/skills.test.tsx`**: Updated shadow-DOM assertions and spread the real `@/lib/highlight` module in mocks so `createAuraZedTheme` registration survives.
- Chromium checks against `npm run ui:fixture`: file opening, syntax tokens, virtualization subset + deep scrolling, Markdown Source/Preview toggle, 320 px layout, dark and light themes, zero console/page errors.

---

## 4b. Phase 5, Part 1 — Multi-Line Range Commenting & Hunk/File Navigation (Completed)

### Multi-Line Range Commenting (`src/web/lib/review.ts`, `src/web/lib/pierre-diffs.ts`, `src/web/components/workspace/diff-list.tsx`)
- `ReviewComment` gained an optional inclusive `endLine`; single-line comments (including existing `sessionStorage` drafts) are unchanged, keeping the format backwards-compatible. `code` for a range joins its lines with newlines.
- `reviewMessage()` formats ranges as `src/app.ts, lines 12–18` (and `removed lines` for old-side ranges).
- Selection model: `enableLineSelection` is on, so pointer drags paint ranges directly — wired through `onLineSelectionEnd`, which fires only for genuine pointer interaction. (`onLineSelected` also echoes *controlled* writes back — using it makes the echoed keyboard selection stick forever; this trap is why the end hook matters.)
- Keyboard: `Shift+ArrowDown`/`Shift+ArrowUp` extends a range from the cursor; extending stops at a side boundary because a range cannot span old and new lines. Plain arrows, `Home`/`End`, `Escape`, or blur collapse the range. Enter opens one composer covering the whole selection.
- Composers and comment cards anchor at the range end; outdated checks compare the joined range text via the new `getRangeTextFromDiff` helper.

### Hunk & File Jump Navigation (`src/web/components/workspace/diff-list.tsx`)
- `]` / `[` move the keyboard cursor to the first line of the next/previous hunk inside a file diff (reusing the existing selection scroll-into-view machinery).
- `}` / `{` jump focus to the next/previous file's diff region, opening it first if collapsed.

### `<UnresolvedFile>` Evaluation — Decision: Not Adopted
`<UnresolvedFile>` renders git conflict markers with accept/reject actions. Anton never surfaces conflict-marker content in diff patches — conflicts exist only transiently in working-tree files while the agent resolves them inside the sandbox, and users do not hand-resolve merges in the UI (the PR tab instructs them to ask the agent). Rendering an interactive resolution editor would invite conflicts with the agent's own resolution work, so the evaluation ends with a documented negative.

### Phase 5, Part 1 Tests
- `tests/ui/pierre-diffs.test.tsx`: shift-extension range commenting (joined range code + `endLine`), range collapse on plain movement, `reviewMessage` range formatting, `]`/`[` hunk jumping, `}` file jumping with focus following.

---

## 5. Remaining Phases — Implementation Plan (Phases 4–5)

Phase 3 completes the migration of existing patch rendering surfaces. The remaining work splits cleanly into two incremental phases:

### Phase 4: Worker-Backed `<File>` Viewer for Files Tab, Source Previews & Shared Worker Pool (completed — see §4a)

#### Scope & Changes
1. **Hoist `DiffWorkerProvider` to the Task Workspace Shell (`src/web/lib/pierre-diffs.ts`, `src/web/components/shell/task-workspace.tsx`, `src/web/components/workspace/diff-list.tsx`)**:
   - Currently `DiffWorkerProvider` mounts inside `ChangeList`, which tears down and recreates the `@pierre/diffs` Web Worker pool when switching between Changes, PR, History, and Files.
   - Hoist a shared `DiffWorkerProvider` (keeping a safe nested fallback or `useWorkerPool()` guard so standalone tests like `<ChangeList />` continue working without extra wrappers) to the task workspace/app boundary so all tabs share one worker pool and cached AST state.
2. **Migrate `FileView` to `@pierre/diffs/react`'s `<File>` (`src/web/components/content/file-view.tsx`, `src/web/components/workspace/files-tab.tsx`)**:
   - Replace main-thread `highlight()` + `lines.map(...)` rendering in `FileView` with `<File>` inside `<Virtualizer>` using `AURA_DIFF_THEMES` and `.anton-diff` styling.
   - Preserve existing behaviors in `FileView`:
     - `structuralSharing` `Uint8Array` equality check on the file query so live tool polling does not re-render unchanged files.
     - `markedLine` deep-linking (`path:line` links from replies) via `selectedLines` (`{ start: markedLine, end: markedLine }`) and virtualized scroll-into-view.
     - `MarkdownToggle` / `DocumentMarkdown` preview mode for Markdown files, image blob previews, and binary file messages.
     - Plain-text fallback / guard for oversized files or files exceeding tokenization thresholds.
3. **Evaluate `CodeBlock` `source` Mode Migration (`src/web/components/content/code-block.tsx`, `src/web/components/content/file-previews.tsx`, `docs/architecture/replies-and-artifacts.md`)**:
   - Migrate `CodeBlock` when `source={true}` (used by `Source` / `SourceAt` in `file-previews.tsx` for artifact/file previews) to virtualized `<File>` rendering while strictly preserving the pinned line-number gutter and single-viewport two-axis scroll invariant documented in `docs/architecture/replies-and-artifacts.md`.
   - Keep lightweight main-thread `@pierre/highlights` + `useSettled` for small inline markdown fenced blocks (`source={false}`) where streaming stability and minimal per-block DOM overhead matter more than Shadow DOM virtualization.

#### Verification for Phase 4
- `npm run check:types`, `npm run lint:hooks`, `npm run build`
- `npx vitest run tests/ui/design-tokens.test.tsx` and UI tests for `file-view`, `files-tab`, `code-block`, and `output-viewer`
- Playwright check opening a large source file in Files, clicking a `path:line` link from a reply, toggling Markdown Source/Preview, switching dark/light themes, and verifying layout at 320 px width

---

### Phase 5: Rich Code-Review & Diff Workflows

#### Scope & Changes
1. **Multi-Line Range Commenting (`src/web/lib/review.ts`, `src/web/components/workspace/diff-list.tsx`)**:
   - Enable multi-line selection in `PierreFileDiff` options (`enableLineSelection`, `onLineSelected` / `Shift+ArrowUp` / `Shift+ArrowDown`) so `SelectedLineRange` supports `{ start, end, side }`.
   - Extend `ReviewComment` with optional `endLine?: number` (staying backwards-compatible with existing `sessionStorage` drafts) and update `reviewMessage()` to format multi-line comments cleanly (e.g., `src/app.ts, lines 12–18`).
   - Anchor inline comment cards and composers at the range end (`Math.max(start, end)`) and verify range-aware outdated checks.
2. **Inline GitHub PR Review Threads (`src/core/ports.ts`, `src/providers/github/host.ts`, `src/web/components/workspace/pr-tab.tsx`)**:
   - Extend GitHub PR review comment records in `PullRequestDetail['discussion']` (or a dedicated field) with `side` (`old`/`new`), `line`, `originalLine`, and `outdated` status.
   - Render GitHub review threads as read-only `lineAnnotations` directly inside `PullChanges` in `pr-tab.tsx`, and add click-to-jump links from Discussion entries to the matching file and line in the PR Changes sub-tab.
3. **Hunk/File Jump Navigation & Merge-Conflict Rendering (`src/web/components/workspace/diff-list.tsx`, `git-tab.tsx`)**:
   - Add next/previous hunk (`]` / `[` shortcuts and optional toolbar actions) and next/previous file navigation built on `fileDiff.hunks` and `virtualizer.scrollSpanIntoView`.
   - Evaluate `@pierre/diffs/react`'s `<UnresolvedFile>` for rendering git merge-conflict markers surfaced in workspaces after `merge_base_branch`.

#### Verification for Phase 5
- `env -u ANTON_STORE -u TIGRIS_SECRET_ACCESS_KEY node --experimental-strip-types --test tests/github-host.test.ts` plus unit tests for multi-line `reviewMessage` formatting
- Vitest UI tests for multi-line range commenting, PR inline discussion annotations, and hunk navigation
- Playwright browser checks for drag/`Shift+Arrow` range commenting and PR Discussion -> Changes line jump

---

## 6. Summary Roadmap & Cross-Phase Verification Checklist

| Phase | Scope | Key Files | Status |
| --- | --- | --- | --- |
| **Phase 1** | `@pierre/highlights` Zed Aura theme, `@pierre/diffs` `DiffLines`, worker pool, preferences, draft & keyboard commenting | `highlight.ts`, `pierre-diffs.ts`, `diff-list.tsx`, `diff.ts`, `aura-tokens.css`, `aura-components.css` | **Done (PR #354)** |
| **Phase 2** | On-demand context expansion (`loadDiffFiles` + `/diff-files` endpoints + `baseSha`) & all 5 PR #354 review fixes | `files.ts`, `pull-requests.ts`, `sessions.ts`, `host.ts`, `pierre-diffs.ts`, `diff-list.tsx`, `git-tab.tsx`, `pr-tab.tsx`, `history-tab.tsx` | **Done** |
| **Phase 3** | Thread `show` diff cards, PR/History virtualization, post-hydration annotation sync, remove `highlightDiff` | `show-card.tsx`, `diff-list.tsx`, `pr-tab.tsx`, `history-tab.tsx`, `highlight.ts` | **Done** |
| **Phase 4** | Shared workspace `DiffWorkerProvider`, Files tab `<File>` + `<Virtualizer>`, artifact source preview evaluation (rejected, invariant documented) | `task-workspace.tsx`, `file-view.tsx`, `diff-scroll-container.tsx`, `diff-list.tsx` | **Done** |
| **Phase 5** | Multi-line range commenting, inline GitHub PR review threads, hunk/file jump navigation, `<UnresolvedFile>` evaluation | `review.ts`, `diff-list.tsx`, `pr-tab.tsx`, `ports.ts`, `github/host.ts` | **Part 1 done** (ranges, hunk/file nav, `<UnresolvedFile>` rejected); PR inline threads planned |

### Standard Verification Gates (Every Remaining Phase)
- `npm run check:types` and `npm run lint:hooks`
- `npm run build` and confirm worker assets emit cleanly under `dist/client/assets/worker-*.js`
- `npx vitest run tests/ui/design-tokens.test.tsx` (ensuring zero raw CSS values or banned utility classes)
- Focused `node --experimental-strip-types --test` (with `env -u ANTON_STORE -u TIGRIS_SECRET_ACCESS_KEY`) and `npx vitest run` suites for modified modules and callers
- Playwright headless Chromium checks against `npm run ui:fixture` verifying interactive Shadow DOM rendering, virtualized scrolling, focus retention, zero console/page/network errors, and narrow-width responsiveness
