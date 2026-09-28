import { mkdir, writeFile, copyFile, readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const dirname = fileURLToPath(new URL("..", import.meta.url))
const DIST = dirname + "dist"

await mkdir(DIST, { recursive: true })

await build({
  entryPoints: [dirname + "src/index.ts"],
  outfile: dirname + "dist/index.js",
  bundle: true,
  format: "esm",
platform: "node",
target: "es2022",
external: ["bun:sqlite", "@opencode-ai/plugin"],
sourcemap: false,
minify: false,
  logLevel: "info",
})

await writeFile(
  DIST + "/index.d.ts",
  `import type { Plugin } from "@opencode-ai/plugin"
export declare const ProjectMemoryPlugin: Plugin
`,
  "utf8",
)

const commandOut = DIST + "/command"
await mkdir(commandOut, { recursive: true })
const commandSrc = dirname + "src/command"
for (const f of await readdir(commandSrc)) {
  if (f.endsWith(".md")) await copyFile(commandSrc + "/" + f, commandOut + "/" + f)
}

// The writer sub-agent definition ships with the package because the plugin
// names it in session.create(). Without this file the host falls back to a
// default agent, which silently restores the two failures the definition
// exists to prevent: the child gets a full tool set, and its permission asks
// become interactive because it has no parent to inherit grants from.
const agentOut = DIST + "/agent"
await mkdir(agentOut, { recursive: true })
const agentSrc = dirname + "src/agent"
for (const f of await readdir(agentSrc)) {
  if (f.endsWith(".md")) await copyFile(agentSrc + "/" + f, agentOut + "/" + f)
}

console.log("✓ dist/index.js + dist/index.d.ts + dist/command/*.md + dist/agent/*.md 生成")