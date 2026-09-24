import path from "path"
import { createHash } from "crypto"

export type Scope = "global" | "projects" | "sessions"

export type MemoryType = "free" | "memory" | "checkpoint" | "notes"

export interface MemoryLocator {
  scope: Scope
  scope_id: string
  type: MemoryType
  key: string
}

const TYPE_PATTERNS: Array<{ match: RegExp; type: MemoryType }> = [
  { match: /^memory$/i, type: "memory" },
  { match: /^memory-/i, type: "memory" },
  { match: /^checkpoint$/, type: "checkpoint" },
  { match: /^checkpoint-/, type: "checkpoint" },
  { match: /^notes$/, type: "notes" },
]

function detectType(key: string): MemoryType {
  for (const p of TYPE_PATTERNS) if (p.match.test(key)) return p.type
  return "free"
}

export function parsePath(absPath: string): MemoryLocator | null {
  const norm = absPath.replace(/\\/g, "/")
  const m = norm.match(/\/memory\/(global|projects|sessions)(?:\/([^/]+))?\/(.+)\.md$/)
  if (!m) return null
  const [, scope, idMaybe, keyRaw] = m
  const scope_id = scope === "global" ? "" : (idMaybe ?? "")
  return { scope: scope as Scope, scope_id, type: detectType(keyRaw), key: keyRaw }
}

function assertSafeComponent(value: string) {
  for (const segment of value.split("/")) {
    if (segment === "..") throw new Error(`buildPath: invalid path component: ${value}`)
  }
  if (value.startsWith("/")) throw new Error(`buildPath: invalid path component: ${value}`)
}

export function buildPath(input: { root: string; scope: Scope; scope_id?: string; key: string }): string {
  if (input.scope_id !== undefined) assertSafeComponent(input.scope_id)
  assertSafeComponent(input.key)
  const parts = [input.root, input.scope]
  if (input.scope !== "global") parts.push(input.scope_id ?? "")
  parts.push(`${input.key}.md`)
  return path.join(...parts)
}

export function resolveProjectId(absRepoPath: string): string {
  return createHash("sha256").update(absRepoPath).digest("hex").slice(0, 12)
}
