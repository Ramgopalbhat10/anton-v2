# `@pierre/highlights` & `@pierre/diffs` Migration Roadmap

This document describes the overall objective for adopting `@pierre/highlights` and `@pierre/diffs` across Anton v2, what was delivered in Phases 1 and 2, and the implementation plan for the remaining phases (Phases 3–5).

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

## 4. Remaining Phases — Implementation Plan (Phases 3–5)

Phase 2 intentionally stops after workspace diff context expansion and the PR #354 fixes. The remaining work splits cleanly into three incremental phases:

### Phase 3: Remaining Diff Surfaces, PR/History Virtualization & Legacy Cleanup

#### Scope & Changes
1. **Migrate Thread `show` Diff Cards (`src/web/components/thread/show-card.tsx`)**:
   - Replace the manual `<pre>` line loop inside `Diff` (currently splitting `node.patch` and styling `+`/`-`/`@@` lines by prefix) with a read-only `@pierre/diffs` render (`<PatchDiff>` or `<PierreFileDiff>` via `getCachedFileDiffMetadata`) inside `.anton-diff` + `DiffWorkerProvider`.
   - Use unified layout (`diffStyle: 'unified'`), Aura themes (`AURA_DIFF_THEMES`), `max-h-80 overflow-auto`, and `disableFileHeader: true` when `node.path` already renders the card header.
   - Keep a plain `<pre>` fallback for malformed or headerless patches where `parsePatchFiles` returns zero files.
2. **Virtualize PR & History `DiffList` (`src/web/components/workspace/diff-list.tsx`, `pr-tab.tsx`, `history-tab.tsx`)**:
   - Currently `GitTab` wraps `<ChangeList>` in `<DiffScrollContainer>`, whereas `DiffList` (used by `PullChanges` in `pr-tab.tsx` and `CheckpointView` in `history-tab.tsx`) renders `<ChangeList>` directly without `<DiffScrollContainer>` and calls `useOpenFiles(files)` without `{ virtualized: true }`.
   - Update `DiffList` to wrap `<ChangeList>` in `<DiffScrollContainer className="min-h-0 flex-1 overflow-auto">` inside a bounded flex column (passing bounded height from `PullChanges` / `CheckpointView`) and enable `{ virtualized: true }` on `useOpenFiles`.
3. **Re-sync Annotations After Context Hydration (`src/web/components/workspace/diff-list.tsx`)**:
   - Track a per-`DiffLines` hydration revision counter incremented in `handlePostRender` whenever `instance`'s metadata transitions from `isPartial === true` to `false`.
   - Include that revision in the `commentTargets` and `lineAnnotations` dependency arrays so comments or keyboard navigation reflect newly expanded context lines immediately.
4. **Remove Legacy `highlightDiff` (`src/web/lib/highlight.ts`, `tests/ui/highlight.test.tsx`)**:
   - Remove `highlightDiff` and `highlightHunk` (which have zero remaining callers in `src/web`) along with their unit tests in `tests/ui/highlight.test.tsx`, keeping `highlight`, `languageFor`, `createAuraZedTheme`, and `hashText`.

#### Verification for Phase 3
- `npm run check:types`, `npm run lint:hooks`, `npm run build`
- `npx vitest run tests/ui/pierre-diffs.test.tsx tests/ui/changes-pr.test.tsx tests/ui/highlight.test.tsx` plus `show-card` UI tests covering both valid git patches and fallback snippets
- Playwright check verifying large PR diff / checkpoint virtualization and thread `show` diff card rendering in dark & light themes

---

### Phase 4: Worker-Backed `<File>` Viewer for Files Tab, Source Previews & Shared Worker Pool

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

## 5. Summary Roadmap & Cross-Phase Verification Checklist

| Phase | Scope | Key Files | Status |
| --- | --- | --- | --- |
| **Phase 1** | `@pierre/highlights` Zed Aura theme, `@pierre/diffs` `DiffLines`, worker pool, preferences, draft & keyboard commenting | `highlight.ts`, `pierre-diffs.ts`, `diff-list.tsx`, `diff.ts`, `aura-tokens.css`, `aura-components.css` | **Done (PR #354)** |
| **Phase 2** | On-demand context expansion (`loadDiffFiles` + `/diff-files` endpoints + `baseSha`) & all 5 PR #354 review fixes | `files.ts`, `pull-requests.ts`, `sessions.ts`, `host.ts`, `pierre-diffs.ts`, `diff-list.tsx`, `git-tab.tsx`, `pr-tab.tsx`, `history-tab.tsx` | **Done (This PR)** |
| **Phase 3** | Thread `show` diff cards, PR/History virtualization, post-hydration annotation sync, remove `highlightDiff` | `show-card.tsx`, `diff-list.tsx`, `pr-tab.tsx`, `history-tab.tsx`, `highlight.ts` | **Planned** |
| **Phase 4** | Shared workspace `DiffWorkerProvider`, Files tab `<File>` + `<Virtualizer>`, artifact source preview evaluation | `task-workspace.tsx`, `file-view.tsx`, `files-tab.tsx`, `code-block.tsx`, `file-previews.tsx` | **Planned** |
| **Phase 5** | Multi-line range commenting, inline GitHub PR review threads, hunk/file jump navigation, `<UnresolvedFile>` evaluation | `review.ts`, `diff-list.tsx`, `pr-tab.tsx`, `ports.ts`, `github/host.ts` | **Planned** |

### Standard Verification Gates (Every Remaining Phase)
- `npm run check:types` and `npm run lint:hooks`
- `npm run build` and confirm worker assets emit cleanly under `dist/client/assets/worker-*.js`
- `npx vitest run tests/ui/design-tokens.test.tsx` (ensuring zero raw CSS values or banned utility classes)
- Focused `node --experimental-strip-types --test` (with `env -u ANTON_STORE -u TIGRIS_SECRET_ACCESS_KEY`) and `npx vitest run` suites for modified modules and callers
- Playwright headless Chromium checks against `npm run ui:fixture` verifying interactive Shadow DOM rendering, virtualized scrolling, focus retention, zero console/page/network errors, and narrow-width responsiveness
