import type { Db } from "./db.ts"
import { readMemoryFile, statFingerprint } from "./storage.ts"
import { parsePath, type MemoryLocator } from "./paths.ts"
import { cjkSpace } from "./service.ts"

export function locKey(loc: MemoryLocator): string {
  if (loc.scope === "global") return `memory/global/${loc.key}.md`
  return `memory/${loc.scope}/${loc.scope_id}/${loc.key}.md`
}

export function initMemoryFts(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_fts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL,
      scope_id TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      body TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      last_indexed_at INTEGER NOT NULL
    );
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS memory_fts_scope_idx ON memory_fts(scope, scope_id);
    CREATE INDEX IF NOT EXISTS memory_fts_type_idx ON memory_fts(type);
  `)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_idx USING fts5(
      body,
      content_rowid='rowid'
    );
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
}

export function metaGet(db: Db, key: string): string | null {
  const r = db.get<{ value: string }>("SELECT value FROM memory_meta WHERE key = ?", key)
  return r?.value ?? null
}

export function metaSet(db: Db, key: string, value: string) {
  db.run("INSERT INTO memory_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value)
}

export function upsertIndexRow(db: Db, path: string, loc: MemoryLocator, body: string, fingerprint: string) {
  const row = db.get<{ id: number }>("SELECT id FROM memory_fts WHERE path = ?", path)
  if (row) {
    db.run(
      "UPDATE memory_fts SET scope=?, scope_id=?, type=?, body=?, fingerprint=?, last_indexed_at=? WHERE id=?",
      loc.scope,
      loc.scope_id,
      loc.type,
      body,
      fingerprint,
      Date.now(),
      row.id,
    )
    db.run("DELETE FROM memory_fts_idx WHERE rowid = ?", row.id)
    db.run("INSERT INTO memory_fts_idx(rowid, body) VALUES(?, ?)", row.id, cjkSpace(body))
  } else {
    const info = db.get<{ id: number }>(
      "INSERT INTO memory_fts(scope, scope_id, type, body, fingerprint, last_indexed_at, path) VALUES(?,?,?,?,?,?,?) RETURNING id",
      loc.scope,
      loc.scope_id,
      loc.type,
      body,
      fingerprint,
      Date.now(),
      path,
    )
    const id = info!.id
    db.run("INSERT INTO memory_fts_idx(rowid, body) VALUES(?, ?)", id, cjkSpace(body))
  }
}

export function deleteIndexRow(db: Db, path: string) {
  const row = db.get<{ id: number }>("SELECT id FROM memory_fts WHERE path = ?", path)
  if (!row) return
  db.run("DELETE FROM memory_fts_idx WHERE rowid = ?", row.id)
  db.run("DELETE FROM memory_fts WHERE id = ?", row.id)
}

export function indexFromDisk(db: Db, filePath: string): "hit" | "updated" | "skipped" {
  const loc = parsePath(filePath)
  if (!loc) return "skipped"
  const fingerprint = statFingerprint(filePath)
  if (!fingerprint) return "skipped"
  const row = db.get<{ fingerprint: string }>("SELECT fingerprint FROM memory_fts WHERE path = ?", filePath)
  if (row?.fingerprint === fingerprint) return "hit"
  const body = readMemoryFile(filePath)
  if (body === null) return "skipped"
  upsertIndexRow(db, filePath, loc, body, fingerprint)
  return "updated"
}

export function reconcileMemory(db: Db, filePaths: string[]): { indexed: number; pruned: number } {
  const diskPaths = new Set(filePaths)
  let pruned = 0
  const rows = db.all<{ path: string }>("SELECT path FROM memory_fts")
  for (const r of rows) {
    if (!diskPaths.has(r.path)) {
      deleteIndexRow(db, r.path)
      pruned++
    }
  }
  let indexed = 0
  for (const p of diskPaths) {
    if (indexFromDisk(db, p) === "updated") indexed++
  }
  return { indexed, pruned }
}
