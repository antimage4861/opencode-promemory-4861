import { Plugin } from "@opencode-ai/plugin"
import { Database } from "bun:sqlite"
import path from "path"
import os from "os"
import fs from "fs"
import { wrapBunDb, type Db } from "./memory/db.ts"
import { initMemoryFts, reconcileMemory, metaGet, metaSet } from "./memory/fts.ts"
import { listFiles } from "./memory/storage.ts"
import {
  initHistoryFts,
  upsertMirrorPart,
  deleteMirrorMessage,
  deleteMirrorSession,
  catchupHistory,
} from "./history/mirror.ts"
import { partsFromMessage } from "./history/service.ts"
import { createMemoryTool } from "./tools/memory.ts"
import { createHistoryTool } from "./tools/history.ts"
import {
  settleWriter,
  expireWriters,
  runWriter,
  persistOrphan,
  removeOrphan,
  findOrphan,
  listOrphans,
  expireOrphans,
  finalizeWriter,
  type PendingWriter,
  type WriterDeps,
  type WriterTarget,
} from "./session/writer.ts"
import {
  recordActivity,
  startScanner,
  cleanupExpiredSessions,
  type ScanDeps,
} from "./session/scanner.ts"
import { createCompactionHandler } from "./session/compaction-hook.ts"
import { WRITER_PROMPT } from "./session/prompt.ts"
import { resolveConfig, asMemoryPluginOptions, type MemoryPluginConfig } from "./config.ts"

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

  const reconcile = () => reconcileMemory(db, listFiles(memoryRoot, []))

  const writerDeps: WriterDeps = {
    client,
    db,
    root: memoryRoot,
    toolsWhitelist: { memory: true, history: true },
    writerPrompt: WRITER_PROMPT,
    blacklist,
    projectDir: directory ?? undefined,
  }

  const scanDeps: ScanDeps = {
    ...writerDeps,
    db,
    idleCheckpointTimeoutMs: cfg.idleCheckpointTimeoutMs,
    idleCheckIntervalMs: cfg.idleCheckIntervalMs,
    writeEnabled: !cfg.disableWrite,
  }

  const sessionsProvider = async () => {
    try {
      const res = await client.session.list()
      return (res?.data ?? []) as Array<{ id: string }>
    } catch {
      return []
    }
  }

  const scanner = startScanner(scanDeps, writerState, sessionsProvider)

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
        await finalizeWriter(writerDeps, o.target, o.childSessionID)
        await removeOrphan(memoryRoot, o.childSessionID)
      } catch {
        continue
      }
    }
  }

  void sessionsProvider().then(async (sessions) => {
    for (const s of sessions) {
      recordActivity(s.id)
    }
    if (cfg.disableWrite) return
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
      }),
      history: createHistoryTool({
        db: () => historyDb,
        scoreFloor: () => cfg.searchScoreFloor,
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
        recordActivity(info.sessionID)
        if (cfg.disableWrite) return
        if (blacklist.has(info.sessionID)) return
        if (!info.time?.completed) return
        const messageID = info.id
        if (!messageID) return
        try {
          const res = await client.session.message({ path: { id: info.sessionID, messageID } })
          const message = res.data as { info?: { id?: string }; parts?: Array<{ id?: string; type?: string; text?: string }> }
          if (!message) return
          const parts = partsFromMessage(message as never, info.sessionID)
          for (const p of parts) upsertMirrorPart(historyDb, p)
        } catch {
          return
        }
      } else if (event.type === "message.removed") {
        const info = event.properties?.info as { sessionID?: string; id?: string } | undefined
        if (info?.sessionID && info.id) deleteMirrorMessage(historyDb, info.sessionID, info.id)
      } else if (event.type === "session.deleted") {
        const info = event.properties?.info as { id?: string } | undefined
        if (info?.id) {
          deleteMirrorSession(historyDb, info.id)
          blacklist.delete(info.id)
        }
      }
    },
    dispose: async () => {
      scanner.stop()
      clearInterval(retentionTimer)
    },
  }
}
