import type { Db } from "../memory/db.ts"
import { cjkSpace } from "../memory/service.ts"
import { partsFromMessage } from "./service.ts"

export interface MirrorPart {
  part_id: string
  session_id: string
  message_id: string
  body: string
  time_created: number
  tool_name?: string
}

export function initHistoryFts(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_fts (
      part_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      body TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      tool_name TEXT
    );
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS history_fts_session_idx ON history_fts(session_id, time_created);
    CREATE INDEX IF NOT EXISTS history_fts_message_idx ON history_fts(message_id);
  `)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS history_fts_idx USING fts5(
      body,
      content_rowid='rowid'
    );
  `)
}

export function upsertMirrorPart(db: Db, part: MirrorPart) {
  const row = db.get<{ rowid: number }>("SELECT rowid FROM history_fts WHERE part_id = ?", part.part_id)
  if (row) {
    db.run(
      "UPDATE history_fts SET session_id=?, message_id=?, body=?, time_created=?, tool_name=? WHERE part_id=?",
      part.session_id,
      part.message_id,
      part.body,
      part.time_created,
      part.tool_name ?? null,
      part.part_id,
    )
    db.run("DELETE FROM history_fts_idx WHERE rowid = ?", row.rowid)
    db.run("INSERT INTO history_fts_idx(rowid, body) VALUES(?, ?)", row.rowid, cjkSpace(part.body))
  } else {
    const info = db.get<{ rowid: number }>(
      "INSERT INTO history_fts(session_id, message_id, body, time_created, tool_name, part_id) VALUES(?,?,?,?,?,?) RETURNING rowid",
      part.session_id,
      part.message_id,
      part.body,
      part.time_created,
      part.tool_name ?? null,
      part.part_id,
    )
    const rowid = info!.rowid
    db.run("INSERT INTO history_fts_idx(rowid, body) VALUES(?, ?)", rowid, cjkSpace(part.body))
  }
}

export function deleteMirrorPart(db: Db, part_id: string) {
  const row = db.get<{ rowid: number }>("SELECT rowid FROM history_fts WHERE part_id = ?", part_id)
  if (!row) return
  db.run("DELETE FROM history_fts_idx WHERE rowid = ?", row.rowid)
  db.run("DELETE FROM history_fts WHERE part_id = ?", part_id)
}

export function deleteMirrorMessage(db: Db, session_id: string, message_id: string) {
  const rows = db.all<{ rowid: number; part_id: string }>(
    "SELECT rowid, part_id FROM history_fts WHERE session_id = ? AND message_id = ?",
    session_id,
    message_id,
  )
  for (const r of rows) {
    db.run("DELETE FROM history_fts_idx WHERE rowid = ?", r.rowid)
  }
  db.run("DELETE FROM history_fts WHERE session_id = ? AND message_id = ?", session_id, message_id)
}

export function deleteMirrorSession(db: Db, session_id: string) {
  const rows = db.all<{ rowid: number }>("SELECT rowid FROM history_fts WHERE session_id = ?", session_id)
  for (const r of rows) {
    db.run("DELETE FROM history_fts_idx WHERE rowid = ?", r.rowid)
  }
  db.run("DELETE FROM history_fts WHERE session_id = ?", session_id)
}

export function listMirrorSessionIds(db: Db): string[] {
  return db.all<{ session_id: string }>("SELECT DISTINCT session_id FROM history_fts").map((r) => r.session_id)
}

export async function catchupHistory(db: Db, client: any, sessions: Array<{ id: string }>, blacklist: Set<string>, pageSize = 200): Promise<number> {
  let added = 0
  for (const s of sessions) {
    if (blacklist.has(s.id)) continue
    try {
      const res = await client.session.messages({ path: { id: s.id }, query: { limit: pageSize } })
      const messages = (res?.data ?? []) as Array<{
        info?: { id?: string; sessionID?: string; time?: { created?: number } }
        parts?: Array<{ id?: string; type?: string; text?: string }>
      }>
      for (const m of messages) {
        for (const p of partsFromMessage(m, s.id)) {
          const exists = db.get<{ part_id: string }>("SELECT part_id FROM history_fts WHERE part_id = ?", p.part_id)
          if (exists) continue
          upsertMirrorPart(db, p)
          added++
        }
      }
    } catch {
      continue
    }
  }
  return added
}
