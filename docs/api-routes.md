# API routes

Every HTTP route Anton's API registers, as of [`src/app.ts`](../src/app.ts). The app is a
[Hono](https://hono.dev) app exported from that file; errors thrown by a handler become a JSON
`{ "error": "…" }` with the status from `statusOf()` (`src/core/errors.ts`), and a 5xx is logged.

Anton has no login of its own: put it behind an access proxy, since anyone who reaches these routes
can run code in your sandboxes and push with your token.

Vocabulary in the paths, which does not match the UI everywhere:

| In a path | In the UI |
| --- | --- |
| `/api/projects` (with `/repos`, `/branches`, `/automations`) | A repository |
| `/api/spaces` | A project: a coordinator conversation over parallel threads |
| `/api/sessions` | A task (or a chat, when it has no repository) |

The list is 152 direct registrations on `app` below, plus the routes two agent routers mount
(`/api/agents/coder` and `/api/agents/coordinator`, from `@flue/runtime`'s `createAgentRouter`), which
make up the agent runtime section. Query parameters that matter are shown in the path column.

## Agent runtime

`createAgentRouter(agent)` builds these four, mounted at `/api/agents/coder` (with `Coder`) and
`/api/agents/coordinator` (with `Coordinator`). The coder's and coordinator's `POST /:id` also carry a
middleware that validates the task or project, the spending cap and the files, before the runtime
answers.

| Method | Path | Handler | Description |
| --- | --- | --- | --- |
| `POST` | `/api/agents/coder/:id` | `executeAgentPrompt` (Flue) | Send a message to the task `:id`: the task must exist, not be restoring files and be under its spending cap; then its model and MCP servers load and the message goes to the agent. |
| `GET`, `HEAD` | `/api/agents/coder/:id` | `executeAgentConversationRead` (Flue) | Read the task's conversation from `?offset=`: a snapshot by default, `?live=sse` to follow it as a stream, `?live=long-poll` to wait for the next items. |
| `POST` | `/api/agents/coder/:id/abort` | `executeAgentAbort` (Flue) | Stop the reply in flight; its running subagents end as stopped, not failed. |
| `GET` | `/api/agents/coder/:id/attachments/:attachmentId` | `executeAgentAttachmentRead` (Flue) | Download one attachment's bytes from the task's conversation. |
| `POST` | `/api/agents/coordinator/:id` | `executeAgentPrompt` (Flue) | Send a message to project `:id`'s coordinator, checked against the spending cap, after it loads a fresh picture of the project. |
| `GET`, `HEAD` | `/api/agents/coordinator/:id` | `executeAgentConversationRead` (Flue) | Read the coordinator's conversation from `?offset=`, the same way: a snapshot, `?live=sse` or `?live=long-poll`. |
| `POST` | `/api/agents/coordinator/:id/abort` | `executeAgentAbort` (Flue) | Stop the coordinator's reply in flight. |
| `GET` | `/api/agents/coordinator/:id/attachments/:attachmentId` | `executeAgentAttachmentRead` (Flue) | Download one attachment's bytes from the coordinator's conversation. |

The reviewer's router is created only so that `setAgentAbort` can stop it (`src/app.ts:244`); it is never
mounted, so it serves no HTTP route.

## Events and health

| Method | Path | Handler | Description |
| --- | --- | --- | --- |
| `GET` | `/api/events` | `onChange` (`src/core/changes.ts`) | SSE stream of what changed, so open pages refetch just that instead of polling; a heartbeat comment every 25 s keeps proxies from closing it. |
| `GET` | `/api/health` | inline | `{ ok, openRouter, providers }`: whether an OpenRouter key is set and which sandbox, store and git providers are in use. |

## Spending, usage and settings

| Method | Path | Handler | Description |
| --- | --- | --- | --- |
| `GET` | `/api/budget?session=` | `budget` | The spending caps, today's spend, the task's spend when `session` is given, and what would block a message. |
| `GET` | `/api/usage` | `usageView` | This month's spend by repository and by model, today's spend, a daily series and each plan's limits, for Settings › Usage. |
| `PUT` | `/api/settings/limits` | `setLimits` | Set the daily cap and the per-task cap (USD, or null for none); answers the new `budget()`. |
| `GET` | `/api/settings/commands` | `commands` | The saved slash commands (name → prompt). |
| `PUT` | `/api/settings/commands` | `setCommands` | Replace the slash commands; at most 100, each name ≤ 40 characters and prompt ≤ 20,000. |
| `GET` | `/api/settings/sandbox` | `sandboxSettings` | Sandbox size, idle and lifetime limits, region, allowed domains and base image, plus the default base image and provider. |
| `PUT` | `/api/settings/sandbox` | `setSandboxSettings` | Change any of those sandbox settings. |
| `GET` | `/api/settings/general` | `generalSettings` | Default model, reasoning, plan mode, automatic reviews, code mode, visual replies, page network, image model and the per-subagent models. |
| `PUT` | `/api/settings/general` | `setGeneralSettings` | Change the general settings; an unknown model or image model is refused, and a null model or reasoning means the default. |
| `GET` | `/api/settings/guardrails` | `guardrails` | Whether secrets are hidden from the agent. |
| `PUT` | `/api/settings/guardrails` | `setGuardrails` | Turn secret hiding on or off. |

## Plugins, marketplaces and skills

| Method | Path | Handler | Description |
| --- | --- | --- | --- |
| `GET` | `/api/plugins` | `pluginsView`, `marketplaces` | Installed plugins and the configured marketplaces. |
| `PUT` | `/api/settings/marketplaces` | `setMarketplaces` | Replace the marketplace list (at most 20). |
| `GET` | `/api/marketplaces/catalog?repo=&bundle=` | `catalog` | What a marketplace or bundle offers: skills and plugins to install. |
| `POST` | `/api/plugins` | `installPlugin` | Install a plugin by marketplace and name, by address, or by the plugin id a preview returned; answers the new plugin list. |
| `GET` | `/api/plugins/preview` | `previewPlugin` | What installing the given marketplace plugin, address or plugin id would add, before installing it. |
| `GET` | `/api/plugins/file?repo=&sha=&path=` | `pluginFile` | One file's bytes from a repository at a commit, for browsing a plugin. |
| `GET` | `/api/skills/search?q=` | `searchGitHub` | Search GitHub for skills. |
| `PATCH` | `/api/plugins/:id` | `setEnabled` | Enable or disable one plugin. |
| `DELETE` | `/api/plugins/:id` | `removePlugin` | Uninstall one plugin. |

## Notifications

| Method | Path | Handler | Description |
| --- | --- | --- | --- |
| `GET` | `/api/push` | `pushView` | Registered devices and the notification options, with the public key browsers subscribe with. |
| `POST` | `/api/push/devices` | `addDevice` | Register a browser's push subscription (endpoint and keys), with an optional name, and the endpoint it replaces. |
| `DELETE` | `/api/push/devices/:id` | `removeDevice` | Forget one device. |
| `POST` | `/api/push/test` | `sendTest` | Send a test notification, to one device when given. |
| `PUT` | `/api/push/options` | `setPushOptions` | Turn the "task finished" notification on or off. |
| `POST` | `/api/push/presence` | `notePresence` | Say whether an Anton page is in front of you, so your phone stays quiet while it is. |

## Secrets, reviews, compute, logs and storage

| Method | Path | Handler | Description |
| --- | --- | --- | --- |
| `GET` | `/api/secrets` | `secretsView` | Names of the shared environment variables and variables per repository (values hidden). |
| `PUT` | `/api/secrets/shared` | `setSharedEnv` | Set the environment variables every task gets; a null value keeps the stored one. |
| `POST` | `/api/projects/:id/prepared-image/rebuild` | `rebuildPreparedImage` | Drop repository `:id`'s prepared image, so its next sandbox is built again with the setup script. |
| `GET` | `/api/reviews` | `reviewQueue` | Every pull request Anton opened or reviews, the ones waiting on you first, each with its checks, comments and conflicts. |
| `POST` | `/api/reviews` | `reviewPullRequest` | Review any pull request by its link, in a task of its own unless Anton opened it (201). |
| `GET` | `/api/connections` | `connections` | Each outside service probed and marked ok, set, off or failing: code host, sandboxes, object storage, models, plans, web search. |
| `GET` | `/api/compute` | `computeView` | Running sandboxes, how many others the provider runs, and which provider, for Settings › Compute. |
| `POST` | `/api/compute/stop-all` | `stopAllSandboxes` | Stop every running sandbox. |
| `GET` | `/api/logs` | `recentProblems` | Recent warnings and errors from the server log. |
| `GET` | `/api/storage` | `storageView` | How many objects storage holds, their bytes, and when cleanup last ran. |
| `POST` | `/api/storage/cleanup` | `cleanUpStorage` | Delete what storage no longer needs. |

## Models and subscriptions

| Method | Path | Handler | Description |
| --- | --- | --- | --- |
| `GET` | `/api/models` | `listModels`, `defaultModel`, `pinnedModels` | Models on offer — OpenRouter's for the key in use, and those of any plan signed in — with the default and the pinned ones. |
| `GET` | `/api/image-models` | `imageModels`, `imagesAvailable` | What `generate_image` can draw with, for Settings › General; empty without an OpenRouter key. |
| `PUT` | `/api/models/pinned` | `setPinnedModels` | Replace the pinned models (at most 100). |
| `GET` | `/api/subscriptions` | `subscriptionsView` | Plans you pay for (ChatGPT, Claude Code, OpenCode Go, Cursor) and OpenRouter's key, with limits and sign-in state. |
| `PUT` | `/api/subscriptions/:id` | `setSubscriptionOptions` | Enable or disable a plan, and whether its calls count at API prices toward the caps. |
| `DELETE` | `/api/subscriptions/:id` | `disconnect` | Disconnect a plan and forget its sign-in or key; 409 for Claude Code, which keeps its own sign-in and is signed out on the server instead. |
| `POST` | `/api/subscriptions/:id/login` | `beginLogin` | Start the vendor's own sign-in flow; answers the URL to open. |
| `DELETE` | `/api/subscriptions/:id/login` | `cancelLogin` | Cancel a sign-in in progress. |
| `POST` | `/api/subscriptions/:id/login/complete` | `finishLogin` | Finish the sign-in with the callback URL the vendor sent the browser to. |
| `POST` | `/api/subscriptions/:id/import` | `importLogin` | Import a sign-in made elsewhere (`auth.json` from `pi-ai login`). |
| `PUT` | `/api/subscriptions/:id/key` | `connectKey` | Connect a plan's key from the vendor's dashboard, checked with the vendor before it is kept; also OpenRouter's key. |
| `POST` | `/api/subscriptions/:id/models/refresh` | `refreshSubscriptionModels` | Refresh a plan's model list from the vendor. |

## Connectors and MCP servers

| Method | Path | Handler | Description |
| --- | --- | --- | --- |
| `GET` | `/api/connectors` | `connectorsView`, `mcpServersView` | Connected accounts (Gmail and others), the mailboxes each offers, and the MCP servers every task gets. |
| `PUT` | `/api/connectors/accounts/:id/client` | `setAccountClient` | Set your own OAuth client id and secret for an account. |
| `DELETE` | `/api/connectors/accounts/:id` | `disconnectAccount` | Disconnect an account. |
| `POST` | `/api/connectors/mailboxes/:id/connect` | `beginConnect` | Start signing a mailbox in, with read-only or draft access; answers the URL to open. |
| `PUT` | `/api/connectors/mailboxes/:id` | `setMailboxOptions` | Enable a mailbox, and allow drafting and sending. |
| `GET` | `/api/connectors/:account/callback` | `finishConnect` | Where the vendor sends the browser back: finishes the sign-in, then redirects to `/settings/connectors/view` with the outcome. |
| `POST` | `/api/mcp-servers` | `addMcpServer` | Add an MCP server (https URL, tools, auth, code mode), named with lowercase letters, digits, `-` and `_`. |
| `PUT` | `/api/mcp-servers/:name` | `updateMcpServer` | Replace one MCP server's URL, tools, auth and code mode. |
| `PATCH` | `/api/mcp-servers/:name` | `toggleMcpServer` | Turn one MCP server on or off. |
| `DELETE` | `/api/mcp-servers/:name` | `removeMcpServer` | Remove one MCP server. |
| `GET` | `/api/mcp-servers/:name/tools` | `mcpServerTools` | List the tools one MCP server offers. |
| `POST` | `/api/mcp-servers/:name/sign-in` | `beginMcpSignIn` | Start an OAuth sign-in to one MCP server, with an optional client; answers the URL to open. |
| `DELETE` | `/api/mcp-servers/:name/sign-in` | `signOutOfMcpServer` | Sign out of one MCP server. |
| `GET` | `/api/mcp-servers/callback` | `finishMcpSignIn` | Where an MCP server sends the browser back: finishes the sign-in, then redirects to Settings › Connectors with the outcome. |

## Repositories and automations

| Method | Path | Handler | Description |
| --- | --- | --- | --- |
| `GET` | `/api/profile` | `profileName` | Your name, from the GitHub account in use. |
| `GET` | `/api/projects` | `projects` | The repositories Anton can work on. |
| `GET` | `/api/repos` | `addableRepos` | Repositories that could be added, from GitHub. |
| `POST` | `/api/projects` | `addProject` | Add a repository by `owner/name`. |
| `DELETE` | `/api/projects/:id` | `removeProject` | Remove a repository. |
| `PUT` | `/api/projects/:id/memory` | `saveMemory` | Replace a repository's memory: the short notes its tasks' agents read. |
| `PUT` | `/api/projects/:id/settings` | `updateSettings` | Change a repository's settings: environment variables, setup script, preview ports, base image, full VM, follow-ups, reviewing others' pull requests. |
| `GET` | `/api/projects/:id/automations` | `automations` | A repository's automations (on issues, or on a schedule). |
| `POST` | `/api/projects/:id/automations` | `addAutomation` | Add an automation to a repository. |
| `PATCH` | `/api/automations/:id` | `setAutomationEnabled` | Turn one automation on or off. |
| `PUT` | `/api/automations/:id` | `editAutomation` | Change one automation: kind, label, schedule, prompt, model, reasoning, plan first. |
| `POST` | `/api/automations/:id/run` | `runAutomation` | Run one automation now, whether or not its schedule says so. |
| `DELETE` | `/api/automations/:id` | `removeAutomation` | Delete one automation. |
| `GET` | `/api/projects/:id/branches` | `branches` | A repository's branches, for picking a task's start. |
| `GET` | `/api/projects/:id/files?branch=` | `projectFiles` | Every file path in a repository, optionally on one branch, for the file picker. |

## Projects (spaces) and their threads

| Method | Path | Handler | Description |
| --- | --- | --- | --- |
| `GET` | `/api/spaces` | `spacesView` | Projects, with their threads' state. |
| `POST` | `/api/spaces` | `createSpace` | Create a project: name, icon, goal, instructions, autonomy, parallelism, repositories. |
| `GET` | `/api/spaces/:id` | `spaceView` | One project: its settings, repositories, how many threads it has and how they count by state. |
| `PATCH` | `/api/spaces/:id` | `editSpace` | Change a project: its fields, memory, coordinator and thread models, state (active, paused, archived), repositories. |
| `DELETE` | `/api/spaces/:id` | `removeSpace` | Delete a project. |
| `GET` | `/api/spaces/:id/threads` | `listThreads` | A project's threads. |
| `POST` | `/api/spaces/:id/threads` | `startThread` | Start a thread from a brief on one of the project's repositories, or a chat when `projectId` is null; the coordinator hears of it. |
| `POST` | `/api/spaces/:id/threads/:threadId/nudge` | `nudgeThread` | Send a thread a message as you, without the coordinator writing it. |
| `GET` | `/api/spaces/:id/usage` | `spaceUsage` | What a project's threads have spent. |
| `GET` | `/api/spaces/:id/automations` | `spaceAutomations` | A project's automations, which start its threads. |
| `POST` | `/api/spaces/:id/automations` | `addAutomation` | Add an automation that starts threads in a project. |
| `GET` | `/api/spaces/:id/files` | `listSpaceFiles` | The project's Library: files every thread reads. |
| `GET` | `/api/spaces/:id/file?path=` | `readSpaceFile` | One Library file's bytes, images and PDFs inline. |
| `POST` | `/api/spaces/:id/files?name=` | `uploadSpaceFile` | Add a file to the Library: the body is the file, its name in the query (up to 20 MB). |
| `POST` | `/api/spaces/:id/attachments?name=` | `attachToProject` | Attach a file to a message to the coordinator or a new brief: saved to the Library, read as text for the message (up to 20 MB). |
| `DELETE` | `/api/spaces/:id/file?path=` | `removeSpaceFile` | Remove one file from the Library. |

## Tasks (sessions)

| Method | Path | Handler | Description |
| --- | --- | --- | --- |
| `GET` | `/api/sessions` | `listSessions` | Every task and chat. |
| `POST` | `/api/sessions` | `createSession` | Create a task on a repository and branch (or a chat, with no `projectId`), with a model, reasoning, title and plan mode; `titleFrom` lets a fast model name it. |
| `GET` | `/api/sessions/:id` | `getSession` | One task: its branch, title, model, state. |
| `PATCH` | `/api/sessions/:id` | `editSession` | Change a task: title, model, reasoning, plan mode, pinned, resolved, and its project (`spaceId`). |
| `DELETE` | `/api/sessions/:id` | `deleteTask` | Delete a task; a project thread keeps the files it saved as project files. |
| `GET` | `/api/sessions/:id/skills` | `sessionSkills` | The skills the task's agent can use. |
| `POST` | `/api/sessions/:id/fork` | `forkSession` | Fork a task: a new task on the same base, model and plan mode holding the task's files as they are now, so two approaches can be tried side by side. The conversation and outputs stay with the original. |
| `POST` | `/api/sessions/:id/review` | `requestReview` | Ask for a review of the task's pull request. |
| `POST` | `/api/sessions/:id/stop` | `stopSession` | Stop the agent working on a task. |
| `POST` | `/api/sessions/:id/resume` | `resumeSession` | Resume a stopped task, starting its sandbox from its snapshot. |
| `GET` | `/api/sessions/:id/checkpoints` | `listCheckpoints` | A task's checkpoints: after each agent response, and before a stop, restore or revert. |
| `GET` | `/api/sessions/:id/checkpoints/:at` | `readCheckpointPatchAt` | The patch saved at one checkpoint. |
| `POST` | `/api/sessions/:id/checkpoints/:at/restore` | `restoreCheckpoint` | Restore the workspace to one checkpoint. |
| `POST` | `/api/sessions/:id/revert` | `revertFile` | Revert one file to its state before the task changed it. |
| `GET` | `/api/sessions/:id/previews` | `previewsView` | The task's preview ports, their URLs and which have a server listening; never starts the sandbox. |
| `GET` | `/api/sessions/:id/browser` | `browserView` | The Browser panel: whether a browser is open, its page, address and live view. |
| `POST` | `/api/sessions/:id/browser` | `openBrowser` | Open the task's browser, optionally at a URL. |
| `DELETE` | `/api/sessions/:id/browser` | `closeBrowser` | Close the task's browser. |
| `POST` | `/api/sessions/:id/browser/navigate` | `navigate` | Go to a URL, or back, forward or reload. |
| `POST` | `/api/sessions/:id/browser/inspect` | `inspectAt` | What is at a point in the page, for the picker. |
| `POST` | `/api/sessions/:id/browser/highlight/clear` | `clearHighlight` | Remove the highlight the picker drew. |
| `POST` | `/api/sessions/:id/browser/screenshot` | `browserScreenshot` | Screenshot the task's browser page. |
| `POST` | `/api/sessions/:id/browser/watch` | `watchBrowser` | Keep following the page's live view for a while, because the panel is on screen. |
| `GET` | `/api/sessions/:id/computer` | `computerView` | The Computer panel: the desktop in the task's sandbox, and whether it is running. Viewing never starts it. |
| `POST` | `/api/sessions/:id/computer` | `startComputer` | Start the desktop. |
| `POST` | `/api/sessions/:id/computer/stop` | `stopComputer` | Stop the desktop. |
| `POST` | `/api/sessions/:id/computer/connect` | `connectComputer` | Connect to the desktop's stream. |
| `POST` | `/api/sessions/:id/computer/control` | `setComputerControl` | Who drives the desktop: you or the agent. |
| `POST` | `/api/sessions/:id/computer/screenshot` | `computerScreenshot` | Screenshot the desktop. |
| `GET` | `/api/sessions/:id/subagents` | `subagentRuns` | The task's subagent runs and what each is doing. |
| `POST` | `/api/sessions/:id/subagents/:run/stop` | `stopSubagent` | Stop one subagent on its own; the agent carries on with what it had done. 409 when it is not running. |
| `GET` | `/api/sessions/:id/scripts` | `scriptCalls` | The `run_script` calls the agent made in a task. |
| `GET` | `/api/sessions/:id/mail` | `mailApprovals` | Emails the agent asked to send, waiting for your answer. |
| `POST` | `/api/sessions/:id/mail/:approval` | `decideSend` | Send or skip one of them; only your `send: true` sends it. |
| `GET` | `/api/sessions/:id/todos` | `todosFor` | The agent's todo list. |
| `GET` | `/api/sessions/:id/joins` | `joinsFor` | Where the agent read each message sent while it worked, for the thread to show it there. |
| `GET` | `/api/sessions/:id/now` | `agentNow` | What the agent is doing at this moment; later changes come over `/api/events`. |
| `GET` | `/api/sessions/:id/context` | `contextView` | How full the agent's context window is. |
| `GET` | `/api/sessions/:id/pull-request` | `pullRequestView` | The task's pull request: its URL and its state (open, merged or closed). |
| `GET` | `/api/sessions/:id/changes` | `changesView` | The files the task changed, with their diffs, for the Changes panel. |
| `GET` | `/api/sessions/:id/files` | `fileTree` | The task's file tree. |
| `GET` | `/api/sessions/:id/file?path=` | `readFile` | One file's bytes from the task's workspace, images and PDFs inline, anything else as a download. |
| `GET` | `/api/sessions/:id/outputs` | `outputsView` | The task's Library: the files the agent saved. |
| `GET` | `/api/sessions/:id/output?path=` | `readOutputFile` | One Library file's bytes, images and PDFs inline. |
| `GET` | `/api/sessions/:id/render-frame?path=` | `pageFrame` | The frame page the thread shows a `render_html` page in, with a CSP that lets the page run only inside it. |
| `GET` | `/api/sessions/:id/render?path=` | `renderPage` | The page the agent wrote with `render_html`, as it stands, never from a cache. |
| `GET` | `/api/sessions/:id/page-state?path=` | `pageState` | The state every open copy of that page shares. |
| `PUT` | `/api/sessions/:id/page-state?path=` | `savePageState` | Save what the page changed about its state. |
| `POST` | `/api/sessions/:id/page-fetch?path=` | `pageFetch` | Make a request on the page's behalf, since the page itself cannot reach the network. |
| `GET` | `/api/artifacts` | `listArtifacts` | Everything the agent made in every task, for the Artifacts page. |
| `POST` | `/api/sessions/:id/outputs?name=` | `uploadOutput` | Add a file to the task's Library: the body is the file, its name in the query (up to 20 MB). |
| `POST` | `/api/sessions/:id/attachments?name=` | `attachToTask` | Attach a file to a message: saved to the task's Library and read as text for the message (up to 20 MB). |
| `DELETE` | `/api/sessions/:id/output?path=` | `removeOutput` | Remove one file from the task's Library. |

## Keeping this page true

The tables follow `src/app.ts` top to bottom, route for route: the 152 direct registrations and the
agent routers' routes. When you add or change a route there, change its row here in the same pull
request; `npm test` does not check this page, so a review is what catches a stale row.
