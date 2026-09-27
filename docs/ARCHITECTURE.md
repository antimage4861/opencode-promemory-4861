# 架构说明

本文描述 opencode-promemory-4861 的内部结构与关键设计取舍。面向要改这个插件的人。
使用说明见 [README](../README.md)。

代码规模：约 3900 行 TypeScript（含 822 行测试），零运行时第三方依赖（bundle 只 external
`bun:sqlite` 与 `@opencode-ai/plugin`）。

---

## 1. 三层结构

```
采集层  history/mirror.ts      事件 → history.db（逐字原文，FTS5 索引）
          ↓
沉淀层  session/writer.ts      增量原文 → 子代理蒸馏 → checkpoint + 项目记忆
          ↓
检索层  tools/memory.ts        checkpoint / MEMORY.md → BM25 检索
        tools/history.ts       原文 → BM25 检索
```

分层的意义在于**降级方向**：策展层必然有损，所以必须有路能钻到底。`memory` 返回结论，
`history` 返回逐字原文，两者是分工而非冗余。

---

## 2. checkpoint 的两条触发路径

这是全插件最容易被误解的地方，先分清两个概念：

| 概念 | 函数 | 作用 |
| --- | --- | --- |
| **派发** | `runWriter` | 创建子会话、投喂增量、开始蒸馏 |
| **结算** | `settleWriter` | 取回子代理输出、校验、落盘、推水位 |

派发点全仓库只有两处（`grep -rn "runWriter(" src/`）：

- `session/compaction-hook.ts:15` — 压缩前自动沉淀
- `index.ts:207` — `/mem-checkpoint` 手动触发

结算点有六处，但其中五处是**轮询与崩溃恢复**，不是触发。

### 2.1 路径 A：压缩前自动沉淀

```
opencode 判定上下文将满
  → experimental.session.compacting 事件
  → index.ts:201  if (cfg.disableWrite) return
  → compactionHandler(input)              compaction-hook.ts:12
      → if (blacklist.has(sessionID)) return
      → if (!hasPendingIncrement(sessionID)) return
      → runWriter({ title: "压缩前自动沉淀" })
```

`hasPendingIncrement` 的实现在 `index.ts:135`：

```ts
hasPendingIncrement(sessionID) {
  return !writerState.has(sessionID)
}
```

注意它**不是**「有没有未落盘的增量」，而是「当前没有在途的 writer」。配合上一行的
early return，效果是**并发闸**：同一会话已有蒸馏在跑时不重复派发。真正判断增量是否为空
在 `spawnWriter` 里——`readIncrement` 读完发现 `inc.body.trim()` 为空就直接返回。

### 2.2 路径 B：手动 checkpoint

```
用户输入 /mem-checkpoint
  → index.ts:204  command.execute.before
  → if (cmd === "mem-checkpoint" && writerEnabled())
  → runWriter({ title: "手动 checkpoint" })
```

命令模板本身（`src/command/mem-checkpoint.md`）只做核对与播报，不含蒸馏逻辑——
蒸馏由上面这次 `runWriter` 触发。模板与宿主动作是两件事，缺一不可。

### 2.3 为什么压缩触发不只是「保存原文」

常见理解是「压缩会丢原文，所以提前抢救」。这只对了一半。真正的原因有四层，
按重要性排列：

**① 蒸馏输入的保真度（最关键）**

writer 提示词的 Facts 段明确要求：

> Keep exact values (connection strings, ports, tokens, full commands, paths) verbatim.
> Never paraphrase them.

而 `readIncrement`（`writer.ts:119`）是从 `client.session.messages()` **重新拉取**的。
压缩之后这段历史已被摘要改写，此时再蒸馏，**蒸馏对象就从原始推理过程变成了二手摘要**。

后果是**逐代衰减**：精确值在摘要那一步就丢了，再蒸馏一次只是把丢失固化。端口、路径、
完整命令这些恰恰是本系统最高频查询的内容——`history` 工具的存在意义就是回溯它们。
压缩前触发保护的是**未来所有蒸馏的输入质量**，而不只是这一次的数据存在。

**② 触发时机的确定性**

`session.idle` 不会在压缩前到来。idle 是「这一轮回答结束」，压缩是「上下文即将被重写」。
顺序上 idle 永远更晚——等到 idle 时，数据已经被摘要改写过了。

压缩是宿主**明确告知**的边界（事件名就叫 `experimental.session.compacting`），
是唯一一个「重写发生前」的信号。手动路径同理不可靠：用户不会在每次压缩前手动敲命令。

**③ 水位与列表的时序一致性**

水位 `scanner:<sid>` 是时间戳，增量窗口按 `m.info.time.created > since` 选取
（`writer.ts:135`）。压缩会重写消息列表。压缩前结算意味着增量是从**稳定列表**里读的；
压缩后结算则要面对一个刚被改写过的列表，窗口假设可能失配。

**④ 工作单元的语义边界（设计意图，非硬约束）**

压缩点通常对应「一个工作单元即将收尾」，此时取的 checkpoint 语义上更接近一个完整
单元，而不是任意时间切片。这一条是设计意图，代码不做保证。

### 2.4 结算：轮询与崩溃恢复

派发之后，子代理的完成检测靠轮询，**不依赖任何事件**：

```
watchChildCompletion（writer.ts:187）
  每 5 秒查 client.session.status({ id: childSessionID })
    → status.type === "idle"  → settleWriter(childSessionID)
    → 查询抛错                → settleWriter(childSessionID)
  180 秒硬超时                → settleWriter(childSessionID)
```

另有两条恢复路径：

- **孤儿接管**：`persistOrphan`（`writer.ts:566`）在派发后立刻把在途状态写进
  `.writers.json`。进程崩溃 / 被杀留下的孤儿，在下次启动时由 `settleStartupOrphans`
  （`index.ts:142`）补齐。
- **过期清理**：`expireOrphans` 按 `writerTimeoutMs` 丢弃超时孤儿。

孤儿判定只看 `busy` / `retry`：

```ts
const busy = status?.type === "busy" || status?.type === "retry"
if (busy) continue
```

曾用 `status.type !== "idle"`，但已完成会话该端点返回 `undefined`，
`undefined !== "idle"` 恒真，导致孤儿永远被跳过，每次启动白烧一个子会话。

---

## 3. writer 生命周期

```
runWriter                       writer.ts:209
  ├─ state.has(sessionID) ? return          同会话防重
  ├─ 失败数 >= maxWriterRetries ? return    重试上限，spawn 前检查
  └─ void spawnWriter                      writer.ts:151
       ├─ readIncrement                    跳过 user 消息、跳过水位之前的
       │                                    预算 24000 字节
       ├─ session.create                   建子会话
       ├─ blacklist.add(childID)           防子会话自触发
       ├─ session.promptAsync(tools: {})   ★ 工具白名单为空
       ├─ persistOrphan                    写 .writers.json
       └─ void watchChildCompletion        5s 轮询
```

### 3.1 工具白名单为空是刻意的

`index.ts:93` 传 `toolsWhitelist: {}`，`writer.ts:174` 把它交给 `promptAsync`。

0.3.0 收紧的。子代理只依赖增量原文，不给任何工具——防止它检索到其他项目的内容
污染本项目记忆。提示词第 35 行也明写：

> Do NOT call any tool to write files or edit memory. The checkpoint and project
> memory are persisted by the host system from YOUR REPLY TEXT alone.

**模型只产出内容，宿主负责落盘。** 这条边界是整个可核对性的前提——如果模型能自己
写文件，宿主就无法验证它到底写了什么。

### 3.2 结算的九道关口

`finalizeWriterOnce`（`writer.ts:231`）：

| # | 关口 | 行为 |
| --- | --- | --- |
| 1 | 无输出 | 计为失败 + 记日志（否则重试上限永不生效） |
| 2 | `stripDelta` | 剥离 delta 块，**不写进任何记忆文件** |
| 3 | `validateCheckpoint` | 7 个必需 section + 10KB 上限 + 空白行比例 + 垃圾模式 |
| 4 | section 预算 | 超预算**只警告不拒绝** |
| 5 | mtime 守卫 | 文件已被更新则跳过 checkpoint 写（项目追加仍跑） |
| 6 | 写 checkpoint | 失败 → 计入失败数 |
| 7 | delta 解析 | markdown 分节解析，失败退回 0.4.x 追加 |
| 8 | 写项目记忆 | 分节 merge 或 global merge |
| 9 | 推水位 | **仅当 6 与 8 都成功** |

### 3.3 三条不变量

**水位单调**（`writer.ts:91`）

```ts
export function markCheckpoint(db, sessionID, ms = Date.now()): boolean {
  if (lastCheckpointMs(db, sessionID) >= ms) return false
  metaSet(db, key, String(ms))
  return true
}
```

同一会话两个子代理可能乱序结算（不同触发各派一个）。无条件 `Date.now()` 会让
后结算的那个把水位推过另一个尚未记录的窗口，那段内容永久跳过。

**水位只在全部写成功后推进**（`writer.ts:280`）

中途推进过一次，导致项目追加**永久丢失**——增量在水位越过后永不再读。

**重试上限前置检查**（`writer.ts:209`）

在 spawn **之前**检查而非失败之后。磁盘满、只读挂载这类永久故障，否则每次触发
都烧一个子会话。

`deps.maxWriterRetries ?? 3` 的 `?? 3` 不是防御性冗余：手维护的 deploy 入口曾漂移过，
`undefined` 让 `failures >= undefined` 恒假，**静默禁用了上限**且无任何报错。

### 3.4 幂等靠水位，不靠尾部比对

`appendProjectMemory`（`writer.ts:473`）有两道守卫：

```ts
const covered = Number(metaGet(db, `project_appended:${pid}`) ?? "0")
if (Number.isFinite(covered) && watermarkMs <= covered) return true
```

尾部 `endsWith` 检查不够：失败重试时同一份 checkpoint 再跑一次，尾部可能已插了别的
内容，`endsWith` 就漏了。**水位与顺序无关。** 尾部检查保留给无水位调用（直接调用、
测试）与前水位时代的历史数据。

`mergeProjectMemory` 与 `mergeGlobalMemory` 用同一套手法，global 侧水位键是
`global_appended`（`merge.ts:47`）。

---

## 4. 记忆文件布局

```
~/.config/opencode/memory/
├── memory.db                      memory_fts + memory_fts_idx + memory_meta
├── history.db                     history_fts + history_fts_idx
├── .writers.json                  在途子代理状态（崩溃恢复）
├── global/MEMORY.md               跨项目环境事实，预算 6000 字节
├── projects/<pid>/MEMORY.md       四段结构，段落预算合计 26000
└── sessions/<sid>/checkpoint.md   滚动快照，每会话一份
```

`<pid>` = `sha256(projectDir)`。用 sha256 而非路径编码，是因为 bun 与 node 对
SHA-256 有细微输入差异，跨运行时会导致 pid 不同、记忆散落成两个文件。

### 4.1 四段结构

`merge.ts:21` 定义，顺序固定：

```
## Project context                  预算 3000
## Rules                            预算 5000
## Architecture decisions           预算 8000
## Discovered durable knowledge     预算 10000
```

### 4.2 整文件不设上限，段落设预算

0.3.1 那次给 `MEMORY.md` 套了 10KB 上限，超限被静默拒写、调用方又丢弃返回值，
导致 236 会话批量结算**一个字未落盘**。

**累积型文件套单条上限是错的。** 但按段落设预算是对的——有意义的决策比文件列表
更值钱，所以「Architecture decisions」的预算高于「Project context」。

裁剪方向是**留新删旧**（`capSection`，`merge.ts:204`）：段落是追加的，尾部是最近的
决策，被砍的是头部。砍了多少行会记日志，不静默。

### 4.3 delta 用 markdown 而非 JSON

`writer-prompt.txt:52` 明令不转义任何字符：

> Do NOT escape backslashes, quotes or any other character — this is markdown,
> not JSON. A Windows path is written exactly as you see it: D:\RMANBAK\...

原因：路径是本系统最高频的内容，而模型对反斜杠转义是随机的。0.6.0 用 JSON 时实测
同一份输出 10 处中 1 处漏，整块解析失败——间歇性失败，且只在真实 checkpoint 上复现。

markdown 分节对内容零约束：反斜杠、引号、`-->` 箭头、空行全部原样通过。

结束标记只认**整行等于** `-->`（`findDeltaEnd`，`merge.ts:230`）。裸 `indexOf("-->")`
不安全：内容里合法出现箭头（`迁移 --> 展开`）会提前截断。

### 4.4 global 与 project 的分工

`global/MEMORY.md` 只放**关于用户与这台机器、换个项目依然成立**的事实。
提示词给模型的自检问句（`writer-prompt.txt:57`）：

> Test each candidate by asking "would this still be true if the user opened a
> different repository?" If no, it belongs in the four project sections instead.

**跨项目的规范与偏好不进 global**——那属于用户的 AGENTS.md。作为指令注入的东西
不该再作为证据检索一份，否则这个文件就是 AGENTS.md 的次级副本。

`writer.ts:346` 还有一条：只有 global delta 而没有 project delta 时，
**项目水位仍要推进**，否则增量会被无限重复蒸馏。

---

## 5. 检索层

### 5.1 中文 BM25

`cjkSpace()`（`service.ts:12`）在连续汉字间插空格，配合 FTS5 按空格分词。
中英混合关键词（JWT/认证、closure/死锁）可命中。

`buildFtsQuery` 把 token 逐个加引号后 OR 连接，规避 FTS5 语法字符。

### 5.2 相对分数阈值

```ts
const topScore = mapped[0]!.score
const cutoff = floorRatio > 0 ? topScore * floorRatio : -Infinity
return mapped.filter((r, i) => i === 0 || r.score >= cutoff).slice(0, limit)
```

第一名无条件保留，其余按「相对最佳命中的比例」过滤（默认 0.15）。

### 5.3 项目隔离

`memory` 未显式传 `scope_id` 时默认限定当前项目 `projects/<pid>`；
`history` 未传 `project_id` 时同样默认当前项目，且 `history get` 会校验 part 归属，
**跨项目拒绝读取**。

pid 靠 `session.list()` 预热 + `session.get()` 懒查（`index.ts:72`），存量数据在
启动时由 `backfillProjectIds` 回填。

### 5.4 索引新鲜度

`memory` 工具每次执行前调 `reconcile()`（`index.ts:87`），扫描记忆根下所有 `.md`
重建索引。`RECONCILE_ON_SEARCH=false` 可关。

**代价**：手工编辑 `MEMORY.md` 后不触发检索时索引会陈旧。dream 改完文件后同样有
这个延迟——dream 自己不 reconcile，靠下一次 `memory` 检索补上。

---

## 6. 校验的两层设计

`session/validator.ts` 严格区分拒绝与警告：

**拒绝（硬错误）**

- 缺 7 个必需 section 之一
- 超 10KB 总大小
- 空白行占比 > 50%
- 命中垃圾模式

**警告（只记录，不拒绝）**

- 单 section 超预算（800 / 1500 / 2000 / 800 / 1500 / 800）

理由写在 `validator.ts:19`：

> Overshooting one is reported as a warning, never a rejection: a rejected
> checkpoint is silently lost, which is the failure mode this whole check exists
> to make visible.

段落预算总和 7400 字节，落在 10KB 之内——这样超预算时通常先撞总大小错误，
writer 能报出真实原因。

---

## 7. 事件处理

`index.ts:235` 起的 `event` 处理器：

| 事件 | 处理 |
| --- | --- |
| `session.idle` | `settleWriter` + `expireWriters` + dream 事后核对 |
| `session.status` | `idle` 时再兜一次 |
| `message.updated` | 消息完成时拉全文 parts 写 `history.db` |
| `message.removed` | 删除镜像 |
| `session.updated` | 更新 pid 缓存 |
| `session.deleted` | 删镜像 + 清 blacklist + 清缓存 |

### 已知问题：`session.idle` 的结算参数

`index.ts:239`：

```ts
await settleWriter(writerDeps, writerState, sid)   // sid 是父会话 id
```

而 `settleWriterOnce`（`writer.ts:410`）按 `p.childSessionID === childSessionID` 匹配。
`state` 的键是父会话 id、值里的 `childSessionID` 是子会话 id，二者永不相等。

**这条路径实际是 no-op。** 结算实际由 `watchChildCompletion` 的 5 秒轮询完成。
同分支的 `expireWriters` 是有效的（它遍历整个 map，不依赖传入的 sid）。

影响：无功能损失（轮询已覆盖），但 idle 与 status 两个分支的 `settleWriter` 调用
是死代码。

### 启动补偿链

`index.ts:158`，四步各自 try/catch，任一失败都不阻塞插件启动：

```
session.list 预热 pid 缓存
  → backfillProjectIds   回填存量 project_id
  → catchupHistory      补拉历史消息
  → settleStartupOrphans 接管孤儿
```

---

## 8. dream 的可核对性

dream 是 agent 驱动的命令，宿主只管闸门和核对：

```
command.execute.before 查 dream:last，7 天未到则 splice 原地替换为拦截文案
  → 放行时拍快照（snapshotProjectMemory，dream.ts:33）
  → agent 自己改写 MEMORY.md
  → session.idle 时比对前后（diffProjectMemory，dream.ts:46）
```

快照存**全文而非哈希**，因为要报出具体删了哪些行——那是人真正想看的。
纯追加与真正修订的区别就在 `removed` 是否为 0：

```
dream 修订项目记忆 14274→15367 字节，行 72→58，删 43 行 / 增 29 行
只有新增没有删除：本次是追加而非修订，过时条目可能仍在
dream 未改动项目记忆（14274 字节不变）—— 整合本应修订或合并，若近期确有新结论，说明它没有生效
```

### 冷却闸门必须用 splice

`index.ts:225`：

```ts
output.parts.splice(0, output.parts.length, { type: "text", text: 拦截文案 })
```

整体赋值 `output.parts = [...]` 在 headless `run --command` 下**不生效**——
agent 收到的是命令模板原文，照常执行整合。原地 splice 两种模式都有效。

---

## 9. 同步与防漂移

四处曾重复的副本，各有唯一来源与门禁：

| 重复物 | 唯一来源 | 门禁 |
| --- | --- | --- |
| 共享模块 | `src/**` | `npm run sync:deploy` + 部署后 `diff -r` |
| writer 提示词 | `session/writer-prompt.txt` | `npm run gen:prompt -- --check` |
| deploy 入口 | `src/index.ts` | `npm run gen:deploy-entry -- --check` + 导入存在性 |
| 命令模板 | `src/command/*.md` | `install.mjs` 全位置安装 + 按内容比对 |

`npm run check` 一次跑完三道：提示词漂移、deploy 入口漂移、发布前产物校验
（`publish-check.mjs`：dist 产物存在、name 规范、main 指向、files 不含
`node_modules`/`src`/`.git`、license 存在）。

`install.mjs`（0.6.1 修）从「只装第一个 + 按 mtime 判新旧」改为
「装到所有发现的目录 + 按内容比对 + 装完交叉校验字节一致，不一致退出码非 0」。
原因是 `.opencode/command/` 才是 TUI 实际读取位置，而旧逻辑恰好漏了它。

---

## 10. 边界与非目标

- **不做上下文注入。** 记忆只在模型主动检索时返回。省 token，且避免过时记忆污染上下文。
- **writer 不做检索。** 工具白名单为空（见 3.1）。
- **`notes` / `docs` / `free` 三个 scope 已在类型与检索层预留，但无任何写入端。**
  工具描述里明说了，避免模型反复尝试写入。
- **`global/MEMORY.md` 至今没被子代理真实写入过。** 两次 checkpoint 的 delta 里
  都没有跨项目环境事实。`mergeGlobalMemory` 有测试覆盖，但那条路径尚未被真实内容
  走通。
- **V2 迁移未做。** OpenCode V2 未发布、插件 API 自标 beta、`v2` 分支仍在重构中。
  详见项目记忆里的调研记录。
