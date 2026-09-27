import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolveProjectId } from "../src/memory/paths.ts"
import { projectMemoryTemplate } from "../src/memory/template.ts"
import type { Db } from "../src/memory/db.ts"
import {
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
