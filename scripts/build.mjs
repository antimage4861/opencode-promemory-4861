import { mkdir, writeFile } from "node:fs/promises"
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

console.log("✓ dist/index.js + dist/index.d.ts 生成")