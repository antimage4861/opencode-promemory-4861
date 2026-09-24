import { tool } from "@opencode-ai/plugin"
import type { Db } from "../memory/db.ts"
import { searchHistory, getHistoryPart } from "../history/service.ts"

export function createHistoryTool(deps: { db: () => Db; scoreFloor: () => number; getProjectId: () => string | null }) {
  return tool({
    description: [
      "检索会话原始对话（history 镜像的 BM25 搜索），返回逐字原文片段 + 定位。",
      "何时用：memory 检索不到、或需要精确原文（用户原话、完整命令、被摘要丢弃的细节）时。",
      "用法：search 给独特词；get 用返回的 part_id 读完整原文。",
      "默认只在当前项目范围内检索；跨项目需显式传 project_id（项目目录路径哈希）或用 session_id 限定单会话。",
    ].join("\n"),
    args: {
      operation: tool.schema.enum(["search", "get"]).optional().describe("操作，默认 search"),
      query: tool.schema.string().optional().describe("检索词（search 必需）"),
      session_id: tool.schema.string().optional().describe("限定某会话"),
      project_id: tool.schema.string().optional().describe("限定某项目（目录路径哈希 pid）；不传默认当前项目"),
      part_id: tool.schema.string().optional().describe("get 所需，读取该 part 完整原文"),
      limit: tool.schema.number().optional().describe("返回条数，默认 10"),
    },
    async execute(args) {
      if (args.operation === "get") {
        if (!args.part_id) return { title: "History get", output: "operation=get 需要 part_id。", metadata: { count: 0 } }
        const hit = getHistoryPart(deps.db(), args.part_id)
        if (!hit) return { title: "History get", output: `Part not found: ${args.part_id}`, metadata: { count: 0 } }
        const currentPid = deps.getProjectId()
        if (currentPid && hit.project_id && hit.project_id !== currentPid) {
          return {
            title: "History get",
            output: `Part ${args.part_id} 属于其他项目（project_id=${hit.project_id}），当前项目（${currentPid}）无权读取，已拒绝。`,
            metadata: { count: 0 },
          }
        }
        return { title: "History get", output: hit.body, metadata: { count: 1 } }
      }
      if (!args.query) return { title: "History search", output: "operation=search 需要 query。", metadata: { count: 0 } }
      const project_id = args.project_id ?? deps.getProjectId() ?? undefined
      const results = searchHistory(deps.db(), {
        query: args.query,
        session_id: args.session_id,
        project_id,
        limit: args.limit,
        scoreFloor: deps.scoreFloor(),
      })
      if (results.length === 0) {
        return {
          title: "History search: 0 results",
          output: [
            `No matches for "${args.query}".`,
            "",
            "0 结果不代表原文不存在——若记忆目录已索引，检查：1) 用更独特的词重试；2) 该内容可能发生在插件启用之前；3) 放宽到 memory 工具或 grep 原文目录。",
          ].join("\n"),
          metadata: { count: 0 },
        }
      }
      const lines = [
        `Found ${results.length} match(es)（摘要片段；用 history get part_id=... 读完整原文）。`,
        project_id ? `范围：当前项目（project_id=${project_id}）` : "范围：全库",
        "",
      ]
      for (const r of results) {
        lines.push(`### session_id=${r.session_id} message_id=${r.message_id} part_id=${r.part_id} time=${r.time_created}`)
        lines.push(`score=${r.score.toFixed(3)} project_id=${r.project_id ?? "unknown"}`)
        lines.push(r.snippet)
        lines.push("")
      }
      return {
        title: `History search: ${results.length} result(s)`,
        output: lines.join("\n"),
        metadata: { count: results.length },
      }
    },
  })
}
