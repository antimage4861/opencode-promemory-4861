import { readFile, existsSync } from "node:fs"
import { promisify } from "node:util"

const readF = promisify(readFile)
const root = new URL("..", import.meta.url)

const problems = []
const ok = []

const pkg = JSON.parse(await readF(new URL("package.json", root), "utf8"))

const requiredFiles = ["dist/index.js", "dist/index.d.ts"]
for (const f of requiredFiles) {
  if (existsSync(new URL(f, root))) ok.push(f)
  else problems.push(`缺少构建产物: ${f} (请先 npm run build)`)
}

const nameOk = /^opencode-promemory-[a-z0-9-]+$/.test(pkg.name)
if (!nameOk) problems.push(`name 不符合约定规范: ${pkg.name}`)
else ok.push(`name=${pkg.name}`)

if (!pkg.main || pkg.main !== "./dist/index.js") problems.push(`main 应为 ./dist/index.js,当前=${pkg.main}`)
else ok.push(`main=${pkg.main}`)

const files = pkg.files ?? []
if (!files.includes("dist")) problems.push('files 未包含 "dist"')
else ok.push("files 包含 dist")

for (const banned of ["node_modules", "src", ".git"]) {
  if (files.includes(banned)) problems.push(`files 不应包含 ${banned}`)
}

if (!pkg.license) problems.push("缺少 license")
else ok.push(`license=${pkg.license}`)

if (problems.length > 0) {
  console.error("✗ 发布前检查未通过:")
  for (const p of problems) console.error(`  - ${p}`)
  console.error("")
  console.error("修复后重新执行: npm run check")
  process.exit(1)
}

console.log("✓ 发布前检查全部通过:")
for (const o of ok) console.log(`  - ${o}`)
console.log("")
console.log("下一步: npm pack 查看 tarball 内容,确认无误后 npm publish")