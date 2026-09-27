import { buildPath, resolveProjectId } from "./paths.ts"
import { readMemoryFile, writeMemoryFile } from "./storage.ts"

/**
 * Starting skeleton for a project's MEMORY.md. Written once, on the first
 * checkpoint that lands for a project, so the file is never born empty and
 * later appends have a header to sit under.
 *
 * Deliberately format-agnostic: this matches the 0.4.x append behaviour, where
 * each settled checkpoint is appended verbatim. The sectioned layout arrives
 * with the merge work and replaces this template then.
 */
export function projectMemoryTemplate(projectDir: string): string {
  return [
    `# 项目记忆（${projectDir}）`,
    "",
    "> 本文件由 project-memory 插件维护。下方按时间顺序追加各会话沉淀的 checkpoint 增量。",
    "> 稳定结论由 `/mem-dream` 定期整合；本段之下是原始增量，仅供回溯。",
  ].join("\n")
}

export function ensureMemoryTemplate(root: string, projectDir: string | undefined): boolean {
  if (!projectDir) return false
  const target = buildPath({
    root,
    scope: "projects",
    scope_id: resolveProjectId(projectDir),
    key: "MEMORY",
  })
  if (readMemoryFile(target) !== null) return false
  return writeMemoryFile(target, projectMemoryTemplate(projectDir)).ok
}
