import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolveProjectId } from "../src/memory/paths.ts"
import { projectMemoryTemplate } from "../src/memory/template.ts"
import { GLOBAL_CAP, SECTION_CAPS, extractDelta, mergeGlobalMemory, migrateMemoryLayout, normalizeBullets } from "../src/memory/merge.ts"
import { describeDreamDiff, diffProjectMemory, snapshotProjectMemory } from "../src/session/dream.ts"
import { validateCheckpoint, SECTION_BUDGET_BYTES } from "../src/session/validator.ts"
import { stripDelta, extractDelta } from "../src/memory/merge.ts"
import type { Db } from "../src/memory/db.ts"
import {
  bumpWriterFail,
  clearWriterFail,
  writerFailCount,
    markCheckpoint,
    lastCheckpointMs,
    lastCheckpointId,
  runWriter,
  appendProjectMemory,
  checkpointPath,
  finalizeWriter,
  persistOrphan,
    settleWriter,
    spawnWriter,
    childDeadlineMs,
  type PendingWriter,
  type WriterDeps,
  type WriterTarget,
} from "../src/session/writer.ts"

const checkpoint = [
  "# Checkpoint",
  "## Summary",
  "同一份 checkpoint",
  "## Decisions",
  "- 保持幂等",
  "## Facts",
  "- 一次写入",
  "## Open",
  "- 无",
  "## Files",
  "- src/session/writer.ts",
  "## Notes",
  "并发 settle 回归测试",
].join("\n")

function createDb(): { db: Db; values: Map<string, string> } {
  const values = new Map<string, string>()
  const db: Db = {
    exec() {},
    run(_sql: string, ...params: unknown[]) {
      if (params.length >= 2) values.set(String(params[0]), String(params[1]))
    },
    all<T>() {
      return [] as T[]
    },
    get<T>(_sql: string, ...params: unknown[]) {
      const value = values.get(String(params[0]))
      return value === undefined ? undefined : ({ value } as T)
    },
  }
  return { db, values }
}

function createTarget(projectDir: string): WriterTarget {
  return { sessionID: "parent-session", projectDir, title: "test" }
}

function createDeps(root: string, db: Db, messages: () => Promise<unknown>): WriterDeps {
  return {
    client: { session: { messages } },
    db,
    root,
    toolsWhitelist: {},
    writerPrompt: "",
    blacklist: new Set<string>(),
    settling: new Map<string, Promise<boolean>>(),
    finalizing: new Map<string, Promise<boolean>>(),
    projectDir: root,
    maxWriterRetries: 3,
  }
}

type LogEntry = { level: string; message: string }

function createLoggedDeps(root: string, db: Db, messages: () => Promise<unknown>): { deps: WriterDeps; logs: LogEntry[] } {
  const logs: LogEntry[] = []
  const deps = createDeps(root, db, messages)
  deps.client = {
    session: { messages },
    app: {
      log(args: { body: { level: string; message: string } }) {
        logs.push({ level: args.body.level, message: args.body.message })
        return Promise.resolve()
      },
    },
  }
  return { deps, logs }
}

const okMessages = (text: string) => async () => ({
  data: [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }],
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "promemory-writer-"))
}

describe("project id", () => {
  test("normalizes Windows path separators", () => {
    expect(resolveProjectId("D:\\RMANBAK")).toBe(resolveProjectId("D:/RMANBAK"))
  })
})

describe("writer finalization", () => {
  test("shares one in-flight finalization per child session", async () => {
    const root = tempRoot()
    const gate = deferred()
    let messageCalls = 0
    const { db } = createDb()
    const target = createTarget(root)
    const deps = createDeps(root, db, async () => {
      messageCalls += 1
      await gate.promise
      return {
        data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: checkpoint }] }],
      }
    })
    try {
      const first = finalizeWriter(deps, target, "child-session")
      const second = finalizeWriter(deps, target, "child-session")
      expect(second).toBe(first)
      gate.resolve()
      await Promise.all([first, second])
      expect(messageCalls).toBe(1)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("concurrent settle calls append one checkpoint", async () => {
    const root = tempRoot()
    const gate = deferred()
    let messageCalls = 0
    const { db } = createDb()
    const target = createTarget(root)
    const childSessionID = "child-session"
    const deps = createDeps(root, db, async () => {
      messageCalls += 1
      await gate.promise
      return {
        data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: `${checkpoint}\nCHECKPOINT_DONE` }] }],
      }
    })
    const state = new Map<string, PendingWriter>()
    state.set(target.sessionID, { target, childSessionID, createdAt: Date.now(), done: false })
    try {
      await persistOrphan(root, target, childSessionID)
      const first = settleWriter(deps, state, childSessionID)
      const second = settleWriter(deps, state, childSessionID)
      expect(second).toBe(first)
      gate.resolve()
      await Promise.all([first, second])
      expect(messageCalls).toBe(1)
      expect(fs.readFileSync(checkpointPath(root, target.sessionID), "utf8")).toBe(checkpoint)
      const memoryPath = path.join(root, "projects", resolveProjectId(root), "MEMORY.md")
      const withTemplate = `${projectMemoryTemplate(root)}

${checkpoint}`
      expect(fs.readFileSync(memoryPath, "utf8")).toBe(withTemplate)
      await persistOrphan(root, target, childSessionID)
      await settleWriter(deps, state, childSessionID)
      expect(fs.readFileSync(memoryPath, "utf8")).toBe(withTemplate)
      expect(JSON.parse(fs.readFileSync(path.join(root, ".writers.json"), "utf8"))).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("does not append the same project body twice", () => {
    const root = tempRoot()
    const projectDir = path.join(root, "project")
    try {
      expect(appendProjectMemory(root, projectDir, checkpoint)).toBe(true)
      expect(appendProjectMemory(root, projectDir, checkpoint)).toBe(true)
      const memoryPath = path.join(root, "projects", resolveProjectId(projectDir), "MEMORY.md")
      expect(fs.readFileSync(memoryPath, "utf8")).toBe(`${projectMemoryTemplate(projectDir)}

${checkpoint}`)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("accumulates past 10KB and 200 lines", () => {
    const root = tempRoot()
    const projectDir = path.join(root, "project")
    const bodies = Array.from({ length: 120 }, (_, i) =>
      Array.from({ length: 5 }, (_, j) => `- 批次 ${i} 条目 ${j}：记忆文件是累积型产物`).join("\n"),
    )
    try {
      for (const body of bodies) expect(appendProjectMemory(root, projectDir, body)).toBe(true)
      const merged = fs.readFileSync(path.join(root, "projects", resolveProjectId(projectDir), "MEMORY.md"), "utf8")
      expect(merged).toBe(`${projectMemoryTemplate(projectDir)}\n\n${bodies.join("\n\n")}`)
      expect(Buffer.byteLength(merged, "utf8")).toBeGreaterThan(10 * 1024)
      expect(merged.split("\n").length).toBeGreaterThan(200)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("writer failure visibility", () => {
  test("logs an error and leaves the watermark alone when validation rejects", async () => {
    const root = tempRoot()
    const { db, values } = createDb()
    const { deps, logs } = createLoggedDeps(root, db, okMessages("这不是 checkpoint，没有 section"))
    const target = createTarget(root)
    try {
      await finalizeWriter(deps, target, "child-rejected")
      expect(fs.existsSync(checkpointPath(root, target.sessionID))).toBe(false)
      expect(values.has(`scanner:${target.sessionID}`)).toBe(false)
      expect(logs.filter((l) => l.level === "error")).toHaveLength(1)
      expect(logs[0].message).toContain("missing section")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("warns on an over-budget section without rejecting the checkpoint", async () => {
    const root = tempRoot()
    const { db, values } = createDb()
    const fat = checkpoint.replace("## Facts\n- 一次写入", `## Facts\n${"- 超长事实".repeat(400)}`)
    const { deps, logs } = createLoggedDeps(root, db, okMessages(fat))
    const target = createTarget(root)
    try {
      // A cursor, as every real batch carries. Settlement holds the watermark
      // when none is supplied, so the assertion below needs one to mean
      // anything — the test's subject is the section warning, not the cursor.
      await finalizeWriter(deps, target, "child-fat", { lastConsumed: 1_700_000_000_000, lastConsumedId: "m1" })
      expect(fs.existsSync(checkpointPath(root, target.sessionID))).toBe(true)
      expect(values.get(`scanner:${target.sessionID}`)).toBe("1700000000000")
      const warns = logs.filter((l) => l.level === "warn")
      expect(warns.length).toBeGreaterThan(0)
      expect(warns.some((w) => w.message.includes("## Facts") && w.message.includes("budget"))).toBe(true)
      expect(logs.filter((l) => l.level === "error")).toHaveLength(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("does not advance the watermark when the project append fails", async () => {
    const root = tempRoot()
    const { db, values } = createDb()
    const { deps, logs } = createLoggedDeps(root, db, okMessages(checkpoint))
    const projectDir = path.join(root, "project")
    // 在 MEMORY.md 的确切路径上建目录，让 writeFileSync 以 EISDIR 失败
    const pid = resolveProjectId(projectDir)
    fs.mkdirSync(path.join(root, "projects", pid), { recursive: true })
    fs.mkdirSync(path.join(root, "projects", pid, "MEMORY.md"), { recursive: true })
    const target = createTarget(projectDir)
    try {
      await finalizeWriter(deps, target, "child-io-fail")
      expect(fs.readFileSync(checkpointPath(root, target.sessionID), "utf8")).toBe(checkpoint)
      expect(values.has(`scanner:${target.sessionID}`)).toBe(false)
      expect(logs.some((l) => l.level === "error" && l.message.includes("project memory append failed"))).toBe(true)
      expect(logs.some((l) => l.message.includes("watermark not advanced"))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("project memory template", () => {
  test("is written once and never duplicated", () => {
    const root = tempRoot()
    const projectDir = path.join(root, "project")
    const memoryPath = path.join(root, "projects", resolveProjectId(projectDir), "MEMORY.md")
    try {
      appendProjectMemory(root, projectDir, checkpoint)
      const first = fs.readFileSync(memoryPath, "utf8")
      expect(first.startsWith(projectMemoryTemplate(projectDir))).toBe(true)
      const extra = `${checkpoint}\n\n## 另一段\n- 新内容`
      appendProjectMemory(root, projectDir, extra)
      const second = fs.readFileSync(memoryPath, "utf8")
      expect(second).toBe(`${first}\n\n${extra}`)
      expect(second.split(projectMemoryTemplate(projectDir))).toHaveLength(2)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("watermark monotonicity", () => {
  test("never moves backwards", () => {
    const { db } = createDb()
    expect(markCheckpoint(db, "s1", 2000)).toBe(true)
    expect(markCheckpoint(db, "s1", 1000)).toBe(false)
    expect(lastCheckpointMs(db, "s1")).toBe(2000)
    expect(markCheckpoint(db, "s1", 3000)).toBe(true)
    expect(lastCheckpointMs(db, "s1")).toBe(3000)
  })
})

  describe("child deadline scaling", () => {
    // Measured from the child session's own timestamps (time_updated minus
    // time_created) on the idle path — not from the outer poll, which for a long
    // time measured the deadline instead of the work:
    //   129,144 B →  68s   0.517 ms/byte
    //   129,144 B → 111s   0.846 ms/byte
    //   132,000 B →  89s   0.655 ms/byte
    // Mean 0.672, sd 0.135, CV 20.1%, worst/best 1.64x. Two identical 129KB
    // inputs differed by 63s, so the spread is real and the coefficient is set
    // against the slow end rather than the mean.
    const SAMPLES = [
      { bytes: 129_144, ms: 68_000 },
      { bytes: 129_144, ms: 111_000 },
      { bytes: 132_000, ms: 89_000 },
    ] as const
    const SLOWEST_MS = 111_000
    const CV = 0.201

    test("clears the slowest measured full-budget run", () => {
      const budget = childDeadlineMs(132_000)
      // 1ms/byte gives 288s here, 2.6x the slowest observation. The 1.64x
      // worst/best spread is what this has to absorb.
      expect(budget).toBeGreaterThanOrEqual(SLOWEST_MS * 2)
    })

    test("every measured sample fits inside the budget", () => {
      for (const s of SAMPLES) {
        expect(childDeadlineMs(s.bytes)).toBeGreaterThan(s.ms)
      }
    })

    test("margin absorbs the observed spread, not just the mean", () => {
      // Guards the specific mistake: setting the coefficient from the mean rate.
      // At 0.672 ms/byte mean a coefficient tuned to it would leave a fast-looking
      // budget that the 0.846 sample blows through.
      const margin = childDeadlineMs(132_000) / SLOWEST_MS
      expect(margin).toBeGreaterThanOrEqual(1 / (1 + CV) * 2)
      expect(margin).toBeGreaterThanOrEqual(2)
    })

    test("a stuck child is not left waiting for the old 21 minutes", () => {
      // The 6ms constant made a full-budget ceiling of 1278s — 11.5x the work.
      // Harmless while the idle branch fires, but a genuinely stuck child then
      // sat that long before anything noticed.
      expect(childDeadlineMs(135_000)).toBeLessThan(300_000)
    })

  test("never drops below the original flat ceiling", () => {
      // The budget is a ceiling, not a wait: a small increment still settles as
      // soon as the child reports idle. What must never happen is the budget
      // falling under the old flat 180s, which would re-tighten the deadline the
      // scaling exists to widen.
      for (const bytes of [0, 5_000, 12_000, 24_000]) {
        expect(childDeadlineMs(bytes)).toBeGreaterThanOrEqual(180_000)
      }
      expect(childDeadlineMs(0)).toBe(180_000)
    })

    test("grows monotonically with the increment", () => {
      let previous = 0
      for (const bytes of [0, 24_000, 60_000, 100_000, 135_000]) {
        const budget = childDeadlineMs(bytes)
        expect(budget).toBeGreaterThanOrEqual(previous)
        previous = budget
      }
    })
  })

describe("checkpoint size ceiling", () => {
  // A real full-budget run: a 131,544-byte increment distilled to 16,067 bytes,
  // which the old 10,240 ceiling rejected. The rejection held the watermark, so
  // the host loop stopped after one batch and the rest of the increment was
  // never processed — a full-size increment was simply unprocessable.
  const REAL_OUTPUT_BYTES = 16_067

  function sized(base: string, targetBytes: number): string {
    // Grow one section until the body reaches targetBytes, so the test uses a
    // real byte count rather than a guess. The "- " and newline added below
    // are part of the body, so they come out of the budget — otherwise the
    // result overshoots the target by exactly those 3 bytes.
    const INJECTED = 3 // "\n" + "- "
    const need = targetBytes - Buffer.byteLength(base, "utf8") - INJECTED
    expect(INJECTED).toBe(Buffer.byteLength("\n- ", "utf8"))
    return base.replace("## Notes", `## Notes\n- ${"x".repeat(Math.max(0, need))}`)
  }

  test("accepts a checkpoint the size a full-budget run actually produces", () => {
    const body = sized(checkpoint, REAL_OUTPUT_BYTES)
    expect(Buffer.byteLength(body, "utf8")).toBe(REAL_OUTPUT_BYTES)
    const verdict = validateCheckpoint(body)
    // Overshooting section budgets is a warning, never a rejection.
    expect(verdict.errors.filter((e) => e.includes("size exceeds"))).toEqual([])
    expect(verdict.ok).toBe(true)
  })

  test("still rejects a checkpoint far past the ceiling", () => {
    const body = sized(checkpoint, 64 * 1024)
    const verdict = validateCheckpoint(body)
    expect(verdict.ok).toBe(false)
    expect(verdict.errors.some((e) => e.includes("size exceeds"))).toBe(true)
  })

  test("the ceiling clears the sum of the section budgets", () => {
    const sum = Object.values(SECTION_BUDGET_BYTES).reduce((a, b) => a + b, 0)
    // A well-behaved child fits inside the section budgets, so the ceiling must
    // be well clear of them or a compliant checkpoint could still be rejected.
    const ceiling = validateCheckpoint(sized(checkpoint, 24 * 1024 - 1))
    expect(sum).toBeLessThan(24 * 1024)
    expect(ceiling.errors.filter((e) => e.includes("size exceeds"))).toEqual([])
  })
})

describe("duplicate delta markers", () => {
  // Two real writer replies, captured verbatim. Both were rejected by the
  // validator, which held the watermark and stopped the host loop after one
  // batch — 2 of 8 full-budget samples, a 25% failure rate.
  //
  // The writer emitted the delta marker more than once and paired it with a close
  // belonging to a later block, so everything in between was stripped along with
  // the required sections. Taking the LAST open marker fixes both; taking the
  // first is what broke them.
  const REQ = ["# Checkpoint", "## Summary", "## Decisions", "## Facts", "## Open", "## Files", "## Notes"]

  function fixture(name: string): string {
    return fs.readFileSync(path.join(import.meta.dir, "fixtures", name), "utf8")
  }

  test("a reply with two opens and one close keeps its required sections", () => {
    const raw = fixture("malformed-delta-swallowed-notes.md")
    expect(raw.split("<!-- project-memory-delta").length - 1).toBe(2)
    const body = stripDelta(raw).replace(/CHECKPOINT_DONE\s*$/, "").trim()
    for (const s of REQ) expect(body).toContain(s)
    expect(validateCheckpoint(body).ok).toBe(true)
  })

  test("a reply written twice with three opens keeps its required sections", () => {
    const raw = fixture("malformed-duplicated-checkpoint.md")
    expect(raw.split("<!-- project-memory-delta").length - 1).toBe(3)
    const body = stripDelta(raw).replace(/CHECKPOINT_DONE\s*$/, "").trim()
    for (const s of REQ) expect(body).toContain(s)
    expect(validateCheckpoint(body).ok).toBe(true)
  })

  test("the delta parsed is the last block, not the abandoned draft", () => {
    const raw = fixture("malformed-delta-swallowed-notes.md")
    const delta = extractDelta(raw)
    expect(delta).not.toBeNull()
    // A real parse of the final block: every project section present.
    for (const key of Object.keys(delta!.project)) {
      expect(typeof delta!.project[key as keyof typeof delta.project]).toBe("string")
    }
    expect(delta!.global.length).toBeGreaterThan(0)
  })

  test("a well-formed reply behaves exactly as before", () => {
    // One open marker: lastIndexOf and indexOf agree, so this path must not move.
    const raw = [
      "# Checkpoint",
      "## Summary",
      "- s",
      "## Decisions",
      "- d",
      "## Facts",
      "- f",
      "## Open",
      "- o",
      "## Files",
      "- a.ts",
      "## Notes",
      "- n",
      "",
      "<!-- project-memory-delta",
      "## Project context",
      "- ctx",
      "-->",
      "CHECKPOINT_DONE",
      ].join("\n")
    expect(raw.split("<!-- project-memory-delta").length - 1).toBe(1)
    const body = stripDelta(raw)
    expect(body).toContain("## Notes")
    expect(body).not.toContain("project-memory-delta")
    expect(extractDelta(raw)?.project["Project context"]).toContain("ctx")
  })
})

describe("increment overflow", () => {
  // Regression cover for the data-loss path that used to sit here.
  //
  // readIncrement stops at INCREMENT_BUDGET and reports full=false, but
  // finalisation used to advance the watermark to settleStart — the dispatch
  // time, not the last message actually read. Every message past the cut fell
  // below a watermark that had jumped over it, so no later checkpoint could ever
  // select it. Measured on a 240KB increment: 6 messages, 120,118 bytes, gone
  // with no error reported.
  //
  // The cursor now tracks the last message handed over in full, and a truncated
  // batch re-arms the writer for the next one.
  const CHUNK = "x".repeat(20_000)
  const BASE = 1_700_000_000_000

  function session(total: number) {
    return Array.from({ length: total }, (_, i) => ({
      info: { role: "assistant", id: `m${i}`, time: { created: BASE + i * 1_000 } },
      parts: [{ type: "text", text: `${CHUNK} #${i}` }],
    }))
  }

  const childCheckpoint = async () => ({
    data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: checkpoint }] }],
  })

  /** deps whose child dispatch records what was fed. */
  function dispatchDeps(root: string, db: Db, messages: unknown[], fed: { value: string }): WriterDeps {
    return {
      ...createDeps(root, db, async () => ({ data: messages })),
      client: {
        session: {
          messages: async () => ({ data: messages }),
          create: async () => ({ data: { id: "child-1" } }),
          promptAsync: async (args: { body: { parts?: Array<{ text?: string }> } }) => {
            fed.value = (args.body.parts ?? []).map((p) => p.text ?? "").join("")
            return {}
          },
        },
      },
    }
  }

  test("the increment is cut at the budget and the tail is not fed", async () => {
    const root = tempRoot()
    const { db } = createDb()
    const target = createTarget(root)
    const fed = { value: "" }
    try {
      const msgs = session(12)
      await spawnWriter(dispatchDeps(root, db, msgs, fed), target, new Map())
      expect(fed.value).toContain("#0")
      expect(fed.value).not.toContain("#11")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("the watermark lands on the last fully-fed message, not the dispatch time", async () => {
    const root = tempRoot()
    const { db } = createDb()
    const target = createTarget(root)
    const state = new Map<string, PendingWriter>()
    const fed = { value: "" }
    try {
      fs.mkdirSync(path.join(root, "sessions", target.sessionID), { recursive: true })
      const msgs = session(12)
      await spawnWriter(dispatchDeps(root, db, msgs, fed), target, state)
      const pending = state.get(target.sessionID)
      expect(pending).toBeDefined()
      expect(pending?.truncated).toBe(true)
      // The cursor is the newest message that made it into the prompt, which is
      // strictly older than the newest message in the session.
      expect(pending?.lastConsumed).toBeGreaterThan(0)
      expect(pending?.lastConsumed).toBeLessThan(BASE + 11_000)

      await settleWriter(createDeps(root, db, childCheckpoint), state, "child-1")

      const watermark = lastCheckpointMs(db, target.sessionID)
      expect(watermark).toBe(pending?.lastConsumed)
      // The whole point: the unread tail is still above the cursor.
      expect(watermark).toBeLessThan(BASE + 11_000)
      expect(lastCheckpointId(db, target.sessionID)).toBe(pending?.lastConsumedId)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("the next batch picks up the tail the first one left behind", async () => {
    const root = tempRoot()
    const { db } = createDb()
    const target = createTarget(root)
    const state = new Map<string, PendingWriter>()
    try {
      fs.mkdirSync(path.join(root, "sessions", target.sessionID), { recursive: true })
      const msgs = session(12)
      await spawnWriter(dispatchDeps(root, db, msgs, { value: "" }), target, state)
      await settleWriter(createDeps(root, db, childCheckpoint), state, "child-1")

      // A fresh read of the same 12 messages must now see the remainder. Before
      // the cursor this came back empty, which is the loss.
      const second = { value: "" }
      await spawnWriter(dispatchDeps(root, db, msgs, second), target, new Map())
      expect(second.value).toContain("#6")
      expect(second.value).toContain("#11")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("a message cut mid-way by the budget leaves the cursor on the previous one", async () => {
    const root = tempRoot()
    const { db } = createDb()
    const target = createTarget(root)
    const fed = { value: "" }
    try {
      // Two text parts on one message. The budget admits the first and rejects
      // the second, so the cursor must not claim this message — otherwise the
      // rejected part is skipped forever. Sized so m0 (60,017B) plus m1's first
      // part (60,017B) fit inside 135,000 and a third would not.
      const big = "y".repeat(60_000)
      const msgs = [
        { info: { role: "assistant", id: "m0", time: { created: BASE } }, parts: [{ type: "text", text: `${big} a` }] },
        {
          info: { role: "assistant", id: "m1", time: { created: BASE + 1_000 } },
          parts: [
            { type: "text", text: `${big} b` },
            { type: "text", text: `${big} c` },
          ],
        },
      ]
      const state = new Map<string, PendingWriter>()
      await spawnWriter(dispatchDeps(root, db, msgs, fed), target, state)
      const pending = state.get(target.sessionID)
      // m1's second part did not fit, so m1 is not consumed.
      expect(fed.value).toContain(`${big} b`)
      expect(fed.value).not.toContain(`${big} c`)
      expect(pending?.lastConsumed).toBe(BASE)
      expect(pending?.lastConsumedId).toBe("m0")
      expect(pending?.truncated).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("sibling messages sharing a millisecond are not skipped", async () => {
    const root = tempRoot()
    const { db } = createDb()
    const target = createTarget(root)
    const fed = { value: "" }
    try {
      markCheckpoint(db, target.sessionID, BASE, "m0")
      // m1 shares m0's millisecond. A timestamp-only comparison would skip it.
      const msgs = [
        { info: { role: "assistant", id: "m0", time: { created: BASE } }, parts: [{ type: "text", text: "one" }] },
        { info: { role: "assistant", id: "m1", time: { created: BASE } }, parts: [{ type: "text", text: "two" }] },
        {
          info: { role: "assistant", id: "m2", time: { created: BASE + 1_000 } },
          parts: [{ type: "text", text: "three" }],
        },
      ]
      await spawnWriter(dispatchDeps(root, db, msgs, fed), target, new Map())
      expect(fed.value).not.toContain("one")
      expect(fed.value).toContain("two")
      expect(fed.value).toContain("three")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("a stale result leaves the watermark where it was", async () => {
    const root = tempRoot()
    const { db } = createDb()
    const target = createTarget(root)
    try {
      fs.mkdirSync(path.join(root, "sessions", target.sessionID), { recursive: true })
      const file = checkpointPath(root, target.sessionID)
      fs.writeFileSync(file, "# Checkpoint\n## Summary\n更新的内容\n", "utf8")
      const future = new Date(Date.now() + 10_000)
      fs.utimesSync(file, future, future)

      const stale = `${checkpoint}\n\n## 补充\n- 迟到结果`
      const ok = await finalizeWriter(createDeps(root, db, okMessages(stale)), target, "child-stale", {
        lastConsumed: BASE,
        lastConsumedId: "m0",
      })
      expect(ok).toBe(true)
      // The batch never reached the file, so claiming its cursor would strand
      // everything the child did read.
      expect(lastCheckpointMs(db, target.sessionID)).toBe(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("a batch with no cursor leaves the watermark alone", async () => {
    const root = tempRoot()
    const { db } = createDb()
    const target = createTarget(root)
    try {
      fs.mkdirSync(path.join(root, "sessions", target.sessionID), { recursive: true })
      await finalizeWriter(createDeps(root, db, okMessages(checkpoint)), target, "child-nocursor")
      // Unknown cursor must not fall back to the dispatch time.
      expect(lastCheckpointMs(db, target.sessionID)).toBe(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test(
    "settling a truncated batch re-arms the writer for the next one",
    // Two 5s poll cycles are inherent here: the watcher only settles on a timer.
    async () => {
      const root = tempRoot()
      const { db } = createDb()
      const target = createTarget(root)
      const state = new Map<string, PendingWriter>()
      const msgs = session(12)
      const sid = target.sessionID
      let dispatched = 0
      const fed: string[] = []
      try {
        fs.mkdirSync(path.join(root, "sessions", sid), { recursive: true })
        // messages() serves both callers: readIncrement asks for the parent,
        // finalizeWriterOnce asks for the child. The SDK nests the id under
        // `path`, so that is where it has to be read from. The child reports
        // idle immediately, so the 5s poll settles and re-arms.
        const childReply = { data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: checkpoint }] }] }
        const pick = (args: { path?: { id?: string } }) =>
          args?.path?.id === sid ? { data: msgs } : childReply
        const deps: WriterDeps = {
          ...createDeps(root, db, pick),
          maxWriterRetries: 3,
          client: {
            session: {
              messages: pick,
              create: async () => ({ data: { id: `child-${dispatched}` } }),
              promptAsync: async (args: { body: { parts?: Array<{ text?: string }> } }) => {
                fed.push((args.body.parts ?? []).map((p) => p.text ?? "").join(""))
                dispatched += 1
                return {}
              },
              status: async () => ({ data: {} }),   // absent = idle
            },
          },
        }
        runWriter(target, deps, state)

        // Two 5s poll cycles: settle batch one, then its re-arm.
        for (let i = 0; i < 60 && dispatched < 2; i++) {
          await new Promise((r) => setTimeout(r, 250))
        }
        expect(dispatched).toBeGreaterThanOrEqual(2)
        // Batch two is fed the tail batch one stopped short of.
        expect(fed[0]).toContain("#0")
        expect(fed[1]).toContain("#6")
        // A third cycle settles batch two, after which the watermark reaches the
        // newest message and the loop stops on its own — no batch four.
        for (let i = 0; i < 60 && lastCheckpointMs(db, sid) < BASE + 11_000; i++) {
          await new Promise((r) => setTimeout(r, 250))
        }
        expect(lastCheckpointMs(db, sid)).toBe(BASE + 11_000)
        await new Promise((r) => setTimeout(r, 1_500))
        expect(dispatched).toBe(2)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
    20_000,
  )

  test(
    "a status call that throws still re-arms the loop",
    // Regression from a real 29KB run against a live provider: the batch
    // overran its deadline, and only the idle branch re-armed, so the loop ended
    // after one batch and the remaining 29KB was stranded. The idle-only test
    // above could not catch it — its mock reports idle, the one path that
    // already worked. Exercised here through the throw path, which reaches the
    // same settleAndRearm helper without having to fake a 180s+ clock; the
    // deadline branch shares that helper and is the one that actually fired.
    async () => {
      const root = tempRoot()
      const { db } = createDb()
      const target = createTarget(root)
      const state = new Map<string, PendingWriter>()
      const msgs = session(12)
      const sid = target.sessionID
      let dispatched = 0
      try {
        fs.mkdirSync(path.join(root, "sessions", sid), { recursive: true })
        const childReply = { data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: checkpoint }] }] }
        const pick = (args: { path?: { id?: string } }) => (args?.path?.id === sid ? { data: msgs } : childReply)
        const deps: WriterDeps = {
          ...createDeps(root, db, pick),
          maxWriterRetries: 3,
          client: {
            session: {
              messages: pick,
              create: async () => ({ data: { id: `child-${dispatched}` } }),
              promptAsync: async () => {
                dispatched += 1
                return {}
              },
              status: async () => {
                throw new Error("status unavailable")
              },
            },
          },
        }
        runWriter(target, deps, state)
        // 12 × 20KB against a 135K budget is two batches, each settling on one
        // throw. Wait for the chain to finish so no watcher outlives the test.
        let settled = 0
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 250))
          settled = lastCheckpointMs(db, sid)
          if (settled >= BASE + 11_000) break
        }
        expect(dispatched).toBeGreaterThanOrEqual(2)
        expect(settled).toBe(BASE + 11_000)
        const after = dispatched
        await new Promise((r) => setTimeout(r, 1_500))
        expect(dispatched).toBe(after)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
    20_000,
  )

  test(
    "the deadline branch re-arms, not just idle and throw",
    // The call site that actually broke twice. d822c2a claimed to fix the
    // deadline branch but shipped it unfixed: a `cp` of an already-deleted
    // backup restored nothing, the mutation went unnoticed because the
    // negative test's replace was a no-op, and every test still passed. Only a
    // real 134KB run against a live provider caught it — the loop stopped after
    // one batch again.
    //
    // The clock is advanced monotonically so each batch crosses its own
    // deadline on the first poll and the chain converges. An earlier attempt
    // froze the offset, which left the last batch's watcher polling forever once
    // the clock was restored, and its errors landed on unrelated tests.
    async () => {
      const root = tempRoot()
      const { db } = createDb()
      const target = createTarget(root)
      const state = new Map<string, PendingWriter>()
      const msgs = session(12)
      const sid = target.sessionID
      let dispatched = 0
      let childID = ""
      let settled = 0
      try {
        fs.mkdirSync(path.join(root, "sessions", sid), { recursive: true })
        const childReply = { data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: checkpoint }] }] }
        const pick = (args: { path?: { id?: string } }) => (args?.path?.id === sid ? { data: msgs } : childReply)
        const deps: WriterDeps = {
          ...createDeps(root, db, pick),
          maxWriterRetries: 3,
          client: {
            session: {
              messages: pick,
                create: async () => {
                  childID = `child-${dispatched}`
                  return { data: { id: childID } }
                },
                promptAsync: async () => {
                  dispatched += 1
                  return {}
                },
                // The child stays in the map, so the only exit left is the
                // deadline. Keyed by the id actually handed out above, since
                // /session/status is a map — a hardcoded key would leave the
                // child absent, which now means idle and would exit early.
                status: async () => ({ data: { [childID]: { type: "busy" } } }),
            },
          },
        }
        const realNow = Date.now
        let ticks = 0
        Date.now = () => (++ticks <= 2 ? realNow() : realNow() + ticks * 10_000_000)
        try {
          runWriter(target, deps, state)
          for (let i = 0; i < 60; i++) {
            await new Promise((r) => setTimeout(r, 250))
            settled = lastCheckpointMs(db, sid)
            if (settled >= BASE + 11_000) break
          }
        } finally {
          Date.now = realNow
        }
        // Two batches of 12 × 20KB against a 135K budget, both settled through
        // the deadline branch.
        expect(dispatched).toBe(2)
        expect(settled).toBe(BASE + 11_000)
        const after = dispatched
        await new Promise((r) => setTimeout(r, 1_500))
        expect(dispatched).toBe(after)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
    25_000,
  )

  test(
    "a child that is idle but past the deadline is reported as idle, not as a timeout",
    // The poll runs every 5s, so a child finishing at 888s against an 891s
    // budget lands on a poll where the deadline has already passed. Checking the
    // deadline first recorded that as "deadline reached" — the same log line a
    // genuinely cut-off child produces, leaving no way to tell whether the
    // coefficient is too low or the poll merely missed the window. Observed on a
    // real 134KB batch: 892.5s against 891.2s.
    async () => {
      const root = tempRoot()
      const { db } = createDb()
      const target = createTarget(root)
      const state = new Map<string, PendingWriter>()
      const msgs = session(12)
      const sid = target.sessionID
      const logs: string[] = []
      let dispatched = 0
      try {
        fs.mkdirSync(path.join(root, "sessions", sid), { recursive: true })
        const childReply = { data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: checkpoint }] }] }
        const pick = (args: { path?: { id?: string } }) => (args?.path?.id === sid ? { data: msgs } : childReply)
        const deps: WriterDeps = {
          ...createDeps(root, db, pick),
          maxWriterRetries: 3,
          client: {
            session: {
              messages: pick,
              create: async () => ({ data: { id: `child-${dispatched}` } }),
              promptAsync: async () => {
                dispatched += 1
                return {}
              },
              // Idle on the first probe, and the clock is already past the
              // deadline. Idle must win, and the loop must end on this poll.
              status: async () => ({ data: {} }),   // absent = idle
            },
            app: {
              log: async (args: { body: { message: string } }) => {
                logs.push(args.body.message)
              },
            },
          },
        }
        const realNow = Date.now
        const t0 = realNow()
        let jumped = false
        // Jump the clock once real time has moved on, not after a fixed number
        // of Date.now calls. Everything before the first poll — pending.createdAt,
        // the orphan record, startedAt — happens within milliseconds, and the
        // poll then sleeps 5 real seconds. Counting calls instead would be
        // brittle: an unrelated timestamp added anywhere upstream would shift
        // the count and silently stop the test discriminating anything.
        Date.now = () => {
          const real = realNow()
          if (!jumped && real - t0 > 1_000) jumped = true
          return jumped ? real + 10_000_000 : real
        }
        try {
          runWriter(target, deps, state)
          // Wait for the settle, not the dispatch: `dispatched` flips during
          // spawnWriter, while settlement only happens on the first 5s poll.
          for (let i = 0; i < 60 && lastCheckpointMs(db, sid) === 0; i++) {
            await new Promise((r) => setTimeout(r, 250))
          }
        } finally {
          Date.now = realNow
        }
        // Settled through the idle branch: no timeout line was logged, and the
        // cursor advanced.
        expect(dispatched).toBeGreaterThanOrEqual(1)
        expect(logs.some((l) => l.includes("deadline reached"))).toBe(false)
        expect(lastCheckpointMs(db, sid)).toBeGreaterThan(0)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
    20_000,
  )
})

describe("late settle guard", () => {
  test("does not let a stale result overwrite a newer checkpoint file", async () => {
    const root = tempRoot()
    const { db } = createDb()
    const stale = `${checkpoint}\n\n## 补充\n- 迟到结果带来的额外内容`
    const fresh = "# Checkpoint\n## Summary\n更新的内容\n"
    // 先落一份较新的文件，再让一次更早开始时刻的结算跑完
    const { deps, logs } = createLoggedDeps(root, db, okMessages(stale))
    const target = createTarget(root)
    try {
      fs.mkdirSync(path.join(root, "sessions", target.sessionID), { recursive: true })
      fs.writeFileSync(checkpointPath(root, target.sessionID), fresh, "utf8")
      const future = new Date(Date.now() + 10_000)
      fs.utimesSync(checkpointPath(root, target.sessionID), future, future)
      await finalizeWriter(deps, target, "child-stale")
      expect(fs.readFileSync(checkpointPath(root, target.sessionID), "utf8")).toBe(fresh)
      expect(logs.some((l) => l.message.includes("skipped as stale"))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("project append idempotency", () => {
  test("skips a window the project file already covers, even mid-file", () => {
    const root = tempRoot()
    const projectDir = path.join(root, "project")
    const memoryPath = path.join(root, "projects", resolveProjectId(projectDir), "MEMORY.md")
    const { db, values } = createDb()
    try {
      expect(appendProjectMemory(root, projectDir, "第一段", db, "s1", 1000)).toBe(true)
      expect(appendProjectMemory(root, projectDir, "第二段", db, "s2", 2000)).toBe(true)
      const afterTwo = fs.readFileSync(memoryPath, "utf8")
      // 重放第一段：水位更旧，且不在尾部，尾���比对会漏掉
      expect(appendProjectMemory(root, projectDir, "第一段", db, "s1", 1000)).toBe(true)
      expect(fs.readFileSync(memoryPath, "utf8")).toBe(afterTwo)
      expect(values.get(`project_appended:${resolveProjectId(projectDir)}`)).toBe("2000")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("writer retry cap", () => {
  test("suppresses dispatch once consecutive failures reach the limit", async () => {
    const root = tempRoot()
    const { db, values } = createDb()
    let createCalls = 0
    const { deps, logs } = createLoggedDeps(root, db, okMessages(checkpoint))
    deps.client = {
      session: {
        messages: async () => ({ data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "父会话增量内容" }] }] }),
        create: async () => {
          createCalls += 1
          return { data: { id: "spawned" } }
        },
        promptAsync: async () => ({ data: true }),
        status: async () => ({ data: {} }),
      },
      app: { log: (a: { body: { level: string; message: string } }) => { logs.push({ level: a.body.level, message: a.body.message }); return Promise.resolve() } },
    } as unknown as WriterDeps["client"]
    const target = createTarget(root)
    const state = new Map<string, PendingWriter>()
    try {
      // 未达上限：正常派发
      runWriter(target, deps, state)
      await Bun.sleep(50)
      expect(createCalls).toBe(1)
      expect(logs.some((l) => l.message.includes("writer suppressed"))).toBe(false)

      // 连续失败到上限：闸门拦下派发
      state.clear()
      bumpWriterFail(db, target.sessionID)
      bumpWriterFail(db, target.sessionID)
      bumpWriterFail(db, target.sessionID)
      expect(writerFailCount(db, target.sessionID)).toBe(3)
      runWriter(target, deps, state)
      expect(createCalls).toBe(1)
      expect(logs.some((l) => l.message.includes("writer suppressed"))).toBe(true)

      // 一次成功后计数清零
      clearWriterFail(db, target.sessionID)
      expect(writerFailCount(db, target.sessionID)).toBe(0)
      expect(values.has(`writer_fail:${target.sessionID}`)).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("counts an empty child reply as a failure", async () => {
    const root = tempRoot()
    const { db } = createDb()
    const { deps, logs } = createLoggedDeps(root, db, okMessages(""))
    const target = createTarget(root)
    try {
      await finalizeWriter(deps, target, "child-empty")
      expect(writerFailCount(db, target.sessionID)).toBe(1)
      expect(logs.some((l) => l.message.includes("produced no output"))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("sectioned project memory", () => {
  const deltaLine = (obj: Record<string, string>) => {
    const sections = Object.entries(obj).map(([k, v]) => `## ${k}\n${v}`).join("\n")
    return `<!-- project-memory-delta\n${sections}\n-->`
  }

  const fourKeys = {
    "Project context": "- 这是一个开源插件",
    Rules: "- 禁止直推 main",
    "Architecture decisions": "- 记忆用两库而非单库",
    "Discovered durable knowledge": "- Path.contains 在 .NET 上语义不同",
  }

  test("merges a delta into the four sections and keeps the file bounded", async () => {
    const root = tempRoot()
    const { db, values } = createDb()
    const projectDir = path.join(root, "project")
    const memoryPath = path.join(root, "projects", resolveProjectId(projectDir), "MEMORY.md")
    const reply = `${checkpoint}\n\n${deltaLine(fourKeys)}\nCHECKPOINT_DONE`
    const { deps, logs } = createLoggedDeps(root, db, okMessages(reply))
    const target = createTarget(projectDir)
    try {
      await finalizeWriter(deps, target, "child-merge")
      const merged = fs.readFileSync(memoryPath, "utf8")
      for (const [k, v] of Object.entries(fourKeys)) expect(merged).toContain(`## ${k}`)
      expect(merged).toContain("- 禁止直推 main")
      // checkpoint 自身不应进项目记忆，delta 块也不该出现
      expect(merged).not.toContain("并发 settle 回归测试")
      expect(merged).not.toContain("project-memory-delta")
      // checkpoint 文件里同样不能有 delta 块
      const cp = fs.readFileSync(checkpointPath(root, target.sessionID), "utf8")
      expect(cp).not.toContain("project-memory-delta")
      expect(cp).toContain("## Summary")
      expect(values.has(`memory_layout:${resolveProjectId(projectDir)}`)).toBe(true)
      expect(logs.some((l) => l.message.includes("falling back to append"))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("accumulates a second delta into the same sections without appending raw", async () => {
    const root = tempRoot()
    const { db } = createDb()
    const projectDir = path.join(root, "project")
    const memoryPath = path.join(root, "projects", resolveProjectId(projectDir), "MEMORY.md")
    let { deps } = createLoggedDeps(root, db, okMessages(`${checkpoint}\n\n${deltaLine(fourKeys)}\nCHECKPOINT_DONE`))
    const target = createTarget(projectDir)
    try {
      await finalizeWriter(deps, target, "child-1")
      const first = fs.readFileSync(memoryPath, "utf8")
      const second = `${checkpoint}\n\n${deltaLine({ ...fourKeys, Rules: "- 提交前必须跑测试" })}\nCHECKPOINT_DONE`
      ;({ deps } = createLoggedDeps(root, db, okMessages(second)))
      await finalizeWriter(deps, target, "child-2")
      const merged = fs.readFileSync(memoryPath, "utf8")
      expect(merged).toContain("- 禁止直推 main")
      expect(merged).toContain("- 提交前必须跑测试")
      expect(merged.length).toBeLessThan(first.length * 2)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("falls back to append when the delta block has no recognised section", async () => {
    const root = tempRoot()
    const { db } = createDb()
    const projectDir = path.join(root, "project")
    const memoryPath = path.join(root, "projects", resolveProjectId(projectDir), "MEMORY.md")
    const reply = `${checkpoint}\n\n<!-- project-memory-delta\n## 完全不认识的标题\n- 内容\n-->\nCHECKPOINT_DONE`
    const { deps, logs } = createLoggedDeps(root, db, okMessages(reply))
    const target = createTarget(projectDir)
    try {
      await finalizeWriter(deps, target, "child-bad")
      const merged = fs.readFileSync(memoryPath, "utf8")
      expect(merged).toContain("并发 settle 回归测试")
      expect(logs.some((l) => l.message.includes("no recognised section heading"))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("truncates the oldest lines when a section outgrows its budget", async () => {
    const root = tempRoot()
    const { db } = createDb()
    const projectDir = path.join(root, "project")
    const memoryPath = path.join(root, "projects", resolveProjectId(projectDir), "MEMORY.md")
    const fat = "- " + "内".repeat(400)
    const big: Record<string, string> = {}
    for (let i = 0; i < 12; i++) big["Discovered durable knowledge"] = `${big["Discovered durable knowledge"] ?? ""}\n- 第${i}条 ${fat}`
    let reply = `${checkpoint}\n\n${deltaLine(big)}\nCHECKPOINT_DONE`
    const { deps, logs } = createLoggedDeps(root, db, async () => ({
      data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: reply }] }],
    }))
    const target = createTarget(projectDir)
    try {
      for (let i = 0; i < 8; i++) {
        reply = `${checkpoint}\n\n${deltaLine({ ...big, "Discovered durable knowledge": `${big["Discovered durable knowledge"]}\n- 第${i}轮新增` })}\nCHECKPOINT_DONE`
        await finalizeWriter(deps, { ...target, sessionID: `sess-${i}` }, `child-${i}`)
      }
      const merged = fs.readFileSync(memoryPath, "utf8")
      const section = merged.split("## Discovered durable knowledge")[1] ?? ""
      expect(Buffer.byteLength(section, "utf8")).toBeLessThanOrEqual(SECTION_CAPS["Discovered durable knowledge"] + 300)
      // 最新的内容必须留下，砍掉的应该是头部
      expect(section).toContain("第7轮新增")
      expect(logs.some((l) => l.message.includes("project memory truncated"))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("layout migration", () => {
  test("folds a legacy MEMORY.md into the four sections, once", () => {
    const root = tempRoot()
    const { db, values } = createDb()
    const projectDir = path.join(root, "project")
    const pid = resolveProjectId(projectDir)
    const memoryPath = path.join(root, "projects", pid, "MEMORY.md")
    fs.mkdirSync(path.join(root, "projects", pid), { recursive: true })
    fs.writeFileSync(memoryPath, "# 项目记忆\n\n## 旧的自定义小节\n- 旧内容 A\n- 旧内容 B\n", "utf8")
    const classified = {
      "Project context": "- 旧内容 A",
      Rules: "",
      "Architecture decisions": "- 旧内容 B",
      "Discovered durable knowledge": "",
    }
    try {
      const first = migrateMemoryLayout(db, root, projectDir, pid, classified)
      expect(first).toEqual({ migrated: true, reason: "migrated" })
      const merged = fs.readFileSync(memoryPath, "utf8")
      expect(merged).toContain("## Project context")
      expect(merged).toContain("## Discovered durable knowledge")
      expect(merged).not.toContain("## 旧的自定义小节")
      expect(merged).toContain("- 旧内容 A")
      // 幂等：第二次直接跳过
      const second = migrateMemoryLayout(db, root, projectDir, pid, null)
      expect(second).toEqual({ migrated: false, reason: "already-migrated" })
      expect(fs.readFileSync(memoryPath, "utf8")).toBe(merged)
      expect(values.get(`memory_layout:${pid}`)).toBeTruthy()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("refuses to guess when no classification is supplied", () => {
    const root = tempRoot()
    const { db, values } = createDb()
    const projectDir = path.join(root, "project")
    const pid = resolveProjectId(projectDir)
    fs.mkdirSync(path.join(root, "projects", pid), { recursive: true })
    fs.writeFileSync(path.join(root, "projects", pid, "MEMORY.md"), "旧的自由格式内容", "utf8")
    try {
      expect(migrateMemoryLayout(db, root, projectDir, pid, null)).toEqual({
        migrated: false,
        reason: "needs-classification",
      })
      expect(fs.readFileSync(path.join(root, "projects", pid, "MEMORY.md"), "utf8")).toBe("旧的自由格式内容")
      expect(values.has(`memory_layout:${pid}`)).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("bullet normalization", () => {
  test("splits a squashed bullet run onto separate lines", () => {
    expect(normalizeBullets("- 第一条。- 第二条。- 第三条。")).toBe("- 第一条。\n- 第二条。\n- 第三条。")
  })

  test("leaves ordinary prose and dash usage alone", () => {
    const prose = "- 端口 6379 - 密码 securepass，另一项 - 还要写"
    expect(normalizeBullets(prose)).toBe(prose)
    expect(normalizeBullets("- 范围 session → project → global")).toBe("- 范围 session → project → global")
    expect(normalizeBullets("无 bullet 的段落")).toBe("无 bullet 的段落")
  })

  test("keeps a real multi-line list untouched", () => {
    const list = "- 一\n- 二\n- 三"
    expect(normalizeBullets(list)).toBe(list)
  })
})

describe("global memory", () => {
  const globalLine = (obj: Record<string, string>) => {
    const sections = Object.entries(obj).map(([k, v]) => `## ${k}\n${v}`).join("\n")
    return `<!-- project-memory-delta\n${sections}\n-->`
  }

  test("merges an environment fact into global and leaves the project file alone", async () => {
    const root = tempRoot()
    const { db } = createDb()
    const projectDir = path.join(root, "project")
    const globalPath = path.join(root, "global", "MEMORY.md")
    const projectPath = path.join(root, "projects", resolveProjectId(projectDir), "MEMORY.md")
    const reply = `${checkpoint}\n\n${globalLine({ "Global (cross-project facts)": "- 本机没有 gh CLI，PR 只能网页创建" })}\nCHECKPOINT_DONE`
    const { deps, logs } = createLoggedDeps(root, db, okMessages(reply))
    const target = createTarget(projectDir)
    try {
      await finalizeWriter(deps, target, "child-global")
      const global = fs.readFileSync(globalPath, "utf8")
      expect(global).toContain("## 已沉淀事实")
      expect(global).toContain("本机没有 gh CLI")
      // 只有 global 内容时不应重写项目记忆，也不该退回追加路径
      expect(fs.existsSync(projectPath)).toBe(false)
      expect(logs.some((l) => l.message.includes("falling back to append"))).toBe(false)
      expect(logs.filter((l) => l.level === "error")).toHaveLength(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("routes project and global facts to their own files in one settle", async () => {
    const root = tempRoot()
    const { db } = createDb()
    const projectDir = path.join(root, "project")
    const reply = `${checkpoint}\n\n${globalLine({
      "Architecture decisions": "- 本项目记忆不设体积上限",
      "Global (cross-project facts)": "- PowerShell 处理中文引号会吞引号",
    })}\nCHECKPOINT_DONE`
    const { deps } = createLoggedDeps(root, db, okMessages(reply))
    const target = createTarget(projectDir)
    try {
      await finalizeWriter(deps, target, "child-both")
      const global = fs.readFileSync(path.join(root, "global", "MEMORY.md"), "utf8")
      const project = fs.readFileSync(path.join(root, "projects", resolveProjectId(projectDir), "MEMORY.md"), "utf8")
      expect(global).toContain("PowerShell")
      expect(global).not.toContain("体积上限")
      expect(project).toContain("本项目记忆不设体积上限")
      expect(project).not.toContain("PowerShell")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("a replayed watermark does not duplicate", () => {
    const root = tempRoot()
    const { db } = createDb()
    const globalPath = path.join(root, "global", "MEMORY.md")
    const fact = "- 用户在 Windows 上开发，路径分隔符需注意"
    try {
      expect(mergeGlobalMemory(root, fact, db, 1000).ok).toBe(true)
      const first = fs.readFileSync(globalPath, "utf8")
      // 同一水位重放（失败重试场景）：不得再次追加
      expect(mergeGlobalMemory(root, fact, db, 1000).ok).toBe(true)
      expect(fs.readFileSync(globalPath, "utf8")).toBe(first)
      expect(first.split("用户在 Windows 上开发").length - 1).toBe(1)
      // 更旧的水位同样跳过
      expect(mergeGlobalMemory(root, fact, db, 500).ok).toBe(true)
      expect(fs.readFileSync(globalPath, "utf8")).toBe(first)
      // 更大的水位是新增量，应当追加
      expect(mergeGlobalMemory(root, "- 后来的事实", db, 2000).ok).toBe(true)
      expect(fs.readFileSync(globalPath, "utf8")).toContain("后来的事实")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("truncates global when it outgrows its cap, keeping the newest", async () => {
    const root = tempRoot()
    const { db } = createDb()
    const fat = "- " + "惯".repeat(400)
    let reply = `${checkpoint}\n\n${globalLine({ "Global (cross-project facts)": `${fat}\n- 最早的条目` })}\nCHECKPOINT_DONE`
    const { deps, logs } = createLoggedDeps(root, db, async () => ({
      data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: reply }] }],
    }))
    try {
      for (let i = 0; i < 6; i++) {
        reply = `${checkpoint}\n\n${globalLine({ "Global (cross-project facts)": `${fat}\n- 第${i}轮新增` })}\nCHECKPOINT_DONE`
        await finalizeWriter(deps, { sessionID: `g-${i}`, projectDir: root, title: "t" }, `gc-${i}`)
      }
      const global = fs.readFileSync(path.join(root, "global", "MEMORY.md"), "utf8")
      expect(Buffer.byteLength(global, "utf8")).toBeLessThanOrEqual(GLOBAL_CAP + 400)
      expect(logs.some((l) => l.message.includes("global memory truncated"))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})


describe("delta block content tolerance", () => {
  test("parses Windows paths, quotes and arrows verbatim", () => {
    const block = [
      "<!-- project-memory-delta",
      "## Project context",
      "- 本地目录 `D:\RMANBAK\opencode-promemory-4861`，生产目录 `D:\RMANBAK\.opencode\plugins`",
      '- 标题里带引号："Project context" 与 \'single\' 都能留',
      "- 箭头 --> 不是结束标记",
      "## Global (cross-project facts)",
      "- 临时目录 `C:\Users\ADMINI~1\AppData\Local\Temp`；换行后继续写",
      "  - 缩进的续行也在同一段里",
      "-->",
    ].join("\n")
    const got = extractDelta(block)
    expect(got).not.toBeNull()
    expect(got!.project["Project context"]).toContain("D:\RMANBAK\opencode-promemory-4861")
    expect(got!.project["Project context"]).toContain('"Project context"')
    expect(got!.project["Project context"]).toContain("箭头 --> 不是结束标记")
    expect(got!.global).toContain("C:\Users\ADMINI~1\AppData\Local\Temp")
    expect(got!.global).toContain("缩进的续行")
  })

  test("the real-world failure case: unescaped backslash paths used to break JSON", () => {
    // This is the exact content that failed in production: a JSON block where
    // some Windows paths were written with single backslashes, making \R an
    // illegal escape and failing the whole parse. The markdown format has no
    // escaping requirement, so the same content now parses.
    const block = [
      "<!-- project-memory-delta",
      "## Project context",
      "- 本地目录 `D:\RMANBAK`，另一处写成 D:\cygwin\home\Administrator",
      '## Discovered durable knowledge',
      "- 结论: 前面有冒号也不影响解析",
      "-->",
    ].join("\n")
    const got = extractDelta(block)
    expect(got).not.toBeNull()
    expect(got!.project["Project context"]).toContain("D:\RMANBAK")
    expect(got!.project["Discovered durable knowledge"]).toContain("冒号也不影响解析")
  })

  test("ignores unknown headings instead of failing the whole block", () => {
    const block = [
      "<!-- project-memory-delta",
      "## 随便一个标题",
      "- 不该被采纳",
      "## Rules",
      "- 这条应该被采纳",
      "-->",
    ].join("\n")
    const got = extractDelta(block)
    expect(got).not.toBeNull()
    expect(got!.project.Rules).toBe("- 这条应该被采纳")
    expect(JSON.stringify(got)).not.toContain("不该被采纳")
  })

  test("returns null when no recognised heading carries content", () => {
    expect(extractDelta("<!-- project-memory-delta\n## 空的\n-->\n")).toBeNull()
    expect(extractDelta("没有 delta 块")).toBeNull()
  })
})

describe("dream verification", () => {
  const memoryOf = (root: string, projectDir: string) =>
    path.join(root, "projects", resolveProjectId(projectDir), "MEMORY.md")

  test("reports a revision: lines removed and added are both counted", () => {
    const root = tempRoot()
    const projectDir = path.join(root, "project")
    const p = memoryOf(root, projectDir)
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, ["## Rules", "- 旧事实：格式是 JSON", "- 保留事实", ""].join("\n"), "utf8")
      const snap = snapshotProjectMemory(root, projectDir)
      expect(snap).not.toBeNull()
      // dream 修订：删掉过时那条，改写另一条，再加一条新的
      fs.writeFileSync(p, ["## Rules", "- 保留事实", "- 新事实：格式是 markdown", ""].join("\n"), "utf8")
      const diff = diffProjectMemory(snap, root)!
      expect(diff.changed).toBe(true)
      expect(diff.removed).toBe(1)
      expect(diff.added).toBe(1)
      expect(diff.linesBefore).toBe(3)
      expect(diff.linesAfter).toBe(3)
      expect(describeDreamDiff(diff)).toContain("删 1 行 / 增 1 行")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("flags an append-only run, which is not a revision", () => {
    const root = tempRoot()
    const projectDir = path.join(root, "project")
    const p = memoryOf(root, projectDir)
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, "## Rules\n- 既有事实\n", "utf8")
      const snap = snapshotProjectMemory(root, projectDir)
      fs.writeFileSync(p, "## Rules\n- 既有事实\n- 只有新增\n", "utf8")
      const text = describeDreamDiff(diffProjectMemory(snap, root)!)
      expect(text).toContain("只有新增没有删除")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("flags a no-op run instead of reporting success", () => {
    const root = tempRoot()
    const projectDir = path.join(root, "project")
    const p = memoryOf(root, projectDir)
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, "## Rules\n- 既有事实\n", "utf8")
      const snap = snapshotProjectMemory(root, projectDir)
      const text = describeDreamDiff(diffProjectMemory(snap, root)!)
      expect(text).toContain("未改动项目记忆")
      expect(text).toContain("说明它没有生效")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("returns null when there is no project memory to snapshot", () => {
    const root = tempRoot()
    const other = tempRoot()
    try {
      expect(snapshotProjectMemory(root, path.join(root, "nope"))).toBeNull()
      expect(snapshotProjectMemory(root, undefined)).toBeNull()
      expect(diffProjectMemory(null, other)).toBeNull()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(other, { recursive: true, force: true })
    }
  })
})
