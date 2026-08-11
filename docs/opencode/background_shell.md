# Background shell execution for OpenCode — feasibility & plan

Analysis of `external_libs/opencode` (anomalyco/opencode, `dev` branch) to determine how to add Claude Code-style background shell execution: (1) modify the codebase, or (2) build a plugin. Companion to `docs/claude-code/RESEARCH.md` (Claude Code reference behavior).

## Current state of the bash tool

- **Active tool in the CLI**: legacy `ShellTool` — `packages/opencode/src/tool/shell.ts` (tree-sitter permission scanning, `ChildProcessSpawner`). Strictly synchronous: spawn → race(exit/abort/timeout) → kill → return. No `background` param, no job registry.
- **V2 core rewrite**: `packages/core/src/tool/bash.ts` — also synchronous. Contains **locked TODOs** (asserted by `packages/core/test/tool-bash.test.ts`) that the maintainers already scoped:
  - `Re-add model-facing background launch only with owner-bound get/wait/cancel tools and completion delivery`
  - `Persist background job status and define restart recovery before exposing remote observation`
  - `Add HTTP background-job observation only after durable status, restart recovery, and authorization are defined`
  - Test asserts input schema has **no** `background` property.
- `OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS` — timeout knob only.

## What already exists (the big finds)

The background-job plumbing is 80% present — it's just wired to the `task` tool, not `bash`:

1. **`BackgroundJob` service** — `packages/core/src/background-job.ts` (365 lines) + instance-scoped wrapper `packages/opencode/src/background/job.ts`. API: `start({id?, type, title?, metadata?, onPromote?, run})`, `extend`, `wait({id, timeout})`, `cancel`, `list`, `get`, `promote`, `waitForPromotion`. Status machine: `running | completed | error | cancelled`. Run is an `Effect`; `cancel` triggers the run's `onInterrupt` cleanup.
2. **Background mode on `task` tool** — `packages/opencode/src/tool/task.ts`: `background: true` param (gated on `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`), returns `<task state="running">` immediately, then `notifyBackgroundResult` does `background.wait({id})` → on terminal state **injects a synthetic user message into the parent session** (`ops.prompt({sessionID: parent, parts: [{type: "text", synthetic: true, text: "<task ...>"}]})`) → model wakes and processes it. Exactly Claude Code's queued-notification → next-turn pattern.
3. **Session-end cleanup** — `packages/opencode/src/session/run-state.ts:111` `cancelBackgroundJobs`: walks job tree via `metadata.sessionId`/`metadata.parentSessionId`, cancels all running descendants. A bash job registered the same way dies with its session.
4. **SDK**: `session.prompt` / `session.promptAsync` (with `noReply`) — `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:316,329`; `synthetic: true` parts supported in prompt payload (`packages/opencode/src/session/prompt.ts:711`).
5. **Plugin hooks** — `packages/plugin/src/index.ts`: `tool` (custom tool defs), `event`, `chat.message` (mutate `output.parts` on inbound messages), `tool.execute.before/after`, `experimental.chat.system.transform` (append system guidance), `experimental.session.compacting`.
6. **Tool override semantics**: `registry.all()` = `[...builtin, ...custom]` → `session/tools.ts:99` `tools[id] = tool(...)` — **last assignment wins**, so a plugin tool named `bash` replaces the builtin. But plugin tools don't inherit bash's permission machinery (tree-sitter scans, external-directory checks) — they'd need to reimplement it.

## Path A — modify the codebase (enables the exact design: `run_in_background` arg on bash)

Matches the user's design and the maintainers' own locked TODO. Patch plan (minimal surface):

1. `packages/opencode/src/tool/shell.ts` — add `background: Schema.optional(Schema.Boolean)` to `Parameters` (`packages/opencode/src/tool/shell/prompt.ts` `parameterSchema`), plus a prompt note (copy Claude Code's `getBackgroundUsageNote` wording).
2. On `background: true` (or timeout fallback): register a `BackgroundJob` whose `run` effect spawns the command via `ChildProcess.make(command, [], {shell, cwd, env, stdin: "ignore", detached: true, forceKillAfter})`, waits for exit, reads the output file, returns it as job output. The job's `metadata` = `{sessionId: ctx.sessionID}` so `cancelBackgroundJobs` picks it up.
3. Notify: copy `TaskTool.injectBackgroundResult` — `background.wait({id})` fork → `ops.prompt({sessionID: parent, agent, parts: [{type:"text", synthetic:true, text:"<task_notification>…"}]})`. Tool result immediately returns `<task id state="running">` with output-file path.
4. Output file: mirror Claude Code — child stdout/stderr → same file fd (both fds to one file), path under project tmp + session id (`packages/opencode/src/utils/...` or reuse `TaskOutput`-like storage; simplest: write path into job metadata and let Read read it).
5. Cleanup: `kill(-pid)` process group on `cancel` (spawn detached ⇒ pgid == pid); `cancelBackgroundJobs` already invoked on session cancel (`run-state.ts:78`).
6. Timeout → auto-background: in `run`'s timeout branch, background the job instead of killing (Claude Code behavior); gate assistant-mode auto-background (15s budget) on a feature flag like the existing KAIROS pattern.
7. Stall watchdog (optional phase 2): poll output-file size every 5s; if stagnant 45s + tail matches prompt regexes → inject a statusless synthetic notification advising `echo y | …` re-run.
8. Remove/update the two locked TODOs + the test asserting no `background` property (`packages/core/test/tool-bash.test.ts`) — do the V2 core (`packages/core/src/tool/bash.ts`) instead of/in addition to legacy shell.

**Cost**: touches core tool + prompt + tests; needs `bun typecheck` in package dirs; fork of opencode required. **Benefit**: the design the user wants (`run_in_background` on bash), native permission handling, session-tree integration, matches upstream intent (their TODO says exactly this).

## Path B — plugin (no fork)

Constraints that shape this path:

- **Plugins cannot add args to the builtin bash tool.** `tool.execute.before` can mutate `output.args` but not the schema. So "new arg on bash" is impossible plugin-side; the plugin must either (a) register a **new tool** (e.g. `background_bash` / `bash_bg`), or (b) shadow `bash` entirely (loses builtin permissions; must reimplement tree-sitter scanning, external-directory approval, bash permission rules — significant).
- (a) is the sane plugin design:
  1. Plugin state: module-level `Map<id, Job>` (id like `bg_xxx`); Bun spawn (plugin ctx gives `$` shell; `Bun.spawn` with `{detached: true}` + write output to file under `~/.local/share/opencode/`).
  2. Tools: `background_bash(command, workdir?, timeout?)` → returns id + output path; `background_status(id)` / `background_read(id)` / `background_kill(id)` (owner-bound get/wait/cancel — matches the TODO's "owner-bound get/wait/cancel tools").
  3. Notify on exit: `client.session.prompt({path: {id: sessionID}, body: {parts: [{type: "text", text: "<task_notification>…"}]}})` (or `promptAsync` + `noReply` for fire-and-forget; kdco uses promptAsync). Synthetic parts keep it out of user-visible UI.
  4. Guidance: `experimental.chat.system.transform` → push rules: "prefer background_bash for long-running commands; you will be notified; DO NOT poll"; teach `<task_notification>` format. Compaction: `experimental.session.compacting` → carry running jobs context.
  5. Cleanup: `event` hook on session end → kill all this session's pids (`kill(-pgid)`); plus `dispose` hook.
  6. Stall watchdog: same polling logic in plugin (stat + tail + regex) → inject notification.
  7. Permissions: plugin tools map to their own permission action (`background_bash`); use `ctx.ask` for command approval parity.
- **Cost**: self-contained, no fork; ~1 file + prompts; installable via `plugin: ["…"]`. **Benefit**: works on stock opencode, including future releases. **Limitation**: different tool name than the user's design; no bash-permission reuse; no upstream durability story.

## Recommendation

- If we want the user's design verbatim (`run_in_background` **on the bash tool**, timeout → background, session-integrated) → **Path A** (modify codebase). Upstream's locked TODO means a PR-ready patch is actually desired; effort is moderate and mostly copy-paste of existing `task.ts` patterns.
- If we must not fork (releases, distribution) → **Path B** with new tool ids (`background_bash` etc.) — the kdco plugin proves the SDK paths work on stock opencode.
- Hybrid fallback: Path B plugin as a shippable artifact now; Path A patch as an upstream PR later.

## Open questions

1. Fork-and-maintain (Path A) vs plugin-only (Path B)? Determines everything.
2. For Path A: legacy `ShellTool` (live tool today) or V2 core `bash.ts` (future, has the TODO)? Legacy is what runs in the CLI now; V2 is where upstream wants it.
3. Assistant-mode auto-background budget (15s Claude Code) — desired? Or only explicit `run_in_background` + timeout-background?
4. Stall watchdog — phase 1 or later?
5. Output file location: project tmp (session-scoped, like CC) vs global `~/.local/share/opencode/` (survives sessions, like kdco)?
