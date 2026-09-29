# opencode-promemory-4861 贡献指南

本文件为项目级指令，与全局 `AGENTS.md` 冲突时以本文件为准。

## Git 工作流

采用 GitHub Flow，**`main` 只能经由 PR 变更**，包括版本号 bump 也不例外。

release commit 也不例外——历史上 `0.6.4` 的两个 commit（`cd147b1` check 修复、`cd1bdd3` 版本 bump）都是直接 push 到 main 的，没有 PR。这条已经违反过一次，且 npm 版本发布后无法回退补救。补一个 revert 只会污染历史（`scripts/` 不在 `files` 白名单内，对已发布产物零影响），所以正确做法是下次不再犯。

判定方法：`git log --merges origin/main` 里应能看到每个功能变更对应的 merge commit。没有 merge commit 的 commit 就是绕过 PR 直推的。

### 分支

- 从 `main` 拉分支，命名 `fix/*` / `feat/*` / `docs/*` / `chore/*`
- 合并后删除本地与远端分支
- commit 遵循 Conventional Commits，原子提交

## 发布流程

### 关键前提：`dist/` 是构建产物且不入库

`dist/` 在 `.gitignore` 中，**源码改动不会让它失效**。磁盘上的 bundle 可能比 `src/` 旧任意多个版本，且不会报错。

这个坑踩过一次：超时系数已在 `src/session/writer.ts` 改成 `4`，而 `dist/index.js` 仍是 `2`，`npm pack` 照常打包，shasum 与上一个已发布版本**逐字相同**——看上去毫无异常，实际准备发布的是旧代码。

`npm run check` 现在会比对 `CHILD_DEADLINE_MS_PER_BYTE` 与 `INCREMENT_BUDGET` 两个常量拦截这种情况，但它只能拦住常量漂移，拦不住其他形式的陈旧产物。

### 步骤

```bash
npm test                    # 48 pass
npm run build               # 必须。dist/ 不会自动重建
npm run check               # 校验 dist 与 src 一致 + deploy 副本一致 + agent 产物完整
npm run sync:deploy         # 同步到 D:/RMANBAK/.opencode/plugins/project-memory/
```

### 发布前必做：从 tarball 内部核对

`npm run check` 通过**不等于**产物正确。它校验的是 `dist/` 目录，而 `npm pack` 打包的也是 `dist/`——若 `dist/` 本身就旧，两者会一致地错。

必须解开 tarball 看里面的实际代码：

```bash
npm pack
tar -xzf opencode-promemory-4861-*.tgz -C /tmp/verify
grep -n "var CHILD_DEADLINE_MS_PER_BYTE\|var INCREMENT_BUDGET" /tmp/verify/package/dist/index.js
```

发布后再从注册表下载核对一次（这一步与前面的判断无关，能发现本地与线上不一致）：

```bash
npm pack opencode-promemory-4861@<version> --pack-destination /tmp/regcheck
tar -xzf /tmp/regcheck/*.tgz -C /tmp/regcheck
grep -n "var CHILD_DEADLINE_MS_PER_BYTE" /tmp/regcheck/package/dist/index.js
```

### 唯一来源

改动只落在源头，其余由 `npm run check` 保证同步：

| 源文件 | 生成物 |
|---|---|
| `src/session/writer-prompt.txt` | `src/session/prompt.ts` |
| `src/index.ts` | `deploy/opencode-plugin/project-memory.ts` |
| `src/**` | `deploy/opencode-plugin/project-memory/src/**` |
| `src/agent/promem-writer.md` | `dist/agent/` → 安装目录 |

直接改生成物会被 `check` 拦下。改完 `src/` 却忘了 `sync:deploy` 时，副本会落后一整个 release 而 `check` 一路放行——共享文件的逐字节比对就是为拦住这种情况加的。

### 版本号

默认只升 patch。`0.6.5` / `0.6.6` / `0.6.7`…，而非 `0.7.0`。

## 验证方法

**本项目最常出问题的地方，单独一节。**

### 核心禁令

> **不得从「看起来通过」的验证结果推导结论。**

判据只有一条：**一个验证的成功结果，必须与「这个验证根本没跑」的结果可区分。** 区分不了，说明它什么都没验。

这句话在本项目被违反过 12 次，列在下面。共同点是：每一次都有一个「看起来没问题」的结果，而那个结果和「根本没检查」完全无法区分。

### 案例清单

| # | 验证的东西 | 实际发生了什么 | 正确做法 |
|---|---|---|---|
| 1 | 208 秒耗时 | 那是被超时砍断的时刻，不是完成耗时（真实 490 秒） | 只认完成时刻 |
| 2 | `toBe(180_000)` | 连续量锁死精确值；4ms 下 24KB 合法地变 234 秒 | 锁意图，用 `≥` |
| 3 | `Number("135_000")` | 返回 `NaN`，新写的门禁在**全新构建**上误报 | 归一化后比较 |
| 4 | `dist/` 是否新鲜 | 陈旧的 dist 打包出的 shasum 与上个已发布版本**逐字相同** | 从 tarball 内部读，不看本地 dist |
| 5 | `deploy/` 是否新鲜 | `gen:deploy-entry --check` 只比对入口的 13 个导入路径，共享模块根本没查 | 逐字节比 18 个共享文件 |
| 6 | deploy 门禁的目录遍历 | 只返回文件名没返回相对路径，拿 `src/session/writer.ts` 和 deploy 根目录比——**比了个空，报「一致」** | 返回相对路径，并断言比较到的文件数 > 0 |
| 7 | deploy 门禁的 URL 拼接 | 多写一层 `../`，读不到文件，`catch` 把它当成「跳过」 | 读取失败必须报错，不能静默跳过 |
| 8 | 测试 fixture 的字节数 | part 设成 120KB，被测消息**第一片就超预算**，断言了一个不可能发生的场景 | 先做算术验算，确认目标分支真的可达 |
| 9 | mock 让子会话立即 idle | 恰好绕开唯一有 bug 的分支（deadline） | 每条退出路径都要有测试 |
| 10 | 「代码已加载」 | 只看文件内容是新的，**没比对进程启动时间**，实测跑的是 10 小时前的旧代码 | 比对 `代码 mtime` vs `进程 StartTime` |
| 11 | `cp` 恢复备份 | 备份已被上一条命令的 `rm` 删掉；`cp` 对不存在的源**不报错**，变异代码原样提交 | 恢复后核对内容，不看退出码 |
| 12 | 负向验证的 `replace` | 目标行本来就是原样，replace **空操作**；「没有测试失败」被读成「该分支无覆盖」 | 先断言变异生效 |
| 13 | `session.status` 的返回结构 | 该端点返回**映射表** `{[sessionID]: SessionStatus}`，且 `path?: never`——旧代码传 `path` 并直接读 `.type`，恒为 `undefined` | 读 SDK 类型 + 服务端源码 |
| 14 | `status=busy` 这个日志字段 | 因 #13，map 恒空，busy 与 idle **两种情况都记成 busy**，被当作「子代理仍在工作」的证据用了三轮 | 判据必须能证伪 |

第 11、12 条叠在一起，让 `0.6.6` 声称修好的 deadline 分支**根本没修**，而单元测试、负向验证、CHANGELOG 全部显示正常。只有真实 provider 实测才暴露。

第 13、14 条更隐蔽：idle 分支从不命中，所有批次都等满 deadline，而由此拟合出的「6.01 ms/字节」看起来极其合理——**被 deadline 约束的时间序列，拟合出来必然是 deadline 的形状**。同样只有真实实测才暴露。

**如果只看单元测试，这四条一个都不会被发现。**

### 硬性要求

**A. 改完必须读回确认落到了目标文件**

改 `src/` 后不要凭「编辑成功了」往下走。读回来，或数一遍：

```bash
grep -c 'await settleAndRearm()' src/session/writer.ts   # 期望 3
```

涉及多处相同调用时，逐处核对而非只看总数——总数对不代表每一处都对。

**B. 恢复 / 回滚后必须核对内容**

`cp` 的退出码在源文件不存在时仍为 0。恢复后必须比对：

```bash
cp /tmp/backup src/session/writer.ts && grep -c 'marker' src/session/writer.ts
```

不要在同一批命令里 `rm` 掉下一批还要用的备份。

**C. 负向验证必须先证明变异生效**

这是最容易自欺的一环。「没有测试失败」有两种可能：门禁有效，或者变异没做。必须排除后者：

```python
assert old in s, "PATTERN NOT FOUND"   # 缺这一行，replace 可能什么都没做
```

并在变异前后各 grep 一次，确认计数真的变了。恢复后同样显式校验，**不要只看测试是否变绿**。

**D. 验证对象必须与运行对象是同一个**

- 验 `dist` 不等于验 tarball——解开 tarball 读
- 验文件内容不等于验运行中的代码——比对进程启动时间
- mock 与真实路径不同就等于没测——真实 provider 跑一次
- **验「轮询到的东西」不等于验「真实工作量」**。若循环由超时兜底退出，实测到的就是超时值。判据是子进程自身的时间戳（`session.time_updated` 减去 `time_created`），不是外层循环的等待时长
- **调用第三方 API 前先读其类型定义与实现**。`SessionStatusData.path` 声明为 `never` 说明该端点不接受单会话参数，而运行时传了 `path` 且不报错——静默丢弃

**E. 单点读数不作为基线**

任何被写进代码、注释或 CHANGELOG 的数字，来源要么是完成时刻，要么有两个以上独立来源交叉印证。「测到过一次」不是基线。

### 测试约定

- 连续量（耗时、预算、字节数）**不要用 `toBe` 锁精确值**。见上表 #2
- 断言要锁**意图**而非**当时读到的数字**。「预算不小于 180 秒」用 `toBeGreaterThanOrEqual`
- 同一数量在源码与产物里写法可能不同（esbuild 把 `135_000` 写成 `135e3`），比较前先归一化。见上表 #3
- 门禁类代码必须做**负向验证**：故意制造它要防的错误，确认真的被拦下。见上表 #12
- mock 要覆盖每一条退出路径，不要只覆盖最顺利的那条。见上表 #9
- fixture 的数值先做算术验算，确认要测的分支真的可达。见上表 #8

## 调参常量的定标方法

`INCREMENT_BUDGET`、`CHILD_DEADLINE_BASE_MS`、`CHILD_DEADLINE_MS_PER_BYTE` 是 writer 的三个承重常量。

### 铁律：先确认测量链路是通的，再采信任何数字

**定标的第一步不是测量，是验证「测的东西确实是被测对象」。**

这个项目在同一条链路上错了三次，每次都产出了一批看起来完全合理的数字：

| 次数 | 测到的 | 真相 |
|---|---|---|
| 0.6.3 | 132,497 字节耗时 208 秒 | 那是 180 秒超时**砍断轮询的时刻**，不是完成耗时 |
| 0.6.4–0.6.7 | 四批全部「超时」，拟合出 6.01 ms/字节 | 那是**每一批都等满 deadline** 的结果，与工作量无关 |
| 0.6.7 | 日志里 `status=busy`，据此断言「子代理仍在工作」 | 该字段**恒为 busy**，携带零信息 |

第三次的教训最彻底：`/session/status` 的返回结构被读错了（详见「验证方法」案例 #13），导致 idle 分支从不命中，所有批次都走 deadline 分支。于是我拿「deadline + 2 秒」当完成耗时去拟合，拟合出一条 `90.7s + 6.01n` 的曲线——**看起来非常合理，因为 deadline 本身就是一个线性函数**。

而真实情况是：

```
133,322 字节的子代理 36 秒就完成了（含 step-finish，产出完整 checkpoint）
轮询却在它身上坐了 1293 秒
真实速率 = 36s ÷ 133,322B = 0.27 ms/字节   （当时设的系数是 6，相差 22 倍）
```

**被 deadline 约束的时间序列，拟合出来必然是 deadline 的形状。** 这类伪影的特征是「每一批都恰好超出 1～3 秒」——真实工作量不会这么整齐。

### 测量前的三项检查

1. **读 SDK 类型定义**，不靠猜。`~/.opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`
2. **读服务端源码**。路由的 `?:` 字段和服务的实际数据结构常常不一致——`SessionStatusData` 写着 `path?: never`，说明这个端点根本不接受单会话参数
3. **用一个能证伪的样本验证**。比如「map 恒空」如果同时对**活跃会话**成立，那它反映的是进程/作用域问题，不是「没有活跃会话」

### 当前值与依据

`CHILD_DEADLINE_BASE_MS = 60_000`、`CHILD_DEADLINE_MS_PER_BYTE = 6`、`CHILD_DEADLINE_SLACK = 1.5`

系数 6 的来历需要说明清楚：**它不是定标的结果，是错误定标的结果。** 当时拟合出 6.01 ms/字节，取 6 作为「刚够」，实际需求是 0.27 ms/字节。

这个值现在保留着，因为**它只是上限，不再是等待时长**——idle 检测修好后子代理 36 秒完成、约 40 秒结算，不会碰上限。代价是万一某批次真超时，等待上限偏大（22 分钟 vs 真实需求 1 分钟）。

**重新定标的前提是先有 idle 路径下的真实数据。** 修好之后跑几轮满额，记录的是「idle 分支的结算时刻」而非 deadline，然后用两点（满额 + 零头）拟合。届时应把系数降到 1～2 量级。

`CHILD_DEADLINE_BASE_MS = 60_000` 同理存疑：它来自那个错误的拟合截距 90.7s ÷ 1.5。真实 36 秒里有多少是固定开销尚未拆解，不能假设 60s 是对的。

### INCREMENT_BUDGET = 135,000

这个值是独立定的（子代理模型的压缩触发线实测约 140K，减去 system 提示与包裹文本），与 deadline 无关，仍然有效。

### 一个反复出现的取错对象

写测试时我一度把系数反解出来（`(budget / 1.5 - 60_000) / n`）去与拟合斜率直接比较，测试红了。**比错了对象**：1.5 因子会乘上每字节项，系数 6 已经给出 9 ms/字节的预算。正确的比较是**两条整线之间的差**，不是系数与速率之比。

同「验证方法」案例 #2：连续量要比较的是同一层次的量。
