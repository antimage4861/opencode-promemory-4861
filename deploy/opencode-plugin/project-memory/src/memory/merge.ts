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
export const LAYOUT_VERSION = "sections-v1"

export function emptyDelta(): MemoryDelta {
  return { "Project context": "", Rules: "", "Architecture decisions": "", "Discovered durable knowledge": "" }
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
 * Extract the delta block the writer appended to its reply. Returns null when
 * absent or unparseable so the caller can fall back to the 0.4.x append
 * behaviour rather than losing the result.
 */
export function extractDelta(reply: string): MemoryDelta | null {
  const start = reply.indexOf(DELTA_OPEN)
  if (start < 0) return null
  const from = start + DELTA_OPEN.length
  const end = reply.indexOf(DELTA_CLOSE, from)
  if (end < 0) return null
  const raw = reply.slice(from, end).trim()
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const out = emptyDelta()
  for (const name of MEMORY_SECTIONS) {
    const value = (parsed as Record<string, unknown>)[name]
    if (typeof value === "string" && value.trim()) out[name] = value.trim()
  }
  return MEMORY_SECTIONS.some((n) => out[n]) ? out : null
}

/** Strip the machine-readable block so it never reaches a memory file. */
export function stripDelta(reply: string): string {
  const start = reply.indexOf(DELTA_OPEN)
  if (start < 0) return reply
  const from = start + DELTA_OPEN.length
  const end = reply.indexOf(DELTA_CLOSE, from)
  return end < 0 ? reply.slice(0, start) : `${reply.slice(0, start)}${reply.slice(end + DELTA_CLOSE.length)}`
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
