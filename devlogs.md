# Devlogs — opencode-background-shell

## 2026-08-10 — Research phase: Claude Code background shell execution

- Cloned leaked Claude Code source to `external_libs/claude-code` (codeaashu/claude-code, 2026-03-31 leak)
- Deep-dived background shell execution: `run_in_background` arg, timeout→background, stall watchdog, process-tree kill, `<task_notification>` queue
- Full research notes: `docs/claude-code/RESEARCH.md`
- Verified claude CLI 2.1.220 installed locally

Remaining: decide plugin architecture (custom tool vs bash tool wrapper); implement `run_in_background` + task registry + kill-on-exit + notify queue

## 2026-08-10 — Research phase: OpenCode codebase analysis (background shell feasibility)

- Analyzed `external_libs/opencode` (anomalyco/opencode dev): active bash tool is legacy `ShellTool` (sync); V2 core bash has locked TODOs reserving background support
- Big find: `BackgroundJob` service + `task` tool's `background: true` already implement the full pattern (start/wait/cancel + synthetic-message injection into parent session + session-end cleanup via `cancelBackgroundJobs`)
- Two paths documented in `docs/opencode/background_shell.md`: (A) modify codebase → `run_in_background` arg on bash, reusing BackgroundJob + inject pattern; (B) plugin → new tools (`background_bash`, status/read/kill), SDK prompt injection, system-prompt guidance. Plugin cannot add args to builtin bash (schema not extensible plugin-side)
- Recommendation: Path A if we want the exact design; Path B as shippable non-fork artifact

Remaining: decide fork (Path A) vs plugin (Path B); answer open questions in `docs/opencode/background_shell.md`

## 2026-08-11 — Spec phase: background_bash plugin design locked

- Deep-dived three existing implementations: kdco/opencode-background-agents (background *agents*: new tools, promptAsync notify), oh-my-opencode Monitor (background *shell*: detached Bun.spawn, batched injection, noReply toggle, permission reuse via `ctx.ask({permission:"bash", patterns:[command]})`), opencode-pty (PTY sessions + notifyOnExit)
- Verified plugin hook contracts in `external_libs/opencode`: `tool.execute.before` fires before execute/permission (tools.ts:106), custom tools can shadow-by-name (last-wins), plugin ToolContext has `ask`, `experimental.chat.system.transform`, `experimental.session.compacting`, `config` hot-reload exist
- Locked design: **new tool `background_bash` (no shadowing) + block builtin bash via guidance-error hook + kill-switch `route_bash`**; permission reuse via same `"bash"` action string (+ heuristic `external_directory`); no job timeouts (no max-runtime kill); stall watchdog (5s poll / 45s threshold / prompt-tail regex, one-shot, never kills); `<task-notification>` via promptAsync (noReply toggling); session.deleted + dispose cleanup; compaction carry; in-memory registry
- Written: `specs/background-bash.md` (full I/O contracts, lifecycle, notifications, watchdog, config, security, edge cases, testing, open questions, agent assumptions)

Remaining: implement plugin skeleton (registry + spawn + hooks); permission heuristic; watchdog; tests
