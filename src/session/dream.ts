import { readMemoryFile } from "../memory/storage.ts"
import { buildPath, resolveProjectId } from "../memory/paths.ts"

export interface DreamSnapshot {
  projectDir: string
  path: string
  content: string
  takenAt: number
}

export interface DreamDiff {
  changed: boolean
  bytesBefore: number
  bytesAfter: number
  linesBefore: number
  linesAfter: number
  removed: number
  added: number
}

/**
 * dream is an agent-driven command: the plugin only gates the interval, then the
 * agent edits projects/<pid>/MEMORY.md itself. Nothing recorded what it changed,
 * so "did it actually revise anything, or did it just append again?" had no
 * answer — and a silent no-op looked identical to a successful consolidation.
 *
 * The snapshot is taken when the gate admits the command, and compared on the
 * next session-idle event, which is when the agent's turn has finished. The
 * before-content is kept in memory rather than hashed so the comparison can
 * report which lines were dropped, which is the part a human actually wants to
 * check: a revision should show removals, an append shows none.
 */
export function snapshotProjectMemory(root: string, projectDir: string | undefined): DreamSnapshot | null {
  if (!projectDir) return null
  const target = buildPath({
    root,
    scope: "projects",
    scope_id: resolveProjectId(projectDir),
    key: "MEMORY",
  })
  const content = readMemoryFile(target)
  if (content === null) return null
  return { projectDir, path: target, content, takenAt: Date.now() }
}

export function diffProjectMemory(before: DreamSnapshot | null, root: string): DreamDiff | null {
  if (!before) return null
  const after = readMemoryFile(before.path)
  if (after === null) return null
  // Non-empty lines, the same unit removed/added are counted in, so the three
  // numbers in the log line up with each other.
  const countLines = (s: string) => s.split("\n").filter((l) => l.trim() !== "").length
  const lineSet = (s: string) => {
    const m = new Map<string, number>()
    for (const line of s.split("\n")) {
      const t = line.trim()
      if (!t) continue
      m.set(t, (m.get(t) ?? 0) + 1)
    }
    return m
  }
  const a = lineSet(before.content)
  const b = lineSet(after)
  let removed = 0
  for (const [line, n] of a) removed += Math.max(0, n - (b.get(line) ?? 0))
  let added = 0
  for (const [line, n] of b) added += Math.max(0, n - (a.get(line) ?? 0))
  return {
    changed: before.content !== after,
    bytesBefore: Buffer.byteLength(before.content, "utf8"),
    bytesAfter: Buffer.byteLength(after, "utf8"),
    linesBefore: countLines(before.content),
    linesAfter: countLines(after),
    removed,
    added,
  }
}

export function describeDreamDiff(diff: DreamDiff): string {
  if (!diff.changed) {
    return `dream 未改动项目记忆（${diff.bytesBefore} 字节不变）—— 整合本应修订或合并，若近期确有新结论，说明它没有生效`
  }
  const bits = [
    `dream 修订项目记忆 ${diff.bytesBefore}→${diff.bytesAfter} 字节`,
    `行 ${diff.linesBefore}→${diff.linesAfter}`,
    `删 ${diff.removed} 行 / 增 ${diff.added} 行`,
  ]
  if (diff.removed === 0 && diff.added > 0) {
    bits.push("只有新增没有删除：本次是追加而非修订，过时条目可能仍在")
  }
  return bits.join("，")
}
