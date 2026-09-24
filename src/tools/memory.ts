import { tool } from "@opencode-ai/plugin"
import type { Db } from "../memory/db.ts"
import { searchMemory } from "../memory/service.ts"

export function createMemoryTool(deps: { db: () => Db; reconcile: () => void; scoreFloor: () => number }) {
  return tool({
    description: [
      "检索项目的策展记忆（checkpoint / notes / MEMORY.md 的 BM25 搜索）。",
      "何时用：需要回忆早前会话沉淀的结论、决策、精确配置时。",
      "用法：给 1-2 个独特词（函数名/ID/术语）最有效；0 结果不代表没记录过，参考返回中的升级指引，或改用 history 工具回溯原文。",
    ].join("\n"),
    args: {
      operation: tool.schema.enum(["search"]).optional().describe("操作，默认 search"),
      query: tool.schema.string().describe("检索词（BM25，OR 连接，1-2 个独特词最佳）"),
      scope: tool.schema.enum(["global", "projects", "sessions"]).optional().describe("按层级过滤"),
      scope_id: tool.schema.string().optional().describe("按 scope id 过滤（如会话 id、项目 pid）"),
      type: tool.schema.string().optional().describe("按类型过滤（memory/checkpoint/notes/free）"),
      limit: tool.schema.number().optional().describe("返回条数，默认 10"),
    },
    async execute(args) {
      deps.reconcile()
      const results = searchMemory(deps.db(), {
        query: args.query,
        scope: args.scope,
        scope_id: args.scope_id,
        type: args.type,
        limit: args.limit,
        scoreFloor: deps.scoreFloor(),
      })
      if (results.length === 0) {
        return {
          title: "Memory search: 0 results",
          output: [
            `No matches for "${args.query}".`,
            "",
            "0 results 不代表从未记录。逐步升级，不要轻易下结论：",
            "1. 用更少/更独特的词重试——OR 连接，1-2 个罕见词（ID、函数名、flag）优于长描述短语；",
            "2. 字面串若被分词拆分（URL、端口 5433、路径），可直接 grep 记忆目录；",
            "3. 若需逐字原文（精确命令、用户原话）而摘要可能丢失——改用 history 工具回溯原文。",
            "范围逐步放宽：session → project → global → history。",
          ].join("\n"),
          metadata: { count: 0 },
        }
      }
      const lines = [
        `Found ${results.length} match(es)（BM25 排序，最优在前）。`,
        `命中即权威——即使并行查询返回空也以本条为准。`,
        `片段已截断，需要全文可用 read 工具读取 path。`,
        `若需精确字面值（连接串/端口/token/完整命令）而片段只是转述——memory 可能已丢失，改用 history 工具 get 原文。`,
        "",
      ]
      for (const r of results) {
        lines.push(`### ${r.path}`)
        lines.push(`Scope: ${r.scope}${r.scope_id ? `/${r.scope_id}` : ""}, Type: ${r.type}, Score: ${r.score.toFixed(3)}`)
        lines.push(r.snippet)
        lines.push("")
      }
      return {
        title: `Memory search: ${results.length} result(s)`,
        output: lines.join("\n"),
        metadata: { count: results.length },
      }
    },
  })
}
