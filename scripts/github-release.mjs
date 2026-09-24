#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const TOKEN_FILE = process.env.GITHUB_TOKEN_FILE ?? path.join(os.homedir(), ".config", "opencode", "github-token")

const [tag, ...rest] = process.argv.slice(2)
const body = rest.join(" ")

if (!tag) {
  console.error("用法: node scripts/github-release.mjs <tag> [release 说明文字]")
  console.error("token 来源: 环境变量 GITHUB_TOKEN,或文件 " + TOKEN_FILE)
  process.exit(1)
}

async function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  try {
    const st = await stat(TOKEN_FILE)
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
      console.error(`⚠ 建议收紧权限: chmod 600 ${TOKEN_FILE}`)
    }
    const raw = await readFile(TOKEN_FILE, "utf8")
    const tok = raw.trim().split(/\r?\n/)[0]
    if (!tok) throw new Error("token 文件为空")
    return tok
  } catch {
    console.error(`未找到 GitHub token。请: 1) 生成新 token 2) 保存到 ${TOKEN_FILE} 或导出 GITHUB_TOKEN`)
    process.exit(1)
  }
}

const token = await getToken()
const repo = "antimage4861/opencode-promemory-4861"

async function api(pathname, options = {}) {
  const res = await fetch("https://api.github.com" + pathname, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "opencode-promemory-4861-release",
      ...(options.headers ?? {}),
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 300)}`)
  }
  return res.status === 204 ? null : res.json()
}

const me = await api("/user")
console.log(`已认证: ${me.login}`)

const existing = await api(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`).catch(() => null)
if (existing) {
  console.log(`⚠ Release ${tag} 已存在: ${existing.html_url}`)
  process.exit(0)
}

const release = await api(`/repos/${repo}/releases`, {
  method: "POST",
  body: JSON.stringify({
    tag_name: tag,
    name: tag,
    body: body || `发布 ${tag}`,
    draft: false,
    prerelease: false,
  }),
})

console.log(`✓ Release 已创建: ${release.html_url}`)
