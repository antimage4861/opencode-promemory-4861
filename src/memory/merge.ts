import { metaGet, metaSet } from "./fts.ts"
import { buildPath } from "./paths.ts"
import { readMemoryFile, writeMemoryFile } from "./storage.ts"
import type { Db } from "./db.ts"

/**
 * Sectioned layout for projects/<pid>/MEMORY.md.
 *
 * The 0.4.x behaviour appended every settled checkpoint verbatim, which made
 * the file a change log: unbounded growth, the same conclusion restated by
 * every checkpoint that touched it, and BM25 relevance diluted by process
 * noise (file lists, command transcripts). The distilled conclusions that
 * actually deserve a place in project memory were buried underneath.
 *
 * The writer subagent still has no tools (0.3.0 tightened the whitelist to
 * empty on purpose, to keep distillation free of retrieval pollution), so it
 * cannot rewrite the file itself. Instead it returns a delta for these four
 * sections as JSON and the host merges. Classification is the model's job;
 * persistence stays in the host, where the path allowlist already is.
 */
export const MEMORY_SECTIONS = [
  "Project context",
  "Rules",
  "Architecture decisions",
  "Discovered durable knowledge",
] as const

export type MemorySection = (typeof MEMORY_SECTIONS)[number]

export type MemoryDelta = Record<MemorySection, string>

/**
 * Per-section byte budgets, summing to 26000 — slightly wider than the 29KB
 * the append-based layout had reached, because a section that holds a decision
 * is worth more per byte than a file listing.
 */
export const SECTION_CAPS: Record<MemorySection, number> = {
  "Project context": 3000,
  Rules: 5000,
  "Architecture decisions": 8000,
  "Discovered durable knowledge": 10000,
}

const DELTA_OPEN = "<!-- project-memory-delta"
const DELTA_CLOSE = "-->"
const LAYOUT_KEY_PREFIX = "memory_layout:"
const GLOBAL_APPENDED_KEY = "global_appended"
export const LAYOUT_VERSION = "sections-v1"

/** Heading the writer uses for cross-project facts inside the delta block. */
const GLOBAL_HEADING = "Global (cross-project facts)"

/**
 * Cap for the global file. Borrowed from MiMoCode's `caps.global`; global is
 * meant to hold a handful of durable environment facts, not a second
 * project memory, so it stays small enough that a misclassification is visible
 * by looking at the file.
 */
export const GLOBAL_CAP = 6000

/**
 * What the writer is asked to classify each increment into.
 *
 * `project` — facts about this repository, keyed by the four sections above.
 * `global`  — facts about the user and this machine that hold regardless of
 *              which project is open: platform quirks, missing CLI tools, the
 *              user's habitual debugging commands. A fact that is only true
 *              inside the current project belongs in `project`, never here.
 *
 * Cross-project standing rules are NOT global memory — they live in the user's
 * AGENTS.md, which is injected as instructions rather than retrieved as
 * evidence. Keeping the two apart is what stops this file becoming a second,
 * less authoritative copy of the instructions.
 */
export type WriterDelta = { project: MemoryDelta; global: string }


export function emptyDelta(): MemoryDelta {
  return { "Project context": "", Rules: "", "Architecture decisions": "", "Discovered durable knowledge": "" }
}


export function globalTemplate(): string {
  return [
    "# 全局记忆（跨项目）",
    "",
    "> 存放**关于用户与这台机器、换个项目依然成立**的事实：平台怪癖、缺失的工具、习惯用的命令。",
    "",
    "> 不放这里：跨项目的硬性规范与偏好（那属于 AGENTS.md）、只在单个项目成立的事实（那属于该项目的 MEMORY.md）。",
    "",
  ].join("\n")
}

export function ensureGlobalTemplate(root: string): boolean {
  const target = buildPath({ root, scope: "global", key: "MEMORY" })
  if (readMemoryFile(target) !== null) return false
  return writeMemoryFile(target, globalTemplate()).ok
}

export function renderGlobalMemory(body: string): string {
  const content = body.trim()
  return `${globalTemplate()}\n## 已沉淀事实\n\n${content || "_（暂无）_"}\n`
}

/**
 * Merge into the global file. Idempotent through the same watermark trick as
 * the project file, so a retried settle cannot double-append. The newest
 * entries survive truncation, matching the project sections' behaviour.
 */
export function mergeGlobalMemory(
  root: string,
  delta: string,
  db?: Db,
  watermarkMs?: number,
): { ok: boolean; truncatedLines: number } {
  const normalized = normalizeBullets(delta)
  if (!normalized.trim()) return { ok: true, truncatedLines: 0 }
  if (db && typeof watermarkMs === "number") {
    const covered = Number(metaGet(db, GLOBAL_APPENDED_KEY) ?? "0")
    if (Number.isFinite(covered) && watermarkMs <= covered) return { ok: true, truncatedLines: 0 }
  }
  const target = buildPath({ root, scope: "global", key: "MEMORY" })
  const existing = readMemoryFile(target) ?? ""
  const previous = existing.includes("## 已沉淀事实")
    ? (existing.split("## 已沉淀事实").slice(1).join("## 已沉淀事实").trim() ?? "")
    : ""
  const prior = previous && previous !== "_（暂无）_" ? previous : ""
  const combined = prior ? `${prior}\n\n${normalized}` : normalized
  const capped = capSection(combined, GLOBAL_CAP)
  const written = writeMemoryFile(target, renderGlobalMemory(capped.text))
  if (!written.ok) return { ok: false, truncatedLines: capped.truncated }
  if (db && typeof watermarkMs === "number") {
    metaSet(db, GLOBAL_APPENDED_KEY, String(watermarkMs))
  }
  return { ok: true, truncatedLines: capped.truncated }
}

function heading(line: string): MemorySection | null {
  const m = /^##\s+(.+?)\s*$/.exec(line)
  if (!m) return null
  const name = m[1]
  return (MEMORY_SECTIONS as readonly string[]).includes(name) ? (name as MemorySection) : null
}

/** Parse a MEMORY.md into its four sections. Anything before the first section
 *  heading is treated as `Project context` so pre-migration content is never
 *  dropped on the floor. */
export function parseMemorySections(body: string): MemoryDelta {
  const out = emptyDelta()
  let current: MemorySection = "Project context"
  let buf: string[] = []
  const flush = () => {
    const text = buf.join("\n").trim()
    if (text) out[current] = out[current] ? `${out[current]}\n\n${text}` : text
    buf = []
  }
  for (const line of body.split("\n")) {
    const h = heading(line)
    if (h) {
      flush()
      current = h
      continue
    }
    if (/^#\s+/.test(line) && current === "Project context") continue
    buf.push(line)
  }
  flush()
  return out
}

export function renderMemorySections(dirLabel: string, sections: MemoryDelta): string {
  const parts = [`# 项目记忆（${dirLabel}）`, ""]
  for (const name of MEMORY_SECTIONS) {
    parts.push(`## ${name}`, "", sections[name].trim() || "_（暂无）_", "")
  }
  return parts.join("\n").trimEnd() + "\n"
}

/**
 * Split squashed bullet runs. The writer occasionally emits several bullets on
 * one line ("- a。- b。- c。"), which BM25 then reads as a single very heavy
 * term instead of three independent facts. The pattern requires the dash to
 * touch the preceding character, so ordinary prose ("端口 6379 - 密码 x") and
 * any real dash usage is left alone; a false split only costs a line break.
 */
export function normalizeBullets(text: string): string {
  if (!text.includes("- ")) return text
  const out: string[] = []
  for (const line of text.split("\n")) {
    if (!/(?<=\S)- (?=\S)/.test(line)) {
      out.push(line)
      continue
    }
    out.push(...line.replace(/(?<=\S)- (?=\S)/g, "\n- ").split("\n"))
  }
  return out.join("\n")
}

/**
 * Keep the newest content when a section outgrows its budget. Sections are
 * appended to, so the tail holds the most recent decisions; the head is what
 * gets cut, and the cut is reported so the loss is visible rather than silent.
 */
export function capSection(text: string, cap: number): { text: string; truncated: number } {
  if (Buffer.byteLength(text, "utf8") <= cap) return { text, truncated: 0 }
  const lines = text.split("\n")
  const kept: string[] = []
  let bytes = 0
  let dropped = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(lines[i], "utf8") + 1
    if (bytes + size > cap) {
      dropped = i + 1
      break
    }
    bytes += size
    kept.unshift(lines[i])
  }
  return { text: kept.join("\n"), truncated: dropped }
}

/**
 * Locate the end of the delta block.
 *
 * A bare `indexOf("-->")` is not safe: content bullets legitimately contain
 * arrows (`- 迁移 --> 展开`), and the first one would truncate the block. Only a
 * line that is exactly the closing marker counts, which no bullet ever is. The
 * fallback keeps a model that appends the marker to its last line working.
 */
function findDeltaEnd(body: string): { end: number; rest: string } {
  const lines = body.split("\n")
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === DELTA_CLOSE) {
      return { end: offset, rest: lines.slice(i + 1).join("\n") }
    }
    offset += line.length + 1
  }
  const at = body.indexOf(DELTA_CLOSE)
  if (at < 0) return { end: -1, rest: "" }
  return { end: at, rest: body.slice(at + DELTA_CLOSE.length) }
}

/**
 * Strip the machine-readable block so it never reaches a memory file.
 */
export function stripDelta(reply: string): string {
  const start = reply.indexOf(DELTA_OPEN)
  if (start < 0) return reply
  const body = reply.slice(start + DELTA_OPEN.length)
  const { end, rest } = findDeltaEnd(body)
  if (end < 0) return reply.slice(0, start)
  return `${reply.slice(0, start)}${rest}`
}

/**
 * Extract the delta block the writer appended to its reply.
 *
 * Format is markdown sections, not JSON. JSON was tried first and is the wrong
 * choice here: paths are the highest-frequency content in this system, and a
 * Windows path in a JSON string needs every backslash doubled. The writer got
 * that right in some places and wrong in others within the same block, which
 * fails the whole parse — an intermittent failure that only reproduced on a
 * real checkpoint. Markdown sections put no constraint on content: backslashes,
 * quotes, arrows and blank lines all pass through untouched.
 *
 * Returns null when neither part carries content, so the caller can fall back to
 * the 0.4.x append behaviour rather than losing the result. A global-only delta
 * is valid: the project sections may all be absent.
 */
export function extractDelta(reply: string): WriterDelta | null {
  const start = reply.indexOf(DELTA_OPEN)
  if (start < 0) return null
  const body = reply.slice(start + DELTA_OPEN.length)
  const { end } = findDeltaEnd(body)
  if (end < 0) return null
  const block = body.slice(0, end)

  const project = emptyDelta()
  let global = ""
  let bucket: MemorySection | "global" | null = null
  let buf: string[] = []
  const flush = () => {
    const text = buf.join("\n").trim()
    if (text && bucket === "global") global = text
    else if (text && bucket) project[bucket] = text
    buf = []
  }
  for (const line of block.split("\n")) {
    const h = /^##\s+(.+?)\s*$/.exec(line)
    if (h) {
      flush()
      const name = h[1]
      bucket =
        name === GLOBAL_HEADING
          ? "global"
          : (MEMORY_SECTIONS as readonly string[]).includes(name)
            ? (name as MemorySection)
            : null
      continue
    }
    if (bucket) buf.push(line)
  }
  flush()
  const hasProject = MEMORY_SECTIONS.some((n) => project[n])
  if (!hasProject && !global) return null
  return { project, global }
}

export function layoutDone(db: Db, pid: string): boolean {
  return metaGet(db, `${LAYOUT_KEY_PREFIX}${pid}`) === LAYOUT_VERSION
}

export function markLayout(db: Db, pid: string): void {
  metaSet(db, `${LAYOUT_KEY_PREFIX}${pid}`, LAYOUT_VERSION)
}

/**
 * Fold a pre-sectioned MEMORY.md into the four sections, once per project.
 *
 * The mechanical part is ours: read, parse, re-render, record the layout
 * version so it never runs twice. Deciding which of the old lines belong to
 * which section is a judgement call and is deliberately not automated — the
 * caller passes the already-classified text. Idempotent via memory_layout, and
 * a no-op when the file is missing or already sectioned.
 */
export function migrateMemoryLayout(
  db: Db,
  root: string,
  projectDir: string,
  pid: string,
  classified: MemoryDelta | null,
): { migrated: boolean; reason: string } {
  if (layoutDone(db, pid)) return { migrated: false, reason: "already-migrated" }
  const p = buildPath({ root, scope: "projects", scope_id: pid, key: "MEMORY" })
  const existing = readMemoryFile(p)
  if (existing === null) return { migrated: false, reason: "no-file" }
  const hasSections = MEMORY_SECTIONS.some((name) => new RegExp(`^##\\s+${name}\\s*$`, "m").test(existing))
  if (hasSections) {
    markLayout(db, pid)
    return { migrated: false, reason: "already-sectioned" }
  }
  if (!classified) return { migrated: false, reason: "needs-classification" }
  const merged: MemoryDelta = emptyDelta()
  for (const name of MEMORY_SECTIONS) {
    const capped = capSection(classified[name] ?? "", SECTION_CAPS[name])
    merged[name] = capped.text
  }
  const written = writeMemoryFile(p, renderMemorySections(projectDir, merged))
  if (!written.ok) return { migrated: false, reason: written.reason }
  markLayout(db, pid)
  return { migrated: true, reason: "migrated" }
}
