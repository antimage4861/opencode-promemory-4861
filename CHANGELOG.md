# 0.4.0 (2026-09-27)

- **BREAKING:移除「1h 空闲自动沉淀」通道**。checkpoint 触发通道由三个收敛为两个:**压缩前自动沉淀** / **手动 `/mem-checkpoint`**。
  - 持续活跃的会话本就拿不到空闲沉淀(活动刷新导致永不满足 1h 空闲),而空闲会话的沉淀质量与压缩前、手动触发同源,收益不足以支撑一条常驻定时器。
  - 删除 `startScanner` / `scanSessions` / `shouldCheckpoint` 与 `activityCache`(`scanner.ts` 仅剩过期清理,重命名为 `retention.ts`)。
  - **BREAKING:删除配置项** `PROJECT_MEMORY_IDLE_CHECKPOINT_TIMEOUT_MS` 与 `PROJECT_MEMORY_IDLE_CHECK_INTERVAL_MS`,设置后不再生效。
  - 保留不变:`session.idle` / `session.status` 结算事件、启动孤儿接管、`retentionTimer`。
  - 存量数据不受影响:`memory_meta` 的 `scanner:<sid>` 水位键名保持不变(改名会孤立 236 条历史水位)。
- `/mem-dream`、`/mem-distill` 维持原设计:**手动触发 + 7 / 30 天冷却拦截**,本次不引入自动调度。
- **BREAKING:取消记忆文件体积上限**。`writeMemoryFile` 原先对所有记忆文件套用 `10KB / 200 行` 单条上限,而 `projects/<pid>/MEMORY.md` 是累积型文件,超限后 `size-exceeded` 被拒且调用方丢弃返回值,导致项目记忆静默永久停止追加。
  - 删除 `MAX_FILE_BYTES` / `MAX_FILE_LINES` 与 `WriteResult` 的 `size-exceeded`;`disable_write` 与 IO 错误语义不变。
  - 单条 checkpoint 的 10KB 蒸馏约束仍在 `validateCheckpoint` 中保留(它约束的是单次蒸馏质量,与累积上限性质不同)。
  - 实测:本次 checkpoint 正文 5783 字节,而 `MEMORY.md` 已 11021 字节,合并后 16806 字节必然被拒 —— 这正是 0.3.1 以来 236 个会话批量结算一个字都没写进项目记忆的原因。

# 0.3.1 (2026-09-26)

- **修复:同一 writer 子会话并发结算导致项目记忆重复追加**。`session.idle` / `session.status` / scanner 三通道可同时结算同一子会话,落盘两份相同 checkpoint。
  - 结算与收尾按 `childSessionID` single-flight(`settling` / `finalizing` 两张 in-flight 表),重复触发共享同一次执行。
  - `appendProjectMemory` 增加尾部内容去重:待写内容与已有末尾相同时不再二次写入。
  - 启动时孤儿接管改为走 `settleWriter`,不再绕过 single-flight 直接 finalize。
- **修复:同一路径生成两个项目 ID**。Bun 与 Node 传入的仓库路径分隔符不同(`D:\RMANBAK` 与 `D:/RMANBAK`),hash 不同导致记忆分裂为两个项目目录。`resolveProjectId` 现统一分隔符后再哈希,两种运行时得到同一 ID。
- **新增测试**:`npm test`(`bun test`)纳入 scripts,覆盖并发结算、晚到孤儿、重复去重、路径规范化 4 个用例。

# 0.3.0 (2026-09-24)

- **项目隔离(根治互串)**:给 history 原文镜像加 `project_id` 维度,`memory` / `history` 检索默认限定当前项目,杜绝跨项目内容污染与回溯拿错。
  - `history_fts` 新增 `project_id` 列,写入时按会话所属项目目录哈希定位(内存缓存 + `session.get` 懒查);存量数据启动时 `backfillProjectIds` 回填,已删除会话标 NULL。
  - `history` search 默认过滤当前项目 pid,`get` 校验 part 归属、跨项目拒绝读取。
  - `memory` search 未显式传 `scope_id` 时兜底为当前项目 `projects/<pid>`。
  - 蒸馏子会话工具白名单收紧为空:writer 只依赖增量原文,不再暴露检索工具,消除蒸馏污染路径。

# 0.2.0 (2026-09-24)

- **重大修复:v1/v2 插件系统兼容**。opencode 1.18 双轨插件系统确认:`opencode.json` 的 `plugin` 数组(npm 包)走 v2 加载器,只接受 `export default { id, effect|setup }`;v1 格式(具名导出)放入会**静默失败**(无日志、无工具、无报错)。
- **安装方式改为 v1 本地目录**:废弃 `plugin: ["opencode-promemory-4861"]` 方式,改为把 `dist/index.js` 复制为 `.opencode/plugins/project-memory.js`(项目)或 `~/.config/opencode/plugins/`(全局),由 v1 加载器自动发现。已实测:bundle 复制为插件文件后 memory/history 工具 + 间隔拦截 + history 写入全通过。
- **修复 `promem-install` 打包缺陷**:命令模板现随构建产物拷贝到 `dist/command/*.md` 并进 npm 包,脚本从包内定位读取(此前读 `../src/command/` 在 npm 包内不存在,导致模板无法安装)。
- README 重写安装章节,说明 v1/v2 双轨机制与正确安装方式。

# 0.1.0 (2026-09-24)

- 首个可发布版本:从 `project-memory` 本地插件独立成 npm 包 `opencode-promemory-4861`。
- 打包形态:esbuild 单文件 bundle(`dist/index.js`,43.8 kB),`bun:sqlite` / `@opencode-ai/plugin` 保持 external(由 opencode 运行时提供)。
- 交互式命令模板(mem-checkpoint / mem-dream / mem-distill / mem-search)随包分发,`promem-install` 脚本一键复制到全局 command 目录。
- 内置功能:跨会话 checkpoint 自动沉淀、策展记忆 + 历史原文双 BM25(FTS5)检索、孤儿会话启动接管、间隔整合拦截(默认 dream 7 天 / distill 30 天)。