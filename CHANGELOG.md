# 0.6.1 (2026-09-28)

- **修复:delta 块从 JSON 改为 markdown 分节格式**。0.6.0 的 global 写入路径首次生产验证即失败:子代理输出的 JSON 里有 10 处非法转义,全部是 Windows 路径的单反斜杠 —— `D:\RMANBAK` 里的 `\R` 不是合法 JSON 转义,整个块解析失败,宿主退回追加路径,项目 MEMORY.md 混进一整份原始 checkpoint(已清理),global 一条没写。
  - 根因不是模型偶发失误,而是格式选错:路径是本系统最高频的内容,而 Windows 路径放进 JSON 字符串要求每个反斜杠都转义成双写。子代理在同一块内有的地方转义了、有的没转,必然翻车。
  - 改为 markdown 分节(`## Project context` / `## Rules` / `## Architecture decisions` / `## Discovered durable knowledge` / `## Global (cross-project facts)`),对内容零约束:反斜杠、直引号、箭头、空行全部原样保留。解析复用记忆文件本身已在用的分节思路,单趟扫描 O(n)。
  - 提示词明确写了「this is markdown, not JSON」并给出 Windows 路径的正例。
  - 块边界不再用 `indexOf("-->")`:内容里的箭头(如「迁移 --> 展开」)会截断块,改为只认整行等于 `-->`;模型把标记接在最后一行时仍兼容。
  - 退回路径的告警措辞随之改为「delta block present but no recognised section heading」—— markdown 格式下已不存在「解析失败」这回事。
  - npm test 增至 31 个用例,新增覆盖:反斜杠路径/引号/箭头/缩进续行原样解析、真实失败的那类内容可解析、不认识的标题被忽略而非整体失败、无有效内容时返回 null。
- **新增:dream 具备修订能力并留下核对日志**。writer 只追加,过时事实只能靠 dream 修订 —— 这是它区别于 writer 的唯一职责,但此前做不到:
  - 模板只让 dream 读 checkpoints,没说先读 `projects/<pid>/MEMORY.md`。而它要做的恰恰是重写:没读过目标文件就去重,等于闭着眼睛覆盖,甚至可能拿 checkpoint 重写整个文件,把之前 dream 自己整合的结论冲掉。模板改为三段式(先读目标文件 → 整合与修订 → 注意),明确「被新事实推翻的旧条目要删除或改写,不允许新旧并存」。
  - dream 是 agent 自主行为,插件只管间隔拦截,它到底改了什么事后无从验证 —— 静默的空转和成功的收敛看起来一模一样。闸门放行时快照项目记忆全文,下一个 `session.idle`(agent 那一轮结束)比对并记日志:保留快照原文而非只存哈希,才能报出「删了几行/增了几行」;三种结果分别措辞 —— 有删有增(正常修订)、只增未删(是追加不是修订)、完全未改(整合没生效)。
  - 频率仍为 7 天手动,未改。首跑实测:14274→15367 字节,删 43 行 / 增 29 行。
- **修复:命令模板安装到全部位置并按内容比对**。`install.mjs` 只挑第一个存在的候选目录,且用 mtime 判新旧,两个后果都实测到:
  - 项目级 `.opencode/command` 根本不在候选里 —— 而 TUI 的工作目录就是仓库父目录,读的是那份。本次把 mem-dream 改成三段式后全局那份更新了、项目级那份仍停在 09-24,只有手工 cp 才生效。
  - mtime 不是可靠的新旧信号:文件只是被复制来复制去,时间戳的先后与内容是否一致无关。
  - 改为:候选含 `OPENCODE_CONFIG_DIR/command`、`~/.config/opencode/command` 及从 cwd 向上找到的所有 `.opencode/command`,全部安装;按内容比对;装完交叉校验每个位置的字节一致,不一致则退出码非 0。验证:人为把项目级那份改成过期内容,脚本自动发现并修复。
- **修复:`gen-deploy-entry` 的安全网文案区分两种成因**(模块未列入 `SHARED_REL` / 已列入但忘了先跑 `sync:deploy`)。新增 `session/dream.ts` 时立刻被它拦下,但原文案把第二种也说成「需加入清单」,会把人引向错误的修复方向。
- `sync:deploy` 清单补入 `session/dream.ts`。

# 0.6.0 (2026-09-27)

- **新增:`global/MEMORY.md` 跨项目环境与习惯事实**。此前 global 只在类型与检索层预留、没有任何写入方,永远是空的。
  - 边界:装**关于用户与这台机器、换个项目依然成立**的事实(平台怪癖、缺失的工具、习惯命令)。判据是"若用户打开另一个仓库,这条还成立吗";不成立就该进项目那四段。
  - **跨项目的硬性规范与偏好不放这里** —— 用户的 AGENTS.md 已作为指令承载它们。global 是被发现的事实,不是规则。
  - 由 writer delta 块的 `## Global (cross-project facts)` 段维护,与项目四段同一次结算;提示词给出上述判据。
  - 预算 6000 字节(取自 MiMoCode 的 `caps.global`),超限保留最新、裁掉头部并记 warn。预算足够小,一份被污染的 global 肉眼可辨。
  - 幂等走 `global_appended` 水位,失败重试不会重复追加。
  - 仅含 global 内容的结算不重写项目 MEMORY.md(但仍推进项目水位,否则该增量会被无限重新蒸馏)。
  - 存储、索引、检索三层零改动:`buildPath` / `parsePath` / `locKey` 对 global 早已支持,已验证往返正确;`memory` 工具 `scope=global` 直接可用。
  - **上游 MiMoCode 的 global 是「read-only from the agent side, no auto-create」** —— 完全没有写入方,其价值靠注入实现。本插件不做注入,因此 global 只能被主动检索;这削弱了它的自动生效程度,是与上游的设计差异。
- README 与 memory 工具描述同步:global 从「预留无写入端」改为「由 writer 维护」;`notes` / `free` 仍无写入端。
- npm test 增至 27 个用例,新增覆盖:仅 global 内容的结算不碰项目文件、一次结算内项目与 global 各归各位、同一水位重放不重复、global 超预算裁剪保留最新。

# 0.5.0 (2026-09-27)

- **BREAKING:项目记忆改为分段结构化写入**。此前 writer 把每份 checkpoint 原文整份追加进 `projects/<pid>/MEMORY.md`,使该文件变成变更日志:无界增长、同一结论被反复重述、BM25 相关度被过程性内容(文件清单、命令流水)稀释,而真正值得进项目记忆的结论被埋在下面。
  - 四个知识段:`Project context` / `Rules` / `Architecture decisions` / `Discovered durable knowledge`,各段独立字节预算 3000 / 5000 / 8000 / 10000。
  - **写入主体仍是宿主**:writer 子代理只返回一段 delta JSON,宿主解析、合并、裁剪、落盘。0.3.0 刻意把子代理工具白名单收紧为空以杜绝蒸馏污染,直接给子代理 `write` 权限会破坏该决定,故不采用 MiMoCode 的写法。
  - delta 块缺失或损坏时**退回旧的整份追加路径**并记 warn,优先「有损但不丢数据」。子会话返回了 delta 块却无法解析时同样记 warn,否则分段布局会静默退化成追加模式而无从追查。
  - 段落超预算时保留**最新**内容、裁掉头部,裁剪量记 warn。
  - checkpoint 正文与追加内容都会剥离 delta 块,机器可读内容不进任何记忆文件。
  - `migrateMemoryLayout` 幂等迁移:已分段的跳过,缺分类结果时**拒绝猜测**(返回 `needs-classification`)。归类属判断题,由调用方提供已分类文本,代码只负责建结构。
  - 本仓库自身的 `MEMORY.md` 已完成迁移:29060 → 9998 字节,19KB 原始 checkpoint 流水清除(内容本就是冗余,已存于 `sessions/<sid>/checkpoint.md` 与 `history.db`),原文件备份为 `MEMORY.md.pre-v1-sections`。
- 三个静默失真点一并修复(见下方 0.4.1 之后的 fix 提交):水位单调不后退、迟到结算结果不覆盖更新的 checkpoint、失败重试上限。

# 0.4.1 (2026-09-27)

- **修复:writer 静默失败**。校验失败与写入失败全程无日志、返回值被丢弃,checkpoint 会无声消失;水位又在两次写入**中间**推进,项目记忆追加失败时增量永久丢失且不会被重试。
  - 校验拒绝、文件写入失败、项目记忆追加失败、水位未推进,四类情况统一经 `client.app.log` 上报(`service: project-memory`)。
  - 调整顺序为「写 checkpoint → 追加项目记忆 → 推进水位」,两个写入都成功才推进水位;失败则水位不动,下次触发自动重试该增量。`projectDir` 缺失时视为成功,避免无限重试。
  - 新增按 section 的字节预算检查(Summary 800 / Decisions 1500 / Facts 2000 / Open 800 / Files 1500 / Notes 800),**超限只 warn 不 reject** —— 拒绝等于静默丢数据,与本次修复目标相反。预算合计 7400,留足 10KB 总量约束的余量。
  - `npm test` 增至 9 个用例,新增覆盖:校验拒绝留痕且水位不动、超预算仍落盘、IO 失败不推进水位、模板只写一次。
- **新增:项目记忆起步模板**。`ensureMemoryTemplate` 在某项目首次沉淀时写入标题与维护说明骨架,幂等(文件已存在不动)。此前新项目的 `MEMORY.md` 由第一份 checkpoint 直接充当,没有可读的抬头。
- **文档:纠正 notes / global 的错误承诺**。README 与 `memory` 工具描述此前宣称可检索 `notes` / `free` / `global`,但插件只有 checkpoint 与项目记忆两个写入点,`memory` 工具是纯只读(仅 `search`),这三个类型永远为空。现明确标注为「已预留但无写入端」。
- 下一版(0.5.0)计划把 `MEMORY.md` 从「整份 checkpoint 追加」改为分段结构化写入,需配套迁移。

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