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

// The plugin names this agent in session.create(). If it is absent from the
// tarball the host silently falls back to a default agent: the writer sub-agent
// regains a full tool set and its permission asks become interactive again.
// Both failures were observed before this file existed, so check it here rather
// than letting them come back through a stale build.
const agentFile = "dist/agent/promem-writer.md"
if (!existsSync(new URL(agentFile, root))) {
  problems.push(`缺少 ${agentFile} (请先 npm run build) — 缺失会导致 writer 子代理回退到默认 agent`)
} else {
  const body = await readF(new URL(agentFile, root), "utf8")
  if (!/toolAllowlist|permission:/.test(body)) {
    problems.push(`${agentFile} 缺少工具/权限限制,子代理将获得默认工具集`)
  } else {
    ok.push(agentFile)
  }
  if (!/mode:\s*subagent/.test(body)) {
    problems.push(`${agentFile} 未声明 mode: subagent,审批将回退为交互式`)
  }
}

// dist/ is gitignored, so a source change does not invalidate it — the bundle
// on disk can be arbitrarily older than src/. Publishing that bundle ships code
// the repository no longer contains, and it is invisible: the local `npm pack`
// shasum then matches the tarball, so nothing looks wrong. Observed after the
// deadline-constant change, where pack happily produced the pre-change bundle
// under a bumped version number.
const srcWriter = await readF(new URL("src/session/writer.ts", root), "utf8").catch(() => "")
const distBundle = await readF(new URL("dist/index.js", root), "utf8").catch(() => "")
if (srcWriter && distBundle) {
  // Compare only the load-bearing tuning constants. Both sides are normalised
  // before comparing because the two write the same number differently:
  // `135_000` in source, `135e3` in the bundle. Number() alone is not enough —
  // it returns NaN for the underscore form, so NaN !== 135000 would report
  // drift on a perfectly fresh build.
  const num = (raw) => Number(String(raw).replace(/_/g, ""))
  const TRACKED = ["CHILD_DEADLINE_MS_PER_BYTE", "INCREMENT_BUDGET"]
  const stale = TRACKED.filter((name) => {
    const inSrc = srcWriter.match(new RegExp(`^const[ \\t]+${name}[ \\t]*=[ \\t]*(-?[0-9_.e]+)`, "m"))?.[1]
    const inDist = distBundle.match(new RegExp(`^var[ \\t]+${name}[ \\t]*=[ \\t]*(-?[0-9_.e]+)`, "m"))?.[1]
    // Only a name declared on both sides is comparable: the bundle drops some
    // consts entirely, and an absent one is not drift.
    if (inSrc === undefined || inDist === undefined) return false
    return num(inSrc) !== num(inDist)
  })
  if (stale.length > 0) {
    problems.push(
      `dist/index.js 与 src/session/writer.ts 不一致(${stale.join(", ")}) — 请先 npm run build,否则发布的是旧代码`,
    )
  } else {
    ok.push("dist 与 src 常量一致")
  }
}

// deploy/ ships as a hand-maintained copy of the shared modules so a single
// tarball can be dropped into both the plugin and command locations.
// `gen:deploy-entry --check` only compares the entry file's import list, so a
// stale shared module in the copy passes the whole gate — which is how a cursor
// fix reached src/ and left deploy/ a release behind.
//
// The shared set is read from sync-deploy.mjs rather than re-listed: a second
// copy of that list would drift, and the drift would read as "deploy is fine".
const DEPLOY_SHARED = "deploy/opencode-plugin/project-memory/src"
const syncSrc = await readF(new URL("scripts/sync-deploy.mjs", root), "utf8").catch(() => "")
const sharedList = [...syncSrc.matchAll(/^\s*"([^"]+\.(?:ts|txt))",$/gm)].map((m) => m[1])
if (sharedList.length === 0) {
  problems.push("无法从 scripts/sync-deploy.mjs 解析共享文件清单,deploy 一致性检查无效")
} else {
  const drift = []
  for (const rel of sharedList) {
    const from = await readF(new URL(`src/${rel}`, root), "utf8").catch(() => null)
    const to = await readF(new URL(`${DEPLOY_SHARED}/${rel}`, root), "utf8").catch(() => null)
    if (from === null) drift.push(`${rel} (src 缺失)`)
    else if (to === null) drift.push(`${rel} (deploy 缺失)`)
    else if (to !== from) drift.push(`${rel} (内容不同)`)
  }
  if (drift.length > 0) {
    problems.push(`deploy 副本与 src 不一致:${drift.join(", ")} — 请先 npm run sync:deploy`)
  } else {
    ok.push(`deploy 副本与 src 一致(${sharedList.length} 个共享文件)`)
  }
}

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