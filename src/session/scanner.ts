import type { Db } from "../memory/db.ts"
import type { PendingWriter, WriterDeps } from "./writer.ts"
import { runWriter, lastCheckpointMs } from "./writer.ts"
import fs from "fs"
import path from "path"

export interface ScanDeps extends WriterDeps {
  db: Db
  idleCheckpointTimeoutMs: number
  idleCheckIntervalMs: number
  writeEnabled: boolean
}

const activityCache = new Map<string, number>()

export function recordActivity(sessionID: string) {
  activityCache.set(sessionID, Date.now())
}

export function clearActivity(sessionID: string) {
  activityCache.delete(sessionID)
}

export function cleanupExpiredSessions(root: string, retentionDays: number): number {
  if (retentionDays <= 0) return 0
  const sessionsDir = path.join(root, "sessions")
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  let removed = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = path.join(sessionsDir, e.name)
    try {
      const st = fs.statSync(dir)
      if (st.mtimeMs < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true })
        removed++
      }
    } catch {
      continue
    }
  }
  return removed
}

export function shouldCheckpoint(sessionID: string, db: Db, timeoutMs: number): boolean {
  const lastActivity = activityCache.get(sessionID)
  if (!lastActivity) return false
  const lastCp = lastCheckpointMs(db, sessionID)
  if (lastActivity <= lastCp) return false
  return Date.now() - lastActivity >= timeoutMs
}

export function scanSessions(deps: ScanDeps, sessions: Array<{ id: string }>, writerState: Map<string, PendingWriter>): void {
  if (!deps.writeEnabled) return
  for (const s of sessions) {
    if (deps.blacklist.has(s.id)) continue
    if (writerState.has(s.id)) continue
    if (!shouldCheckpoint(s.id, deps.db, deps.idleCheckpointTimeoutMs)) continue
    runWriter(
      { sessionID: s.id, title: "1h 空闲自动沉淀", projectDir: deps.projectDir },
      deps,
      writerState,
    )
  }
}

export function startScanner(
  deps: ScanDeps,
  writerState: Map<string, PendingWriter>,
  sessionsProvider: () => Promise<Array<{ id: string }>>,
): { stop(): void } {
  const timer = setInterval(() => {
    void sessionsProvider().then((sessions) => scanSessions(deps, sessions, writerState))
  }, deps.idleCheckIntervalMs)
  return {
    stop() {
      clearInterval(timer)
    },
  }
}
