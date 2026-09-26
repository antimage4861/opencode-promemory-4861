import fs from "fs"
import path from "path"

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
