import type { Db } from "../memory/db.ts"
import { buildFtsQuery, extractSnippet } from "../memory/service.ts"
import type { MirrorPart } from "./mirror.ts"

export interface HistoryHit {
  part_id: string
  session_id: string
  message_id: string
  time_created: number
  tool_name?: string
  project_id?: string
  snippet: string
  score: number
}

export function searchHistory(
  db: Db,
  input: { query: string; session_id?: string; project_id?: string; limit?: number; scoreFloor?: number },
): HistoryHit[] {
  const limit = input.limit ?? 10
  const ftsQuery = buildFtsQuery(input.query)
  if (!ftsQuery) return []
  const floorRatio = input.scoreFloor ?? 0.15

  const conditions: string[] = []
  const params: unknown[] = []
  if (input.session_id) {
    conditions.push("history_fts.session_id = ?")
    params.push(input.session_id)
  }
  if (input.project_id) {
    conditions.push("history_fts.project_id = ?")
    params.push(input.project_id)
  }
  const whereClause = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : ""

  const sql = `
    SELECT history_fts.part_id, history_fts.session_id, history_fts.message_id,
           history_fts.time_created, history_fts.tool_name, history_fts.project_id, history_fts.body,
           bm25(history_fts_idx) AS score
    FROM history_fts_idx
    JOIN history_fts ON history_fts.rowid = history_fts_idx.rowid
    WHERE history_fts_idx MATCH ?
    ${whereClause}
    ORDER BY score
    LIMIT ?
  `
  const fetchLimit = Math.min(limit * 3, 50)
  const rows = db.all<{
    part_id: string
    session_id: string
    message_id: string
    time_created: number
    tool_name: string | null
    project_id: string | null
    body: string
    score: number
  }>(sql, ftsQuery, ...params, fetchLimit)
  const mapped: HistoryHit[] = rows.map((r) => ({
    part_id: r.part_id,
    session_id: r.session_id,
    message_id: r.message_id,
    time_created: r.time_created,
    tool_name: r.tool_name ?? undefined,
    project_id: r.project_id ?? undefined,
    snippet: extractSnippet(r.body, input.query),
    score: -r.score,
  }))
  if (mapped.length === 0) return []
  const topScore = mapped[0]!.score
  const cutoff = floorRatio > 0 ? topScore * floorRatio : -Infinity
  return mapped.filter((r, i) => i === 0 || r.score >= cutoff).slice(0, limit)
}

export function getHistoryPart(db: Db, part_id: string): { body: string; project_id?: string } | null {
  const row = db.get<{ body: string; project_id: string | null }>(
    "SELECT body, project_id FROM history_fts WHERE part_id = ?",
    part_id,
  )
  if (!row) return null
  return { body: row.body, project_id: row.project_id ?? undefined }
}

export function partsFromMessage(message: {
  info: { id: string; sessionID?: string; time?: { created?: number } }
  parts?: Array<{ id?: string; type?: string; text?: string }>
}, sessionID: string): MirrorPart[] {
  const out: MirrorPart[] = []
  const msgId = message.info?.id ?? ""
  const created = message.info?.time?.created ?? Date.now()
  for (const p of message.parts ?? []) {
    if (p.type !== "text" || !p.text) continue
    out.push({
      part_id: p.id ?? `${msgId}-${out.length}`,
      session_id: message.info?.sessionID ?? sessionID,
      message_id: msgId,
      body: p.text,
      time_created: created,
    })
  }
  return out
}
