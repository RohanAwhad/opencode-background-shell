# Research — Claude Code background shell execution

Research notes from reading the leaked Claude Code source (`external_libs/claude-code`). This is reference material for building our own background shell execution plugin — not project history (that lives in `devlogs.md`).

## 2026-08-10 — Deep dive: Claude Code background shell execution (leaked source)

Source: `external_libs/claude-code` (codeaashu/claude-code leak, package version `0.0.0-leaked`, tagged 2026-03-31). Local claude CLI installed: 2.1.220. Key files:

- `src/tools/BashTool/BashTool.tsx` — tool definition + `runShellCommand` generator
- `src/utils/Shell.ts` — `exec()` process spawning
- `src/utils/ShellCommand.ts` — `ShellCommandImpl` (timeout/background/kill)
- `src/tasks/LocalShellTask/LocalShellTask.tsx` — task registry + notifications + stall watchdog
- `src/tasks/LocalShellTask/killShellTasks.ts` — kill logic
- `src/utils/task/TaskOutput.ts` — output file + shared tail poller
- `src/utils/task/diskOutput.ts` — output file lifecycle/eviction
- `src/utils/messageQueueManager.ts` — notification queue
- `src/cli/print.ts` — queue drain: notification → model turn

### What it is trying to do
Restore synchronous-agent ergonomics to long-running commands: the agent never blocks on a slow process, never loses state, and gets woken with a machine-readable completion notification. Entire design is **file-based, zero-JS hot path**: output flows child→file fd directly, progress is read by polling the file tail, and completion is delivered as a queued synthetic user turn.

### 1. Model-facing contract
- `Bash` input has `run_in_background: boolean` ("Use Read to read the output later") + `timeout` (max from `getMaxBashTimeoutMs`).
- Prompt note (`getBackgroundUsageNote`): "Only use this if you don't need the result immediately... you'll be notified when it finishes. You do not need to use `&` at the end of the command."
- Output carries `backgroundTaskId`, `backgroundedByUser`, `assistantAutoBackgrounded`, `persistedOutputPath`; model reads output later via FileRead on `<output-file>`.
- Model is explicitly told interactive input is NOT supported (git `-i` etc. banned).
- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` env removes `run_in_background` from schema entirely.

### 2. Execution (exec())
- Fresh shell process per command: `spawn(binShell, args, {detached: true, stdio: ['pipe', fd, fd]})` — both stdout+stderr → the SAME file fd (O_APPEND, O_NOFOLLOW; interleaved chronologically). No JS in the data path.
- stdin = `'pipe'`, never written to → processes that prompt block (handled by watchdog, below).
- `TaskOutput` owns the file at `.claude/…/{session}/tasks/{taskId}.output`; shared 1s poller tails 4KB per tick → `onProgress` → progress events/yields.
- Default timeout 30 min. On timeout: if `shouldAutoBackground` → background the process; else SIGTERM via `treeKill`.
- cwd tracking: provider wraps command with `pwd -P >| tmpfile`; read after exit; backgrounded results skip cwd update.

### 3. Four ways a command becomes background
1. **Explicit**: `run_in_background: true` → immediate `spawnShellTask()`, return `{backgroundTaskId}`.
2. **On timeout**: `onTimeout` callback backgrounds instead of killing.
3. **Assistant auto-background** (KAIROS feature): main agent + command still running after `ASSISTANT_BLOCKING_BUDGET_MS = 15_000` → auto-background so the agent stays responsive; message tells model it was auto-backgrounded.
4. **User Ctrl+B**: `backgroundAll()` backgrounds every registered foreground bash task (+ agent tasks). Foreground tasks register after 2 s (progress threshold) precisely so they can be Ctrl+B'd; `BackgroundHint` UI shown.
- `sleep` is excluded from auto-background; standalone `sleep ≥2s` is blocked by validation (use `Monitor` tool or `run_in_background`).

### 4. Dealing with "input fields" (stdin)
- No stdin support by design. No PTY, no `child.stdin.write`.
- Instead: **stall watchdog** (`startStallWatchdog`): every 5 s, if output stopped growing for 45 s AND tail matches prompt patterns (`(y/n)`, `Press any key`, `Continue?`, `Overwrite?`, "Do you…?") → one-shot notification: "appears to be waiting for interactive input… Kill this task and re-run with piped input (e.g. `echo y | command`) or a non-interactive flag."
- `peekForStdinData` (utils/process.ts) is the input-side analog for `-p` mode (distinguish real pipe vs idle inherited stdin).
- So: detect-the-block + tell-the-model → model kills and re-runs non-interactively.

### 5. Cleanup
- **Kill**: `treeKill(pid, 'SIGKILL')` (whole process tree; `detached: true` in provider). Timeout-kill path uses SIGTERM then exit-code mapping.
- `killTask()`: kill + cleanup, task status → `killed`, `notified: true` (suppresses dup notification), `evictTaskOutput`.
- **Per-agent**: `killShellTasksForAgent` — when a subagent exits, all its running bash tasks are killed and its queued notifications purged (prevents "10-day fake-logs.sh zombies").
- **Process exit**: `registerCleanup` at spawn registers a kill-all hook → no orphans after Claude quits.
- **Output files**: `evictTaskOutput` (flush + drop in-memory map entry; file stays on disk); `deleteOutputFile` when output fit inline (`outputFileRedundant`); small outputs deleted, large ones linked/copied to tool-results dir. Files live per-session dir → survive `/clear`, compaction, restarts.
- **Disk-fill protection**: on backgrounding, a 5 s size watchdog polls the file; > 5 GB (`MAX_TASK_OUTPUT_BYTES`) → SIGKILL (learned from a "768GB incident"). Pipe mode caps at same limit.
- `cleanup()`: removes stream listeners, aborts polling, nulls refs for GC.

### 6. Notify-on-exit mechanism
- `enqueueShellNotification`: builds `<task_notification><task-id>…<output-file>…<status>…<summary>…</task_notification>` (plus `<tool-use-id>` when spawned by a subagent); summary: `Background command "…" completed (exit code N)` / `failed` / `was stopped`.
- Dedup: atomic `task.notified` flag check before enqueue.
- Enqueued as `QueuedCommand {mode: 'task-notification', priority: 'later'}` into a **module-level command queue** (`messageQueueManager`; priorities now > next > later; user input never starved).
- Drain (print.ts): `task-notification` → emit SDK `task_notification` system event (only when `<status>` present) → **fall through to `ask()`**: the XML is fed to the model as the next user turn. That's the wake-up — no polling by the agent.
- Race handling: if backgrounding fired but the command completed first, `markTaskNotified` + strip `backgroundTaskId` so the model sees a clean result and no redundant notification.

### 7. Key design takeaways (for our plugin)
- Output must go **directly to a file fd**, not through JS — everything else (progress, notification, reads) derives from that file.
- Notify = queue an XML-tagged message that becomes the next model turn; use the `chat.message`/queue hook to inject.
- Tasks are **registry entries with kill + cleanup + notified flags**; ownership (agentId) enables scoped kill.
- Background ≠ fire-and-forget: register a cleanup hook at spawn; kill on agent exit and process exit.
- Blocked-on-stdin detection (output stall + prompt-looking tail) is the substitute for interactive input.
- Env kill-switch (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`) + model-facing guidance to prefer background over `&`.

### 8. Stall watchdog mechanics (deep detail)

Heuristic substitute for stdin interactivity — the model cannot type into a background process, so a process blocked on a prompt would sit silently forever. The watchdog detects "stuck on a prompt" and fires a one-shot notification.

Per background task (`startStallWatchdog`, LocalShellTask.tsx):

1. Every `STALL_CHECK_INTERVAL_MS = 5s`, `stat` the output file size
2. Track `lastGrowth` (timestamp of last size increase)
3. Size grew → reset, keep watching
4. Size unchanged for `STALL_THRESHOLD_MS = 45s` → read last `STALL_TAIL_BYTES = 1KB` of output file
5. Regex-check last line vs prompt patterns: `(y/n)`, `[y/n]`, `(yes/no)`, `Press any key`, `Continue?`, `Overwrite?`, `Do you/Would you/Shall I/Are you sure/Ready to… ?`
6. Match → latch once (`cancelled=true`, clear interval), enqueue `<task-notification>` with **no `<status>` tag** (statusless = not terminal; SDK emitter skips it as a progress ping, print.ts still feeds it to the model): *"appears to be waiting for interactive input… Kill this task and re-run with piped input (e.g. `echo y | command`) or a non-interactive flag."* + last output tail
7. No match → just slow (`git log -S`, long builds) → reset `lastGrowth`, keep watching silently

Cancel function returned; called when command completes. Skipped entirely for `monitor` kind tasks. Output-side analog of `peekForStdinData` (input-side: distinguishes real pipe from idle inherited stdin in `-p` mode).

### 9. OS-level process-tree kill options (for our cleanup)

- **POSIX process groups (recommended)**: spawn with `detached: true` (Node ≈ `setsid`) → child becomes group leader (pgid == pid). Kill whole tree with ONE syscall: `process.kill(-pid, signal)` — all descendants inherit the group; no scan race. Claude Code uses `detached: true` + tree-kill (userspace `/proc` walk with recursion; race: descendants forked between scan and kill escape).
- **macOS**: process groups work identically (`kill(-pgid)`); `pkill -P` kills only direct children (needs recursion). No cgroups.
- **Linux cgroups**: airtight — kill cgroup kills every member; nothing escapes (even `setsid`). Docker/systemd mechanism. Overkill for a plugin.
- **Windows**: `taskkill /T /F` (what tree-kill does under the hood).
- Escape hatch: a descendant that calls `setsid()` itself leaves the group — cgroups are the only airtight answer; acceptable residual risk for a dev tool.

### 10. Implications for our plugin design

- `run_in_background` arg on our bash tool; on timeout → auto-background (Claude Code also has the 15s assistant budget + Ctrl+B, those are optional polish)
- Output must go directly to a file fd; everything else derives from the file (progress = tail poll, result = read, notification = XML + output path)
- No stdin support; stall watchdog = stall detection + prompt-regex tail sniff + one-shot statusless notification
- Global task registry with `detached: true` spawns; on process exit kill all via `kill(-pgid)`; per-agent ownership enables scoped kills
- Notify = queue XML `<task-notification>`-style message that becomes the model's next turn; dedupe via notified flag
- Kill-switch env + model prompt guidance to prefer `run_in_background` over `&`
