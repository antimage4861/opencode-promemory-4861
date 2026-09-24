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