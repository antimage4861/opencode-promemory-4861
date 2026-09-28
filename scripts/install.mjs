#!/usr/bin/env node
// Install the slash-command templates and the writer sub-agent definition to
// every location opencode may read them from.
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

const GLOBAL_DIR = path.join(os.homedir(), ".config", "opencode")

/**
 * Each installable set: a source directory in dist/ and the directory name
 * opencode expects to find it under. They differ (command vs agent), so the
 * pair travels together rather than being hardcoded at each use site.
 */
const SETS = [
  { name: "命令模板", src: path.join(pkgRoot, "dist", "command"), dir: "command" },
  { name: "writer 子代理定义", src: path.join(pkgRoot, "dist", "agent"), dir: "agent" },
]

/** Project-local .opencode/<dir> directories, walking up from cwd. */
function projectDirs(startDir, dir) {
  const found = []
  let d = path.resolve(startDir)
  for (;;) {
    const candidate = path.join(d, ".opencode", dir)
    if (existsSync(candidate)) found.push(candidate)
    const parent = path.dirname(d)
    if (parent === d) break
    d = parent
  }
  return found
}

function resolveTargets(dir) {
  const explicit = process.argv.slice(2).filter((a) => !a.startsWith("-"))
  if (explicit.length > 0) return explicit.map((d) => path.resolve(d))
  const candidates = []
  if (process.env.OPENCODE_CONFIG_DIR) {
    candidates.push(path.join(process.env.OPENCODE_CONFIG_DIR, dir))
  }
  candidates.push(path.join(GLOBAL_DIR, dir), ...projectDirs(process.cwd(), dir))
  const unique = [...new Set(candidates.map((d) => path.resolve(d)))]
  const existing = unique.filter(existsSync)
  // Nothing exists yet: create the global default rather than installing nowhere.
  return existing.length > 0 ? existing : [path.join(GLOBAL_DIR, dir)]
}

let failed = false

for (const set of SETS) {
  if (!existsSync(set.src)) {
    console.error(`✗ 缺少 ${set.src}，请先运行 npm run build`)
    process.exit(1)
  }
  const targets = resolveTargets(set.dir)
  const files = (await readdir(set.src)).filter((f) => f.endsWith(".md"))
  const sources = new Map()
  for (const f of files) {
    sources.set(f, await readFile(path.join(set.src, f), "utf8"))
  }

  console.log(`\n[${set.name}]`)
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
      await copyFile(path.join(set.src, f), to)
      copied++
    }
    installed += copied
    // Cross-check: after installing, every location must hold identical bytes.
    for (const [f, body] of sources) {
      const got = await readFile(path.join(target, f), "utf8")
      if (got !== body) diverged.push(`${target} / ${f}`)
    }
    console.log(`  ${copied === 0 ? "= 已是最新" : `→ 复制 ${copied} 个`}  ${target}`)
  }

  console.log(
    installed === 0
      ? `  ✓ ${set.name}全部已是最新（共 ${targets.length} 个位置）`
      : `  ✓ ${set.name}已更新 ${installed} 处（共 ${targets.length} 个位置）`,
  )
  if (diverged.length > 0) {
    console.error(`  ✗ 以下位置内容仍不一致，需人工检查:`)
    for (const d of diverged) console.error(`      ${d}`)
    failed = true
  }
  if (targets.length > 1) {
    console.log(`  提示:同一份 ${set.name} 存在多个安装位置，任何一处过期都会导致行为不一致；本脚本已全部同步。`)
  }
}

if (failed) process.exit(1)

console.log("\n说明:如需卸载,删除各目录下对应的 .md 文件即可。")
console.log("      卸载 writer 子代理定义会削弱它的权限隔离 —— 没有该定义时,")
console.log("      宿主会回退到默认 agent,子代理将重新获得工具并可能阻塞在审批上。")
