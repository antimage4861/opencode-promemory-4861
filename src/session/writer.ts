import fs from "fs"
import path from "path"
import { buildPath, resolveProjectId } from "../memory/paths.ts"
import { writeMemoryFile, readMemoryFile, withFileLock } from "../memory/storage.ts"
import { ensureMemoryTemplate } from "../memory/template.ts"
import {
  GLOBAL_CAP,
  MEMORY_SECTIONS,
  mergeGlobalMemory,
  SECTION_CAPS,
  capSection,
  emptyDelta,
  normalizeBullets,
  extractDelta,
  markLayout,
  parseMemorySections,
  renderMemorySections,
  stripDelta,
  type MemoryDelta,
} from "../memory/merge.ts"
import { validateCheckpoint } from "./validator.ts"
import type { Db } from "../memory/db.ts"
import { metaGet, metaSet } from "../memory/fts.ts"

// Incremental input ceiling. The child session carries this verbatim inside
// its own context, so exceeding it drives the host into compaction and the
// writer ends up distilling an already-summarised increment. Measured: the
// sub-agent's model reports 70% of its window as the compaction trigger,
// which lands around 140K here. 135K leaves a small margin for the system
// prompt and the wrapper text, which also count against the same budget.
const INCREMENT_BUDGET = 135_000
const WRITER_SYSTEM_BUDGET = 6_000
const WRITER_DEADLINE_MS = 180_000
// Defined in .opencode/agent/promem-writer.md. Naming it here keeps the two in
// sync: without a matching definition the host falls back to a default agent
// that carries tools and can block waiting on an approval nobody is watching.
const WRITER_AGENT = "promem-writer"
const CP_KEY_PREFIX = "scanner:"
const CP_ID_KEY_PREFIX = "scanner_id:"
const FAIL_KEY_PREFIX = "writer_fail:"
const APPEND_KEY_PREFIX = "project_appended:"

interface OrphanRecord {
  childSessionID: string
  target: WriterTarget
  createdAt: number
  /**
   * Cursor captured at dispatch. A restart resumes settlement from the orphan
   * file, and without the cursor the resumed write would have to fall back to
   * the dispatch time — reintroducing exactly the jump-over-the-tail this cursor
   * exists to prevent. 0 on records written by older versions; settlement then
   * leaves the watermark alone rather than guessing.
   */
  lastConsumed: number
  lastConsumedId: string
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
  /**
   * Timestamp and id of the last message handed to this child, and whether the
   * increment was fully read. Settlement advances the watermark to the cursor
   * rather than to the dispatch time, and a truncated increment re-arms the
   * writer for the next batch. 0 / "" means nothing was consumed and no
   * watermark may move.
   */
  lastConsumed: number
  lastConsumedId: string
  truncated: boolean
}

export function lastCheckpointMs(db: Db, sessionID: string): number {
  const raw = metaGet(db, `${CP_KEY_PREFIX}${sessionID}`)
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) ? n : 0
}

/**
 * Id of the message the cursor last landed on. Timestamps are milliseconds, so
 * two messages in the same turn can share one; without this the read would skip
 * every message at the cursor's instant, not just the one it consumed. Empty on
 * stores written before the cursor existed, which makes the reader fall back to
 * the timestamp-only comparison.
 */
export function lastCheckpointId(db: Db, sessionID: string): string {
  return metaGet(db, `${CP_ID_KEY_PREFIX}${sessionID}`) ?? ""
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
export function markCheckpoint(db: Db, sessionID: string, ms = Date.now(), messageID = ""): boolean {
  const key = `${CP_KEY_PREFIX}${sessionID}`
  if (lastCheckpointMs(db, sessionID) >= ms) return false
  metaSet(db, key, String(ms))
  // Always written, even when empty: a legacy cursor that advanced without an id
  // must not keep the empty-value fallback alive for a session that now has one.
  metaSet(db, `${CP_ID_KEY_PREFIX}${sessionID}`, messageID)
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
  lastConsumed: number
  lastConsumedId: string
  model?: { providerID: string; modelID: string }
}> {
  const res = await deps.client.session.messages({ path: { id: target.sessionID } })
  const messages = (res?.data ?? []) as Array<{
    info?: { id?: string; role?: string; time?: { created?: number }; model?: { providerID?: string; modelID?: string } }
    parts?: Array<{ type?: string; text?: string }>
  }>
  const since = lastCheckpointMs(deps.db, target.sessionID)
  const sinceId = lastCheckpointId(deps.db, target.sessionID)
  const selected: string[] = []
  let bytes = 0
  let full = true
  let model: { providerID: string; modelID: string } | undefined
  // The cursor records the last message handed over in full — never the dispatch
  // time. Moving it past a message the child never saw is what strands the tail
  // of an oversized increment: those messages end up below a watermark that
  // jumped over them, and no later read can select them again.
  //
  // Recorded only once every text part of a message fits. A message cut mid-way
  // leaves the cursor on the previous one, so that whole message is re-read next
  // round — a duplicate the append idempotency absorbs, traded against never
  // dropping a part.
  let lastConsumed = 0
  let lastConsumedId = ""
  for (const m of messages) {
    if (!model && m.info?.model?.providerID && m.info.model.modelID) {
      model = { providerID: m.info.model.providerID, modelID: m.info.model.modelID }
    }
    if (m.info?.role === "user") continue
    const created = m.info?.time?.created ?? 0
    if (since > 0 && created <= since) {
      // Messages can share a millisecond. `<=` alone would skip the siblings
      // following the one the cursor landed on, so an id disambiguates the
      // boundary. An absent id (store written before this version) falls back to
      // the old behaviour.
      if (created < since || sinceId === "" || m.info?.id === sinceId) continue
    }
    let complete = true
    for (const p of m.parts ?? []) {
      if (p.type !== "text" || !p.text) continue
      const line = `[${m.info?.role ?? "assistant"} ${m.info?.id ?? ""}]\n${p.text}\n`
      if (bytes + Buffer.byteLength(line) > INCREMENT_BUDGET) {
        full = false
        complete = false
        break
      }
      selected.push(line)
      bytes += Buffer.byteLength(line)
    }
    if (!complete) break
    lastConsumed = created
    lastConsumedId = m.info?.id ?? ""
  }
  return { body: selected.join("\n"), full, lastConsumed, lastConsumedId, model }
}

export async function spawnWriter(deps: WriterDeps, target: WriterTarget, state: Map<string, PendingWriter>): Promise<void> {
  if (state.has(target.sessionID)) return
  let childSessionID = ""
  try {
    const inc = await readIncrement(deps, target)
    if (!inc.body.trim()) return
    const incrementBytes = Buffer.byteLength(inc.body, "utf8")
    reportFailure(
      deps,
      "warn",
      `writer dispatch session=${target.sessionID} increment_bytes=${incrementBytes} budget=${INCREMENT_BUDGET} truncated=${inc.full === false} deadline_ms=${childDeadlineMs(incrementBytes)}`,
    )
    const system = `${deps.writerPrompt.slice(0, WRITER_SYSTEM_BUDGET)}\n\n父会话 ID: ${target.sessionID}`
    // parentID is load-bearing, not bookkeeping. Without it the host's ask
    // router has no parent to inherit grants from and falls back to interactive
    // approval — the child then sits on a prompt nobody sees until the hard
    // deadline fires, having done no work at all.
    //
    // The agent matters for the same reason: the default agent carries a full
    // tool set, and the writer prompt's "do not call any tool" is a request,
    // not a restriction. A 132K child that reached for bash burned the whole
    // budget on an approval prompt instead of distilling.
    const createBody: { parentID?: string; title?: string; agent?: string } = {
      title: target.title,
      parentID: target.parentID ?? target.sessionID,
      agent: WRITER_AGENT,
    }
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
      lastConsumed: inc.lastConsumed,
      lastConsumedId: inc.lastConsumedId,
      truncated: !inc.full,
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
    await persistOrphan(deps.root, target, childSessionID, {
      lastConsumed: inc.lastConsumed,
      lastConsumedId: inc.lastConsumedId,
    })
    void watchChildCompletion(deps, state, childSessionID, incrementBytes)
  } catch (e) {
    state.delete(target.sessionID)
  }
}

/**
 * Deadline for a child's completion poll, scaled to the size of the increment it
 * was handed and then padded.
 *
 * The original flat 180s was measured when increments were capped at 24KB, and
 * stopped being meaningful once the budget rose to 135K. A 132,497-byte
 * increment then took 490s to distil, so the old ceiling cut the poll off before
 * the child finished writing. The result read as an empty reply, which the
 * caller correctly reports as "produced no output" — a wasted child and a
 * burned retry. With the retry cap at 3, a third failure silences the session
 * for good, so under-budgeting is the expensive direction.
 *
 * 4ms/byte is set from a completed run: 490s ÷ 132,497B ≈ 3.7ms/byte. The 1.5
 * factor on top gives ~6.7x headroom over the measured cost. Note the first
 * attempt at this constant used 2ms, derived from a 208s reading that turned
 * out to be the moment the 180s ceiling cut the poll — not a completion time.
 * Re-measure against a real full-budget (135,000B) run if this ever looks tight
 * again.
 *
 * The 60s base covers the fixed costs (session create, prompt round-trip, the
 * child's first token) so small increments are not penalised, and the result
 * never drops below the original 180s floor. A child that overruns the budget
 * is still settled rather than abandoned, so the retry cap can observe it.
 */
const CHILD_DEADLINE_BASE_MS = 60_000
const CHILD_DEADLINE_MS_PER_BYTE = 4
const CHILD_DEADLINE_SLACK = 1.5

export function childDeadlineMs(incrementBytes: number): number {
  const scaled = CHILD_DEADLINE_BASE_MS + incrementBytes * CHILD_DEADLINE_MS_PER_BYTE
  return Math.round(Math.max(WRITER_DEADLINE_MS, scaled * CHILD_DEADLINE_SLACK))
}

/**
 * Re-arm the writer for the next batch once a truncated increment has landed.
 *
 * The cursor makes this safe to loop: each batch advances the watermark to the
 * last message it actually fed, so the next read starts exactly where the
 * previous one stopped. Without that, the loop would re-read the same window
 * forever.
 *
 * Re-arming requires the watermark to have actually moved. A batch that was
 * rejected, produced no output, or lost the stale race never advanced it, and
 * retrying would re-distil a window the cursor still points at — a spin, not
 * progress. The failure counter is checked as well so a broken target is left
 * for the retry cap rather than looped.
 */
function rearmIfTruncated(
  deps: WriterDeps,
  state: Map<string, PendingWriter>,
  pending: PendingWriter,
): void {
  if (!pending.truncated) return
  if (pending.lastConsumed <= 0) {
    reportFailure(
      deps,
      "warn",
      `writer loop stopped session=${pending.target.sessionID} truncated increment consumed no complete message`,
    )
    return
  }
  const limit = deps.maxWriterRetries ?? 3
  if (writerFailCount(deps.db, pending.target.sessionID) >= limit) return
  if (state.has(pending.target.sessionID)) return
  if (lastCheckpointMs(deps.db, pending.target.sessionID) < pending.lastConsumed) {
    reportFailure(
      deps,
      "warn",
      `writer loop stopped session=${pending.target.sessionID} watermark did not reach cursor=${pending.lastConsumed}`,
    )
    return
  }
  runWriter(pending.target, deps, state)
}

async function watchChildCompletion(
  deps: WriterDeps,
  state: Map<string, PendingWriter>,
  childSessionID: string,
  incrementBytes: number,
): Promise<void> {
  const budget = childDeadlineMs(incrementBytes)
  const startedAt = Date.now()
  const deadline = startedAt + budget
  // Captured before settling: settleWriter removes the entry from state.
  let pending: PendingWriter | undefined
  for (const p of state.values()) {
    if (p.childSessionID === childSessionID) {
      pending = p
      break
    }
  }
  for (;;) {
    await new Promise((r) => setTimeout(r, 5_000))
    if (Date.now() > deadline) {
      reportFailure(
        deps,
        "warn",
        `writer child deadline reached child=${childSessionID} increment_bytes=${incrementBytes} budget_ms=${budget} elapsed_ms=${Date.now() - startedAt}`,
      )
      await settleWriter(deps, state, childSessionID)
      return
    }
    try {
      const res = await deps.client.session.status({ path: { id: childSessionID } })
      const status = res?.data as { type?: string } | undefined
      if (status?.type === "idle") {
        await settleWriter(deps, state, childSessionID)
        if (pending) rearmIfTruncated(deps, state, pending)
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
  // `?? 3` guards the hand-maintained deploy entry: it is a copy of this wiring
  // and has silently drifted once already, where an undefined limit made
  // `failures >= undefined` false forever and disabled the cap with no error.
  const limit = deps.maxWriterRetries ?? 3
  if (failures >= limit) {
    reportFailure(
      deps,
      "error",
      `writer suppressed session=${task.sessionID} consecutive_failures=${failures} limit=${limit}`,
    )
    return
  }
  void spawnWriter(deps, task, state)
}

/**
 * Cursor for one settled batch. `0` means unknown — settlement then leaves the
 * watermark alone instead of guessing at the dispatch time, because a wrong
 * guess skips messages permanently and a missing one only costs a re-read.
 */
export interface WriterCursor {
  lastConsumed: number
  lastConsumedId: string
}

async function finalizeWriterOnce(
  deps: WriterDeps,
  target: WriterTarget,
  childSessionID: string,
  cursor?: WriterCursor,
): Promise<boolean> {
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
        `writer produced no output session=${target.sessionID} consecutive_failures=${failures} limit=${deps.maxWriterRetries ?? 3}`,
      )
      await removeOrphan(deps.root, childSessionID)
      return true
    }
    const checkpointFile = checkpointPath(deps.root, target.sessionID)
    // The delta block is machine-readable and must not reach any memory file:
    // the checkpoint markdown and the append fallback both get it stripped.
    const body = stripDelta(result)
      .replace(/CHECKPOINT_DONE\s*$/, "")
      .trim()
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
    // Project memory: prefer the sectioned merge. A missing or malformed delta
    // block falls back to the 0.4.x append rather than dropping the result —
    // the append is noisier but lossless, which is the right failure direction.
    let projectWrite = true
    let usedMerge = false
    if (target.projectDir) {
      const delta = extractDelta(result)
      if (delta) {
        const hasProject = MEMORY_SECTIONS.some((n) => delta.project[n])
        // A global-only delta must still advance the project watermark, or the
        // increment is re-distilled forever. The project file is only rewritten
        // when this increment actually has something to say about the project.
        if (hasProject) {
          const merged = mergeProjectMemory(
            deps.root,
            target.projectDir,
            delta.project,
            deps.db,
            target.sessionID,
            settleStart,
          )
          projectWrite = merged.ok
          usedMerge = merged.ok
          if (merged.ok && merged.truncatedLines > 0) {
            reportFailure(
              deps,
              "warn",
              `project memory truncated session=${target.sessionID} lines=${merged.truncatedLines} caps=${JSON.stringify(SECTION_CAPS)}`,
            )
          }
          if (!merged.ok) {
            reportFailure(
              deps,
              "warn",
              `project memory merge failed, falling back to append session=${target.sessionID}`,
            )
          }
        } else {
          usedMerge = true
        }
        if (delta.global) {
          const global = mergeGlobalMemory(deps.root, delta.global, deps.db, settleStart)
          if (global.truncatedLines > 0) {
            reportFailure(
              deps,
              "warn",
              `global memory truncated session=${target.sessionID} lines=${global.truncatedLines} cap=${GLOBAL_CAP}`,
            )
          }
          if (!global.ok) {
            reportFailure(deps, "error", `global memory merge failed session=${target.sessionID}`)
          }
        }
      } else if (result.includes("<!-- project-memory-delta")) {
        // The block was emitted but carried no recognised section heading. Logged
        // because otherwise the sectioned layout silently degrades to append mode
        // for the rest of time and nothing points at the prompt being violated.
        reportFailure(
          deps,
          "warn",
          `delta block present but no recognised section heading, appending instead session=${target.sessionID}`,
        )
      }
      if (!usedMerge) {
        projectWrite = appendProjectMemory(deps.root, target.projectDir, body, deps.db, target.sessionID, settleStart)
      }
    }
    if (!projectWrite) {
      reportFailure(
        deps,
        "error",
        `project memory append failed session=${target.sessionID} dir=${target.projectDir}`,
      )
    }
    if (checkpointWrite.ok && projectWrite) {
      // The watermark tracks the cursor, not the dispatch time. settleStart sits
      // above every message the child never received, so using it here stranded
      // the unread tail of an oversized increment: those messages fell below a
      // mark that had jumped over them and no later read could select them.
      //
      // A stale result keeps the watermark still even though the writes "succeeded":
      // this batch's content is not in the checkpoint file, and moving the cursor
      // would claim it was. The project append above still runs — it has its own
      // idempotency token and may cover a window the newer result missed.
      const lastConsumed = cursor?.lastConsumed ?? 0
      if (stale) {
        reportFailure(
          deps,
          "warn",
          `watermark held at cursor session=${target.sessionID} cursor=${lastConsumed} reason=stale result not written`,
        )
        // Not clearing the failure count: the retry cap is what stops the loop
        // from re-reading this window, and the batch still needs another pass.
        bumpWriterFail(deps.db, target.sessionID)
      } else if (lastConsumed <= 0) {
        reportFailure(
          deps,
          "warn",
          `watermark not advanced session=${target.sessionID} reason=no cursor recorded for this batch`,
        )
        bumpWriterFail(deps.db, target.sessionID)
      } else {
        markCheckpoint(deps.db, target.sessionID, lastConsumed, cursor?.lastConsumedId ?? "")
        clearWriterFail(deps.db, target.sessionID)
      }
    } else {
      const failures = bumpWriterFail(deps.db, target.sessionID)
      reportFailure(
        deps,
        "error",
        `watermark not advanced session=${target.sessionID} consecutive_failures=${failures} limit=${deps.maxWriterRetries ?? 3}; next trigger will retry this increment`,
      )
    }
    await removeOrphan(deps.root, childSessionID)
  } catch (e) {
    void e
  }
  return true
}

export function finalizeWriter(
  deps: WriterDeps,
  target: WriterTarget,
  childSessionID: string,
  cursor?: WriterCursor,
): Promise<boolean> {
  const active = deps.finalizing.get(childSessionID)
  if (active) return active
  const task = finalizeWriterOnce(deps, target, childSessionID, cursor)
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
    if (orphan) {
      return finalizeWriter(deps, orphan.target, orphan.childSessionID, {
        lastConsumed: orphan.lastConsumed ?? 0,
        lastConsumedId: orphan.lastConsumedId ?? "",
      })
    }
    return false
  }
  pending.done = true
  state.delete(pending.target.sessionID)
  return finalizeWriter(deps, pending.target, childSessionID, {
    lastConsumed: pending.lastConsumed,
    lastConsumedId: pending.lastConsumedId,
  })
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

/**
 * Merge a writer delta into the four sections of the project memory. Returns
 * false when there is no delta to apply or the write failed, so the caller can
 * fall back to the 0.4.x append and never drop the result.
 */
export function mergeProjectMemory(
  root: string,
  projectDir: string | undefined,
  delta: MemoryDelta,
  db?: Db,
  sessionID?: string,
  watermarkMs?: number,
): { ok: boolean; truncatedLines: number } {
  if (!projectDir) return { ok: false, truncatedLines: 0 }
  const pid = resolveProjectId(projectDir)
  if (db && sessionID && typeof watermarkMs === "number") {
    const covered = Number(metaGet(db, `${APPEND_KEY_PREFIX}${pid}`) ?? "0")
    if (Number.isFinite(covered) && watermarkMs <= covered) return { ok: true, truncatedLines: 0 }
  }
  const p = buildPath({ root, scope: "projects", scope_id: pid, key: "MEMORY" })
  const existing = readMemoryFile(p) ?? ""
  const current = parseMemorySections(existing)
  const merged: MemoryDelta = emptyDelta()
  let truncation = 0
  for (const name of MEMORY_SECTIONS) {
    const addition = normalizeBullets(delta[name]?.trim() ?? "")
    const combined = addition ? (current[name] ? `${current[name]}\n\n${addition}` : addition) : current[name]
    const capped = capSection(combined, SECTION_CAPS[name])
    truncation += capped.truncated
    merged[name] = capped.text
  }
  const written = writeMemoryFile(p, renderMemorySections(projectDir, merged))
  if (!written.ok) return { ok: false, truncatedLines: truncation }
  if (db && sessionID && typeof watermarkMs === "number") {
    metaSet(db, `${APPEND_KEY_PREFIX}${pid}`, String(watermarkMs))
  }
  markLayout(db as Db, pid)
  return { ok: true, truncatedLines: truncation }
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

export async function persistOrphan(
  root: string,
  target: WriterTarget,
  childSessionID: string,
  cursor?: { lastConsumed: number; lastConsumedId: string },
): Promise<void> {
  await withFileLock(orphanFile(root), () => {
    const records = readOrphans(root).filter((r) => r.childSessionID !== childSessionID)
    records.push({
      childSessionID,
      target,
      createdAt: Date.now(),
      lastConsumed: cursor?.lastConsumed ?? 0,
      lastConsumedId: cursor?.lastConsumedId ?? "",
    })
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
