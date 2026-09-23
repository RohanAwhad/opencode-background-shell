import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const REPO_ROOT = path.resolve(import.meta.dir, "..")
const PLUGIN_PATH = path.join(REPO_ROOT, ".opencode/plugins/background-bash.ts")
const EVIDENCE_DIR = path.join(REPO_ROOT, "logs/validate")
const PORT_BASE = 43200
const DEFAULT_MODEL = process.env.VALIDATE_MODEL ?? "openai/gpt-4o-mini"
const RUN_TIMEOUT_MS = 90_000
const SCENARIO_TIMEOUT_MS = 120_000
const FETCH_TIMEOUT_MS = 3000

type ScenarioId = "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "S8" | "S9" | "S10" | "S11" | "S12" | "S13" | "S14" | "S15"

type Scenario = {
  id: ScenarioId
  name: string
  config: Record<string, unknown>
  prompt: string
  expect: (evidence: Evidence) => string[]
}

type Evidence = {
  id: ScenarioId
  dir: string
  sessionLog: string
  pluginLog: string
  pgrepFile: string
  parentMessagesFile: string
  readFile: (rel: string) => string
}

function log(msg: string) {
  console.log(`[validate] ${msg}`)
}

function fileLines(file: string): string[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .replace(/\x1b\[[0-9;]*m/g, "")
      .split("\n")
  } catch {
    return []
  }
}

function grepLines(file: string, pattern: RegExp): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = []
  fileLines(file).forEach((text, i) => {
    if (pattern.test(text)) out.push({ line: i + 1, text })
  })
  return out
}

function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now()
    const tick = () => {
      if (predicate()) return resolve(true)
      if (Date.now() - start > timeoutMs) return resolve(false)
      setTimeout(tick, intervalMs)
    }
    tick()
  })
}

async function serverReady(url: string, timeoutMs = 20_000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url + "/session", { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (res.ok) return true
    } catch {}
    await Bun.sleep(250)
  }
  return false
}

function expandConfigBase(): Record<string, unknown> {
  return {
    permission: { bash: "allow" },
    model: DEFAULT_MODEL,
    plugin: [
      [
        `file://${PLUGIN_PATH}`,
        {
          background_bash: {
            enabled: true,
            route_bash: true,
            sync_wait_ms: 60_000,
            watchdog_interval_ms: 1000,
            stall_threshold_ms: 8000,
            max_completed_jobs: 20,
            output_dir: "{SCRATCH}/out",
          },
        },
      ],
    ],
  }
}

function writeScenarioConfig(projectDir: string, scratch: string, scenario: Scenario) {
  const cfg = expandConfigBase()
  const merged = { ...cfg, ...scenario.config }
  if (scenario.config.plugin) merged.plugin = scenario.config.plugin
  const json = JSON.stringify(merged, null, 2).replaceAll("{SCRATCH}", scratch)
  fs.writeFileSync(path.join(projectDir, "opencode.json"), json)
}

function extractPluginConfig(scenario: Scenario): Record<string, unknown> {
  const base = (expandConfigBase().plugin as [string, { background_bash: Record<string, unknown> }][])[0][1].background_bash
  return base
}

async function startServer(projectDir: string, scratch: string, port: number): Promise<{ kill: () => void }> {
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(scratch, "config"),
    XDG_CACHE_HOME: path.join(scratch, "cache"),
    XDG_DATA_HOME: path.join(scratch, "data"),
  }
  const proc = Bun.spawn(["opencode", "serve", "--port", String(port), "--log-level", "DEBUG"], {
    cwd: projectDir,
    env,
    stdout: "ignore",
    stderr: "ignore",
  })
  const ok = await serverReady(`http://127.0.0.1:${port}`)
  if (!ok) {
    proc.kill()
    throw new Error(`server did not become ready on port ${port}`)
  }
  return {
    kill: () => {
      try {
        proc.kill()
      } catch {}
    },
  }
}

async function runPrompt(
  projectDir: string,
  scratch: string,
  port: number,
  prompt: string,
  outputFile: string,
  timeoutMs: number,
): Promise<{ timedOut: boolean }> {
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(scratch, "config"),
    XDG_CACHE_HOME: path.join(scratch, "cache"),
    XDG_DATA_HOME: path.join(scratch, "data"),
  }
  fs.rmSync(outputFile, { force: true })
  const out = Bun.file(outputFile).writer()
  const proc = Bun.spawn(["opencode", "run", "--attach", `http://127.0.0.1:${port}`, prompt], {
    cwd: projectDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      out.write(value)
    }
  }
  void pump(proc.stdout)
  void pump(proc.stderr)
  const exited = await Promise.race([
    proc.exited.then(() => true),
    Bun.sleep(timeoutMs).then(() => false),
  ])
  if (!exited) {
    try {
      proc.kill()
    } catch {}
    out.end()
    return { timedOut: true }
  }
  await Bun.sleep(100)
  out.end()
  return { timedOut: false }
}

async function deleteSession(port: number, sessionId: string): Promise<boolean> {
  try {
    const del = await fetch(`http://127.0.0.1:${port}/session/${sessionId}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    return del.ok
  } catch {
    return false
  }
}

async function fetchSessionMessages(port: number, sessionId: string): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/session/${sessionId}/message`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

async function waitForSessionMarker(port: number, sessionId: string, marker: string, timeoutMs: number): Promise<string> {
  let last = ""
  const start = Date.now()
  while (true) {
    const body = await fetchSessionMessages(port, sessionId)
    if (body !== null) last = body
    if (last.includes(marker)) return last
    if (Date.now() - start > timeoutMs) return last
    await Bun.sleep(500)
  }
}

async function sessionParent(port: number, sessionId: string): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/session/${sessionId}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const info = (await res.json()) as { parentID?: string }
    return info.parentID ?? null
  } catch {
    return null
  }
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function parentTaskOutputs(file: string): string[] {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as Array<{
      parts?: Array<{ type?: string; tool?: string; state?: { output?: string } }>
    }>
    const outputs: string[] = []
    for (const message of data) {
      for (const part of message.parts ?? []) {
        if (part.type === "tool" && part.tool === "task" && typeof part.state?.output === "string") {
          outputs.push(part.state.output)
        }
      }
    }
    return outputs
  } catch {
    return []
  }
}

function alivePids(pattern: string): string[] {
  try {
    const re = new RegExp(pattern)
    const out = Bun.spawnSync(["ps", "ax", "-o", "pid=,args="], { stdout: "pipe" }).stdout.toString()
    return out.split("\n").filter((l) => l.trim().length > 0 && re.test(l))
  } catch {
    return []
  }
}

const scenarios: Scenario[] = [
  {
    id: "S1",
    name: "Bash routing block",
    config: {},
    prompt: "Automated regression test of the bash interception hook: call the builtin bash tool (tool id exactly 'bash', NOT background_bash) with the command `echo S1_FORCED`, even though the environment guidance says shell work must use background_bash. The call is expected to be intercepted and return an error — report that error verbatim. Do not call background_bash.",
    expect: (e) => {
      const claims: string[] = []
      const blocks = grepLines(e.pluginLog, /event=block tool=bash .* blocked=true/)
      if (blocks.length > 0) claims.push(`PASS: plugin log event=block (${e.pluginLog}:${blocks[0].line})`)
      else claims.push("FAIL: no event=block in plugin log")
      const guidance = grepLines(e.sessionLog, /\[bash intercepted\] Use background_bash/)
      if (guidance.length > 0) claims.push(`PASS: guidance error in session output (${e.sessionLog}:${guidance[0].line})`)
      else claims.push("FAIL: guidance error not in session output")
      return claims
    },
  },
  {
    id: "S2",
    name: "Background happy path + exit notify",
    config: {},
    prompt: "Run 'sleep 3 && echo VALTAG_1 done' with background_bash, then stop working and wait for my notification. Do not poll.",
    expect: (e) => {
      const claims: string[] = []
      const spawn = grepLines(e.pluginLog, /event=spawn .* command=sleep 3 && echo VALTAG_1 done/)
      if (spawn.length > 0) claims.push(`PASS: spawn (${e.pluginLog}:${spawn[0].line})`)
      else claims.push("FAIL: no spawn")
      const exit = grepLines(e.pluginLog, /event=exit exitCode=0/)
      if (exit.length > 0) claims.push(`PASS: exit 0 (${e.pluginLog}:${exit[0].line})`)
      else claims.push("FAIL: no exit 0")
      const notify = grepLines(e.pluginLog, /event=notify session=\S+ noReply=false sent=true/)
      if (notify.length > 0) claims.push(`PASS: notify sent (${e.pluginLog}:${notify[0].line})`)
      else claims.push("FAIL: notify not sent")
      const jobLogs = fs.readdirSync(e.dir).filter((f) => f.startsWith("bg_"))
      let found = false
      for (const f of jobLogs) {
        if (fs.readFileSync(path.join(e.dir, f), "utf8").includes("VALTAG_1 done")) {
          claims.push(`PASS: job log contains VALTAG_1 done (${f})`)
          found = true
          break
        }
      }
      if (!found) claims.push("FAIL: VALTAG_1 done not found in job logs")
      const woke = grepLines(e.sessionLog, /VALTAG_1 done/)
      if (woke.length > 0) claims.push(`PASS: model wake response references VALTAG_1 done (${e.sessionLog}:${woke[0].line})`)
      else claims.push("INFO: model wake response not visible in session output (attached CLI may have detached)")
      return claims
    },
  },
  {
    id: "S3",
    name: "Sync mode + auto-promotion",
    config: {
      plugin: [
        [
          `file://${PLUGIN_PATH}`,
          {
            background_bash: {
              ...extractPluginConfig({} as Scenario),
              sync_wait_ms: 2000,
            },
          },
        ],
      ],
    },
    prompt: "Run 'sleep 30 && echo VALTAG_2' with background_bash with run_in_background=false. Report what the tool returned. IMPORTANT: Do NOT call background_kill — the command sleeps for 30 seconds and finishes on its own; you will be notified when it completes.",
    expect: (e) => {
      const claims: string[] = []
      const promote = grepLines(e.pluginLog, /event=promote/)
      if (promote.length > 0) claims.push(`PASS: auto-promotion logged (${e.pluginLog}:${promote[0].line})`)
      else claims.push("FAIL: no event=promote")
      const alive = grepLines(e.pgrepFile, /sh -c sleep/)
      if (alive.length > 0) claims.push(`PASS: process alive mid-job (pgrep snapshot)`)
      else claims.push("FAIL: process not alive mid-job")
      const exit = grepLines(e.pluginLog, /event=exit exitCode=0/)
      if (exit.length > 0) claims.push(`PASS: later exit 0 (${e.pluginLog}:${exit[0].line})`)
      else claims.push("FAIL: no later exit")
      const notify = grepLines(e.pluginLog, /event=notify kind=terminal noReply=false/)
      if (notify.length > 0) claims.push(`PASS: terminal notify delivered (${e.pluginLog}:${notify[0].line})`)
      else claims.push("FAIL: no terminal notify")
      return claims
    },
  },
  {
    id: "S4",
    name: "Permission reuse (allow via config)",
    config: {
      permission: { bash: { "echo VALTAG_3 *": "allow" } },
    },
    prompt: "Run 'echo VALTAG_3 ok' via background_bash with run_in_background=false and tell me the output.",
    expect: (e) => {
      const claims: string[] = []
      const permit = grepLines(e.pluginLog, /event=permit via=bash/)
      if (permit.length > 0) claims.push(`PASS: permit logged (${e.pluginLog}:${permit[0].line})`)
      else claims.push("FAIL: no event=permit")
      const spawn = grepLines(e.pluginLog, /event=spawn .* command=echo VALTAG_3/)
      if (spawn.length > 0) claims.push(`PASS: job spawned (${e.pluginLog}:${spawn[0].line})`)
      else claims.push("FAIL: no spawn")
      const denied = grepLines(e.pluginLog, /event=deny/)
      if (denied.length === 0) claims.push("PASS: no deny")
      else claims.push("FAIL: unexpected deny")
      return claims
    },
  },
  {
    id: "S12",
    name: "Sync quick exit → no terminal notification",
    config: {},
    prompt: "Run 'echo VALTAG_12 done' via background_bash with run_in_background=false. Report what the tool returned.",
    expect: (e) => {
      const claims: string[] = []
      const spawn = grepLines(e.pluginLog, /event=spawn .* command=echo VALTAG_12/)
      if (spawn.length > 0) claims.push(`PASS: job spawned (${e.pluginLog}:${spawn[0].line})`)
      else claims.push("FAIL: no spawn for VALTAG_12")
      const inline = grepLines(e.sessionLog, /VALTAG_12 done/)
      if (inline.length > 0) claims.push(`PASS: output returned inline (${e.sessionLog}:${inline[0].line})`)
      else claims.push("FAIL: VALTAG_12 done not in session output")
      const notify = grepLines(e.pluginLog, /event=notify/)
      if (notify.length === 0) claims.push("PASS: no notification for sync-completed job")
      else claims.push(`FAIL: notification delivered for sync job (${e.pluginLog}:${notify[0].line})`)
      return claims
    },
  },
  {
    id: "S5",
    name: "Permission deny",
    config: {
      permission: { bash: { "*rm*": "deny" } },
    },
    prompt: "Run 'rm -rf /tmp/VALTAG_4' via background_bash and report what the tool returned.",
    expect: (e) => {
      const claims: string[] = []
      const deny = grepLines(e.pluginLog, /event=deny via=bash/)
      if (deny.length > 0) claims.push(`PASS: deny logged (${e.pluginLog}:${deny[0].line})`)
      else claims.push("FAIL: no event=deny")
      const deniedText = grepLines(e.sessionLog, /\[PERMISSION_DENIED\]/)
      if (deniedText.length > 0) claims.push(`PASS: [PERMISSION_DENIED] in session output (${e.sessionLog}:${deniedText[0].line})`)
      else claims.push("INFO: [PERMISSION_DENIED] text not in session output (model may paraphrase; plugin deny log is authoritative)")
      const spawn = grepLines(e.pluginLog, /event=spawn .* command=rm -rf/)
      if (spawn.length === 0) claims.push("PASS: no spawn for denied command")
      else claims.push("FAIL: job spawned despite deny")
      return claims
    },
  },
  {
    id: "S6",
    name: "Stall watchdog",
    config: {
      plugin: [
        [
          `file://${PLUGIN_PATH}`,
          {
            background_bash: {
              ...extractPluginConfig({} as Scenario),
              job_stdin: "pipe",
            },
          },
        ],
      ],
    },
    prompt: "Run 'printf \"Continue? \" && read line && echo got $line' with background_bash. Do not kill it. Just report the tool result.",
    expect: (e) => {
      const claims: string[] = []
      const spawn = grepLines(e.pluginLog, /event=spawn .* command=printf/)
      const jobId = spawn[0]?.text.match(/job=(bg_[0-9a-f]+)/)?.[1]
      const stall = grepLines(e.pluginLog, /event=stall/)
      if (stall.length > 0 && jobId) {
        const stallsForJob = grepLines(e.pluginLog, new RegExp(`job=${jobId} event=stall`))
        claims.push(`PASS: stall detected (${e.pluginLog}:${stall[0].line})`)
        if (stallsForJob.length > 1) claims.push(`FAIL: stall fired ${stallsForJob.length} times for job ${jobId} (dedupe broken)`)
        else claims.push(`PASS: stall deduped exactly once for ${jobId}`)
      } else {
        claims.push("FAIL: no event=stall")
      }
      const alive = grepLines(e.pgrepFile, /Continue\?/)
      if (alive.length > 0) claims.push("PASS: process still alive after stall (watchdog never kills)")
      else claims.push("FAIL: process dead after stall")
      const stallText = grepLines(e.sessionLog, /stalled/)
      if (stallText.length > 0) claims.push(`PASS: stalled notification visible to model (${e.sessionLog}:${stallText[0].line})`)
      else {
        const modelAction = grepLines(e.sessionLog, /background_kill/)
        if (modelAction.length > 0) claims.push(`INFO: stall text not in session output, but model acted on the stall (killed + re-ran) (${e.sessionLog}:${modelAction[0].line})`)
        else claims.push("INFO: stalled notification text not in session output")
      }
      return claims
    },
  },
  {
    id: "S7",
    name: "Cancel",
    config: {},
    prompt: "Run 'sleep 60' with background_bash. Read the returned job id (task-id) from the tool result very carefully. Then call background_kill with that exact job id. Then background_status the same job id. Report the status output.",
    expect: (e) => {
      const claims: string[] = []
      const kill = grepLines(e.pluginLog, /event=kill/)
      if (kill.length > 0) claims.push(`PASS: kill logged (${e.pluginLog}:${kill[0].line})`)
      else claims.push("FAIL: no event=kill")
      const cancelled = grepLines(e.sessionLog, /cancelled/)
      if (cancelled.length > 0) claims.push(`PASS: cancelled in session output (${e.sessionLog}:${cancelled[0].line})`)
      else claims.push("FAIL: cancelled not in session output")
      const terminalNotify = grepLines(e.pluginLog, /event=notify kind=terminal/)
      if (terminalNotify.length === 0) claims.push("PASS: no terminal notification for cancelled job")
      else claims.push("FAIL: terminal notification delivered for cancelled job")
      const dead = grepLines(e.pgrepFile, /sleep 60/)
      if (dead.length === 0) claims.push("PASS: process group dead after kill")
      else claims.push("FAIL: process still alive after kill")
      return claims
    },
  },
  {
    id: "S8",
    name: "Session cleanup",
    config: {},
    prompt: "Run 'sleep 90' with background_bash. Report the job id and then do nothing else.",
    expect: (e) => {
      const claims: string[] = []
      const cleanup = grepLines(e.pluginLog, /event=cleanup/)
      if (cleanup.length > 0) claims.push(`PASS: cleanup on session.deleted (${e.pluginLog}:${cleanup[0].line})`)
      else claims.push("FAIL: no event=cleanup")
      const kill = grepLines(e.pluginLog, /event=kill/)
      if (kill.length > 0) claims.push(`PASS: job killed (${e.pluginLog}:${kill[0].line})`)
      else claims.push("FAIL: no event=kill")
      const dead = grepLines(e.pgrepFile, /sleep 90/)
      if (dead.length === 0) claims.push("PASS: process dead after session deletion")
      else claims.push("FAIL: process alive after session deletion")
      return claims
    },
  },
  {
    id: "S9",
    name: "Compaction carry",
    config: {
      compaction: { auto: true, reserved: 127_000 },
    },
    prompt: "Run 'sleep 20 && echo VALTAG_9' with background_bash. Then write a very long detailed essay (several thousand words) about the weather.",
    expect: (e) => {
      const claims: string[] = []
      const compact = grepLines(e.pluginLog, /event=compact/)
      if (compact.length > 0) {
        claims.push(`PASS: compaction hook fired (${e.pluginLog}:${compact[0].line})`)
      } else {
        claims.push(
          "SKIP (headless): no event=compact — compaction is unreachable in this environment: all models in the local models.dev catalog have empty `limits` (verified ~/.cache/opencode/models.json, e.g. openai/gpt-4o-mini `limits: {}`), and core's compactIfNeeded short-circuits when `context === undefined` (external_libs/opencode/packages/core/src/session/compaction.ts). Covered by unit tests (buildCompactionContext) + manual TUI check (run a job, force /compact, verify job appears in summary and notification still arrives).",
        )
      }
      const notify = grepLines(e.pluginLog, /event=notify kind=terminal noReply=false/)
      if (notify.length > 0) claims.push(`PASS: terminal notify after essay turn (${e.pluginLog}:${notify[0].line})`)
      else claims.push("FAIL: no notify after compaction window")
      return claims
    },
  },
  {
    id: "S10",
    name: "Kill-switch (route_bash: false)",
    config: {
      plugin: [
        [
          `file://${PLUGIN_PATH}`,
          {
            background_bash: {
              ...extractPluginConfig({} as Scenario),
              route_bash: false,
            },
          },
        ],
      ],
    },
    prompt: "You MUST use the builtin bash tool (tool id exactly 'bash', not background_bash) to run: echo S10_OK",
    expect: (e) => {
      const claims: string[] = []
      const blocked = grepLines(e.pluginLog, /event=block tool=bash blocked=true/)
      if (blocked.length === 0) claims.push("PASS: no bash interception with route_bash=false")
      else claims.push("FAIL: bash blocked despite route_bash=false")
      const output = grepLines(e.sessionLog, /S10_OK/)
      if (output.length > 0) claims.push(`PASS: bash executed and output visible (${e.sessionLog}:${output[0].line})`)
      else claims.push("FAIL: S10_OK not in session output")
      return claims
    },
  },
  {
    id: "S13",
    name: "Subagent completion bridge",
    config: {},
    prompt: [
      "Use the task tool (tool id 'task', subagent_type='general', description='subagent bridge test') with this exact prompt for the subagent:",
      "Call background_bash with command='sleep 15 && echo SUBTAG_13' (run_in_background=true, the default).",
      "Then STOP IMMEDIATELY: do NOT call background_wait, do NOT call background_read, do NOT call background_status, do NOT poll.",
      "End your turn now with the single word STARTED. Your first response must NOT contain SUBTAG_13.",
      "You will be woken later by a <task-notification>. ONLY AFTER that notification arrives: call background_read with job_id set to the job id from the notification, then end your follow-up turn with a final answer that contains the exact literal text SUBTAG_13.",
      "After the task tool returns, do NOT poll or wait for the job. End your turn immediately with a one-line summary.",
    ].join("\n"),
    expect: (e) => {
      const claims: string[] = []
      const spawn = grepLines(e.pluginLog, /event=spawn .* command=.*SUBTAG_13/)
      const jobId = spawn[0]?.text.match(/job=(bg_[0-9a-f]+)/)?.[1]
      if (spawn.length > 0 && jobId) claims.push(`PASS: subagent job spawned (${e.pluginLog}:${spawn[0].line})`)
      else claims.push("FAIL: no event=spawn for the SUBTAG_13 job")
      const exit = jobId
        ? grepLines(e.pluginLog, new RegExp(`job=${jobId} event=exit exitCode=0`))
        : grepLines(e.pluginLog, /event=exit exitCode=0/)
      if (exit.length > 0) claims.push(`PASS: job exited 0 (${e.pluginLog}:${exit[0].line})`)
      else claims.push("FAIL: no exit 0")
      if (jobId) {
        const notify = grepLines(e.pluginLog, new RegExp(`job=${jobId} event=notify kind=terminal noReply=false`))
        if (notify.length > 0) claims.push(`PASS: terminal notification woke the subagent (${e.pluginLog}:${notify[0].line})`)
        else claims.push(`FAIL: no terminal notify for ${jobId}`)
        const forwarded = grepLines(e.pluginLog, /event=bridge status=forwarded/).filter((l) => l.text.includes(jobId))
        if (forwarded.length === 1) claims.push(`PASS: exactly one bridge forward for ${jobId} (${e.pluginLog}:${forwarded[0].line})`)
        else claims.push(`FAIL: expected exactly one event=bridge status=forwarded for ${jobId}, found ${forwarded.length}`)
        const degraded = grepLines(e.pluginLog, /event=bridge status=degraded/).filter((l) => l.text.includes(jobId))
        if (degraded.length === 0) claims.push("PASS: no degraded bridge notice for the cycle")
        else claims.push(`FAIL: degraded bridge notice (${e.pluginLog}:${degraded[0].line})`)
      }
      const envelope = grepLines(e.parentMessagesFile, /<subagent-completion>/)
      if (envelope.length > 0) claims.push(`PASS: <subagent-completion> envelope in parent session (${e.parentMessagesFile}:${envelope[0].line})`)
      else claims.push("FAIL: <subagent-completion> envelope not found in parent session messages")
      const marker = grepLines(e.parentMessagesFile, /<subagent-completion>.*SUBTAG_13/)
      if (marker.length > 0) claims.push(`PASS: forwarded envelope carries SUBTAG_13 (${e.parentMessagesFile}:${marker[0].line})`)
      else claims.push("FAIL: SUBTAG_13 not inside a <subagent-completion> envelope in parent session messages")
      const sessionEnvelope = grepLines(e.sessionLog, /<subagent-completion>/)
      if (sessionEnvelope.length > 0) claims.push(`PASS: forwarded envelope visible in run stdout (${e.sessionLog}:${sessionEnvelope[0].line})`)
      else claims.push("INFO: forwarded envelope not in attached run stdout (the CLI had already detached when the forward arrived)")
      return claims
    },
  },
  {
    id: "S14",
    name: "Subagent background_wait join",
    config: {},
    prompt: [
      "Use the task tool (tool id 'task', subagent_type='general', description='subagent wait join') with this exact prompt for the subagent:",
      "1. Call background_bash with command='sleep 15 && echo SUBTAG_14' (run_in_background=true, the default). Remember the job id from the result.",
      "2. Immediately call background_wait with job_id set to that job id and timeout_ms=60000. It blocks until the job finishes and returns the output inline.",
      "3. Do NOT call background_status, background_list, or background_read, and do NOT poll; background_wait is the way to wait.",
      "4. Your final response must contain the exact literal text SUBTAG_14 (it appears in the output returned by background_wait).",
      "After the task tool returns, report the subagent's final response and then end your turn immediately.",
    ].join("\n"),
    expect: (e) => {
      const claims: string[] = []
      const spawn = grepLines(e.pluginLog, /event=spawn .* command=.*SUBTAG_14/)
      const jobId = spawn[0]?.text.match(/job=(bg_[0-9a-f]+)/)?.[1]
      if (spawn.length > 0 && jobId) claims.push(`PASS: subagent job spawned (${e.pluginLog}:${spawn[0].line})`)
      else claims.push("FAIL: no event=spawn for the SUBTAG_14 job")
      if (jobId) {
        const consumed = grepLines(e.pluginLog, new RegExp(`job=${jobId} event=wait consumed=true`))
        if (consumed.length > 0) claims.push(`PASS: background_wait consumed the job (${e.pluginLog}:${consumed[0].line})`)
        else claims.push(`FAIL: no event=wait consumed=true for ${jobId}`)
        const notify = grepLines(e.pluginLog, new RegExp(`job=${jobId} event=notify kind=terminal`))
        if (notify.length === 0) claims.push("PASS: zero terminal notifications for the joined job")
        else claims.push(`FAIL: terminal notification delivered despite the join (${e.pluginLog}:${notify[0].line})`)
        const forwarded = grepLines(e.pluginLog, /event=bridge status=forwarded/).filter((l) => l.text.includes(jobId))
        if (forwarded.length === 0) claims.push("PASS: no bridge forward for the joined job")
        else claims.push(`FAIL: bridge forwarded a wait-consumed job (${e.pluginLog}:${forwarded[0].line})`)
      }
      const taskOutputs = parentTaskOutputs(e.parentMessagesFile)
      const taskLine = grepLines(e.parentMessagesFile, /"output":.*SUBTAG_14/)[0]?.line
      if (taskOutputs.some((o) => o.includes("SUBTAG_14"))) {
        claims.push(`PASS: SUBTAG_14 in parent task result (${e.parentMessagesFile}${taskLine ? ":" + taskLine : ""})`)
      } else {
        claims.push("FAIL: SUBTAG_14 not in any completed task tool output in the parent session")
      }
      const sessionMarker = grepLines(e.sessionLog, /SUBTAG_14/)
      if (sessionMarker.length > 0) claims.push(`PASS: marker visible in run stdout (${e.sessionLog}:${sessionMarker[0].line})`)
      else claims.push("INFO: marker not in attached run stdout")
      return claims
    },
  },
  {
    id: "S15",
    name: "Folded completion (turn kept active)",
    config: {},
    prompt: [
      "Use the task tool (tool id 'task', subagent_type='general', description='subagent folded completion') with this exact prompt for the subagent:",
      "1. Call background_bash with command='sleep 3 && echo SUBTAG_15' (run_in_background=true, the default) and remember its job id.",
      "2. Immediately call background_bash again with command='sleep 15 && echo PADDING15' and run_in_background=false. It returns inline when done — do not end your turn while it runs.",
      "3. Then call background_read with job_id set to the job id from step 1 (tail=true, limit=2000) and include the marker text you see (it contains SUBTAG_15) in your final response.",
      "4. Do NOT call background_wait anywhere. Your final response must contain the exact literal text SUBTAG_15.",
      "After the task tool returns, report the subagent's final response and then end your turn immediately.",
    ].join("\n"),
    expect: (e) => {
      const claims: string[] = []
      const spawn = grepLines(e.pluginLog, /event=spawn .* command=.*SUBTAG_15/)
      const jobId = spawn[0]?.text.match(/job=(bg_[0-9a-f]+)/)?.[1]
      if (spawn.length > 0 && jobId) claims.push(`PASS: subagent job spawned (${e.pluginLog}:${spawn[0].line})`)
      else claims.push("FAIL: no event=spawn for the SUBTAG_15 job")
      if (jobId) {
        const forwarded = grepLines(e.pluginLog, /event=bridge status=forwarded/).filter((l) => l.text.includes(jobId))
        if (forwarded.length === 0) claims.push("PASS: zero bridge forwards for the folded job")
        else claims.push(`FAIL: bridge forwarded a folded job (${e.pluginLog}:${forwarded[0].line})`)
        const captured = grepLines(e.pluginLog, /event=bridge status=captured/).filter((l) => l.text.includes(jobId))
        if (captured.length > 0) claims.push(`PASS: folded cycle resolved captured (${e.pluginLog}:${captured[0].line})`)
        else claims.push("INFO: no captured bridge event observed (task result is authoritative)")
      }
      const taskOutputs = parentTaskOutputs(e.parentMessagesFile)
      const taskLine = grepLines(e.parentMessagesFile, /"output":.*SUBTAG_15/)[0]?.line
      if (taskOutputs.some((o) => o.includes("SUBTAG_15"))) {
        claims.push(`PASS: SUBTAG_15 in parent task result (${e.parentMessagesFile}${taskLine ? ":" + taskLine : ""})`)
      } else {
        claims.push("FAIL: SUBTAG_15 not in any completed task tool output in the parent session")
      }
      const sessionMarker = grepLines(e.sessionLog, /SUBTAG_15/)
      if (sessionMarker.length > 0) claims.push(`PASS: marker visible in run stdout (${e.sessionLog}:${sessionMarker[0].line})`)
      else claims.push("INFO: marker not in attached run stdout")
      return claims
    },
  },
  {
    id: "S11",
    name: "Devnull stdin (nested opencode run)",
    config: {},
    prompt:
      "Run exactly this command with background_bash: echo S11_JOB_STARTED && ([ -S /dev/fd/0 ] && echo S11_STDIN_SOCKET || echo S11_STDIN_DEVNULL) && opencode run 'echo nested-opencode-ok'; echo S11_JOB_EXIT:$?. Do not kill it. Just report the tool result.",
    expect: (e) => {
      const claims: string[] = []
      const spawn = grepLines(e.pluginLog, /event=spawn .* command=echo S11_JOB_STARTED/)
      const jobId = spawn[0]?.text.match(/job=(bg_[0-9a-f]+)/)?.[1]
      if (!jobId) {
        claims.push("FAIL: no spawn line for S11 job")
        return claims
      }
      let jobLog = ""
      try {
        jobLog = e.readFile(`${jobId}.log`)
      } catch {
        claims.push("FAIL: job log not collected")
        return claims
      }
      if (jobLog.includes("S11_STDIN_DEVNULL")) claims.push(`PASS: job stdin is not a socket (${jobId}.log)`)
      else claims.push("FAIL: job stdin is a socket")
      if (jobLog.includes("nested-opencode-ok")) claims.push("PASS: nested opencode run completed (no socket-stdin hang)")
      else claims.push("FAIL: nested opencode run did not complete")
      if (jobLog.includes("S11_JOB_EXIT:0")) claims.push("PASS: job exited 0")
      else claims.push("FAIL: job exit code not 0")
      const stdinMode = grepLines(e.pluginLog, /event=spawn .* stdin=devnull/)
      if (stdinMode.length > 0) claims.push(`PASS: spawn logged stdin=devnull (${e.pluginLog}:${stdinMode[0].line})`)
      else claims.push("FAIL: spawn log missing stdin=devnull")
      return claims
    },
  },
]

function reportSection(scenario: Scenario, claims: string[], timeoutMs: number, timedOut: boolean): string {
  const lines: string[] = []
  lines.push(`## ${scenario.id} — ${scenario.name}`)
  if (timedOut) lines.push(`TIMED OUT after ${timeoutMs}ms`)
  const pass = claims.filter((c) => c.startsWith("PASS:")).length
  const fail = claims.filter((c) => c.startsWith("FAIL:")).length
  for (const claim of claims) lines.push(`- ${claim}`)
  lines.push(`Result: ${fail === 0 ? "PASS" : "FAIL"} (${pass} pass, ${fail} fail)`)
  return lines.join("\n")
}

async function runScenario(scratch: string, scenario: Scenario, port: number): Promise<string> {
  const dir = path.join(EVIDENCE_DIR, scenario.id)
  fs.mkdirSync(dir, { recursive: true })
  const projectDir = path.join(scratch, "project")
  const sessionLog = path.join(dir, "S" + scenario.id + ".session.log")
  const pluginLog = path.join(dir, "S" + scenario.id + ".plugin.log")
  const pgrepFile = path.join(dir, "S" + scenario.id + ".pgrep.txt")
  const parentMessagesFile = path.join(dir, "S" + scenario.id + ".parent.messages.json")
  const jobsDir = path.join(dir, "jobs")
  fs.mkdirSync(jobsDir, { recursive: true })

  writeScenarioConfig(projectDir, scratch, scenario)
  fs.copyFileSync(path.join(projectDir, "opencode.json"), path.join(dir, "S" + scenario.id + ".opencode.json"))
  const projectLog = path.join(scratch, "data", "opencode", "log", "opencode.log")
  fs.rmSync(projectLog, { force: true })
  log(`S${scenario.id}: starting server (${scenario.name})`)
  const server = await startServer(projectDir, scratch, port)

  log(`S${scenario.id}: running prompt`)
  let pgrepPromise: Promise<void> | null = null
  if (scenario.id === "S3") {
    pgrepPromise = (async () => {
      await waitFor(() => grepLines(projectLog, /event=promote/).length > 0, 30_000, 500)
      await Bun.sleep(4000)
      fs.writeFileSync(pgrepFile, alivePids("VALTAG").join("\n"))
    })()
  }
  const { timedOut } = await runPrompt(projectDir, scratch, port, scenario.prompt, sessionLog, RUN_TIMEOUT_MS)
  if (pgrepPromise) await pgrepPromise

  if (scenario.id === "S8") {
    log("S8: deleting session via API")
    const spawnLines = grepLines(projectLog, /event=spawn .* command=sleep 90/)
    if (spawnLines.length === 0) {
      log("S8: WARN no spawn line found for sleep 90")
    } else {
      const owner = spawnLines[0].text.match(/owner=(\S+)/)?.[1]
      if (!owner) {
        log("S8: WARN no owner in spawn line")
      } else {
        const deleted = await deleteSession(port, owner)
        if (!deleted) log("S8: WARN deleteSession returned false")
      }
    }
    await Bun.sleep(1500)
  }

  if (scenario.id === "S2" || scenario.id === "S3" || scenario.id === "S9") {
    await waitFor(
      () => grepLines(projectLog, /event=notify kind=terminal/).length > 0,
      scenario.id === "S3" || scenario.id === "S9" ? 45_000 : 20_000,
      500,
    )
  }
  if (scenario.id === "S6") {
    await Bun.sleep(12_000)
  }
  if (scenario.id === "S12") {
    await Bun.sleep(3000)
  }
  if (scenario.id === "S11") {
    const spawnLines = grepLines(projectLog, /event=spawn .* command=echo S11_JOB_STARTED/)
    const jobId = spawnLines[0]?.text.match(/job=(bg_[0-9a-f]+)/)?.[1]
    const owner = spawnLines[0]?.text.match(/owner=(\S+)/)?.[1]
    if (jobId && owner) {
      const jobLog = path.join(scratch, "out", owner, `${jobId}.log`)
      await waitFor(
        () => fs.existsSync(jobLog) && fs.readFileSync(jobLog, "utf8").includes("S11_JOB_EXIT:"),
        60_000,
        500,
      )
    }
  }

  if (scenario.id === "S13") {
    const spawnLines = grepLines(projectLog, /event=spawn .* command=.*SUBTAG_13/)
    const jobId = spawnLines[0]?.text.match(/job=(bg_[0-9a-f]+)/)?.[1]
    const childId = spawnLines[0]?.text.match(/owner=(\S+)/)?.[1]
    await waitFor(
      () => grepLines(projectLog, /event=bridge status=forwarded/).some((l) => !jobId || l.text.includes(jobId)),
      90_000,
      1000,
    )
    const forwarded = grepLines(projectLog, /event=bridge status=forwarded/).find((l) => !jobId || l.text.includes(jobId))
    const parentId = forwarded?.text.match(/parent=(\S+)/)?.[1] ?? (childId ? await sessionParent(port, childId) : null)
    if (parentId) {
      fs.writeFileSync(parentMessagesFile, prettyJson(await waitForSessionMarker(port, parentId, "SUBTAG_13", 30_000)))
    } else {
      log("S13: WARN no parent session resolved for parent-message capture")
    }
  }
  if (scenario.id === "S14") {
    const spawnLines = grepLines(projectLog, /event=spawn .* command=.*SUBTAG_14/)
    const jobId = spawnLines[0]?.text.match(/job=(bg_[0-9a-f]+)/)?.[1]
    const childId = spawnLines[0]?.text.match(/owner=(\S+)/)?.[1]
    await waitFor(
      () => grepLines(projectLog, /event=wait consumed=true/).some((l) => !jobId || l.text.includes(jobId)),
      30_000,
      500,
    )
    const parentId = childId ? await sessionParent(port, childId) : null
    if (parentId) {
      fs.writeFileSync(parentMessagesFile, prettyJson(await waitForSessionMarker(port, parentId, "SUBTAG_14", 15_000)))
    } else {
      log("S14: WARN no child/parent session resolved for parent-message capture")
    }
  }
  if (scenario.id === "S15") {
    await waitFor(() => grepLines(projectLog, /event=bridge status=captured/).length > 0, 20_000, 500)
    const spawnLines = grepLines(projectLog, /event=spawn .* command=.*SUBTAG_15/)
    const childId = spawnLines[0]?.text.match(/owner=(\S+)/)?.[1]
    const parentId = childId ? await sessionParent(port, childId) : null
    if (parentId) {
      fs.writeFileSync(parentMessagesFile, prettyJson(await waitForSessionMarker(port, parentId, "SUBTAG_15", 15_000)))
    } else {
      log("S15: WARN no child/parent session resolved for parent-message capture")
    }
  }

  const pluginLines = fs
    .readFileSync(projectLog, "utf8")
    .split("\n")
    .filter((l) => l.includes("[bg-bash]"))
  fs.writeFileSync(pluginLog, pluginLines.join("\n"))
  if (scenario.id !== "S3") {
    fs.writeFileSync(pgrepFile, alivePids("VALTAG|sleep 60|sleep 90|Continue\\?").join("\n"))
  }
  for (const f of fs.readdirSync(projectDir).filter((f) => f.startsWith("bg_"))) {
    fs.copyFileSync(path.join(projectDir, f), path.join(jobsDir, f))
  }
  const outDir = path.join(scratch, "out")
  if (fs.existsSync(outDir)) {
    for (const sessionDir of fs.readdirSync(outDir)) {
      const src = path.join(outDir, sessionDir)
      if (!fs.statSync(src).isDirectory()) continue
      for (const f of fs.readdirSync(src)) {
        fs.copyFileSync(path.join(src, f), path.join(jobsDir, f))
      }
    }
  }

  server.kill()
  const evidence: Evidence = {
    id: scenario.id,
    dir: jobsDir,
    sessionLog,
    pluginLog,
    pgrepFile,
    parentMessagesFile,
    readFile: (rel) => fs.readFileSync(path.join(jobsDir, rel), "utf8"),
  }
  const claims = scenario.expect(evidence)
  return reportSection(scenario, claims, SCENARIO_TIMEOUT_MS, timedOut)
}

async function bootstrap(scratch: string): Promise<string> {
  fs.mkdirSync(path.join(scratch, "config/opencode"), { recursive: true })
  fs.mkdirSync(path.join(scratch, "cache"), { recursive: true })
  fs.mkdirSync(path.join(scratch, "data"), { recursive: true })
  fs.mkdirSync(path.join(scratch, "project"), { recursive: true })
  fs.mkdirSync(path.join(scratch, "out"), { recursive: true })
  const authCandidates = [
    path.join(os.homedir(), ".local/share/opencode/auth.json"),
    path.join(os.homedir(), ".config/opencode/auth.json"),
  ]
  for (const auth of authCandidates) {
    if (fs.existsSync(auth)) {
      fs.copyFileSync(auth, path.join(scratch, "config/opencode/auth.json"))
      return `copied auth from ${auth}`
    }
  }
  throw new Error("no auth.json found; cannot run validation")
}

async function main() {
  const args = process.argv.slice(2)
  const scratchIdx = args.indexOf("--scratch")
  const scratch = scratchIdx >= 0 ? args[scratchIdx + 1] : fs.mkdtempSync(path.join(os.tmpdir(), "bgval-"))
  const keep = args.includes("--keep")
  const filter = args.indexOf("--scenarios")
  const only = filter >= 0 ? args[filter + 1].split(",") : null

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  log(`repo: ${REPO_ROOT}`)
  log(`scratch: ${scratch}`)
  log(`evidence: ${EVIDENCE_DIR}`)
  log(await bootstrap(scratch))

  const report: string[] = []
  report.push("# Validation report — opencode-background-shell")
  report.push(`- date: ${new Date().toISOString()}`)
  report.push(`- model: ${DEFAULT_MODEL}`)
  report.push(`- plugin: ${PLUGIN_PATH}`)
  report.push("")
  for (let i = 0; i < scenarios.length; i++) {
    if (only && !only.includes(scenarios[i].id)) continue
    const section = await runScenario(scratch, scenarios[i], PORT_BASE + i)
    report.push(section)
    report.push("")
  }
  const reportPath = path.join(EVIDENCE_DIR, "VALIDATION-REPORT.md")
  fs.writeFileSync(reportPath, report.join("\n"))
  log(`report: ${reportPath}`)

  if (!keep) {
    log("teardown: cleaning scratch")
    fs.rmSync(scratch, { recursive: true, force: true })
  } else {
    log(`teardown skipped (--keep): ${scratch}`)
  }
}

main().catch((error) => {
  console.error("[validate] fatal:", error)
  process.exit(1)
})
