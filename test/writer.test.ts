import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolveProjectId } from "../src/memory/paths.ts"
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
      expect(fs.readFileSync(memoryPath, "utf8")).toBe(checkpoint)
      await persistOrphan(root, target, childSessionID)
      await settleWriter(deps, state, childSessionID)
      expect(fs.readFileSync(memoryPath, "utf8")).toBe(checkpoint)
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
      expect(fs.readFileSync(memoryPath, "utf8")).toBe(checkpoint)
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
      expect(merged).toBe(bodies.join("\n\n"))
      expect(Buffer.byteLength(merged, "utf8")).toBeGreaterThan(10 * 1024)
      expect(merged.split("\n").length).toBeGreaterThan(200)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
