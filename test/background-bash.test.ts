import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import plugin, { type TestInternals, type Job } from "../.opencode/plugins/background-bash"

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
  formatStatus,
  formatList,
  resolveConfig,
  askBashPermission,
  askExternalDirectoryPermission,
  waitSyncOrPromote,
  setLogFilePath,
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
    notifyOnExit: true,
    bytes: 0,
    spawnError: null,
    proc: null,
    _sink: null,
    _watchdog: null,
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

describe("log contract", () => {
  test("spawn/exit events greppable in log file", async () => {
    const dir = tempDir()
    const logPath = path.join(dir, "plugin.log")
    setLogFilePath(logPath)
    const manager = new JobManager({ ...resolveConfig(undefined), output_dir: dir })
    const job = await manager.spawn({ command: "echo x", workdir: dir, label: "x", owner: "s1" }, () => Promise.resolve(), () => {})
    await waitFor(() => job.state === "exited")
    const content = fs.readFileSync(logPath, "utf8")
    expect(content).toContain(`[bg-bash]`)
    expect(content).toContain(`job=${job.id} event=spawn`)
    expect(content).toContain(`job=${job.id} event=exit`)
  })
})
