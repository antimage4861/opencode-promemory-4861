# opencode-promemory-4861

OpenCode 项目记忆插件:跨会话自动沉淀 checkpoint、BM25(FTS5)检索策展记忆与历史原文、孤儿会话启动接管、间隔整合拦截。

面向"记忆会丢、跨会话上下文断裂"的痛点:把散落在多个会话里的稳定结论、决策、精确值自动提炼成结构化记忆,并在未来会话中可全文检索。

- 运行时:Bun(opencode 自带)。`bun:sqlite` 为内建依赖,无需额外安装。
- 依赖:零运行时第三方包(单文件 bundle,external 仅 `bun:sqlite` 与 `@opencode-ai/plugin`)。
- 语言:记忆内容与命令输出均为中文。

---

## 安装

> **重要**:本插件采用 opencode 1.18 的 **v1 插件 API**(具名导出 + 事件/工具/命令钩子)。opencode 1.18 存在双轨插件系统——`opencode.json` 的 `plugin` 数组(npm 包)一律走 **v2 加载器**,只接受 `export default { id, effect|setup }`,v1 格式插件放入会**静默失败**(无报错、无日志、工具不出现)。因此**不要**用 `plugin: ["opencode-promemory-4861"]` 方式安装。正确方式是把插件文件放进本地插件目录,由 v1 加载器自动发现。

### 方式一:项目级(推荐)

把 `dist/index.js` 复制为项目插件文件(重命名为 `.js` 便于 v1 链识别):

```bash
# 用 npm 包内的构建产物
cp node_modules/opencode-promemory-4861/dist/index.js .opencode/plugins/project-memory.js
# 或直接从本仓库
cp dist/index.js .opencode/plugins/project-memory.js
```

重启 opencode 后即自动加载。`memory` / `history` 工具会出现在会话工具列表中。

### 方式二:全局

同样操作,放到全局插件目录(对所有项目生效):

```bash
cp node_modules/opencode-promemory-4861/dist/index.js ~/.config/opencode/plugins/project-memory.js
```

> 注:`.opencode/plugins/` 与 `~/.config/opencode/plugins/`(复数)是 v1 链自动发现的目录。若同时存在多个来源会各自独立加载,建议只用一个。

---

## 安装交互式命令(可选但推荐)

插件注册两个自定义工具 `memory` / `history`,agent 可自主调用;[斜杠命令]依赖命令模板,需要额外一步(插件不自动注册命令):

```bash
# 一键复制 4 个命令模板到全局 command 目录(~/.config/opencode/command/)
npx promem-install
# 或
npm i -g opencode-promemory-4861 && promem-install
```

模板随 npm 包内的 `dist/command/*.md` 分发,脚本自动定位。手动复制亦可(模板在仓库 `dist/command/*.md`):

```
mem-checkpoint.md  mem-dream.md  mem-distill.md  mem-search.md
→ 复制到 ~/.config/opencode/command/
```

卸载:删除该目录下上述 4 个文件即可。

---

## 使用

| 方式 | 说明 |
| --- | --- |
| `memory` 工具 | 检索策展记忆(checkpoint / notes / 项目 MEMORY.md),BM25 排序,命中即权威 |
| `history` 工具 | 检索会话原始对话镜像,`get` 可读某 part 的逐字原文(用于精确值回溯) |
| `/mem-checkpoint` | 手动把当前会话增量蒸馏为 checkpoint,写入 `sessions/<id>/checkpoint.md` 并追加项目记忆 |
| `/mem-dream` | 跨会话整合:把多个会话的稳定结论并入项目 `projects/<pid>/MEMORY.md`。默认 7 天一次,未到期拦截跳过 |
| `/mem-distill` | 工作流提炼:识别近一月可复用的人工流程,沉淀为 skill/agent/command。默认 30 天一次 |
| `/mem-search <词>` | 一次调用同时搜 memory 与 history |

自动行为(事件驱动,无需操作):

- **压缩前沉淀**:会话 compaction 前若有未沉淀增量,自动先沉淀。
- **孤儿接管**:若某次蒸馏/整合子会话中途退出,留空的 checkpoint 由下个会话启动时自动补齐、写入并清理。

---

## 配置

全部有默认值,通常零配置即可使用。可用环境变量覆盖(优先级:代码内配置 > 环境变量 > 默认值)。

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `PROJECT_MEMORY_DISABLE_WRITE` | `false` | 设为 `true` 只读:关闭所有写入(自动沉淀/整合/命令全停,仅保留检索) |
| `PROJECT_MEMORY_WRITER_TIMEOUT_MS` | `120000` | 子会话蒸馏超时 |
| `PROJECT_MEMORY_RETENTION_DAYS` | `0` | 会话 checkpoint 保留天数,`0` = 不清理 |
| `PROJECT_MEMORY_RECONCILE_ON_SEARCH` | `true` | 检索前是否重建文件索引 |
| `PROJECT_MEMORY_SEARCH_SCORE_FLOOR` | `0.15` | BM25 分数阈值(相对最佳命中的比例) |
| `PROJECT_MEMORY_DREAM_INTERVAL_DAYS` | `7` | dream 间隔天数 |
| `PROJECT_MEMORY_DISTILL_INTERVAL_DAYS` | `30` | distill 间隔天数 |

数据目录:固定为 `~/.config/opencode/memory/`(跨项目共享,同一套记忆库):

```
memory/
├── memory.db      # 策展记忆 FTS5 索引 + memory_meta
├── history.db     # 会话原文镜像 FTS5 索引
├── .writers.json  # 子会话蒸馏的在途状态(崩溃恢复用)
├── global/MEMORY.md
├── projects/<pid>/MEMORY.md       # 项目记忆(pid = sha256(projectDir))
├── sessions/<sessionID>/checkpoint.md
└── notes/  docs/  free/           # 其他类型记忆
```

> 删除数据目录即完全重置插件状态。

---

## 命令模板说明

斜杠命令模板内已写明"间隔检查由插件自动处理(不足 7/30 天则拦截本次执行)"。插件在 `command.execute.before` 钩子中拦截 `/mem-dream`、`/mem-distill`:距上次不足间隔时,用 splice 原地替换用户消息为拦截文案(此方式在 headless `run --command` 下也生效),agent 收到后即跳过整合;到期则更新 `memory_meta` 时间戳放行执行。

---

## 架构(精炼设计说明)

三层结构,各司其职:

**1. 采集层(base:历史镜像)**
`message.updated` 事件把每次完整消息的文本 parts 写入 `history.db` 的 `history_fts` 表格,配 `history_fts_idx` 虚拟表做 FTS5 索引;写入时带 `project_id`(会话所属项目目录的 sha256 pid,经内存缓存 + 懒查 `session.get` 定位);`message.removed`/`session.deleted` 同步删除。启动时 `catchupHistory` 补偿补拉历史消息,并对存量数据 `backfillProjectIds` 回填 `project_id`(已删除会话无法回填的标 NULL)。中文分词靠 `cjkSpace()`:在连续汉字间插空格,配合 FTS5 按空格分词,实现中文 BM25 近似检索。

**2. 沉淀层(writer:值蒸馏)**
核心是 `runWriter` → `settleWriter`:为一个会话挑选上次 checkpoint 之后的增量消息,拼接蒸馏提示词(`writer-prompt`,已内联在 bundle 中)派发**子会话**执行,子会话**不暴露任何工具**(只依赖增量原文,防止检索到其他项目内容污染本项目记忆)、被强制输出结构化 markdown(checkpoint 格式,含 Summary/Decisions/Facts/Open/Files/Notes)。宿主侧校验结果(必含各 section、≤10KB、防空白过多/垃圾文本),通过后写入 `sessions/<id>/checkpoint.md` 并**追加**项目 `MEMORY.md`,同时记录 `scanner:<sid>` 水位。触发通道有两个:压缩前 / 手动命令。若子会话中途退出,写 `.writers.json` 留下孤儿记录,下次启动由 `settleStartupOrphans` 接管补齐(只跳过 status 为 busy/retry 的仍在运行会话)。

**3. 检索层(tools:BM25)**
`memory` / `history` 两个自定义工具,统一走 FTS5 `bm25()` 排序、`scoreFloor` 相对阈值过滤、`extractSnippet` 按命中关键词切片做上下文片段。返回片段的定位(path / session_id / part_id)让 agent 能用 `read` 或 `history get` 取全文。
**项目隔离**:`memory` 未显式传 `scope_id` 时默认检索当前项目的 `projects/<pid>`;`history` 未显式传 `project_id` 时默认限定当前项目 pid,`history get` 也会校验 part 归属、跨项目拒绝读取。跨项目检索需显式传 `scope_id`/`project_id`(或 `session_id` 限定单会话)。

**工程决策(踩坑沉淀)**

- **拦截必须原地改 parts**:`command.execute.before` 的 `output.parts = [...]` 整体赋值在 headless `run --command` 下不生效(agent 收到的是命令模板原文照常执行整合),必须 `output.parts.splice(0, len, {type:"text", text:...})` 原地替换。
- **孤儿判断只看 busy/retry**:曾用 `status.type !== "idle"` 判断,但已完成会话 status 端点返回 `undefined`,`undefined !== "idle"` 恒真导致孤儿永远被跳过,浪费一个子会话。改为只对 busy/retry 跳过。
- **`resolveProjectId` 用 sha256(projectDir)**:bun 与 node 对 SHA-256 有细微输入差异(如截断),跨运行时会导致 pid 不同而记忆散落两个文件。插件统一在 bun 运行时内自洽,无此问题。
- **权限收紧**:子会话工具白名单为空(不暴露 `memory`/`history`),蒸馏只依赖增量原文,杜绝检索到其他项目内容污染本项目记忆。
- **项目隔离靠默认 pid**:`memory`/`history` 都默认限定当前项目 pid(经 `session.list` 预热 + `session.get` 懒查的 pid 缓存),避免跨项目互串;存量历史启动时回填 `project_id`。

---

## 开发

```bash
npm install          # 安装 esbuild / @opencode-ai/plugin / typescript
npm run build        # esbuild 打包 → dist/index.js + dist/index.d.ts + dist/command/*.md
npm run check        # 发布前校验(dist 产物 / name / main / files / license)
npm pack             # 生成 tarball,验证包内容
```

`deploy/opencode-plugin/` 是本插件的**生产部署形态**(分模块 TS 源 + 顶层入口,与 npm 包的单文件 bundle 不同),同步自 `.opencode/plugins/` 部署目录,可用 v1 本地插件方式直接拷贝使用。改动源码时两处需同步:本仓库 `src/`(打包发布)与 `deploy/opencode-plugin/`(生产运行)。

目录结构:

```
src/
├── index.ts                 # 插件入口(导出 ProjectMemoryPlugin)
├── config.ts                # 配置解析:代码内配置 > env > 默认值
├── memory/                  # 策展记忆:db 包装、FTS5 索引、路径解析、BM25 检索、文件存储
├── history/                 # 历史镜像:FTS5 索引、检索、消息→parts 拆解
├── session/                 # 沉淀核心:writer(蒸馏/追加/占位)、compaction-hook、retention(过期清理)、validator、prompt(内联)
├── tools/                   # memory / history 工具定义
└── command/                 # 4 个斜杠命令模板(随包分发)
```

发布到 npm:

```bash
npm run check && npm pack
npm version patch && npm publish
```

> 包名含个人后缀 `-4861`,属个人定制分发,无抢占风险。

---

## License

MIT