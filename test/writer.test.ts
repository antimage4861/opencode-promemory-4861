import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolveProjectId } from "../src/memory/paths.ts"
import { projectMemoryTemplate } from "../src/memory/template.ts"
import { GLOBAL_CAP, SECTION_CAPS, mergeGlobalMemory, migrateMemoryLayout, normalizeBullets } from "../src/memory/merge.ts"
import type { Db } from "../src/memory/db.ts"
import {
  bumpWriterFail,
  clearWriterFail,
  writerFailCount,
  markCheckpoint,
  lastCheckpointMs,
  runWriter,
  appendProjectMemory,
  checkpointPath,
  finalizeWriter,
  persistOrphan,
  settleWriter,
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
      await finalizeWriter(deps, target, "child-fat")
      expect(fs.existsSync(checkpointPath(root, target.sessionID))).toBe(true)
      expect(values.get(`scanner:${target.sessionID}`)).toBeDefined()
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
        status: async () => ({ data: { status: { type: "idle" } } }),
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
  const deltaLine = (obj: Record<string, string>) =>
    `<!-- project-memory-delta ${JSON.stringify(obj)} -->`

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

  test("falls back to append when the delta block is malformed", async () => {
    const root = tempRoot()
    const { db } = createDb()
    const projectDir = path.join(root, "project")
    const memoryPath = path.join(root, "projects", resolveProjectId(projectDir), "MEMORY.md")
    const reply = `${checkpoint}\n\n<!-- project-memory-delta {不是合法 JSON} -->\nCHECKPOINT_DONE`
    const { deps, logs } = createLoggedDeps(root, db, okMessages(reply))
    const target = createTarget(projectDir)
    try {
      await finalizeWriter(deps, target, "child-bad")
      const merged = fs.readFileSync(memoryPath, "utf8")
      expect(merged).toContain("并发 settle 回归测试")
      expect(logs.some((l) => l.message.includes("unparseable, appending instead"))).toBe(true)
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
  const globalLine = (obj: Record<string, string>) =>
    `<!-- project-memory-delta ${JSON.stringify(obj)} -->`

  test("merges an environment fact into global and leaves the project file alone", async () => {
    const root = tempRoot()
    const { db } = createDb()
    const projectDir = path.join(root, "project")
    const globalPath = path.join(root, "global", "MEMORY.md")
    const projectPath = path.join(root, "projects", resolveProjectId(projectDir), "MEMORY.md")
    const reply = `${checkpoint}\n\n${globalLine({ global: "- 本机没有 gh CLI，PR 只能网页创建" })}\nCHECKPOINT_DONE`
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
      global: "- PowerShell 处理中文引号会吞引号",
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

  test("truncates global when it outgrows its cap, keeping the newest", () => {
    const root = tempRoot()
    const { db } = createDb()
    const fat = "- " + "惯".repeat(400)
    let reply = `${checkpoint}\n\n${globalLine({ global: `${fat}\n- 最早的条目` })}\nCHECKPOINT_DONE`
    const { deps, logs } = createLoggedDeps(root, db, async () => ({
      data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: reply }] }],
    }))
    try {
      return (async () => {
        for (let i = 0; i < 6; i++) {
          reply = `${checkpoint}\n\n${globalLine({ global: `${fat}\n- 第${i}轮新增` })}\nCHECKPOINT_DONE`
          await finalizeWriter(deps, { sessionID: `g-${i}`, projectDir: root, title: "t" }, `gc-${i}`)
        }
        const global = fs.readFileSync(path.join(root, "global", "MEMORY.md"), "utf8")
        expect(Buffer.byteLength(global, "utf8")).toBeLessThanOrEqual(GLOBAL_CAP + 400)
        expect(logs.some((l) => l.message.includes("global memory truncated"))).toBe(true)
      })()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

