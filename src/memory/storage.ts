import fs from "fs"
import path from "path"
import crypto from "crypto"

export const MAX_FILE_BYTES = 10 * 1024
export const MAX_FILE_LINES = 200

export type WriteResult =
  | { ok: true }
  | { ok: false; reason: "size-exceeded" | "write-disabled" | "io" }

export interface MemoryWriteConfig {
  memory?: {
    disable_write?: boolean
  }
}

export function isMemoryWriteEnabled(cfg: MemoryWriteConfig | undefined): boolean {
  return cfg?.memory?.disable_write !== true
}

function ensureDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

export function readMemoryFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8")
  } catch {
    return null
  }
}

export function statFingerprint(filePath: string): string | null {
  try {
    const st = fs.statSync(filePath)
    return `${st.size}-${st.mtimeMs}`
  } catch {
    return null
  }
}

export function writeMemoryFile(filePath: string, body: string, cfg?: MemoryWriteConfig): WriteResult {
  if (!isMemoryWriteEnabled(cfg)) return { ok: false, reason: "write-disabled" }
  const bytes = Buffer.byteLength(body, "utf8")
  if (bytes > MAX_FILE_BYTES) return { ok: false, reason: "size-exceeded" }
  const lineCount = body.split("\n").length
  if (lineCount > MAX_FILE_LINES) return { ok: false, reason: "size-exceeded" }
  try {
    ensureDir(filePath)
    fs.writeFileSync(filePath, body, "utf8")
    return { ok: true }
  } catch {
    return { ok: false, reason: "io" }
  }
}

export function removeMemoryFile(filePath: string, cfg?: MemoryWriteConfig): boolean {
  if (!isMemoryWriteEnabled(cfg)) return false
  try {
    fs.unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}

export function listFiles(root: string, prefix: string[]): string[] {
  const dir = path.join(root, ...prefix)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    if (e.isDirectory()) {
      out.push(...listFiles(root, [...prefix, e.name]))
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(path.join(dir, e.name))
    }
  }
  return out
}

export interface ReadLock {
  acquire(): Promise<void>
  release(): void
}

const lockMarkerSuffix = ".memlock"

async function acquireWithTimeout(marker: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      fs.mkdirSync(marker)
      return true
    } catch {
      if (Date.now() > deadline) return false
      await new Promise((r) => setTimeout(r, 25))
    }
  }
}

function releaseLock(marker: string) {
  try {
    fs.rmdirSync(marker)
  } catch {
    try {
      fs.rmSync(marker, { recursive: true, force: true })
    } catch {}
  }
}

export async function withFileLock<T>(filePath: string, fn: () => T | Promise<T>, timeoutMs = 5000): Promise<T | null> {
  const marker = `${filePath}${lockMarkerSuffix}`
  const acquired = await acquireWithTimeout(marker, timeoutMs)
  if (!acquired) return null
  try {
    return await fn()
  } finally {
    releaseLock(marker)
  }
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex")
}
