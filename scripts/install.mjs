#!/usr/bin/env node
import { mkdir, copyFile, readdir, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"

const pkgRoot = fileURLToPath(new URL("../", import.meta.url))
const PLUGIN_COMMAND_DIR = path.join(pkgRoot, "dist", "command")

const DEFAULT_COMMAND_DIR = path.join(os.homedir(), ".config", "opencode", "command")
const CANDIDATES = process.env.OPENCODE_CONFIG_DIR
  ? [path.join(process.env.OPENCODE_CONFIG_DIR, "command"), DEFAULT_COMMAND_DIR]
  : [DEFAULT_COMMAND_DIR]

const target = CANDIDATES.find(existsSync) ?? CANDIDATES[0]
await mkdir(target, { recursive: true })
const files = await readdir(PLUGIN_COMMAND_DIR)
let copied = 0
for (const f of files) {
  if (!f.endsWith(".md")) continue
  const from = path.join(PLUGIN_COMMAND_DIR, f)
  const to = path.join(target, f)
  if (existsSync(to)) {
    const a = await stat(from)
    const b = await stat(to)
    if (a.mtimeMs <= b.mtimeMs) continue
  }
  await copyFile(from, to)
  copied++
}

console.log(copied === 0 ? `✓ 命令模板已是最新(0 新增): ${target}` : `✓ 已复制 ${copied} 个命令模板到 ${target}`)
console.log(`说明:如需卸载,直接删除该目录下的 mem-checkpoint.md / mem-dream.md / mem-distill.md / mem-search.md 即可。`)