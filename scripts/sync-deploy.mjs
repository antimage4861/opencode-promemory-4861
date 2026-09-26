#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SRC = path.join(repoRoot, "src")
const DEPLOY = path.join(repoRoot, "deploy", "opencode-plugin", "project-memory", "src")

const SHARED_REL = [
  "config.ts",
  "history/mirror.ts",
  "history/service.ts",
  "memory/db.ts",
  "memory/fts.ts",
  "memory/paths.ts",
  "memory/service.ts",
  "memory/storage.ts",
  "session/compaction-hook.ts",
  "session/retention.ts",
  "session/validator.ts",
  "session/writer.ts",
  "session/writer-prompt.txt",
  "tools/history.ts",
  "tools/memory.ts",
]

let synced = 0
let changed = 0
for (const rel of SHARED_REL) {
  const from = path.join(SRC, rel)
  const to = path.join(DEPLOY, rel)
  if (!fs.existsSync(from)) {
    console.error(`✗ 源缺失: ${rel}(npm src 已无此文件,跳过)`)
    continue
  }
  const a = fs.readFileSync(from, "utf8")
  const b = fs.existsSync(to) ? fs.readFileSync(to, "utf8") : null
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.writeFileSync(to, a, "utf8")
  synced++
  if (a !== b) {
    changed++
    console.log(`→ 更新: ${rel}`)
  } else {
    console.log(`= 一致: ${rel}`)
  }
}

console.log(`\n同步完成:${synced} 个共享文件,${changed} 个已更新,${synced - changed} 个无变化。`)
console.log(`目标:deploy/opencode-plugin/project-memory/src(顶层 project-memory.ts 入口未改动)。`)
if (changed === 0) console.log("两处已一致,无需提交。")
