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

console.log("✓ dist/index.js + dist/index.d.ts + dist/command/*.md 生成")