import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import plugin, { type TestInternals, type Job, type BridgeMessage } from "../.opencode/plugins/background-bash"
import * as pluginModule from "../.opencode/plugins/background-bash"

const {
  JobManager,
  buildTerminalNotification,
  buildStallNotification,
  sessionContextForPrompt,
  buildCompactionContext,
  buildRunningResult,
  resolveExternalDirectories,
  tokenizeShellCommand,
  promptTailMatches,
  readJobLog,
  buildWaitResult,
  isTerminalState,
  formatStatus,
  formatList,
  resolveConfig,
  askBashPermission,
  askExternalDirectoryPermission,
  waitSyncOrPromote,
  setLogClient,
  BridgeManager,
  buildSubagentCompletionEnvelope,
  buildDegradedCompletionEnvelope,
  formatBridgeJobLine,
  findParentTaskPart,
} = (plugin as unknown as { testInternals: TestInternals }).testInternals

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bg-bash-test-"))
}

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"))
      setTimeout(tick, 10)
    }
    tick()
  })
}

function mockCtx(behavior: { allow?: boolean; deny?: boolean }) {
  return {
    ask: async (input: unknown) => {
      if (behavior.deny) throw new Error("denied by mock")
      return
    },
    _lastAsk: undefined as unknown,
  }
}

describe("resolveConfig", () => {
  test("defaults", () => {
    const cfg = resolveConfig(undefined)
    expect(cfg.route_bash).toBe(true)
    expect(cfg.sync_wait_ms).toBe(60_000)
    expect(cfg.output_dir).toBe(path.join(os.homedir(), ".local/share/opencode/background-bash"))
    expect(cfg.job_stdin).toBe("devnull")
  })

  test("overrides and ~ expansion", () => {
    const cfg = resolveConfig({ sync_wait_ms: 5000, route_bash: false, output_dir: "~/bg-test" })
    expect(cfg.sync_wait_ms).toBe(5000)
    expect(cfg.route_bash).toBe(false)
    expect(cfg.output_dir).toBe(path.join(os.homedir(), "bg-test"))
  })

  test("job_stdin override", () => {
    expect(resolveConfig({ job_stdin: "pipe" }).job_stdin).toBe("pipe")
  })
})

describe("tokenizeShellCommand", () => {
  test("quotes and spaces", () => {
    expect(tokenizeShellCommand("echo 'hello world' \"a b\" c")).toEqual(["echo", "hello world", "a b", "c"])
  })
})

describe("resolveExternalDirectories", () => {
  const root = tempDir()
  const inside = path.join(root, "src")
  const outside = path.join(os.tmpdir(), "bg-outside-dir")
  fs.mkdirSync(inside, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })

  test("no-op for non-file-ops", () => {
    expect(resolveExternalDirectories("sleep 30", root, root)).toEqual([])
  })

  test("in-root paths are ignored", () => {
    expect(resolveExternalDirectories(`cat ${path.join(root, "a.txt")}`, root, root)).toEqual([])
  })

  test("outside path yields dir glob", () => {
    const globs = resolveExternalDirectories(`rm ${path.join(outside, "x.txt")}`, root, root)
    expect(globs).toEqual([path.join(outside, "*")])
  })

  test("flags and operators skipped", () => {
    expect(resolveExternalDirectories(`rm -rf ${outside} > /dev/null 2>&1`, root, root)).toEqual([path.join(outside, "*")])
  })

  test("directories glob themselves", () => {
    const globs = resolveExternalDirectories(`rm -rf ${outside}`, root, root)
    expect(globs).toEqual([path.join(outside, "*")])
  })
})

describe("promptTailMatches", () => {
  test("matches prompt patterns", () => {
    expect(promptTailMatches("Do you want to continue? [y/n] ")).toBe(true)
    expect(promptTailMatches("Press any key to continue...")).toBe(true)
    expect(promptTailMatches("Password:")).toBe(true)
    expect(promptTailMatches("Are you sure? (y/n)")).toBe(true)
  })

  test("does not match normal output", () => {
    expect(promptTailMatches("build completed in 12s\nall tests passed")).toBe(false)
    expect(promptTailMatches("")).toBe(false)
  })
})

describe("notification envelopes", () => {
  const job = {
    id: "bg_test1",
    label: "dev-server",
    state: "exited",
    exitCode: 0,
    logPath: "/tmp/x.log",
    command: "echo hi",
  } as Parameters<typeof buildTerminalNotification>[0]

  test("terminal envelope fields", () => {
    const text = buildTerminalNotification(job)
    expect(text).toContain("<task-notification>")
    expect(text).toContain("<task-id>bg_test1</task-id>")
    expect(text).toContain("<status>exited</status>")
    expect(text).toContain("<exit-code>0</exit-code>")
    expect(text).toContain("background_read(job_id=\"bg_test1\")")
  })

  test("stall envelope has advice and no exit code", () => {
    const text = buildStallNotification({ ...job, command: "read line" })
    expect(text).toContain("<status>stalled</status>")
    expect(text).toContain("echo y | read line")
  })

  test("compaction context", () => {
    const text = buildCompactionContext([
      { ...job, state: "running", startedAt: Date.now() - 30_000, bytes: 120 },
    ])
    expect(text).toContain("<background-jobs>")
    expect(text).toContain("bg_test1: running")
    expect(text).toContain("do not poll")
  })

  test("running result envelope", () => {
    const text = buildRunningResult({ ...job, state: "running" })
    expect(text).toContain('task state="running" task-id="bg_test1"')
    expect(text).toContain("You WILL be notified")
  })
})

describe("sessionContextForPrompt", () => {
  test("maps non-default agent + variant and rewrites model shape", () => {
    expect(
      sessionContextForPrompt({ agent: "auto-accept", model: { id: "deepseek-v4-flash", providerID: "deepseek", variant: "max" } }),
    ).toEqual({
      agent: "auto-accept",
      model: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
      variant: "max",
    })
  })

  test("drops default variant and omits empty fields", () => {
    expect(sessionContextForPrompt({ model: { id: "gpt-4o-mini", providerID: "openai", variant: "default" } })).toEqual({
      model: { providerID: "openai", modelID: "gpt-4o-mini" },
    })
  })

  test("no model / no agent yields empty context (server defaults)", () => {
    expect(sessionContextForPrompt({})).toEqual({})
  })
})

describe("readJobLog", () => {
  test("offset/tail/totalBytes", () => {
    const dir = tempDir()
    const logPath = path.join(dir, "j.log")
    fs.writeFileSync(logPath, "0123456789")
    const job = { logPath, state: "running", id: "bg_x" } as Parameters<typeof readJobLog>[0]

    const first = readJobLog(job, { limit: 4 })
    expect(first.output).toBe("0123")
    expect(first.metadata.nextOffset).toBe(4)
    expect(first.metadata.totalBytes).toBe(10)

    const second = readJobLog(job, { offset: 4, limit: 100 })
    expect(second.output).toBe("456789")

    const tail = readJobLog(job, { tail: true, limit: 3 })
    expect(tail.output).toBe("789")
  })
})

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "bg_x",
    owner: "s1",
    command: "echo hi",
    label: "l",
    pid: 1,
    pgid: 1,
    logPath: "/tmp/x.log",
    state: "running",
    exitCode: null,
    startedAt: Date.now(),
    endedAt: null,
    stallNotifiedAt: null,
    notificationSentAt: null,
    bridgedAt: null,
    notifyOnExit: true,
    waiters: 0,
    bytes: 0,
    spawnError: null,
    proc: null,
    _sink: null,
    _watchdog: null,
    _terminalWaiters: new Set(),
    ...overrides,
  }
}

describe("formatStatus / formatList", () => {
  test("status includes state and pid", () => {
    const { output, metadata } = formatStatus(makeJob({ pid: 42 }))
    expect(output).toContain("state: running")
    expect(output).toContain("pid: 42")
    expect(metadata.state).toBe("running")
  })

  test("list omits commands, shows labels", () => {
    const text = formatList([makeJob({ label: "dev" })])
    expect(text).toContain("bg_x")
    expect(text).toContain("dev")
    expect(text).not.toContain("secret command")
  })
})

describe("permission asks", () => {
  test("bash permission payload", async () => {
    let captured: unknown
    const ctx = {
      ask: async (input: unknown) => {
        captured = input
      },
    }
    const result = await askBashPermission(ctx, "echo hi")
    expect(result.allowed).toBe(true)
    expect(captured).toMatchObject({
      permission: "bash",
      patterns: ["echo hi"],
      always: ["echo hi"],
    })
  })

  test("deny surfaces reason", async () => {
    const result = await askBashPermission(mockCtx({ deny: true }), "rm -rf /")
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("denied")
  })

  test("external_directory skipped when nothing external", async () => {
    let called = false
    const ctx = {
      ask: async () => {
        called = true
      },
    }
    const result = await askExternalDirectoryPermission(ctx, "echo hi", "/root", "/root")
    expect(result.allowed).toBe(true)
    expect(called).toBe(false)
  })

  test("external_directory asks with globs when outside", async () => {
    const root = tempDir()
    let captured: unknown
    const ctx = {
      ask: async (input: unknown) => {
        captured = input
      },
    }
    const outside = path.join(os.tmpdir(), "bg-ext-ask")
    const result = await askExternalDirectoryPermission(ctx, `cat ${path.join(outside, "a.txt")}`, root, root)
    expect(result.allowed).toBe(true)
    expect(captured).toMatchObject({
      permission: "external_directory",
      patterns: [path.join(outside, "*")],
    })
  })
})

describe("JobManager spawn/lifecycle", () => {
  test("spawn → running → exited with exit code and log content", async () => {
    const dir = tempDir()
    const manager = new JobManager({ ...resolveConfig(undefined), output_dir: dir })
    const job = await manager.spawn({ command: "echo hello-from-bg", workdir: dir, label: "echo", owner: "s1" }, () => Promise.resolve(), () => {})
    expect(job.state).toBe("running")
    expect(job.id).toMatch(/^bg_[0-9a-f]{8}$/)
    await waitFor(() => job.state === "exited")
    expect(job.exitCode).toBe(0)
    expect(fs.readFileSync(job.logPath, "utf8")).toContain("hello-from-bg")
    expect(job.pid).toBeGreaterThan(0)
    expect(job.pgid).toBe(job.pid)
  })

  test("spawn of unknown command → exited 127 (sh -c semantics)", async () => {
    const dir = tempDir()
    const manager = new JobManager({ ...resolveConfig(undefined), output_dir: dir })
    const job = await manager.spawn({ command: "definitely-not-a-real-command-xyz-123", workdir: dir, label: "x", owner: "s1" }, () => Promise.resolve(), () => {})
    await waitFor(() => job.state === "exited")
    expect(job.exitCode).toBe(127)
    expect(job.spawnError).toBeNull()
  })

  test("kill → cancelled, process gone, grace respected", async () => {
    const dir = tempDir()
    const manager = new JobManager({ ...resolveConfig(undefined), output_dir: dir })
    const job = await manager.spawn({ command: "sleep 30", workdir: dir, label: "sleeper", owner: "s1" }, () => Promise.resolve(), () => {})
    expect(job.state).toBe("running")
    const started = Date.now()
    await manager.kill(job, "SIGTERM")
    expect(job.state).toBe("cancelled")
    expect(Date.now() - started).toBeLessThan(4000)
    await waitFor(() => {
      try {
        process.kill(job.pid!, 0)
        return false
      } catch {
        return true
      }
    })
  })

  test("eviction keeps max_completed_jobs", async () => {
    const dir = tempDir()
    const manager = new JobManager({ ...resolveConfig({ max_completed_jobs: 2, output_dir: dir }) })
    const jobs: string[] = []
    for (let i = 0; i < 3; i++) {
      const job = await manager.spawn({ command: `echo job${i}`, workdir: dir, label: `j${i}`, owner: "s1" }, () => Promise.resolve(), () => {})
      jobs.push(job.id)
      await waitFor(() => manager.getJob(job.id)?.state === "exited")
    }
    await waitFor(() => manager.registry.size <= 2)
    expect(manager.registry.has(jobs[0])).toBe(false)
    expect(manager.registry.has(jobs[1])).toBe(true)
    expect(manager.registry.has(jobs[2])).toBe(true)
  })

  test("killOwner kills only that session's jobs", async () => {
    const dir = tempDir()
    const manager = new JobManager({ ...resolveConfig(undefined), output_dir: dir })
    const mine = await manager.spawn({ command: "sleep 30", workdir: dir, label: "mine", owner: "s1" }, () => Promise.resolve(), () => {})
    const theirs = await manager.spawn({ command: "sleep 30", workdir: dir, label: "theirs", owner: "s2" }, () => Promise.resolve(), () => {})
    manager.killOwner("s1")
    await waitFor(() => mine.state === "cancelled")
    expect(theirs.state).toBe("running")
    await manager.kill(theirs)
  })

  test("background job (notifyOnExit default true) notifies on exit", async () => {
    const dir = tempDir()
    const manager = new JobManager({ ...resolveConfig(undefined), output_dir: dir })
    let notifyCount = 0
    const job = await manager.spawn(
      { command: "echo bg-notify", workdir: dir, label: "n", owner: "s1" },
      (j) => {
        notifyCount++
        if (j.notificationSentAt === null) j.notificationSentAt = Date.now()
        return Promise.resolve()
      },
      () => {},
    )
    await waitFor(() => job.state === "exited")
    expect(notifyCount).toBe(1)
    expect(job.notificationSentAt).not.toBeNull()
  })

  test("sync job (notifyOnExit false) suppresses notification and marks seen", async () => {
    const dir = tempDir()
    const manager = new JobManager({ ...resolveConfig(undefined), output_dir: dir })
    let notifyCount = 0
    const job = await manager.spawn(
      { command: "echo sync-inline", workdir: dir, label: "n", owner: "s1", notifyOnExit: false },
      () => {
        notifyCount++
        return Promise.resolve()
      },
      () => {},
    )
    await waitFor(() => job.state === "exited")
    expect(notifyCount).toBe(0)
    expect(job.notificationSentAt).not.toBeNull()
  })

  test("promoted sync job re-enables notifyOnExit and notifies after exit", async () => {
    const dir = tempDir()
    const manager = new JobManager({ ...resolveConfig(undefined), output_dir: dir })
    let notifyCount = 0
    const job = await manager.spawn(
      { command: "sleep 3", workdir: dir, label: "n", owner: "s1", notifyOnExit: false },
      (j) => {
        notifyCount++
        if (j.notificationSentAt === null) j.notificationSentAt = Date.now()
        return Promise.resolve()
      },
      () => {},
    )
    const outcome = await waitSyncOrPromote(job, 100, new AbortController().signal)
    expect(outcome).toBe("promote")
    job.notifyOnExit = true
    await waitFor(() => job.state === "exited")
    expect(notifyCount).toBe(1)
    expect(job.notificationSentAt).not.toBeNull()
  })
})

describe("job_stdin", () => {
  test("default devnull → child stdin is not a socket", async () => {
    const dir = tempDir()
    const manager = new JobManager({ ...resolveConfig(undefined), output_dir: dir })
    const job = await manager.spawn({ command: "[ -S /dev/fd/0 ] && echo IS_SOCKET || echo NOT_SOCKET", workdir: dir, label: "stdin", owner: "s1" }, () => Promise.resolve(), () => {})
    await waitFor(() => job.state === "exited")
    expect(job.exitCode).toBe(0)
    expect(fs.readFileSync(job.logPath, "utf8")).toContain("NOT_SOCKET")
  })

  test("pipe mode → child stdin is a socket", async () => {
    const dir = tempDir()
    const manager = new JobManager({ ...resolveConfig({ job_stdin: "pipe", output_dir: dir }) })
    const job = await manager.spawn({ command: "[ -S /dev/fd/0 ] && echo IS_SOCKET || echo NOT_SOCKET", workdir: dir, label: "stdin", owner: "s1" }, () => Promise.resolve(), () => {})
    await waitFor(() => job.state === "exited")
    expect(job.exitCode).toBe(0)
    expect(fs.readFileSync(job.logPath, "utf8")).toContain("IS_SOCKET")
  })
})

describe("watchdog", () => {
  test("stall detected once, job survives", async () => {
    const dir = tempDir()
    const manager = new JobManager({
      ...resolveConfig({ watchdog_interval_ms: 20, stall_threshold_ms: 60, output_dir: dir }),
    })
    let stallCount = 0
    manager.stallNotifier = (job) => {
      stallCount++
      expect(job.id).toBeDefined()
    }
    const job = await manager.spawn(
      { command: "printf 'Continue? '; sleep 2", workdir: dir, label: "staller", owner: "s1" },
      () => Promise.resolve(),
      (j) => manager.startWatchdog(j),
    )
    await waitFor(() => stallCount === 1)
    expect(job.state).toBe("running")
    expect(job.stallNotifiedAt).not.toBeNull()
    await new Promise((r) => setTimeout(r, 150))
    expect(stallCount).toBe(1)
    await manager.kill(job)
  })

  test("no stall for active output", async () => {
    const dir = tempDir()
    const manager = new JobManager({
      ...resolveConfig({ watchdog_interval_ms: 20, stall_threshold_ms: 60, output_dir: dir }),
    })
    let stallCount = 0
    manager.stallNotifier = () => {
      stallCount++
    }
    await manager.spawn(
      { command: "i=0; while [ $i -lt 20 ]; do echo tick; i=$((i+1)); sleep 0.05; done", workdir: dir, label: "ticker", owner: "s1" },
      () => Promise.resolve(),
      (j) => manager.startWatchdog(j),
    )
    await new Promise((r) => setTimeout(r, 500))
    expect(stallCount).toBe(0)
  })
})

describe("waitSyncOrPromote", () => {
  test("promote when exceeding sync_wait_ms", async () => {
    const dir = tempDir()
    const manager = new JobManager({ ...resolveConfig(undefined), output_dir: dir })
    const job = await manager.spawn({ command: "sleep 3", workdir: dir, label: "s", owner: "s1" }, () => Promise.resolve(), () => {})
    const outcome = await waitSyncOrPromote(job, 100, new AbortController().signal)
    expect(outcome).toBe("promote")
    await manager.kill(job)
  })

  test("exit when completing within sync_wait_ms", async () => {
    const dir = tempDir()
    const manager = new JobManager({ ...resolveConfig(undefined), output_dir: dir })
    const job = await manager.spawn({ command: "exit 0", workdir: dir, label: "s", owner: "s1" }, () => Promise.resolve(), () => {})
    const outcome = await waitSyncOrPromote(job, 5000, new AbortController().signal)
    expect(outcome).toBe("exit")
  })
})

describe("background_wait", () => {
  const WAIT_TAIL = 4096

  function setup() {
    const dir = tempDir()
    const manager = new JobManager({ ...resolveConfig(undefined), output_dir: dir })
    const state = { notifyCount: 0 }
    const notify = () => {
      state.notifyCount++
      return Promise.resolve()
    }
    return { dir, manager, state, notify }
  }

  const signal = () => new AbortController().signal

  test("wait returns terminal result and marks job seen (no notification)", async () => {
    const { dir, manager, state, notify } = setup()
    const job = await manager.spawn(
      { command: "sleep 0.2; echo wait-terminal; exit 3", workdir: dir, label: "w", owner: "s1" },
      notify,
      () => {},
    )
    const result = await manager.wait("s1", job.id, 5000, signal())
    expect(result.output).toContain("<task-wait>")
    expect(result.output).toContain(`<task-id>${job.id}</task-id>`)
    expect(result.output).toContain("<status>exited</status>")
    expect(result.output).toContain("<exit-code>3</exit-code>")
    expect(result.output).toContain("wait-terminal")
    expect(result.output).toContain(`background_read(job_id="${job.id}")`)
    expect(result.metadata).toEqual({ found: true, waited: 1, timedOut: false, states: { [job.id]: "exited" } })
    expect(job.notificationSentAt).not.toBeNull()
    expect(state.notifyCount).toBe(0)
    expect(job.waiters).toBe(0)
  })

  test("wait on already-terminal job marks it seen", async () => {
    const { dir, manager, state, notify } = setup()
    const job = await manager.spawn(
      { command: "echo already-done", workdir: dir, label: "done", owner: "s1", notifyOnExit: false },
      notify,
      () => {},
    )
    await waitFor(() => job.state === "exited")
    job.notificationSentAt = null
    const result = await manager.wait("s1", job.id, 1000, signal())
    expect(result.output).toContain("<status>exited</status>")
    expect(result.metadata).toEqual({ found: true, waited: 1, timedOut: false, states: { [job.id]: "exited" } })
    expect(job.notificationSentAt).not.toBeNull()
    expect(state.notifyCount).toBe(0)
  })

  test("wait with no job_id joins all running jobs of the caller", async () => {
    const { dir, manager, state, notify } = setup()
    const a = await manager.spawn({ command: "sleep 0.15; echo A", workdir: dir, label: "a", owner: "s1" }, notify, () => {})
    const b = await manager.spawn({ command: "sleep 0.25; echo B", workdir: dir, label: "b", owner: "s1" }, notify, () => {})
    const foreign = await manager.spawn({ command: "sleep 30", workdir: dir, label: "f", owner: "s2" }, notify, () => {})
    const result = await manager.wait("s1", undefined, 5000, signal())
    expect(result.output).toContain(`<task-id>${a.id}</task-id>`)
    expect(result.output).toContain(`<task-id>${b.id}</task-id>`)
    expect(result.output).not.toContain(foreign.id)
    expect(result.metadata).toEqual({
      found: true,
      waited: 2,
      timedOut: false,
      states: { [a.id]: "exited", [b.id]: "exited" },
    })
    expect(state.notifyCount).toBe(0)
    expect(foreign.state).toBe("running")
    await manager.kill(foreign)
  })

  test("wait with no job_id when nothing is running → found:false, waited:0", async () => {
    const { manager } = setup()
    const result = await manager.wait("s1", undefined, 1000, signal())
    expect(result.output).toBe("No running jobs owned by this session.")
    expect(result.metadata).toEqual({ found: false, waited: 0, timedOut: false, states: {} })
  })

  test("wait timeout returns running state and leaves notifyOnExit enabled", async () => {
    const { dir, manager, notify } = setup()
    const job = await manager.spawn({ command: "sleep 30", workdir: dir, label: "slow", owner: "s1" }, notify, () => {})
    const started = Date.now()
    const result = await manager.wait("s1", job.id, 100, signal())
    expect(Date.now() - started).toBeGreaterThanOrEqual(80)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(result.output).toContain("<task-wait>")
    expect(result.output).toContain("<status>running</status>")
    expect(result.output).not.toContain("<exit-code>")
    expect(result.output).toContain("Still running after 100ms; you WILL be notified when it completes.")
    expect(result.metadata).toEqual({ found: true, waited: 1, timedOut: true, states: { [job.id]: "running" } })
    expect(job.state).toBe("running")
    expect(job.notifyOnExit).toBe(true)
    expect(job.waiters).toBe(0)
    await manager.kill(job)
  })

  test("wait timeout then later exit still notifies (promise not voided)", async () => {
    const { dir, manager, state, notify } = setup()
    const job = await manager.spawn({ command: "sleep 0.3", workdir: dir, label: "later", owner: "s1" }, notify, () => {})
    const result = await manager.wait("s1", job.id, 50, signal())
    expect(result.metadata.timedOut).toBe(true)
    expect(state.notifyCount).toBe(0)
    await waitFor(() => job.state === "exited")
    expect(state.notifyCount).toBe(1)
  })

  test("wait abort returns running state without killing the job", async () => {
    const { dir, manager, notify } = setup()
    const job = await manager.spawn({ command: "sleep 30", workdir: dir, label: "abort", owner: "s1" }, notify, () => {})
    const abort = new AbortController()
    const waiting = manager.wait("s1", job.id, 10_000, abort.signal)
    await new Promise((r) => setTimeout(r, 30))
    abort.abort()
    const result = await waiting
    expect(result.output).toContain("<status>running</status>")
    expect(result.metadata.timedOut).toBe(true)
    expect(job.state).toBe("running")
    expect(job.waiters).toBe(0)
    await manager.kill(job)
    expect(job.state).toBe("cancelled")
  })

  test("wait on unknown job → found:false", async () => {
    const { manager } = setup()
    const result = await manager.wait("s1", "bg_does_not_exist", 100, signal())
    expect(result.output).toBe("Job not found")
    expect(result.metadata).toEqual({ found: false, waited: 0, timedOut: false, states: {} })
  })

  test("wait on a non-owned job → found:false (owner-only; descendant cannot wait on an ancestor-owned job)", async () => {
    const { dir, manager, notify } = setup()
    const job = await manager.spawn({ command: "sleep 30", workdir: dir, label: "ancestor", owner: "parent-session" }, notify, () => {})
    const sibling = await manager.wait("other-session", job.id, 100, signal())
    expect(sibling.output).toBe("Job not found")
    expect(sibling.metadata.found).toBe(false)
    const descendant = await manager.wait("child-session", job.id, 100, signal())
    expect(descendant.output).toBe("Job not found")
    expect(descendant.metadata).toEqual({ found: false, waited: 0, timedOut: false, states: {} })
    expect(job.waiters).toBe(0)
    await manager.kill(job)
  })

  test("exit during active wait suppresses terminal notification", async () => {
    const { dir, manager, state, notify } = setup()
    const job = await manager.spawn({ command: "sleep 0.15; echo suppressed", workdir: dir, label: "s", owner: "s1" }, notify, () => {})
    const result = await manager.wait("s1", job.id, 5000, signal())
    expect(result.metadata.timedOut).toBe(false)
    expect(state.notifyCount).toBe(0)
    expect(job.state).toBe("exited")
  })

  test("exit suppressed for an active wait is claimed by the wait (no notification)", async () => {
    const { dir, manager, state, notify } = setup()
    const job = await manager.spawn({ command: "sleep 0.15; echo claimed", workdir: dir, label: "c", owner: "s1" }, notify, () => {})
    expect(job.notificationSentAt).toBeNull()
    const result = await manager.wait("s1", job.id, 5000, signal())
    expect(result.output).toContain("<status>exited</status>")
    expect(job.notificationSentAt).not.toBeNull()
    expect(state.notifyCount).toBe(0)
  })

  test("wait timeout racing exit re-reads terminal → inline result, no notification", async () => {
    const { dir, manager } = setup()
    const logPath = path.join(dir, "race.log")
    fs.writeFileSync(logPath, "race output")
    const job = makeJob({ id: "bg_race", owner: "s1", logPath, state: "running", startedAt: Date.now() })
    manager.registry.set(job.id, job)
    const waiting = manager.wait("s1", job.id, 40, signal())
    job.exitCode = 7
    job.endedAt = Date.now()
    job.state = "exited"
    const result = await waiting
    expect(result.output).toContain("<status>exited</status>")
    expect(result.output).toContain("<exit-code>7</exit-code>")
    expect(result.metadata).toEqual({ found: true, waited: 1, timedOut: false, states: { [job.id]: "exited" } })
    expect(job.notificationSentAt).not.toBeNull()
    expect(job.waiters).toBe(0)
  })

  test("wait error path releases its waiter token (terminal delivery not permanently suppressed)", async () => {
    const { dir, manager, state, notify } = setup()
    const job = await manager.spawn({ command: "sleep 0.2", workdir: dir, label: "err", owner: "s1" }, notify, () => {})
    const brokenSignal = {
      aborted: false,
      addEventListener() {
        throw new Error("signal failure")
      },
      removeEventListener() {},
    } as unknown as AbortSignal
    await expect(manager.wait("s1", job.id, 5000, brokenSignal)).rejects.toThrow("signal failure")
    expect(job.waiters).toBe(0)
    await waitFor(() => job.state === "exited")
    expect(state.notifyCount).toBe(1)
  })

  test("wait result envelope fields (status/exit/tail/timeout)", async () => {
    const { dir, manager } = setup()
    const logPath = path.join(dir, "big.log")
    fs.writeFileSync(logPath, "y".repeat(5000))
    const job = makeJob({ id: "bg_big", owner: "s1", logPath, state: "exited", exitCode: 0, startedAt: Date.now() - 2000, endedAt: Date.now() })
    manager.registry.set(job.id, job)
    const result = await manager.wait("s1", job.id, 1000, signal())
    expect(result.output).toContain("<task-wait>")
    expect(result.output).toContain("<task-id>bg_big</task-id>")
    expect(result.output).toContain("<status>exited</status>")
    expect(result.output).toContain("<exit-code>0</exit-code>")
    expect(result.output).toMatch(/<elapsed>\d+s<\/elapsed>/)
    expect(result.output).toContain("truncated")
    expect(result.output).toContain("of 5000 bytes")
    expect(result.output).toContain("y".repeat(WAIT_TAIL))
    expect(result.metadata.timedOut).toBe(false)
    expect(isTerminalState(job.state)).toBe(true)
    expect(buildWaitResult(job)).toContain("<tail>")
  })

  test("event=wait lines are greppable via client.log", async () => {
    const entries: Array<{ level: string; service: string; message: string; extra: Record<string, unknown> }> = []
    const mockClient = {
      app: {
        log: async (options: {
          body: {
            service: string
            level: "debug" | "info" | "error"
            message: string
            extra?: Record<string, unknown>
          }
        }) => {
          entries.push({
            level: options.body.level,
            service: options.body.service,
            message: options.body.message,
            extra: options.body.extra ?? {},
          })
        },
      },
    }
    setLogClient(mockClient)
    const { dir, manager, notify } = setup()
    const job = await manager.spawn({ command: "sleep 0.15; echo log", workdir: dir, label: "log", owner: "s1" }, notify, () => {})
    await manager.wait("s1", job.id, 5000, signal())
    const suppression = entries.find((e) => e.message.includes(`job=${job.id} event=wait suppressed=true`))
    const claim = entries.find((e) => e.message.includes(`job=${job.id} event=wait consumed=true`))
    expect(suppression).toBeDefined()
    expect(claim).toBeDefined()
    expect(claim?.extra.event).toBe("wait")
    expect(claim?.extra.consumed).toBe(true)
    setLogClient(null)
  })
})

describe("log contract", () => {
  test("spawn/exit events greppable via client.log", async () => {
    const dir = tempDir()
    const entries: Array<{ level: string; service: string; message: string; extra: Record<string, unknown> }> = []
    const mockClient = {
      app: {
        log: async (options: {
          body: {
            service: string
            level: "debug" | "info" | "error"
            message: string
            extra?: Record<string, unknown>
          }
        }) => {
          entries.push({
            level: options.body.level,
            service: options.body.service,
            message: options.body.message,
            extra: options.body.extra ?? {},
          })
        },
      },
    }
    setLogClient(mockClient)
    const manager = new JobManager({ ...resolveConfig(undefined), output_dir: dir })
    const job = await manager.spawn({ command: "echo x", workdir: dir, label: "x", owner: "s1" }, () => Promise.resolve(), () => {})
    await waitFor(() => job.state === "exited")
    const spawnEntry = entries.find((e) => e.message.includes(`job=${job.id} event=spawn`))
    const exitEntry = entries.find((e) => e.message.includes(`job=${job.id} event=exit`))
    expect(spawnEntry).toBeDefined()
    expect(exitEntry).toBeDefined()
    expect(spawnEntry?.extra.job).toBe(job.id)
    expect(spawnEntry?.extra.event).toBe("spawn")
    expect(spawnEntry?.service).toBe("background-bash")
    setLogClient(null)
  })
})

type Delivered = { sessionID: string; text: string; noReply: boolean }

function bridgeAssistant(text: string | null, completedAt?: number): BridgeMessage {
  return {
    info: { role: "assistant", time: completedAt === undefined ? {} : { completed: completedAt } },
    parts: text === null ? [] : [{ type: "text", text }],
  }
}

function bridgeTaskPart(
  childID: string,
  status: string,
  output = "",
  metadata: Record<string, unknown> | undefined = { sessionId: childID },
): BridgeMessage {
  return {
    info: { role: "assistant", time: { completed: Date.now() } },
    parts: [{ type: "tool", tool: "task", state: { status, output, metadata } }],
  }
}

function makeBridge(
  options: {
    graceMs?: number
    deliverOk?: boolean
    sessions?: Record<string, { parentID?: string }>
  } = {},
) {
  const dir = tempDir()
  const graceMs = options.graceMs ?? 10_000
  const manager = new JobManager({ ...resolveConfig({ output_dir: dir, sync_wait_ms: graceMs }) })
  const delivered: Delivered[] = []
  const sessions = new Map<string, { parentID?: string }>(
    Object.entries(options.sessions ?? {}).map(([id, info]) => [id, { ...info }]),
  )
  const messages = new Map<string, BridgeMessage[]>()
  const failures = { get: new Set<string>(), messages: new Set<string>() }
  let deliverOk = options.deliverOk ?? true
  const client = {
    session: {
      get: async ({ path: p }: { path: { id: string } }) => {
        if (failures.get.has(p.id)) throw new Error("session.get failed")
        return { data: sessions.get(p.id) }
      },
      messages: async ({ path: p }: { path: { id: string } }) => {
        if (failures.messages.has(p.id)) throw new Error("session.messages failed")
        return { data: messages.get(p.id) ?? [] }
      },
    },
  }
  const bridge = new BridgeManager({
    client,
    manager,
    promptAsync: async (sessionID: string, text: string, noReply: boolean) => {
      delivered.push({ sessionID, text, noReply })
      return deliverOk
    },
    graceMs: () => graceMs,
  })
  return {
    dir,
    manager,
    bridge,
    delivered,
    sessions,
    messages,
    failures,
    setDeliverOk: (value: boolean) => {
      deliverOk = value
    },
  }
}

async function addAndArm(setup: ReturnType<typeof makeBridge>, job: Job, sent = true) {
  setup.manager.registry.set(job.id, job)
  await setup.bridge.onTerminalNotification(job, sent)
  return setup.bridge.cycles.get(job.owner)
}

describe("subagent completion bridge", () => {
  test("cycle arms only for a job owner with a parentID; root-owned jobs never forward", async () => {
    const setup = makeBridge({ sessions: { child: { parentID: "parent" }, parent: {}, root: {} } })
    const childJob = makeJob({ id: "bg_child", owner: "child" })
    await addAndArm(setup, childJob)
    const cycle = setup.bridge.cycles.get("child")
    expect(cycle).toBeDefined()
    expect(cycle?.cause).toBe("job")
    expect(cycle?.sourceChild).toBeNull()
    expect(Array.from(cycle!.jobIds)).toEqual(["bg_child"])
    expect(cycle?.resolved).toBeNull()
    expect(cycle?.busyRetries).toBe(3)

    const rootJob = makeJob({ id: "bg_root", owner: "root" })
    setup.manager.registry.set(rootJob.id, rootJob)
    await setup.bridge.onTerminalNotification(rootJob, true)
    expect(setup.bridge.cycles.has("root")).toBe(false)
    await setup.bridge.handleIdle("root")
    expect(setup.delivered.length).toBe(0)
  })

  test("forwards exactly once across duplicate session.idle events", async () => {
    const setup = makeBridge({ sessions: { child: { parentID: "parent" }, parent: {} } })
    const job = makeJob({ id: "bg_1", owner: "child", state: "exited", exitCode: 0 })
    await addAndArm(setup, job)
    setup.messages.set("child", [bridgeAssistant("final answer", Date.now() + 1000)])
    await setup.bridge.handleIdle("child")
    await setup.bridge.handleIdle("child")
    expect(setup.delivered.length).toBe(1)
    expect(setup.delivered[0].sessionID).toBe("parent")
    expect(setup.delivered[0].noReply).toBe(false)
    expect(setup.delivered[0].text).toContain("<status>completed</status>")
    expect(setup.delivered[0].text).toContain("<final-response>\nfinal answer\n</final-response>")
    expect(job.bridgedAt).not.toBeNull()
    expect(setup.bridge.cycles.get("child")?.resolved).toBe("forwarded")
  })

  test("coalesces multiple terminal jobs into one forward", async () => {
    const setup = makeBridge({ sessions: { child: { parentID: "parent" }, parent: {} } })
    const a = makeJob({ id: "bg_a", owner: "child", state: "exited", exitCode: 0 })
    const b = makeJob({ id: "bg_b", owner: "child", state: "exited", exitCode: 1 })
    await addAndArm(setup, a)
    setup.manager.registry.set(b.id, b)
    await setup.bridge.onTerminalNotification(b, true)
    const cycle = setup.bridge.cycles.get("child")
    expect(cycle?.token).toBe(1)
    expect(Array.from(cycle!.jobIds).sort()).toEqual(["bg_a", "bg_b"])
    setup.messages.set("child", [bridgeAssistant("both done", Date.now() + 1000)])
    await setup.bridge.handleIdle("child")
    expect(setup.delivered.length).toBe(1)
    expect(setup.delivered[0].text).toContain("bg_a exited exitCode=0")
    expect(setup.delivered[0].text).toContain("bg_b exited exitCode=1")
  })

  test("task part running → captured, no forward", async () => {
    const setup = makeBridge({ sessions: { child: { parentID: "parent" }, parent: {} } })
    const job = makeJob({ id: "bg_run", owner: "child", state: "exited", exitCode: 0 })
    await addAndArm(setup, job)
    setup.messages.set("child", [bridgeAssistant("child says done", Date.now() + 1000)])
    setup.messages.set("parent", [bridgeTaskPart("child", "running")])
    await setup.bridge.handleIdle("child")
    expect(setup.delivered.length).toBe(0)
    expect(setup.bridge.cycles.get("child")?.resolved).toBe("captured")
  })

  test("task part completed with equal post-wake text → captured, no forward", async () => {
    const setup = makeBridge({ sessions: { child: { parentID: "parent" }, parent: {} } })
    const job = makeJob({ id: "bg_eq", owner: "child", state: "exited", exitCode: 0 })
    await addAndArm(setup, job)
    const text = "the exact final text"
    setup.messages.set("child", [bridgeAssistant(text, Date.now() + 1000)])
    setup.messages.set("parent", [
      bridgeTaskPart(
        "child",
        "completed",
        `<task id="child" state="completed">\n<task_result>${text}</task_result>\n</task>`,
      ),
    ])
    await setup.bridge.handleIdle("child")
    expect(setup.delivered.length).toBe(0)
    expect(setup.bridge.cycles.get("child")?.resolved).toBe("captured")
  })

  test("task result body with core's newline wrapper still captures (trimmed equality)", async () => {
    const setup = makeBridge({ sessions: { child: { parentID: "parent" }, parent: {} } })
    const job = makeJob({ id: "bg_wrap", owner: "child", state: "exited", exitCode: 0 })
    await addAndArm(setup, job)
    const text = "Job `bg_5d0fea27` output: **SUBTAG_15**"
    setup.messages.set("child", [bridgeAssistant(text, Date.now() + 1000)])
    setup.messages.set("parent", [
      bridgeTaskPart(
        "child",
        "completed",
        `<task id="child" state="completed">\n<task_result>\n${text}\n</task_result>\n</task>`,
      ),
    ])
    await setup.bridge.handleIdle("child")
    expect(setup.delivered.length).toBe(0)
    expect(setup.bridge.cycles.get("child")?.resolved).toBe("captured")
  })

  test("task part completed with different text → forward", async () => {
    const setup = makeBridge({ sessions: { child: { parentID: "parent" }, parent: {} } })
    const job = makeJob({ id: "bg_diff", owner: "child", state: "exited", exitCode: 0 })
    await addAndArm(setup, job)
    setup.messages.set("child", [bridgeAssistant("true final text", Date.now() + 1000)])
    setup.messages.set("parent", [
      bridgeTaskPart("child", "completed", '<task id="child" state="completed">\n<task_result>interim text</task_result>\n</task>'),
    ])
    await setup.bridge.handleIdle("child")
    expect(setup.delivered.length).toBe(1)
    expect(setup.delivered[0].text).toContain("<final-response>\ntrue final text\n</final-response>")
  })

  test("gate ignores an incomplete assistant message; later completed text upgrades to forward", async () => {
    const setup = makeBridge({ sessions: { child: { parentID: "parent" }, parent: {} } })
    const job = makeJob({ id: "bg_inc", owner: "child", state: "exited", exitCode: 0 })
    await addAndArm(setup, job)
    setup.messages.set("child", [bridgeAssistant("streaming so far", undefined)])
    await setup.bridge.handleIdle("child")
    expect(setup.delivered.length).toBe(1)
    expect(setup.delivered[0].text).toContain("<status>degraded</status>")
    expect(setup.delivered[0].text).toContain("<reason>no-final-text</reason>")
    expect(setup.bridge.cycles.get("child")?.resolved).toBe("degraded")

    setup.messages.set("child", [bridgeAssistant("streaming so far", Date.now() + 1000)])
    await setup.bridge.handleIdle("child")
    expect(setup.delivered.length).toBe(2)
    expect(setup.delivered[1].text).toContain("<status>completed</status>")
    expect(setup.delivered[1].text).toContain("streaming so far")
  })

  test("no task part → forward only when child text post-dates wake", async () => {
    const setup = makeBridge({ sessions: { child: { parentID: "parent" }, parent: {} } })
    const job = makeJob({ id: "bg_stale", owner: "child", state: "exited", exitCode: 0 })
    await addAndArm(setup, job)
    setup.messages.set("child", [bridgeAssistant("stale text", Date.now() - 1000)])
    await setup.bridge.handleIdle("child")
    expect(setup.delivered.length).toBe(1)
    expect(setup.delivered[0].text).toContain("<reason>no-final-text</reason>")
    setup.messages.set("child", [bridgeAssistant("fresh text", Date.now() + 1000)])
    await setup.bridge.handleIdle("child")
    expect(setup.delivered.length).toBe(2)
    expect(setup.delivered[1].text).toContain("<final-response>\nfresh text\n</final-response>")
  })

  test("cycle armed when the wake delivery is buffered anchors the stale-text guard", async () => {
    const setup = makeBridge({ sessions: { child: { parentID: "parent" }, parent: {} } })
    const job = makeJob({ id: "bg_buf", owner: "child", state: "exited", exitCode: 0 })
    await addAndArm(setup, job, false)
    expect(setup.bridge.cycles.get("child")?.wakeFailed).toBe(true)
    setup.messages.set("child", [bridgeAssistant("stale before wake", Date.now() - 1000)])
    await setup.bridge.handleIdle("child")
    expect(setup.delivered.length).toBe(1)
    expect(setup.delivered[0].text).toContain("<reason>child-not-resumable</reason>")
  })

  test("grace timer fires degraded when the child never resumes", async () => {
    const setup = makeBridge({ graceMs: 20, sessions: { child: { parentID: "parent" }, parent: {} } })
    const job = makeJob({ id: "bg_grace", owner: "child", state: "exited", exitCode: 0 })
    await addAndArm(setup, job)
    await waitFor(() => setup.delivered.length === 1)
    expect(setup.delivered[0].text).toContain("<status>degraded</status>")
    expect(setup.delivered[0].text).toContain("<reason>no-final-text</reason>")
    expect(setup.bridge.cycles.get("child")?.resolved).toBe("degraded")
  })

  test("wake delivery failure → child-not-resumable degraded; later true response still forwarded once", async () => {
    const setup = makeBridge({ graceMs: 20, sessions: { child: { parentID: "parent" }, parent: {} } })
    const job = makeJob({ id: "bg_wf", owner: "child", state: "exited", exitCode: 0 })
    await addAndArm(setup, job, false)
    await waitFor(() => setup.delivered.length === 1)
    expect(setup.delivered[0].text).toContain("<reason>child-not-resumable</reason>")
    setup.messages.set("child", [bridgeAssistant("late but true", Date.now() + 1000)])
    await setup.bridge.handleIdle("child")
    expect(setup.delivered.length).toBe(2)
    expect(setup.delivered[1].text).toContain("<status>completed</status>")
    expect(setup.delivered[1].text).toContain("late but true")
    await setup.bridge.handleIdle("child")
    expect(setup.delivered.length).toBe(2)
  })

  test("grace timer re-arms on non-idle expiry up to the bound, then sends a still-working degraded", async () => {
    const entries: Array<{ message: string }> = []
    setLogClient({
      app: {
        log: async (options: { body: { message: string } }) => {
          entries.push({ message: options.body.message })
        },
      },
    })
    try {
      const setup = makeBridge({ graceMs: 15, sessions: { child: { parentID: "parent" }, parent: {} } })
      const job = makeJob({ id: "bg_busy", owner: "child", state: "exited", exitCode: 0 })
      await addAndArm(setup, job)
      setup.bridge.noteStatus("child", { type: "busy" })
      await waitFor(() => setup.delivered.length === 1)
      expect(setup.delivered[0].text).toContain("<reason>still-working</reason>")
      expect(setup.bridge.cycles.get("child")?.busyRetries).toBe(0)
      expect(entries.filter((e) => e.message.includes("event=bridge status=grace-rearm")).length).toBe(3)
    } finally {
      setLogClient(null)
    }
  })

  test("grace timer treats retry as non-idle (errored pre-retry text never forwarded)", async () => {
    const setup = makeBridge({ graceMs: 15, sessions: { child: { parentID: "parent" }, parent: {} } })
    const job = makeJob({ id: "bg_retry", owner: "child", state: "exited", exitCode: 0 })
    await addAndArm(setup, job)
    setup.messages.set("child", [bridgeAssistant("pre-retry text", Date.now() + 1000)])
    setup.bridge.noteStatus("child", { type: "retry" })
    await waitFor(() => setup.delivered.length === 1)
    expect(setup.delivered[0].text).toContain("<reason>still-working</reason>")
    expect(setup.delivered[0].text).not.toContain("<status>completed</status>")
    await setup.bridge.handleIdle("child")
    expect(setup.delivered.length).toBe(2)
    expect(setup.delivered[1].text).toContain("<status>completed</status>")
    expect(setup.delivered[1].text).toContain("pre-retry text")
  })

  test("grace timer cleared by a forward — no degraded after forwarded", async () => {
    const setup = makeBridge({ graceMs: 15, sessions: { child: { parentID: "parent" }, parent: {} } })
    const job = makeJob({ id: "bg_clr", owner: "child", state: "exited", exitCode: 0 })
    await addAndArm(setup, job)
    setup.messages.set("child", [bridgeAssistant("forwarded fast", Date.now() + 1000)])
    await setup.bridge.handleIdle("child")
    expect(setup.delivered.length).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(setup.delivered.length).toBe(1)
  })

  test("repeated idle with no post-wake text sends one degraded notice (degradedAt guard)", async () => {
    const setup = makeBridge({ sessions: { child: { parentID: "parent" }, parent: {} } })
    const job = makeJob({ id: "bg_rep", owner: "child", state: "exited", exitCode: 0 })
    await addAndArm(setup, job)
    await setup.bridge.handleIdle("child")
    await setup.bridge.handleIdle("child")
    expect(setup.delivered.length).toBe(1)
    expect(setup.delivered[0].text).toContain("<reason>no-final-text</reason>")
  })

  test("parent session.get failure drops the cycle (status=parent-gone, no retry)", async () => {
    const setup = makeBridge({ sessions: { child: { parentID: "parent" }, parent: {} } })
    const job = makeJob({ id: "bg_pg", owner: "child", state: "exited", exitCode: 0 })
    await addAndArm(setup, job)
    setup.failures.get.add("child")
    await setup.bridge.handleIdle("child")
    expect(setup.delivered.length).toBe(0)
    expect(setup.bridge.cycles.has("child")).toBe(false)
    await setup.bridge.handleIdle("child")
    expect(setup.delivered.length).toBe(0)
  })

  test("forward attempted while the parent is busy (not suppressed)", async () => {
    const setup = makeBridge({ sessions: { child: { parentID: "parent" }, parent: {} } })
    const job = makeJob({ id: "bg_pb", owner: "child", state: "exited", exitCode: 0 })
    await addAndArm(setup, job)
    setup.messages.set("child", [bridgeAssistant("busy parent forward", Date.now() + 1000)])
    setup.bridge.noteStatus("parent", { type: "busy" })
    await setup.bridge.handleIdle("child")
    expect(setup.delivered.length).toBe(1)
    expect(setup.delivered[0].sessionID).toBe("parent")
  })

  test("nested cascade forwards one level per cycle (origin bridgedAt does not block it)", async () => {
    const setup = makeBridge({
      sessions: { b: { parentID: "a" }, a: { parentID: "root" }, root: {} },
    })
    const job = makeJob({ id: "bg_n", owner: "b", state: "exited", exitCode: 0 })
    await addAndArm(setup, job)
    setup.messages.set("b", [bridgeAssistant("from b", Date.now() + 1000)])
    await setup.bridge.handleIdle("b")
    expect(setup.delivered.length).toBe(1)
    expect(setup.delivered[0].sessionID).toBe("a")
    expect(setup.delivered[0].text).toContain("<session-id>b</session-id>")
    expect(job.bridgedAt).not.toBeNull()
    const cascade = setup.bridge.cycles.get("a")
    expect(cascade).toBeDefined()
    expect(cascade?.cause).toBe("forwarded-child")
    expect(cascade?.sourceChild).toBe("b")
    expect(Array.from(cascade!.jobIds)).toEqual(["bg_n"])

    setup.messages.set("a", [bridgeAssistant("from a", Date.now() + 1000)])
    await setup.bridge.handleIdle("a")
    expect(setup.delivered.length).toBe(2)
    expect(setup.delivered[1].sessionID).toBe("root")
    expect(setup.delivered[1].text).toContain("<session-id>a</session-id>")
    expect(setup.delivered[1].text).toContain("from a")
    await setup.bridge.handleIdle("a")
    expect(setup.delivered.length).toBe(2)
  })

  test("child deleted mid-job drops pending bridge state (no forward)", async () => {
    const setup = makeBridge({ sessions: { child: { parentID: "parent" }, parent: {} } })
    await setup.bridge.handleSessionDeleted("child", "parent")
    expect(setup.delivered.length).toBe(0)
    expect(setup.bridge.cycles.size).toBe(0)
  })

  test("child deleted with a terminal pending cycle runs the gate first (forward wins) then drops", async () => {
    const setup = makeBridge({ sessions: { child: { parentID: "parent" }, parent: {} } })
    const job = makeJob({ id: "bg_del", owner: "child", state: "exited", exitCode: 0 })
    await addAndArm(setup, job)
    setup.messages.set("child", [bridgeAssistant("posthumous final", Date.now() + 1000)])
    await setup.bridge.handleSessionDeleted("child", "parent")
    expect(setup.delivered.length).toBe(1)
    expect(setup.delivered[0].sessionID).toBe("parent")
    expect(setup.delivered[0].text).toContain("<status>completed</status>")
    expect(setup.delivered[0].text).toContain("posthumous final")
    expect(setup.bridge.cycles.has("child")).toBe(false)
  })

  test("child deleted without post-wake text sends session-gone degraded once then drops", async () => {
    const setup = makeBridge({ sessions: { child: { parentID: "parent" }, parent: {} } })
    const job = makeJob({ id: "bg_del2", owner: "child", state: "exited", exitCode: 0 })
    await addAndArm(setup, job)
    await setup.bridge.handleSessionDeleted("child", "parent")
    expect(setup.delivered.length).toBe(1)
    expect(setup.delivered[0].text).toContain("<status>degraded</status>")
    expect(setup.delivered[0].text).toContain("<reason>session-gone</reason>")
    expect(setup.bridge.cycles.has("child")).toBe(false)
    await setup.bridge.handleSessionDeleted("child", "parent")
    expect(setup.delivered.length).toBe(1)
  })

  test("task output parsing accepts 1.18.31 <task id=…> and legacy task_id: forms", () => {
    const modern = findParentTaskPart(
      [
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "tool",
              tool: "task",
              state: {
                status: "completed",
                output: '<task id="ses_c" state="completed">\n<task_result>hello</task_result>\n</task>',
                metadata: {},
              },
            },
          ],
        },
      ],
      "ses_c",
    )
    expect(modern).toEqual({ status: "completed", resultText: "hello" })
    const legacy = findParentTaskPart(
      [
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "tool",
              tool: "task",
              state: { status: "completed", output: "task_id: ses_c\n<task_result>legacy</task_result>" },
            },
          ],
        },
      ],
      "ses_c",
    )
    expect(legacy).toEqual({ status: "completed", resultText: "legacy" })
    expect(
      findParentTaskPart(
        [{ info: {}, parts: [{ type: "tool", tool: "task", state: { status: "completed", output: "task_id: other" } }] }],
        "ses_c",
      ),
    ).toBeNull()
  })

  test("event=bridge lines are greppable via client.log", async () => {
    const entries: Array<{ level: string; service: string; message: string; extra: Record<string, unknown> }> = []
    const mockClient = {
      app: {
        log: async (options: {
          body: {
            service: string
            level: "debug" | "info" | "error"
            message: string
            extra?: Record<string, unknown>
          }
        }) => {
          entries.push({
            level: options.body.level,
            service: options.body.service,
            message: options.body.message,
            extra: options.body.extra ?? {},
          })
        },
      },
    }
    setLogClient(mockClient)
    try {
      const setup = makeBridge({ sessions: { child: { parentID: "parent" }, parent: {} } })
      const job = makeJob({ id: "bg_log", owner: "child", state: "exited", exitCode: 0 })
      await addAndArm(setup, job)
      setup.messages.set("child", [bridgeAssistant("logged", Date.now() + 1000)])
      await setup.bridge.handleIdle("child")
      const armed = entries.find((e) => e.message.includes("event=bridge status=armed"))
      const forwarded = entries.find((e) => e.message.includes("event=bridge status=forwarded"))
      expect(armed).toBeDefined()
      expect(armed?.extra.event).toBe("bridge")
      expect(forwarded).toBeDefined()
      expect(forwarded?.extra.status).toBe("forwarded")
      expect(forwarded?.extra.session).toBe("child")
    } finally {
      setLogClient(null)
    }
  })
})

describe("bridge envelopes", () => {
  test("subagent-completion envelope fields", () => {
    const text = buildSubagentCompletionEnvelope(
      "ses_child",
      ["bg_a exited exitCode=0", "bg_b failed"],
      "the final text",
    )
    expect(text).toContain("<subagent-completion>")
    expect(text).toContain("<session-id>ses_child</session-id>")
    expect(text).toContain("<status>completed</status>")
    expect(text).toContain("<jobs>\nbg_a exited exitCode=0\nbg_b failed\n</jobs>")
    expect(text).toContain("<final-response>\nthe final text\n</final-response>")
    expect(text).toContain("</subagent-completion>")
  })

  test("degraded envelope fields", () => {
    const text = buildDegradedCompletionEnvelope("ses_child", "session-gone", ["bg_a exited exitCode=1"])
    expect(text).toContain("<subagent-completion>")
    expect(text).toContain("<session-id>ses_child</session-id>")
    expect(text).toContain("<status>degraded</status>")
    expect(text).toContain("<reason>session-gone</reason>")
    expect(text).toContain("bg_a exited exitCode=1")
    expect(text).not.toContain("<final-response>")
  })

  test("formatBridgeJobLine omits exit code when null", () => {
    expect(formatBridgeJobLine(makeJob({ id: "bg_f", state: "failed", exitCode: null }))).toBe("bg_f failed")
    expect(formatBridgeJobLine(makeJob({ id: "bg_e", state: "exited", exitCode: 3 }))).toBe("bg_e exited exitCode=3")
  })
})

describe("bridge plugin wiring", () => {
  async function makePluginInstance(sessions: Record<string, { parentID?: string }>) {
    const dir = tempDir()
    const calls: Delivered[] = []
    const sessionMap = new Map<string, { parentID?: string }>(Object.entries(sessions))
    const messages = new Map<string, BridgeMessage[]>()
    const logLines: string[] = []
    const client = {
      session: {
        get: async ({ path: p }: { path: { id: string } }) => ({ data: sessionMap.get(p.id) }),
        messages: async ({ path: p }: { path: { id: string } }) => ({ data: messages.get(p.id) ?? [] }),
        promptAsync: async (options: {
          path: { id: string }
          body: { noReply?: boolean; parts: Array<{ text?: string }> }
        }) => {
          calls.push({
            sessionID: options.path.id,
            text: options.body.parts[0]?.text ?? "",
            noReply: options.body.noReply === true,
          })
        },
      },
      app: {
        log: async (options: { body: { message: string } }) => {
          logLines.push(options.body.message)
        },
      },
    }
    const hooks = (await (plugin as unknown as (input: unknown, options?: unknown) => Promise<unknown>)(
      { client },
      { background_bash: { output_dir: dir, sync_wait_ms: 1000 } },
    )) as {
      tool: Record<
        string,
        { execute: (args: Record<string, unknown>, ctx: unknown) => Promise<{ metadata?: Record<string, unknown> }> }
      >
      event: (input: { event: { type: string; properties: Record<string, unknown> } }) => Promise<void>
    }
    const ctx = (sessionID: string) => ({
      sessionID,
      directory: dir,
      worktree: dir,
      ask: async () => {},
      abort: new AbortController().signal,
    })
    return { calls, messages, logLines, hooks, ctx }
  }

  test("terminal notification arms a cycle and session.idle forwards to the parent", async () => {
    const w = await makePluginInstance({ child: { parentID: "parent" }, parent: {} })
    await w.hooks.tool.background_bash.execute({ command: "echo bridge-e2e", run_in_background: true }, w.ctx("child"))
    await waitFor(() => w.calls.length >= 1)
    expect(w.calls[0].text).toContain("<task-notification>")
    await waitFor(() => w.logLines.some((line) => line.includes("event=bridge status=armed")))
    w.messages.set("child", [bridgeAssistant("bridged final", Date.now() + 1000)])
    await w.hooks.event({ event: { type: "session.idle", properties: { sessionID: "child" } } })
    await waitFor(() => w.calls.some((call) => call.text.includes("<subagent-completion>")))
    const forwarded = w.calls.find((call) => call.text.includes("<subagent-completion>"))
    expect(forwarded).toBeDefined()
    expect(forwarded?.sessionID).toBe("parent")
    expect(forwarded?.noReply).toBe(false)
    expect(forwarded?.text).toContain("bridged final")
  })

  test("root-owned, sync-inline and cancelled jobs never arm a cycle", async () => {
    const w = await makePluginInstance({ root: {}, child: { parentID: "parent" }, parent: {} })
    await w.hooks.tool.background_bash.execute({ command: "echo root-job", run_in_background: true }, w.ctx("root"))
    await waitFor(() => w.calls.length >= 1)
    await w.hooks.tool.background_bash.execute({ command: "echo inline", run_in_background: false }, w.ctx("child"))
    const spawned = await w.hooks.tool.background_bash.execute(
      { command: "sleep 30", run_in_background: true },
      w.ctx("child"),
    )
    await w.hooks.tool.background_kill.execute({ job_id: String(spawned.metadata?.jobId) }, w.ctx("child"))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(w.logLines.filter((line) => line.includes("event=bridge status=armed")).length).toBe(0)
  })
})

describe("module export surface", () => {
  test("plugin module exposes only the default export (legacy loader invariant)", () => {
    expect(Object.keys(pluginModule).sort()).toEqual(["default"])
  })
})
