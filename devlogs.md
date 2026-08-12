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

## 2026-08-11 — Implementation: plugin built + unit tests green

- Scaffolded repo: package.json (bun), tsconfig with `@opencode-ai/plugin` path-mapped to vendored source, `bunfig.toml` (test root = ./test), types/vendor.d.ts SDK shim (avoids compiling vendored SDK's dep chain: effect, cross-spawn)
- Installed bun 1.3.14 to ~/.bun/bin (was missing)
- Built `.opencode/plugins/background-bash.ts` (single-file v1 plugin, kdco-style `Plugin = async (input, options) => ({tool, ...hooks})`):
  - JobManager: registry, detached spawn (`Bun.spawn sh -c`, `detached: true` ⇒ setsid semantics per bun-types:6707), stdin pipe never written, stdout+stderr merged to one FileSink log file, exit/exitCode, eviction, killAll/killOwner, group-kill `kill(-pgid)` SIGTERM→5s→SIGKILL
  - 5 tools: background_bash (permission ask, sync wait + promotion, envelopes), status, list, read (offset/tail), kill; owner-binding + root-ancestry walk via client.session.get
  - Hooks: tool.execute.before (bash block + route_bash), config (hot reload), event (session.deleted cleanup), dispose, chat.message (buffered notify fallback), system.transform guidance, session.compacting carry
  - Exported test internals + extracted pure helpers (askBashPermission, askExternalDirectoryPermission, waitSyncOrPromote, resolveExternalDirectories...)
- API facts confirmed against vendored v1.18.16 source: `ctx.ask` returns Promise<void> and **deny = thrown rejection** (the one sanctioned try/catch, per spec §8); `client.session.promptAsync({path:{id}, body:{noReply,parts}})` exists (SDK gen sdk.gen.ts:4095); plugin loader accepts v1 function-style default export (getServerPlugin/readV1Plugin)
- **Deviation found by tests**: `sh -c "unknown-command"` → exits 127 (shell semantics), NOT `failed` state — `failed` reserved for exec-level spawn errors. Spec §17 "command not found → failed" updated to reality (matches Claude Code behavior). `> /dev/null` redirection targets excluded from external-directory heuristic
- 31 unit tests green: state machine, spawn/exit/127, kill+cancelled, eviction, killOwner scoping, watchdog stall once+dedupe+survives, no-stall active output, permission payloads+deny, external-dir globs, envelopes, compaction context, read offset/tail, config, log-marker contract
- `bun x tsc --noEmit` clean

Remaining: agentic validation harness scripts/validate.ts (spec §18, S3-S10); README

## 2026-08-12 — Live smoke S1+S2 PASS; key harness learnings

- S1 PASS: forced builtin-bash attempt → `event=block tool=bash blocked=true` in plugin log + full guidance error in session output; model rerouted to background_bash automatically
- S2 PASS (with serve): background job `sleep 3 && echo VALTAG_1 done` survived model-turn end, exit 0, `event=notify ... sent=true` woke the session, model read log and reported "VALTAG_1 done"
- **Harness-critical learnings**:
  - Plugin file must have ONLY a default export — legacy loader's `getLegacyPlugins` iterates ALL module exports and throws "Plugin export is not a function" on any named export (fixed: internals via `testInternals` on default)
  - `opencode run` headless exits when the model's turn ends → server shuts down → `dispose` fires → running jobs get killed. Long-running scenarios (S2/S3/S6) must use `opencode serve` + `opencode run --attach http://127.0.0.1:PORT` so the server (and jobs) persist
  - Sandbox CLI attaches to an existing server via the data-dir socket unless XDG_DATA_HOME is isolated — MUST isolate XDG_CONFIG_HOME + XDG_CACHE_HOME + XDG_DATA_HOME (was posting into the user's live server!)
  - `auth.json` lives at ~/.local/share/opencode/auth.json on this machine (no deepseek cred — model must be pinned to an env-key provider, e.g. openai/gpt-4o-mini with OPENAI_API_KEY)
  - macOS has no `timeout` command — harness must poll instead
  - S1's block proof needs an adversarial prompt ("Do NOT use background_bash, use ONLY the builtin bash tool") — guidance alone makes the model use background_bash willingly

Remaining: agentic validation harness scripts/validate.ts (spec §18, S3-S10); README

## 2026-08-12 — Agentic validation harness: S1-S10 ALL PASS

- Built `scripts/validate.ts` (spec §18): bootstrap (XDG isolation incl. XDG_DATA_HOME, auth copy, config-tuple plugin declaration — symlink approach dropped because options are needed; the tuple form provides them), per-scenario serve+attach (`opencode serve` + `opencode run --attach`) so background jobs outlive the model's turn, evidence into logs/validate/S<N>/, VALIDATION-REPORT.md, `--scenarios` filter, `--keep`
- Final run: **10/10 scenarios PASS** (S9 = SKIP-with-reason: compaction untriggerable headlessly — all models in local models.dev catalog have empty `limits` so core's compactIfNeeded short-circuits; verified ~/.cache/opencode/models.json + core/src/session/compaction.ts; covered by unit tests + manual TUI check)
- **Plugin bugs found by harness and fixed**:
  - Kill race: SIGTERM-killed job's exit handler fired terminal notification before kill() marked it cancelled (§6.5 violation) → kill() now sets state=cancelled BEFORE signaling; exit handler skips notify when cancelled
  - `event=spawn` line now includes `owner=<sessionID>` (S8 session-delete targeting)
- **Harness robustness learnings** (harness bugs, not plugin bugs): plugin log must be reset per scenario (append-only file accumulated prior scenarios); evidence copy must wait for `event=notify kind=terminal` (FileSink flush race gave empty job logs); `pgrep -f` prints PIDs only → `-fl`; session ids are not time-ordered → S8 deletes the job owner session parsed from plugin log; S3 pgrep snapshot must anchor to `event=promote` not run-end (model sometimes polls background_read against guidance, keeping the run attached until job death); S6 dedupe assertion counts per-job (model legitimately kills + re-runs, producing 2 stalled jobs)
- S5/S6 "text in session output" claims downgraded to INFO (model paraphrases tool results; plugin log is authoritative)

Remaining: none for v1 (spec S9 manual TUI compaction check pending)

## 2026-08-11 — Spec phase: background-agents (delegation) design locked

- Fetched + analyzed kdco/opencode-background-agents full source (1983 lines): DelegationManager lifecycle (registered→running→terminal: complete/error/timeout/cancelled), isolated session via `session.create(parentID)` + `session.prompt` with anti-recursion `tools:{task:false,delegate:false,...}`, readable ids (unique-names-generator), artifact persistence to `~/.local/share/opencode/delegations/<projectId>/<id>.md` (git-root HEAD hash scoping), persist-before-notify + terminal-state protection, terminal notify (noReply=true) + all-complete batch wake (noReply=false, quiet period + cycle tokens), small_model metadata gen w/ truncation fallback, `delegation_read` blocking reads, read-only sub-agent enforcement both directions (block task for read-only; delegate only read-only), compaction carry, chat.message buffered fallback
- Wrote `specs/background-agents.md` (companion to background-bash.md): our conventions (file sink `[bg-agent]`, config hot-reload, testInternals, agentic harness §17) + kdco lifecycle/security lifted; deviations: (1) `delegation_cancel` tool added (kdco has none), (2) simplified generation-counter all-complete (no cycle tokens), (3) local vendored wordlist ids (no unique-names-generator dep), (4) parent-session-delete does NOT kill delegations (persistence wins)
- Open questions recorded §18 (naming, cancel tool, unify-with-shell, detached vs parentID sessions)

Remaining: decide open questions; implement `.opencode/plugins/background-agents.ts`; unit tests + D1-D10 harness scenarios

## 2026-08-12 — Fix: notifications no longer reset session agent/model (0.1.2)

- **Bug**: while a session ran a non-default agent (e.g. `auto-accept`) and a model variant (e.g. `max`), a completed background job's notification silently switched the session to the default `build` agent + `default` variant
- **Root cause** (open-code traced, not doc-trusted): plugin's `deliverNotification` called `promptAsync` with only `{ noReply, parts }`. Server-side `createUserMessage` (`packages/opencode/src/session/prompt.ts:635`): absent `input.agent` → `agents.defaultInfo()` = `build` (:637); absent `variant` → `undefined` (:654); since stored session values differ, `sessions.setAgentModel` **persists** build/default onto the session row (:672-689). Loop then runs under `lastUser.agent`/`lastUser.model` (:1170/:1141). `createUserMessage` runs before the `noReply` short-circuit (:1069) so terminal/stall/promotion notifications ALL corrupted the session
- **Why validation missed it**: harness S1-S10 all run fresh default-agent sessions where build/default is a no-op
- **Fix**: `deliverNotification` now reads the owner session via `client.session.get` and passes `agent`, `model {providerID,modelID}`, `variant` (unless `"default"`) through in the `promptAsync` body → `setAgentModel` guard becomes a no-op; session agent/model preserved. Degrades gracefully (fields omitted) if `session.get` fails. Extracted pure helper `sessionContextForPrompt` (exported via testInternals) + 3 unit tests; spec §10.4 + §17 updated
- **tsc fix (pre-existing env issue)**: `.opencode/node_modules` (gitignored) shadows zod v4.1.8 while vendored plugin source expects v3 → added tsconfig `paths` pin `"zod": ["./node_modules/zod"]`
- 34 unit tests green, `bun x tsc --noEmit` clean

Remaining: none for v1; fix is live only after tag/release consumed by `github:RohanAwhad/opencode-background-shell`

## 2026-08-12 — Fix: job stdin default /dev/null; `job_stdin` config knob (0.1.3)

- **Bug**: jobs spawned with `stdin: "pipe"` (Bun = socketpair) — child processes that inherit socket stdin can hang waiting for input. Observed live: `opencode run` inside a background job hung at init forever; adding `</dev/null` fixed it. Socket stdin also defeats EOF-based fail-fast for `read`-style commands.
- **Fix**: new `job_stdin` config key — default `"devnull"` (spawn `stdin: "ignore"` → /dev/null), opt-in `"pipe"` restores the legacy open-but-silent socket. Spawn log line now carries `stdin=<mode>` (evidence contract).
- Harness: S6 (stall watchdog) fixture now sets `job_stdin: "pipe"` (its `read line` block-on-stdin test requires the socket); new **S11** regression scenario — default mode job runs `[ -S /dev/fd/0 ]` socket probe (macOS `readlink` unreliable) + a nested `opencode run 'echo nested-opencode-ok'` and must complete (proves no socket-stdin hang). S11 waits for job exit before collecting evidence.
- Unit tests: resolveConfig default/override for `job_stdin`; `/dev/fd/0` socket probe shows NOT_SOCKET (devnull) vs IS_SOCKET (pipe). 37 tests green.
- Docs: spec §9.3 (stdin rationale rewritten + dated socket-stdin hazard), §11 (stdin note), §15 (config row), §18.4 (S6 fixture + S11), §20-4 (no-stdin wording); README config sample + behavior line.
- Deployment: github-spec installs need cache refresh after push (`rm -rf ~/.cache/opencode/packages/github:RohanAwhad`).

Remaining: refresh global install cache post-push; (optional) S6/S11 agentic run on this machine
