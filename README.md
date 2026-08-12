# opencode-background-shell

Claude Code-grade background shell execution for OpenCode, as a plugin. Adds a `background_bash` tool that runs shell commands detached with **no timeout**, notifies the model on completion, and routes the builtin `bash` tool to it.

## Install

Add the plugin to your project's `opencode.json` (or global config):

```jsonc
{
  "plugin": [
    ["file:///abs/path/to/opencode-background-shell/.opencode/plugins/background-bash.ts", {}]
  ]
}
```

Alternatively, symlink the file into `.opencode/plugins/` of the project (no options in that form).

## Behavior

- `background_bash(command, run_in_background?, workdir?, label?)` — background by default; returns immediately with a job id, log path, and pid. `run_in_background=false` waits up to `sync_wait_ms` for output inline, then auto-promotes to background.
- `background_status(job_id)`, `background_list(include_exited?)`, `background_read(job_id, offset?, limit?, tail?)`, `background_kill(job_id, signal?)` — group-scoped SIGTERM → 5s grace → SIGKILL.
- Completion notifications wake the model via `<task-notification>`; a stall watchdog (5s poll / 45s stagnant / prompt-tail regex, e.g. `(y/n)`, `Press any key`, `Password:`) notifies once and **never kills**.
- Jobs are owned by the session that created them; deleting a session kills its jobs. `dispose` kills all.
- The builtin `bash` tool is intercepted with a guidance error that steers the model to `background_bash`. Permission prompts are the SAME `bash` permission action — existing grants and config rules apply.

## Configuration

```jsonc
{
  "background_bash": {
    "enabled": true,
    "route_bash": true,            // false = restore builtin bash (kill-switch)
    "sync_wait_ms": 60000,         // sync-mode promotion ceiling (not a timeout)
    "watchdog_interval_ms": 5000,
    "stall_threshold_ms": 45000,
    "max_completed_jobs": 20,
    "output_dir": "~/.local/share/opencode/background-bash"
  }
}
```

`route_bash` hot-reloads mid-session. Background jobs have **no timeout** — there is intentionally no runtime cap.

## Development

```bash
bun install
bun test          # unit suite (test/)
bun x tsc --noEmit
```

### Agentic validation (no human in the loop)

```bash
bun run scripts/validate.ts            # S1-S10 headless, evidence to logs/validate/
bun run scripts/validate.ts --scenarios S3,S6   # subset
bun run scripts/validate.ts --keep     # keep scratch dir for inspection
```

Requires `bun`, the `opencode` CLI, and provider auth on the machine (copied into an isolated env; model defaults to `openai/gpt-4o-mini`, override with `VALIDATE_MODEL`). Each scenario runs in a fully isolated scratch project (XDG envs) via `opencode serve` + `opencode run --attach`, and writes evidence files (session output, plugin log, pgrep snapshots, job logs) plus `logs/validate/VALIDATION-REPORT.md`. S9 (compaction carry) is SKIP-with-reason in headless mode: no model in the local models.dev catalog carries `limits.context`, so core's auto-compaction never triggers.

## Non-goals (v1)

No PTY/stdin interactivity (the stall watchdog is the substitute); no persistence (registry is in-memory; jobs orphan on a hard crash); POSIX-only; no runtime cap.
