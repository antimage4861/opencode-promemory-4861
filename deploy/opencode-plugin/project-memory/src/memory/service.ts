import type { Db } from "./db.ts"

export interface SearchResult {
  path: string
  scope: string
  scope_id: string
  type: string
  snippet: string
  score: number
}

export function cjkSpace(text: string): string {
  return text.replace(/([\u4e00-\u9fff])(?=[\u4e00-\u9fff])/g, "$1 ").trim()
}

export function buildFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? []
  if (tokens.length === 0) return null
  const quoted = tokens.map((t) => `"${cjkSpace(t).replaceAll('"', "")}"`)
  return quoted.join(" OR ")
}

export function extractSnippet(body: string, query: string, windowChars = 80): string {
  const tokens = body.match(/[\p{L}\p{N}_]+/gu) ?? []
  const qTokens = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.toLowerCase())
  let bestIdx = -1
  let bestCount = 0
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i]!.toLowerCase()
    if (qTokens.includes(word)) {
      const count = qTokens.filter((q) => q === word).length
      if (count > bestCount) {
        bestCount = count
        bestIdx = i
      }
    }
  }
  if (bestIdx === -1) {
    return body.length > windowChars * 2 ? body.slice(0, windowChars * 2) + "..." : body
  }
  let start = 0
  let pos = -1
  let consumed = 0
  for (let i = 0; i <= bestIdx; i++) {
    pos = body.indexOf(tokens[i]!, consumed)
    if (pos === -1) {
      pos = consumed
    }
    start = pos
    consumed = pos + tokens[i]!.length
  }
  const from = Math.max(0, start - windowChars)
  const to = Math.min(body.length, consumed + windowChars)
  const prefix = from > 0 ? "..." : ""
  const suffix = to < body.length ? "..." : ""
  return prefix + body.slice(from, to) + suffix
}

export function searchMemory(
  db: Db,
  input: { query: string; scope?: string; scope_id?: string; type?: string; limit?: number; scoreFloor?: number },
): SearchResult[] {
  const limit = input.limit ?? 10
  const ftsQuery = buildFtsQuery(input.query)
  if (!ftsQuery) return []
  const floorRatio = input.scoreFloor ?? 0.15

  const conditions: string[] = []
  const params: unknown[] = []
  if (input.scope) {
    conditions.push("memory_fts.scope = ?")
    params.push(input.scope)
  }
  if (input.scope_id) {
    conditions.push("memory_fts.scope_id = ?")
    params.push(input.scope_id)
  }
  if (input.type) {
    conditions.push("memory_fts.type = ?")
    params.push(input.type)
  }
  const whereClause = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : ""

  const sql = `
    SELECT memory_fts.path, memory_fts.scope, memory_fts.scope_id, memory_fts.type, memory_fts.body,
           bm25(memory_fts_idx) AS score
    FROM memory_fts_idx
    JOIN memory_fts ON memory_fts.id = memory_fts_idx.rowid
    WHERE memory_fts_idx MATCH ?
    ${whereClause}
    ORDER BY score
    LIMIT ?
  `
  const fetchLimit = Math.min(limit * 3, 50)
  const rows = db.all<{ path: string; scope: string; scope_id: string; type: string; body: string; score: number }>(
    sql,
    ftsQuery,
    ...params,
    fetchLimit,
  )
  const mapped: SearchResult[] = rows.map((r) => ({
    path: r.path,
    scope: r.scope,
    scope_id: r.scope_id,
    type: r.type,
    snippet: extractSnippet(r.body, input.query),
    score: -r.score,
  }))
  if (mapped.length === 0) return []
  const topScore = mapped[0]!.score
  const cutoff = floorRatio > 0 ? topScore * floorRatio : -Infinity
  return mapped.filter((r, i) => i === 0 || r.score >= cutoff).slice(0, limit)
}
