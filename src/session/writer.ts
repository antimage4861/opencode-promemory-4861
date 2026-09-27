import fs from "fs"
import path from "path"
import { buildPath, resolveProjectId } from "../memory/paths.ts"
import { writeMemoryFile, readMemoryFile, withFileLock } from "../memory/storage.ts"
import { ensureMemoryTemplate } from "../memory/template.ts"
import { validateCheckpoint } from "./validator.ts"
import type { Db } from "../memory/db.ts"
import { metaGet, metaSet } from "../memory/fts.ts"

const INCREMENT_BUDGET = 24_000
const WRITER_SYSTEM_BUDGET = 6_000
const CP_KEY_PREFIX = "scanner:"
const FAIL_KEY_PREFIX = "writer_fail:"
const APPEND_KEY_PREFIX = "project_appended:"

interface OrphanRecord {
  childSessionID: string
  target: WriterTarget
  createdAt: number
}

export interface WriterTarget {
  sessionID: string
  parentID?: string
  projectDir?: string
  title: string
}

export interface WriterDeps {
  client: any
  db: Db
  root: string
  toolsWhitelist: Record<string, boolean>
  writerPrompt: string
  blacklist: Set<string>
  settling: Map<string, Promise<boolean>>
  finalizing: Map<string, Promise<boolean>>
  projectDir?: string
  maxWriterRetries: number
}

export interface PendingWriter {
  target: WriterTarget
  childSessionID: string
  createdAt: number
  done: boolean
}

export function lastCheckpointMs(db: Db, sessionID: string): number {
  const raw = metaGet(db, `${CP_KEY_PREFIX}${sessionID}`)
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) ? n : 0
}

/**
 * Failure reporting for the writer pipeline. Every write/validate failure used
 * to be silent: the caller discarded return values, so a rejected or
 * unwritable checkpoint simply vanished. Logging goes through the opencode app
 * log API (falls back to nothing if the SDK shape differs) — a logger must
 * never itself break the write path.
 */
function reportFailure(deps: WriterDeps, level: "warn" | "error", message: string): void {
  try {
    void deps.client?.app?.log?.({ body: { service: "project-memory", level, message } })
  } catch {
    void 0
  }
}

/**
 * Advance the watermark, never backwards. Two writer children for the same
 * session can settle out of order (different compaction / manual triggers);
 * an unconditional Date.now() meant the later-to-settle one pushed the mark
 * past a window the other had not recorded yet, skipping it for good.
 */
export function markCheckpoint(db: Db, sessionID: string, ms = Date.now()): boolean {
  const key = `${CP_KEY_PREFIX}${sessionID}`
  if (lastCheckpointMs(db, sessionID) >= ms) return false
  metaSet(db, key, String(ms))
  return true
}

export function writerFailCount(db: Db, sessionID: string): number {
  const raw = metaGet(db, `${FAIL_KEY_PREFIX}${sessionID}`)
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) ? n : 0
}

export function bumpWriterFail(db: Db, sessionID: string): number {
  const next = writerFailCount(db, sessionID) + 1
  metaSet(db, `${FAIL_KEY_PREFIX}${sessionID}`, String(next))
  return next
}

export function clearWriterFail(db: Db, sessionID: string): void {
  metaSet(db, `${FAIL_KEY_PREFIX}${sessionID}`, "0")
}

async function readIncrement(deps: WriterDeps, target: WriterTarget): Promise<{
  body: string
  full: boolean
  model?: { providerID: string; modelID: string }
}> {
  const res = await deps.client.session.messages({ path: { id: target.sessionID } })
  const messages = (res?.data ?? []) as Array<{
    info?: { id?: string; role?: string; time?: { created?: number }; model?: { providerID?: string; modelID?: string } }
    parts?: Array<{ type?: string; text?: string }>
  }>
  const since = lastCheckpointMs(deps.db, target.sessionID)
  const selected: string[] = []
  let bytes = 0
  let full = true
  let model: { providerID: string; modelID: string } | undefined
  for (const m of messages) {
    if (!model && m.info?.model?.providerID && m.info.model.modelID) {
      model = { providerID: m.info.model.providerID, modelID: m.info.model.modelID }
    }
    if (m.info?.role === "user") continue
    const created = m.info?.time?.created ?? 0
    if (since > 0 && created <= since) continue
    for (const p of m.parts ?? []) {
      if (p.type !== "text" || !p.text) continue
      const line = `[${m.info?.role ?? "assistant"} ${m.info?.id ?? ""}]\n${p.text}\n`
      if (bytes + Buffer.byteLength(line) > INCREMENT_BUDGET) {
        full = false
        break
      }
      selected.push(line)
      bytes += Buffer.byteLength(line)
    }
    if (!full) break
  }
  return { body: selected.join("\n"), full, model }
}

export async function spawnWriter(deps: WriterDeps, target: WriterTarget, state: Map<string, PendingWriter>): Promise<void> {
  if (state.has(target.sessionID)) return
  let childSessionID = ""
  try {
    const inc = await readIncrement(deps, target)
    if (!inc.body.trim()) return
    const system = `${deps.writerPrompt.slice(0, WRITER_SYSTEM_BUDGET)}\n\n父会话 ID: ${target.sessionID}`
    const createBody: { parentID?: string; title?: string } = { title: target.title }
    if (target.parentID) createBody.parentID = target.parentID
    const createdRes = await deps.client.session.create({ body: createBody })
    childSessionID = createdRes?.data?.id ?? createdRes?.id
    if (!childSessionID) throw new Error("writer: session.create returned no id")
    deps.blacklist.add(childSessionID)
    const pending: PendingWriter = {
      target,
      childSessionID,
      createdAt: Date.now(),
      done: false,
    }
    state.set(target.sessionID, pending)
    const userParts = [
      { type: "text", text: `以下是父会话 ${target.sessionID} 自上次检查点以来的增量原文。请按系统提示蒸馏为检查点输出，最后一行输出 CHECKPOINT_DONE。\n\n${inc.body}` },
    ]
    const promptBody: Record<string, unknown> = { system, tools: deps.toolsWhitelist, parts: userParts }
    if (inc.model) promptBody.model = inc.model
    await deps.client.session.promptAsync({
      path: { id: childSessionID },
      body: promptBody,
    })
    await persistOrphan(deps.root, target, childSessionID)
    void watchChildCompletion(deps, state, childSessionID)
  } catch (e) {
    state.delete(target.sessionID)
  }
}

async function watchChildCompletion(deps: WriterDeps, state: Map<string, PendingWriter>, childSessionID: string): Promise<void> {
  const deadline = Date.now() + 180_000
  for (;;) {
    await new Promise((r) => setTimeout(r, 5_000))
    if (Date.now() > deadline) {
      await settleWriter(deps, state, childSessionID)
      return
    }
    try {
      const res = await deps.client.session.status({ path: { id: childSessionID } })
      const status = res?.data as { type?: string } | undefined
      if (status?.type === "idle") {
        await settleWriter(deps, state, childSessionID)
        return
      }
    } catch {
      await settleWriter(deps, state, childSessionID)
      return
    }
  }
}

export function runWriter(task: WriterTarget, deps: WriterDeps, state: Map<string, PendingWriter>): void {
  if (state.has(task.sessionID)) return
  // Retry cap. Without it a permanently broken target (disk full, read-only
  // mount) re-distilled on every single trigger, burning a subagent each time
  // to produce output that can never land. Checked before spawning, not after
  // failing, so the token cost is what we avoid.
  const failures = writerFailCount(deps.db, task.sessionID)
  if (failures >= deps.maxWriterRetries) {
    reportFailure(
      deps,
      "error",
      `writer suppressed session=${task.sessionID} consecutive_failures=${failures} limit=${deps.maxWriterRetries}`,
    )
    return
  }
  void spawnWriter(deps, task, state)
}

async function finalizeWriterOnce(deps: WriterDeps, target: WriterTarget, childSessionID: string): Promise<boolean> {
  const settleStart = Date.now()
  try {
    const res = await deps.client.session.messages({ path: { id: childSessionID } })
    const messages = (res?.data ?? []) as Array<{
      info?: { role?: string }
      parts?: Array<{ type?: string; text?: string }>
    }>
    const assistantTexts: string[] = []
    for (const m of messages) {
      if (m.info?.role !== "assistant") continue
      for (const p of m.parts ?? []) {
        if (p.type === "text" && p.text) assistantTexts.push(p.text)
      }
    }
    const result = assistantTexts.join("\n").trim()
    if (!result) {
      // Counts as a failure: a child that produced nothing is a failed
      // distillation, and without this the retry cap never engages — the next
      // trigger would spawn another subagent to produce nothing again.
      const failures = bumpWriterFail(deps.db, target.sessionID)
      reportFailure(
        deps,
        "error",
        `writer produced no output session=${target.sessionID} consecutive_failures=${failures} limit=${deps.maxWriterRetries}`,
      )
      await removeOrphan(deps.root, childSessionID)
      return true
    }
    const checkpointFile = checkpointPath(deps.root, target.sessionID)
    const body = result.endsWith("CHECKPOINT_DONE") ? result.replace(/CHECKPOINT_DONE\s*$/, "").trim() : result
    const verdict = validateCheckpoint(body)
    if (!verdict.ok) {
      reportFailure(
        deps,
        "error",
        `checkpoint rejected session=${target.sessionID} errors=${JSON.stringify(verdict.errors)}`,
      )
      await removeOrphan(deps.root, childSessionID)
      return true
    }
    for (const w of verdict.warnings) {
      reportFailure(deps, "warn", `checkpoint section budget session=${target.sessionID} ${w}`)
    }

    // Write both files before touching the watermark. Advancing the watermark
    // mid-sequence used to lose the project-memory append permanently: the
    // increment is never re-read once the watermark moves past it. Only advance
    // when every write landed, so a failure is retried on the next trigger.
    //
    // The mtime guard drops a late result: if the checkpoint file is already
    // newer than this settle began, another trigger for the same session
    // finished later and its content is the fresher one. The project append
    // still runs — this result covers a window that may not be recorded yet.
    const written = checkpointFileMtime(checkpointFile)
    const stale = written !== null && written > settleStart
    if (stale) {
      reportFailure(
        deps,
        "warn",
        `checkpoint write skipped as stale session=${target.sessionID} file_mtime=${new Date(written).toISOString()} settle_start=${new Date(settleStart).toISOString()}`,
      )
    }
    const checkpointWrite = stale ? { ok: true as const } : writeMemoryFile(checkpointFile, body)
    if (!checkpointWrite.ok) {
      reportFailure(
        deps,
        "error",
        `checkpoint write failed session=${target.sessionID} path=${checkpointFile} reason=${checkpointWrite.reason}`,
      )
    }
    const projectWrite = target.projectDir
      ? appendProjectMemory(deps.root, target.projectDir, body, deps.db, target.sessionID, settleStart)
      : true
    if (!projectWrite) {
      reportFailure(
        deps,
        "error",
        `project memory append failed session=${target.sessionID} dir=${target.projectDir}`,
      )
    }
    if (checkpointWrite.ok && projectWrite) {
      markCheckpoint(deps.db, target.sessionID, settleStart)
      clearWriterFail(deps.db, target.sessionID)
    } else {
      const failures = bumpWriterFail(deps.db, target.sessionID)
      reportFailure(
        deps,
        "error",
        `watermark not advanced session=${target.sessionID} consecutive_failures=${failures} limit=${deps.maxWriterRetries}; next trigger will retry this increment`,
      )
    }
    await removeOrphan(deps.root, childSessionID)
  } catch (e) {
    void e
  }
  return true
}

export function finalizeWriter(deps: WriterDeps, target: WriterTarget, childSessionID: string): Promise<boolean> {
  const active = deps.finalizing.get(childSessionID)
  if (active) return active
  const task = finalizeWriterOnce(deps, target, childSessionID)
  deps.finalizing.set(childSessionID, task)
  const clear = () => {
    if (deps.finalizing.get(childSessionID) === task) deps.finalizing.delete(childSessionID)
  }
  void task.then(clear, clear)
  return task
}

async function settleWriterOnce(deps: WriterDeps, state: Map<string, PendingWriter>, childSessionID: string): Promise<boolean> {
  let pending: PendingWriter | undefined
  for (const [, p] of state) {
    if (p.childSessionID === childSessionID && !p.done) {
      pending = p
      break
    }
  }
  if (!pending) {
    const orphan = await findOrphan(deps.root, childSessionID)
    if (orphan) return finalizeWriter(deps, orphan.target, orphan.childSessionID)
    return false
  }
  pending.done = true
  state.delete(pending.target.sessionID)
  return finalizeWriter(deps, pending.target, childSessionID)
}

export function settleWriter(deps: WriterDeps, state: Map<string, PendingWriter>, childSessionID: string): Promise<boolean> {
  const active = deps.settling.get(childSessionID)
  if (active) return active
  const task = settleWriterOnce(deps, state, childSessionID)
  deps.settling.set(childSessionID, task)
  const clear = () => {
    if (deps.settling.get(childSessionID) === task) deps.settling.delete(childSessionID)
  }
  void task.then(clear, clear)
  return task
}

export function expireWriters(deps: WriterDeps, state: Map<string, PendingWriter>, timeoutMs: number): void {
  const now = Date.now()
  for (const [sid, p] of state) {
    if (!p.done && now - p.createdAt > timeoutMs) {
      p.done = true
      state.delete(sid)
    }
  }
}

export function checkpointPath(root: string, sessionID: string): string {
  return buildPath({ root, scope: "sessions", scope_id: sessionID, key: "checkpoint" })
}

function checkpointFileMtime(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return null
  }
}

/**
 * Append a settled checkpoint to the project memory.
 *
 * Two guards, because the tail comparison alone was not enough once failures
 * became retryable: a retry re-runs the same checkpoint, and by then other
 * content may already sit at the tail, so `endsWith` misses it. The
 * `project_appended:<pid>` watermark is order-independent — if this result's
 * window is not newer than what the project file already covers, the content is
 * already recorded. The tail check stays as the guard for calls that carry no
 * watermark (direct/test use) and for pre-watermark history.
 */
export function appendProjectMemory(
  root: string,
  projectDir: string | undefined,
  body: string,
  db?: Db,
  sessionID?: string,
  watermarkMs?: number,
): boolean {
  if (!projectDir) return false
  const normalizedBody = body.trim()
  if (!normalizedBody) return false
  ensureMemoryTemplate(root, projectDir)
  const pid = resolveProjectId(projectDir)
  if (db && sessionID && typeof watermarkMs === "number") {
    const covered = Number(metaGet(db, `${APPEND_KEY_PREFIX}${pid}`) ?? "0")
    if (Number.isFinite(covered) && watermarkMs <= covered) return true
  }
  const p = buildPath({ root, scope: "projects", scope_id: pid, key: "MEMORY" })
  const existing = readMemoryFile(p) ?? ""
  const normalizedExisting = existing.trimEnd()
  if (normalizedExisting === normalizedBody || normalizedExisting.endsWith(`\n\n${normalizedBody}`)) {
    if (db && sessionID && typeof watermarkMs === "number") {
      metaSet(db, `${APPEND_KEY_PREFIX}${pid}`, String(watermarkMs))
    }
    return true
  }
  const merged = existing ? `${existing}\n\n${normalizedBody}` : normalizedBody
  const written = writeMemoryFile(p, merged).ok
  if (written && db && sessionID && typeof watermarkMs === "number") {
    metaSet(db, `${APPEND_KEY_PREFIX}${pid}`, String(watermarkMs))
  }
  return written
}

function orphanFile(root: string): string {
  return path.join(root, ".writers.json")
}

function readOrphans(root: string): OrphanRecord[] {
  try {
    const raw = fs.readFileSync(orphanFile(root), "utf8")
    const arr = JSON.parse(raw) as OrphanRecord[]
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function writeOrphans(root: string, records: OrphanRecord[]) {
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(orphanFile(root), JSON.stringify(records, null, 0), "utf8")
}

export async function persistOrphan(root: string, target: WriterTarget, childSessionID: string): Promise<void> {
  await withFileLock(orphanFile(root), () => {
    const records = readOrphans(root).filter((r) => r.childSessionID !== childSessionID)
    records.push({ childSessionID, target, createdAt: Date.now() })
    writeOrphans(root, records)
  })
}

export async function removeOrphan(root: string, childSessionID: string): Promise<void> {
  await withFileLock(orphanFile(root), () => {
    const records = readOrphans(root).filter((r) => r.childSessionID !== childSessionID)
    writeOrphans(root, records)
  })
}

export async function findOrphan(root: string, childSessionID: string): Promise<OrphanRecord | null> {
  let found: OrphanRecord | null = null
  await withFileLock(orphanFile(root), () => {
    found = readOrphans(root).find((r) => r.childSessionID === childSessionID) ?? null
  })
  return found
}

export async function listOrphans(root: string): Promise<OrphanRecord[]> {
  let out: OrphanRecord[] = []
  await withFileLock(orphanFile(root), () => {
    out = readOrphans(root)
  })
  return out
}

export async function expireOrphans(root: string, timeoutMs: number): Promise<number> {
  let removed = 0
  await withFileLock(orphanFile(root), () => {
    const now = Date.now()
    const records = readOrphans(root)
    const kept = records.filter((r) => now - r.createdAt <= timeoutMs)
    removed = records.length - kept.length
    writeOrphans(root, kept)
  })
  return removed
}
