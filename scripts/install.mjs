#!/usr/bin/env node
// Install the slash-command templates to every location opencode may read them
// from.
//
// The previous version picked the FIRST existing candidate and compared by
// mtime. Two consequences, both observed in practice: the project-local
// .opencode/command was not a candidate at all, so the copy the TUI actually
// loads kept a month-old template; and mtime is not a reliable staleness signal
// for a file that was merely copied around.
import { mkdir, copyFile, readdir, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"

const pkgRoot = fileURLToPath(new URL("../", import.meta.url))
const PLUGIN_COMMAND_DIR = path.join(pkgRoot, "dist", "command")

const GLOBAL_COMMAND_DIR = path.join(os.homedir(), ".config", "opencode", "command")

/** Project-local .opencode/command directories, walking up from cwd. */
function projectCommandDirs(startDir) {
  const found = []
  let dir = path.resolve(startDir)
  for (;;) {
    const candidate = path.join(dir, ".opencode", "command")
    if (existsSync(candidate)) found.push(candidate)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return found
}

function resolveTargets() {
  const explicit = process.argv.slice(2).filter((a) => !a.startsWith("-"))
  if (explicit.length > 0) return explicit.map((d) => path.resolve(d))
  const candidates = []
  if (process.env.OPENCODE_CONFIG_DIR) {
    candidates.push(path.join(process.env.OPENCODE_CONFIG_DIR, "command"))
  }
  candidates.push(GLOBAL_COMMAND_DIR, ...projectCommandDirs(process.cwd()))
  const unique = [...new Set(candidates.map((d) => path.resolve(d)))]
  const existing = unique.filter(existsSync)
  // Nothing exists yet: create the global default rather than installing nowhere.
  return existing.length > 0 ? existing : [GLOBAL_COMMAND_DIR]
}

const targets = resolveTargets()
const files = (await readdir(PLUGIN_COMMAND_DIR)).filter((f) => f.endsWith(".md"))
const sources = new Map()
for (const f of files) {
  sources.set(f, await readFile(path.join(PLUGIN_COMMAND_DIR, f), "utf8"))
}

let installed = 0
const diverged = []
for (const target of targets) {
  await mkdir(target, { recursive: true })
  let copied = 0
  for (const [f, body] of sources) {
    const to = path.join(target, f)
    // Content comparison, not mtime: a copy operation can leave either timestamp
    // newer, and the only question that matters is whether the bytes differ.
    const current = existsSync(to) ? await readFile(to, "utf8") : null
    if (current === body) continue
    await copyFile(path.join(PLUGIN_COMMAND_DIR, f), to)
    copied++
  }
  installed += copied
  // Cross-check: after installing, every location must hold identical bytes.
  for (const [f, body] of sources) {
    const got = await readFile(path.join(target, f), "utf8")
    if (got !== body) diverged.push(`${target} / ${f}`)
  }
  console.log(`${copied === 0 ? "= 已是最新" : `→ 复制 ${copied} 个`}  ${target}`)
}

console.log(
  installed === 0
    ? `\n✓ 命令模板全部已是最新（共 ${targets.length} 个位置）`
    : `\n✓ 已更新 ${installed} 处（共 ${targets.length} 个位置）`,
)
if (diverged.length > 0) {
  console.error(`✗ 以下位置内容仍不一致，需人工检查:`)
  for (const d of diverged) console.error(`    ${d}`)
  process.exit(1)
}
if (targets.length > 1) {
  console.log("提示:同一份模板存在多个安装位置，任何一处过期都会导致行为不一致；本脚本已全部同步。")
}
console.log("说明:如需卸载,删除上述目录下的 mem-checkpoint.md / mem-dream.md / mem-distill.md / mem-search.md 即可。")
