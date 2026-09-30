# Checkpoint
Date: 2026-09-27

## Summary
本增量完成了 opencode-promemory-4861 的架构考古与三轮回档治理：先从首个提交 `491bd64` 与 MiMoCode 上游源码查清原始三层设计（采集/沉淀/检索），确认 `global` 与 `notes` 从首版就没有写入端；随后发布 0.4.1（writer 静默失败治理）、0.5.0（项目记忆四段结构化写入 + 水位单调/迟到守卫/幂等追加/重试上限）、0.6.0（`global` 跨项目环境事实），并把三处重复副本（共享模块、提示词模块、deploy 入口）全部改为生成 + 发布门禁。0.5.0 的端到端验证通过（`MEMORY.md` 9998 → 13167 字节，仅增 checkpoint 的 53%，0 个原始块）。最后 0.6.0 的 `global` 首次生产验证**失败**：子代理输出的 delta JSON 因 Windows 路径反斜杠未转义而解析失败，退回追加路径，把 5510 字节原始 checkpoint 块混进了项目 `MEMORY.md` 第 79 行起。正在做清理污染任务。

## Decisions
- 不采用 MiMoCode 的「子代理直接 write 文件」写法——0.3.0 刻意把 `toolsWhitelist` 收紧为 `{}` 以消除蒸馏污染，改为子代理只返回 delta、宿主落盘。
- 用户明确排除一切上下文注入机制（`pushSection` / `renderRebuildContext` / `insertRebuildBoundary` 全部不采用），故 `global` 只能是拉取式。
- 0.5.0 分段写入四段名沿用 MiMoCode：`Project context` / `Rules` / `Architecture decisions` / `Discovered durable knowledge`，字节预算 3000/5000/8000/10000（合计 26KB）。
- section 预算**只 warn 不 reject**——拒绝等于静默丢数据，与修复目标相反。
- `global` 内容边界定为「关于用户与这台机器、与具体项目无关的**事实**」，判据是「若用户打开另一个仓库，这条还成立吗」；明确**禁止**装跨项目硬性规范与偏好（AGENTS.md 已承载），提示词第 44-45 行不动。
- 用户否决了「每次 checkpoint 派第二个子会话 B 专写 global」和「新增 `/mem-global` 命令」的方案，理由是成本翻倍与多一处冷却闸门；0.6.0 按现状定稿。
- 已知缺口接受不补：`global` 只累积、无自动读取，唯一路径 `memory(scope=global)` 主动检索。
- 备份文件不用 `.bak` 扩展名（会被索引），改用能反映内容的名字。
- delta 块格式要从 JSON 改为 markdown 分节（`## Project context` / `## Global`），复用已有 `parseMemorySections`——对反斜杠、直引号、换行零约束。
- 删分支前必须先跑 `git rev-list --count origin/main..<branch>` 确认为 0。

## Facts
- 原始设计来自首个提交 `491bd64` 的 README「架构（精炼设计说明）」：`message.updated` → `history.db` 的 `history_fts` 全量存档（`cjkSpace()` 插空格实现中文 BM25 近似）→ `runWriter`/`settleWriter` 派子子会话蒸馏 → `memory`/`history` 双工具 BM25 检索。
- `memory.db` 恰好三张表：`memory_fts`（`id, path UNIQUE, scope, scope_id, type, body, fingerprint, last_indexed_at`；`body` 是 `.md` 全文副本，`fingerprint` 格式 `"size-mtimeMs"`）、`memory_fts_idx`（FTS5 虚拟表，`content_rowid='rowid'`）、`memory_meta`（key/value）。
- 写 `MEMORY.md` 的代码路径**唯一**：`finalizeWriterOnce`（`writer.ts:179`）→ `appendProjectMemory`（`writer.ts:254`）；`writeMemoryFile(checkpointFile, body)` 在 `writer.ts:177`。`removeMemoryFile` 定义了但零调用。
- 三个入口喂 writer 链：`/mem-checkpoint`（`index.ts:178`）、压缩前（`compaction-hook.ts:15`）、启动时孤儿接管（`index.ts:122`）。`session.idle` / `session.status`（`index.ts:205`/`213`）仍调 `settleWriter` 但不产生新写入，空闲 scanner 已删。
- `appendProjectMemory` 全历史仅 6 个提交涉及：`491bd64` 引入、后续 `1948b5b`/`4a4933c`/`a7c1c99`/`2a90ef9` 修改。早期函数名（`appendMemory`/`writeProjectMemory`/`appendToProject`/`projectMemory`）零命中——不存在「先没后加」。
- 单条 checkpoint（3968 字节）共 6 份副本：磁盘 `sessions/<sid>/checkpoint.md`、`projects/<pid>/MEMORY.md`、`memory_fts.body`（checkpoint 副本）、`memory_fts.body`（MEMORY.md 全文副本）、`history.db` 的子会话输出、`opencode.db` 的 `part.data`。约 45% 的 memory.db 空间是正文副本。
- 增量原文在 `history.db` 存两遍：父会话原始消息 + 子会话提示词（本次 5385 + 2356 字符，而实际增量约 5KB）。
- 索引实测落后：`memory_fts.body` 13261 字符 vs 文件实际 15619 字符。索引更新只由插件启动与 `memory` 工具调用（`RECONCILE_ON_SEARCH=true`）触发。
- `memory_meta` 现有四类键：`scanner:<sessionID>`（水位，`writer.ts:52`）、`project_appended:<pid>`（幂等追加水位）、`writer_fail:<sid>`（连续失败计数）、`memory_layout:<pid>`（值 `sections-v1`）；另有 `dream:last` / `distill:last`（`index.ts:199`，**命令执行时**写而非产出时写）。
- MiMoCode 关键事实：`globalMemoryPath()` 注释明写 "Read-only from the agent side; no auto-create"，读预算 `caps.global ?? 6000`；其 10,000 是 `readBudgetedSectionAware` 的**读**预算，被我们误当成**写**上限；已迭代到 v6。
- 我们插件的 `MAX_FILE_BYTES = 10 * 1024`（0.4.0 已删）是静默冻结根因：修复了项目记忆静默冻结 12 天、0.3.1 的 236 会话批量结算一字未写。
- `src/index.ts:84` 的 `toolsWhitelist: {}` 是 0.3.0 的刻意决定（CHANGELOG：消除蒸馏污染路径）。
- 冷却闸门共 2 个（`index.ts:186-189`）：`/mem-dream` 默认 7 天（键 `dream:last`，上次 09-24）、`/mem-distill` 默认 30 天（键 `distill:last`，首次 00:04 已跑，下次 10-27），可用 `PROJECT_MEMORY_DREAM_INTERVAL_DAYS` / `_DISTILL_INTERVAL_DAYS` 覆盖；拦截方式是在 `command.execute.before` 里 `output.parts.splice` 原地替换文案，不抛错。
- `retentionCleanupIntervalMs` = 24 小时是 `setInterval` 周期任务（不冷却），`retentionDays` 默认 `0` 即不清理；`writerTimeoutMs` = 120 秒是子会话超时上限。0.4.0 删掉空闲定时器后，插件里唯一还在跑的定时器只有 `retentionTimer`。
- 日志通道：`AppLogData.body = { service, level, message }`，走 `client.app.log()`，写入 **opencode.log 而非 serve.log**。
- `mergeGlobalMemory` 五步（`merge.ts`）：`normalizeBullets` → 查 `global_appended` 水位（`watermarkMs <= 已覆盖` 直接返回）→ 读现有 `## 已沉淀事实` 段前置 → `capSection(combined, 6000)` 保留最新裁头部 → 写盘 + 更新水位。**纯追加，无去重/合并/分类**。
- `mergeGlobalMemory` 唯一调用点 `writer.ts:346-357`，条件为 `if (delta.global)`，空字符串则整段跳过。
- 0.5.0 端到端验证数据：子会话 `ses_f1fb52b7effezQu7De5wyipyhY`，checkpoint 5969 字节，`MEMORY.md` 9998 → 13167（+3169 = 53%），四段齐全，0 个原始块；四段实际占用 2263/1928/4409/4532 字节。
- 0.6.0 验证失败的 delta 块长 2733 字符，含 **10 处非法转义**，`位置 155: D:\RMANBAK` 中 `\R` 非法导致 `Unexpected identifier "oject"`；其余 9 处转义正确——模型时对时错。
- 0.5.0 发布 shasum `5cd7e42d6334b370c9e6498473f2693c9d30a7f3`（10 文件 / unpacked 77,114 字节，registry 约 150 秒生效）；0.6.0 shasum `19f7579668e912eaadfee1ae66e105199d76ebbc`（约 90 秒生效）。
- commit 历史：`dcf6af9` fix: writer 静默失败与水位错位 → `bb62741` docs: 纠正 notes/global 承诺 → `59b679d` chore(release): 0.4.1 → `23658da` fix: 水位单调、乱序结算守卫与蒸馏重试上限 → `89109dc` feat!: 项目记忆改为分段结构化写入 → `c9e55c3` chore(release): 0.5.0 → `00fafa7` fix: 拆分被压成单行的 bullet 串 → `2842ff7` refactor: 单一来源生成 writer 提示词模块 → `926c4dc` chore: .gitattributes 固定行尾 → `58d5c5a` refactor: deploy 入口改为由 src/index.ts 生成 → `4cfa8c3` feat: 新增 global 跨项目环境与习惯事实 → `e72bf13` chore(release): 0.6.0。PR #1~#6 全部已合并，`origin/main` = `0008124`。
- 三处重复副本的唯一来源与门禁：共享模块 `src/**` ← `sync:deploy` + 部署 `diff -r`；提示词 `writer-prompt.txt` ← `scripts/gen-prompt.mjs` + `check` 漂移校验；deploy 入口 `src/index.ts` ← `scripts/gen-deploy-entry.mjs` + `check` 漂移校验 + 导入存在性安全网。
- deploy 入口与 `src/index.ts` 的差异恰为三类：共享模块 import 路径加 `./project-memory/src/` 前缀（12 处）、去掉 `WRITER_PROMPT` 导入（1 处）、`writerPrompt` 换成 `readFileSync(…writer-prompt.txt)`（1 处），其余 256 行逐字相同。
- 提示词双份来源：npm bundle 用 `src/session/prompt.ts` 的 `WRITER_PROMPT` 常量，生产部署入口用 `fs.readFileSync` 读 `writer-prompt.txt` 运行时文件。
- 最终测试基线：27 pass / 0 fail / 226 expect。
- 项目 `MEMORY.md` = 13181 字节四段结构；`global/MEMORY.md` = 702 字节 3 条环境事实；236 条历史 checkpoint 未受影响（`scanner:` 键名未变）。
- `global/MEMORY.md` 现有 3 条：① 本机未装 gh CLI 且只有 22 端口出站（api.github.com / github.com HTTPS 均 HTTP 000 不可达，git push 走 SSH 才通）② PowerShell 处理带中文或引号的文本会吞引号 ③ 端口被占时新进程启动失败但旧进程继续应答 `/config` 仍 200，判活须比对 PID 与启动时间并读 stderr。
- `global_appended` 当前值 `2000000000000`（手动测试用的固定水位，非真实结算时间）。
- 记忆库位置：`~/.config/opencode/memory/`，`global/MEMORY.md` 与 `projects/<pid>/MEMORY.md` 平级；本项目 pid = `9139bb455d97`。

## Open
- 任务 1（进行中）：清理项目 `MEMORY.md` 第 79 行起的 5510 字节原始 checkpoint 块，恢复纯四段结构；备份文件名需能反映内容（不用 `.bak`）。
- 任务 2：delta 块从 JSON 改为 markdown 分节（`## Project context` / `## Global` 等），复用 `parseMemorySections`。
- 任务 3：补测试——路径含反斜杠、直引号、换行时都能正确解析。
- 0.6.0 已在 registry，但 `global` 写入路径的实际可用性仍未验证（子代理是否真会输出 `global` 键未知）。
- `deploy/opencode-plugin/project-memory.ts` 已生成化，但生成逻辑仍需人工审阅；导入存在性安全网已覆盖「新增模块未加入 `SHARED_REL`」这一失效模式。
- 用户未表态是否清理 `MEMORY.md.bak-20260925-cleanup`（834 字节，09-25 项目 ID 清理遗留，内容已并入 `## Discovered durable knowledge`，措辞被改写过）——上一轮已核对为「措辞不同、内容已覆盖」，但删除未确认执行。

## Files
- `src/validator.ts` — 新增按 section 字节预算检查（Summary 800 / Decisions 1500 / Facts 2000 / Open 800 / Files 1500 / Notes 800，合计 7400）
- `src/writer.ts` — 四类失败经 `client.app.log` 上报；写入顺序改为「写 checkpoint → 追加项目记忆 → 推进水位」；水位单调不后退；写前比对文件 mtime 与结算起始时刻；`writerMaxRetries` 派发前检查且 `?? 3` 防呆
- `src/memory/template.ts`（新建，src + deploy 各一份）— `ensureMemoryTemplate` 幂等起步模板
- `src/memory/merge.ts`（新建）— `mergeProjectMemory`（四段）、`mergeGlobalMemory`（扁平追加）、`extractDelta`、`parseMemorySections`、`normalizeBullets`、`capSection`
- `src/session/writer-prompt.txt` — 唯一来源；新增 `<!-- project-memory-delta` 块规范（5 个键：四段 + `global`）；第 44-45 行定义 global 内容边界
- `src/session/prompt.ts` — 生成物，带 `AUTO-GENERATED` 头注释
- `scripts/gen-prompt.mjs`（新建）— 处理反引号与 `${` 转义
- `scripts/gen-deploy-entry.mjs`（新建）— 从 `src/index.ts` 派生生产入口，含导入存在性校验
- `scripts/sync-deploy.mjs` — 硬编码 `SHARED_REL` 清单补入 `memory/template.ts`；现在同时重新生成入口
- `deploy/opencode-plugin/project-memory.ts` — 改为生成，256 行与 `src/index.ts` 逐字相同
- `.gitattributes`（新建）— `* text=auto eol=lf`
- `src/tools/memory.ts` — 工具描述纠正 notes/global 表述
- `README.md` / `CHANGELOG.md` / `package.json` / `package-lock.json` — 版本 0.4.1 → 0.5.0 → 0.6.0
- `C:\Users\Administrator\.config\opencode\AGENTS.md` — 新增第 13 章「以工具输出为准，不以自我判断为准」，5 条带判据的规则（79 → 92 行）
- `ocstate` skill（`C:\Users\Administrator\.agents\skills\ocstate\SKILL.md`）— 四段结构描述、meta 键补全、加 `> 1e11` 阈值区分时间戳与计数器

## Notes
- **判断错误 1**：`writer-prompt.txt` 一度被判为死文件。只 grep 了 `src/`，没 grep deploy 入口——它实际是生产部署形态的提示词来源。漏改会让 npm 用户拿到的插件完全不知道要输出 delta 块，分段写入对他们**静默失效**。是被 `sync:deploy` 报 `prompt.ts` 不一致逼出来的。
- **判断错误 2**：serve 重启「成功」是假的。端口被占时新进程启动失败，旧进程仍在 200 应答，健康检查完全看不出。是被 `stat` 时间戳暴露的。此后重启 serve 必须先确认旧 PID 已退出。
- **判断错误 3**：`deploy/.../config.ts` 一度显示 modified 但 `git diff` 为空。是行尾抖动造成的幽灵 modified，被当噪音忽略过两次。
- **判断错误 4**：`git branch -r` 给的是**缓存的旧 ref**。据此以为远端有 4 个已合并分支要删，实际只有 1 个存在，报 `remote ref does not exist` 才暴露。`git fetch --prune` 后真实远端只剩 `main` / `feat/global-memory` / `refactor/gen-deploy-entry`。
- **判断错误 5**：把「TUI 进程启动时间」当判据，误判用户没重启。实际用户已重启（PID 17260，07:58:39），是自己查得比用户重启早。
- **自查翻车**：手工做幂等复核时两次传了不同的 `Date.now()`，第二次是新增量，追加本就正确——据此以为幂等坏了。文件体积 702 → 1067 才暴露。幂等必须用**同一水位**测。
- **分支建反了**：`git branch` 在当前 HEAD 建，而当时 HEAD 是 `refactor/gen-deploy-entry`，导致 global 的 commit 落进 PR #5。靠 `git log origin/... ..refactor/gen-deploy-entry` 打出本不该在那里的 commit 才发现。已修正：本地回退、删远端分支重推。
- `--amend` 改的是 HEAD 而非目标 commit，导致 `sync:deploy.mjs` 落进 docs commit。用 `reset --soft HEAD~2` 重做。
- `upsertIndexRow` 的 FTS 更新顺序**没有** bug（先改内容表 → 删 vtab → 插 vtab）。MiMoCode 那条「external content 模式须用 `'delete'` 魔法命令」的迁移注释针对触发器上下文，不适用。**实测复制生产库验证过，不成立，是误报。**
- `normalizeBullets` 要求短横**紧贴**前一字符才拆，所以「端口 6379 - 密码 x」和 `→` 箭头不受影响；误拆代价仅一个换行。
- 写测试用 python 替换文本多次未生效（转义问题），改用 edit 工具直接改才成功。
- `spawnWriter` 会先读父会话增量，mock 返回空会导致提前 return——测重试上限时必须补全 mock 才能拿到 `createCalls`。
- 关键教训已抽象进全局 AGENTS.md：自己写的验证会继承自己的假设，验证要用「与我的预期无关」的手段（重新生成后比对、换查询方式、换进程去问）。
- 「checkpoint 会被压缩前自动沉淀覆盖是 bug」是错的——writer prompt 明写 `checkpoint.md` 只是 "boundary reference"，滚动快照整份覆盖是设计意图。
- 切分支前必须确认当前 HEAD 在哪；本会话曾因此把 commit 落错分支两次。

<!-- project-memory-delta
## Project context
- opencode-promemory-4861 是 opencode 的记忆插件，仓库在 `D:\RMANBAK`，生产部署在 `D:\RMANBAK\.opencode\plugins`，deploy 源在 `deploy/opencode-plugin`
- 记忆库根 `~/.config/opencode/memory/`：三层结构——`history.db` 全量存档原始消息、`memory.db` 策展记忆 FTS5 索引（`memory_fts` 存 `.md` 全文副本）、`sessions/<id>/checkpoint.md` 单会话快照
- 项目层 `projects/<pid>/MEMORY.md` 为四段结构（`Project context` / `Rules` / `Architecture decisions` / `Discovered durable knowledge`），字节预算 3000/5000/8000/10000
- `global/MEMORY.md` 为扁平 bullet 列表 + `## 已沉淀事实` 单段，预算 6000 字节
- 生产部署形态是多文件 TS（opencode 直接加载），无法复用 npm 单文件 bundle，因此需独立的 deploy 入口
- 本项目 pid = `9139bb455d97`

## Rules
- 不做任何形式的上下文注入（`pushSection` / `renderRebuildContext` / `insertRebuildBoundary` 一律不用），记忆只能被主动检索读到
- 子会话 `toolsWhitelist` 必须保持为空（`src/index.ts:84`），这是 0.3.0 消除蒸馏污染的决定；不给子代理文件写权限
- 子代理只返回内容，**落盘一律由宿主代码执行**
- 删除分支前必须先 `git rev-list --count origin/main..<branch>` 确认为 0
- 备份文件不用 `.bak` 扩展名（会被索引），用能反映内容的文件名
- 禁止直接提交/推送 main

## Architecture decisions
- 项目记忆写入主体定为**宿主**，子代理只返回 delta——因 MiMoCode 的「子代理直接 write」违反 0.3.0 空白名单威胁模型
- section 预算**只 warn 不 reject**：拒绝等于静默丢数据，与修复目标相反
- 水位语义：写 checkpoint → 追加项目记忆 → **全部成功才** `markCheckpoint`，顺序不可换
- 水位单调不后退 + 写前比对文件 mtime 与结算起始时刻（防迟到结果覆盖）
- 追加幂等走 `project_appended:<pid>` 水位而非尾部字符串比对（重试时中间可能插入别的内容）
- 蒸馏重试上限 `writerMaxRetries` 默认 3，派发前检查，子会话空产出同样计为失败
- `global` 内容边界判据：「若用户打开另一个仓库，这条还成立吗」；只装环境事实，禁止装跨项目规范与偏好（AGENTS.md 已承载）
- 用户否决「每次 checkpoint 派第二个子会话专写 global」与「新增 `/mem-global` 命令」，理由是 LLM 成本翻倍与多一处冷却闸门
- 接受已知缺口：`global` 只累积无自动读取，唯一路径 `memory(scope=global)`
- 三处重复副本全部收敛为生成 + 发布门禁：共享模块 / 提示词模块 / deploy 入口

## Discovered durable knowledge
- `client.app.log` 写 opencode.log，**不写** serve.log——grep serve.log 查不到 writer 日志
- dream/distill 的冷却时间戳在 `command.execute.before` 的**命令执行时**写入，不是产出时
- 冷却拦截的实现是 `output.parts.splice` 原地替换文案，不抛错
- `memory_fts.body` 是 `.md` 全文副本，索引可能落后于磁盘；更新只由插件启动与 `memory` 工具调用触发
- `upsertIndexRow` 的 FTS 更新顺序无 bug，MiMoCode 那条 external content 模式的 `'delete'` 魔法命令注释不适用（不在触发器上下文里）
- 增量原文在 `history.db` 存两遍：父会话原始消息 + 子会话提示词
- **让 LLM 手写 JSON 承载 Windows 路径必然翻车**：实测 10 处 `\R` 等非法转义，模型时对时错，而路径是本系统最高频内容。改用 markdown 分节（`parseMemorySections`）零转义约束
- `git branch -r` 展示的是缓存 ref，需 `git fetch --prune` 才准
- 缺 `.gitattributes` 时 `core.autocrlf=true` 会造成工作区行尾混杂与零差异的幽灵 modified
- `gen-deploy-entry` 的正则要求行首为 import/export，多行 import 的收尾行 `} from "..."` 也要单独改写
- `Db` 接口没有 `root` 属性，`dbRoot(db)` 不存在，需显式传 root
- npm registry 发布后生效延迟：0.4.0 几十秒、0.5.0 约 150 秒、0.6.0 约 90 秒

## Global (cross-project facts)
- 本机未安装 `gh` CLI；`D:\npm`、`~/.config/opencode`、Program Files 均无
- `GITHUB_TOKEN` 未设置，git 凭据 `helper=store`，只有 SSH remote
- `api.github.com` 与 `github.com` 的 HTTPS 均为 HTTP 000 不可达——**只有 22 端口出站**，故 `gh` 装上也无用，创建 PR/改 tag/建 Release 必须人工在网页操作
- `git push` 走 SSH 可通
- PowerShell 处理带中文或引号的文本会吞引号，改用精确编辑工具
- 端口被占时新进程启动失败但旧进程继续应答，`/config` 仍返回 200——判活须比对 PID 与启动时间并读 stderr
- `python` 文本替换常因转义问题静默不生效，应直接用 edit 工具改文件
-->

CHECKPOINT_DONE