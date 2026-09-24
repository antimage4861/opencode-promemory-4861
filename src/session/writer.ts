import fs from "fs"
import path from "path"
import { buildPath, resolveProjectId } from "../memory/paths.ts"
import { writeMemoryFile, readMemoryFile, withFileLock } from "../memory/storage.ts"
import { validateCheckpoint } from "./validator.ts"
import type { Db } from "../memory/db.ts"
import { metaGet, metaSet } from "../memory/fts.ts"

const INCREMENT_BUDGET = 24_000
const WRITER_SYSTEM_BUDGET = 6_000
const CP_KEY_PREFIX = "scanner:"

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
  projectDir?: string
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

export function markCheckpoint(db: Db, sessionID: string, ms = Date.now()) {
  metaSet(db, `${CP_KEY_PREFIX}${sessionID}`, String(ms))
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
  void spawnWriter(deps, task, state)
}

export async function finalizeWriter(deps: WriterDeps, target: WriterTarget, childSessionID: string): Promise<boolean> {
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
      await removeOrphan(deps.root, childSessionID)
      return true
    }
    const checkpointFile = checkpointPath(deps.root, target.sessionID)
    const body = result.endsWith("CHECKPOINT_DONE") ? result.replace(/CHECKPOINT_DONE\s*$/, "").trim() : result
    if (validateCheckpoint(body).ok) {
      writeMemoryFile(checkpointFile, body)
      markCheckpoint(deps.db, target.sessionID)
      appendProjectMemory(deps.root, target.projectDir, body)
    }
    await removeOrphan(deps.root, childSessionID)
  } catch (e) {
    void e
  }
  return true
}

export async function settleWriter(deps: WriterDeps, state: Map<string, PendingWriter>, childSessionID: string): Promise<boolean> {
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

export function appendProjectMemory(root: string, projectDir: string | undefined, body: string): boolean {
  if (!projectDir) return false
  const pid = resolveProjectId(projectDir)
  const p = buildPath({ root, scope: "projects", scope_id: pid, key: "MEMORY" })
  const existing = readMemoryFile(p) ?? ""
  const merged = existing ? `${existing}\n\n${body}` : body
  return writeMemoryFile(p, merged).ok
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
