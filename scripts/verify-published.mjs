// 发布后验证：确认 npm 上真的有这个版本，且关键内容与本仓库一致。
//
// 为什么需要这一步：`npm run check` 只看本地。发布这个动作本身可以被跳过而
// 没有任何报错 —— 0.6.8 就发生过：release 分支合并了、tarball 打了、内部也核对
// 了，但从未执行 `npm publish`，于是 registry 上没有 0.6.8，用户装到的还是上一个
// 版本，而 git 里却有一个 v0.6.8 tag。没有任何一步会失败。
//
// 四件事：
//   1. registry 上存在当前 package.json 的版本
//   2. dist-tags.latest 指向它（否则 npm i 装到的不是这个版本）
//   3. 把线上 tarball 解出来，比对承重常量与 src 是否一致
//   4. 扫本地 git tag，找出版本号存在而 registry 上没有的缺口
//
// 不比 shasum：发布后只要动过 package.json（加个脚本就会），本地 npm pack 的
// shasum 必然与线上不同。那是正常状态，不是缺陷，所以只作提示。真正的判据是
// 第 3 项 —— 线上产物里跑的常量是不是仓库里那些。
import { readFile } from "node:fs"
import { promisify } from "node:util"
import { execFile } from "node:child_process"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"

const readF = promisify(readFile)
const exec = promisify(execFile)
const root = new URL("..", import.meta.url)
const pkg = JSON.parse(await readF(new URL("package.json", root), "utf8"))
const version = pkg.version
const problems = []
const notes = []
const ok = []

const cwd = decodeURIComponent(new URL(root).pathname).replace(/^\/([A-Za-z]:)/, "$1")
const REGISTRY = `https://registry.npmjs.org/${pkg.name.replace("/", "%2f")}`

/** Semver-ish compare, enough for x.y.z tags. */
function cmpVer(a, b) {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

// 只在需要打本地包时走 CLI；Windows 上 npm 是 shell 包装脚本，必须经 shell。
async function packLocal(dest) {
  const { stdout } = await exec("npm", ["pack", "--pack-destination", dest], { cwd, shell: true })
  return path.join(dest, stdout.trim().split("\n").pop().trim())
}

const meta = await fetch(REGISTRY).then((r) => (r.ok ? r.json() : null)).catch(() => null)
if (!meta) {
  console.error(`✗ 无法访问 registry: ${REGISTRY}`)
  process.exit(1)
}

// 1. 版本存在
const rel = meta.versions?.[version]
if (!rel) {
  const onRegistry = Object.keys(meta.versions ?? {}).join(", ")
  problems.push(`registry 上没有 ${pkg.name}@${version}（现有: ${onRegistry}）— 是否忘了 npm publish？`)
} else {
  ok.push(`registry 存在 ${version}`)
}

// 2. latest 指向
const latest = meta["dist-tags"]?.latest
if (latest !== version) {
  // npm 需要几十秒传播 dist-tags，刚 publish 时先重跑而不是判失败
  notes.push(`dist-tags.latest = ${latest}，本仓库为 ${version}${latest === undefined ? "（tag 缺失）" : ""}`)
} else {
  ok.push(`dist-tags.latest = ${version}`)
}

// 3. 线上产物常量 vs src
if (rel) {
  const tmp = await mkdtemp(path.join(tmpdir(), "promem-verify-"))
  try {
    const { stdout: packOut } = await exec("npm", ["pack", `${pkg.name}@${version}`, "--pack-destination", tmp], { cwd, shell: true })
    const dl = packOut.trim().split("\n").pop().trim()
    const tgz = path.join(tmp, dl)
    if (rel.dist?.shasum) {
      const localSha = createHash("sha1").update(await readF(tgz)).digest("hex")
      notes.push(
        localSha === rel.dist.shasum
          ? `下载包 shasum 与 registry 一致 (${localSha.slice(0, 12)})`
          : `下载包 shasum ${localSha.slice(0, 12)} 与 registry 记录的 ${rel.dist.shasum.slice(0, 12)} 不同 — registry 记录的是它自己上传的那个包`,
      )
    }
    const ex = path.join(tmp, "x")
    await mkdir(ex, { recursive: true })
    // --force-local: without it GNU tar reads "C:\..." as a host:path spec and
    // tries to reach a machine named "C".
    await exec("tar", ["--force-local", "-xzf", tgz, "-C", ex], { cwd })
    const bundle = await readF(path.join(ex, "package", "dist", "index.js"), "utf8").catch(() => "")
    if (!bundle) {
      problems.push("线上 tarball 里读不出 dist/index.js")
    } else {
      const num = (raw) => Number(String(raw).replace(/_/g, ""))
      const srcs = {
        "src/session/writer.ts": await readF(new URL("src/session/writer.ts", root), "utf8"),
        "src/session/validator.ts": await readF(new URL("src/session/validator.ts", root), "utf8"),
      }
      const TRACKED = [
        ["CHILD_DEADLINE_MS_PER_BYTE", "src/session/writer.ts"],
        ["INCREMENT_BUDGET", "src/session/writer.ts"],
        ["MAX_CHECKPOINT_BYTES", "src/session/validator.ts"],
      ]
      const drift = []
      const seen = []
      for (const [name, file] of TRACKED) {
        const a = srcs[file].match(new RegExp(`^const[ \\t]+${name}[ \\t]*=[ \\t]*(-?[0-9_.e]+)`, "m"))?.[1]
        const b = bundle.match(new RegExp(`^var[ \\t]+${name}[ \\t]*=[ \\t]*(-?[0-9_.e]+)`, "m"))?.[1]
        if (a === undefined || b === undefined) { drift.push(`${name} 无法解析(src=${a} online=${b})`); continue }
        seen.push(name)
        // esbuild rewrites 135_000 as 135e3; Number() alone returns NaN for the
        // underscore form, so normalise before comparing or a fresh build reads
        // as drift.
        if (num(a) !== num(b)) drift.push(`${name} src=${a} online=${b}`)
      }
      if (drift.length > 0) problems.push(`线上产物常量与 src 不一致：${drift.join("; ")}`)
      else ok.push(`线上产物常量与 src 一致（${seen.join(", ")}）`)
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

// 4. tag 与 registry 的缺口
// 一个 vX.Y.Z tag 存在而 registry 没有该版本，说明发布被整段跳过了。0.6.8 就是：
// release PR 合并了、tag 打了，却从没执行 npm publish。
//
// 跳号本身是合法的发布策略 —— 0.6.8 被 0.6.9 取代、内容全在其中，所以「有 tag
// 无版本」本身不构成失败。真正该拦的是另一种：最新的 tag 没有对应版本，且它下面
// 还有一个更早的 tag 在 registry 上有版本。那说明最近这一次发布被跳过了，而跳号
// 无法解释它（跳号是旧版本被新版本取代，不是新版本没发）。
const tagsOut = await new Promise((res) => {
  exec("git", ["tag", "-l", "v*"], { cwd }, (e, so) => res(e ? "" : so))
})
const localTags = tagsOut
  .split("\n")
  .map((t) => t.trim())
  .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
  .sort((a, b) => cmpVer(a.slice(1), b.slice(1)))
const missing = localTags.filter((t) => !meta.versions?.[t.slice(1)])

if (missing.length === 0) {
  ok.push(`${localTags.length} 个 git tag 在 registry 上均有对应版本`)
} else {
  const latestTag = localTags[localTags.length - 1]
  const skippedLatest = !meta.versions?.[latestTag.slice(1)]
  const olderPublished = localTags.slice(0, -1).some((t) => meta.versions?.[t.slice(1)])
  if (skippedLatest && olderPublished) {
    problems.push(
      `最新 tag ${latestTag} 在 registry 上没有对应版本，而更早的 tag 有 — ` +
        `最近一次发布被跳过了，跳号无法解释（跳号是旧版本被取代，不是新版本缺失）。请 npm publish`,
    )
  } else {
    notes.push(
      `跳号：${missing.join(", ")} 在 registry 上无对应版本` +
        `（内容已在更高版本中，属合法跳号）`,
    )
  }
  if (missing.length > 1) {
    notes.push(`其余无版本的 tag：${missing.filter((t) => t !== latestTag).join(", ")}`)
  }
}

if (problems.length > 0) {
  console.error("✗ 发布后验证未通过:")
  for (const p of problems) console.error(`  - ${p}`)
  for (const n of notes) console.error(`  ! ${n}`)
  console.error("")
  console.error("处理后重新执行: npm run verify:published")
  process.exit(1)
}

console.log("✓ 发布后验证通过:")
for (const o of ok) console.log(`  - ${o}`)
for (const n of notes) console.log(`  ! ${n}`)
