import { Plugin } from "@opencode-ai/plugin"
import { Database } from "bun:sqlite"
import path from "path"
import os from "os"
import fs from "fs"
import { wrapBunDb, type Db } from "./project-memory/src/memory/db.ts"
import { initMemoryFts, reconcileMemory, metaGet, metaSet } from "./project-memory/src/memory/fts.ts"
import { listFiles } from "./project-memory/src/memory/storage.ts"
import {
  initHistoryFts,
  upsertMirrorPart,
  deleteMirrorMessage,
  deleteMirrorSession,
  catchupHistory,
  backfillProjectIds,
} from "./project-memory/src/history/mirror.ts"
import { partsFromMessage } from "./project-memory/src/history/service.ts"
import { resolveProjectId } from "./project-memory/src/memory/paths.ts"
import { createMemoryTool } from "./project-memory/src/tools/memory.ts"
import { createHistoryTool } from "./project-memory/src/tools/history.ts"
import {
  settleWriter,
  expireWriters,
  runWriter,
  persistOrphan,
  listOrphans,
  expireOrphans,
  type PendingWriter,
  type WriterDeps,
  type WriterTarget,
} from "./project-memory/src/session/writer.ts"
import { cleanupExpiredSessions } from "./project-memory/src/session/retention.ts"
import { createCompactionHandler } from "./project-memory/src/session/compaction-hook.ts"
import { resolveConfig, asMemoryPluginOptions, type MemoryPluginConfig } from "./project-memory/src/config.ts"

const memoryRoot = path.join(os.homedir(), ".config", "opencode", "memory")

function openDatabases(): { db: Db; historyDb: Db } {
  fs.mkdirSync(memoryRoot, { recursive: true })
  const rawDb = new Database(path.join(memoryRoot, "memory.db"))
  const rawHist = new Database(path.join(memoryRoot, "history.db"))
  rawDb.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")
  rawHist.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")
  return { db: wrapBunDb(rawDb), historyDb: wrapBunDb(rawHist) }
}

export const ProjectMemoryPlugin: Plugin = async ({ client, directory }, options) => {
  const cfg = resolveConfig(asMemoryPluginOptions(options as MemoryPluginConfig))

  const { db, historyDb } = openDatabases()
  initMemoryFts(db)
  initHistoryFts(historyDb)

  const blacklist = new Set<string>()
  const writerState = new Map<string, PendingWriter>()
  const settlingWriters = new Map<string, Promise<boolean>>()
  const finalizingWriters = new Map<string, Promise<boolean>>()

  const sessionPidCache = new Map<string, string>()
  const getProjectId = () => (directory ? resolveProjectId(directory) : null)

  async function pidForSession(sessionID: string): Promise<string | undefined> {
    const cached = sessionPidCache.get(sessionID)
    if (cached !== undefined) return cached || undefined
    try {
      const res = await client.session.get({ path: { id: sessionID } })
      const dir = (res?.data as { directory?: string } | undefined)?.directory
      const pid = dir ? resolveProjectId(dir) : ""
      sessionPidCache.set(sessionID, pid)
      return pid || undefined
    } catch {
      sessionPidCache.set(sessionID, "")
      return undefined
    }
  }

  const reconcile = () => reconcileMemory(db, listFiles(memoryRoot, []))

  const writerDeps: WriterDeps = {
    client,
    db,
    root: memoryRoot,
    toolsWhitelist: {},
    writerPrompt: fs.readFileSync(path.join(import.meta.dir, "project-memory", "src", "session", "writer-prompt.txt"), "utf8"),
    blacklist,
    settling: settlingWriters,
    finalizing: finalizingWriters,
    projectDir: directory ?? undefined,
  }

  const sessionsProvider = async () => {
    try {
      const res = await client.session.list()
      return (res?.data ?? []) as Array<{ id: string; directory?: string }>
    } catch {
      return []
    }
  }

  const compactionHandler = createCompactionHandler(
    {
      ...writerDeps,
      db,
      markCheckpoint: () => undefined,
      hasPendingIncrement(sessionID) {
        return !writerState.has(sessionID)
      },
    },
    writerState,
  )

  const settleStartupOrphans = async () => {
    const orphans = await listOrphans(memoryRoot)
    for (const o of orphans) {
      try {
        const res = await client.session.status({ path: { id: o.childSessionID } })
        const entry = (res?.data ?? res) as Record<string, { type?: string }> | undefined
        const status = entry?.[o.childSessionID] ?? Object.values(entry ?? {})[0]
        const busy = status?.type === "busy" || status?.type === "retry"
        if (busy) continue
        await settleWriter(writerDeps, writerState, o.childSessionID)
      } catch {
        continue
      }
    }
  }

  void sessionsProvider().then(async (sessions) => {
    for (const s of sessions) {
      if (s.directory) sessionPidCache.set(s.id, resolveProjectId(s.directory))
    }
    if (cfg.disableWrite) return
    try {
      backfillProjectIds(historyDb, sessions)
    } catch {
      // 存量回填失败不阻塞插件
    }
    try {
      await catchupHistory(historyDb, client, sessions, blacklist)
    } catch {
      // 启动补齐失败不阻塞插件
    }
    try {
      await settleStartupOrphans()
    } catch {
      // 孤儿接管失败不阻塞插件
    }
  })

  const retentionTimer = setInterval(() => {
    cleanupExpiredSessions(memoryRoot, cfg.retentionDays)
  }, cfg.retentionCleanupIntervalMs)

  const writerEnabled = () => !cfg.disableWrite

  return {
    tool: {
      memory: createMemoryTool({
        db: () => db,
        reconcile: () => reconcile(),
        scoreFloor: () => cfg.searchScoreFloor,
        getProjectId,
      }),
      history: createHistoryTool({
        db: () => historyDb,
        scoreFloor: () => cfg.searchScoreFloor,
        getProjectId,
      }),
    },
    "experimental.session.compacting": async (input) => {
      if (cfg.disableWrite) return
      await compactionHandler(input)
    },
    "command.execute.before": async (input, output) => {
      const cmd = input.command.replace(/^\/+/, "")
      if (cmd === "mem-checkpoint" && writerEnabled()) {
        runWriter(
          { sessionID: input.sessionID, title: "手动 checkpoint", projectDir: writerDeps.projectDir },
          writerDeps,
          writerState,
        )
        return
      }
      const interval: Record<string, { days: number; key: string; label: string }> = {
        "mem-dream": { days: cfg.dreamIntervalDays, key: "dream:last", label: "dream" },
        "mem-distill": { days: cfg.distillIntervalDays, key: "distill:last", label: "distill" },
      }
      const rule = interval[cmd]
      if (!rule || !writerEnabled()) return
      const lastRaw = metaGet(db, rule.key)
      const last = lastRaw ? Number(lastRaw) : NaN
      const now = Date.now()
      if (Number.isFinite(last) && now - last < rule.days * 24 * 60 * 60 * 1000) {
        const remaining = Math.ceil((rule.days * 24 * 60 * 60 * 1000 - (now - last)) / (24 * 60 * 60 * 1000))
        output.parts.splice(0, output.parts.length, { type: "text", text: `间隔检查（插件）：上次 ${rule.label} 距今不足 ${rule.days} 天（剩约 ${remaining} 天），本次跳过，不执行整合。` })
        return
      }
      metaSet(db, rule.key, String(now))
    },
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        const sid = (event.properties as any)?.sessionID as string | undefined
        if (sid) {
          await settleWriter(writerDeps, writerState, sid)
          expireWriters(writerDeps, writerState, cfg.writerTimeoutMs)
        }
        return
      }
      if (event.type === "session.status") {
        const props = event.properties as { sessionID?: string; status?: { type?: string } } | undefined
        if (props?.sessionID && props.status?.type === "idle") {
          await settleWriter(writerDeps, writerState, props.sessionID)
        }
        return
      }
      if (event.type === "message.updated") {
        const info = event.properties?.info as
          | { sessionID?: string; id?: string; time?: { completed?: number } }
          | undefined
        if (!info?.sessionID) return
        if (cfg.disableWrite) return
        if (blacklist.has(info.sessionID)) return
        if (!info.time?.completed) return
        const messageID = info.id
        if (!messageID) return
        try {
          const res = await client.session.message({ path: { id: info.sessionID, messageID } })
          const message = res.data as { info?: { id?: string }; parts?: Array<{ id?: string; type?: string; text?: string }> }
          if (!message) return
          const project_id = await pidForSession(info.sessionID)
          const parts = partsFromMessage(message as never, info.sessionID)
          for (const p of parts) upsertMirrorPart(historyDb, { ...p, project_id })
        } catch {
          return
        }
      } else if (event.type === "message.removed") {
        const info = event.properties?.info as { sessionID?: string; id?: string } | undefined
        if (info?.sessionID && info.id) deleteMirrorMessage(historyDb, info.sessionID, info.id)
      } else if (event.type === "session.updated") {
        const info = event.properties?.info as { id?: string; directory?: string } | undefined
        if (info?.id && info.directory) sessionPidCache.set(info.id, resolveProjectId(info.directory))
      } else if (event.type === "session.deleted") {
        const info = event.properties?.info as { id?: string } | undefined
        if (info?.id) {
          deleteMirrorSession(historyDb, info.id)
          blacklist.delete(info.id)
          sessionPidCache.delete(info.id)
        }
      }
    },
    dispose: async () => {
      clearInterval(retentionTimer)
    },
  }
}
