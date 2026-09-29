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

第 11、12 条叠在一起，让 `0.6.6` 声称修好的 deadline 分支**根本没修**，而单元测试、负向验证、CHANGELOG 全部显示正常。只有真实 provider 实测才暴露。

**如果只看单元测试，第 11、12 条一个都不会被发现。**

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

`INCREMENT_BUDGET`、`CHILD_DEADLINE_BASE_MS`、`CHILD_DEADLINE_MS_PER_BYTE` 是 writer 的三个承重常量，改动它们需要实测数据支撑。

### 两条硬规则

**一、只认「完成耗时」，不认「被中断的时刻」。**

0.6.3 把系数定为 2ms/字节，来源是「132,497 字节耗时 208 秒」——但那 208 秒是 180 秒硬超时把轮询砍断的时刻，子代理当时还没写完。真实完成耗时是随后跑完的 490 秒。按 2ms 算出的预算是 487.5 秒，余量 **-2.5 秒**。

**二、先确认日志能区分「被砍断」和「早已完成」，再采信任何数据。**

轮询间隔 5 秒，子代理若在 888 秒完成、891 秒预算，892 秒那次轮询会同时满足 idle 与 deadline 两个条件。**先判 deadline 的话，这两种情况产生完全相同的日志行。**

这个顺序导致 0.6.4–0.6.6 期间的实测数据全部无法解读：四批全部显示「超时」，却分不清是真被砍断还是轮询没赶上。`watchChildCompletion` 已改为先探 status 再判 deadline，超时日志附 `status=busy`——**只有该字段为 `busy`，「超时」才是可信的信号**。

### 定标步骤

1. 造一个接近满额的真实增量，跑完，**记录完成时刻**（不是被中断的时刻）
2. 至少采集**两个规模差异明显**的批次（满额 + 零头），两点拟合出 `截距 + 斜率`
3. 预算线必须**整线高于**拟合线，不能只比对某一档
4. 确认日志里有 `status=busy`，佐证批次确实是被砍断的

### 当前值与依据

四批满额实测（全部 `status=busy`，即子代理在 deadline 时仍在工作）：

| 字节 | 预算 | 实际 | 差 |
|---|---|---|---|
| 135,082 | 900.5s | 902.9s | +2.4s |
| 133,539 | 891.2s | 892.5s | +1.2s |
| 47,253 | 373.5s | 375.7s | +2.2s |
| 28,307 | 259.8s | 260.9s | +1.1s |

两点最小二乘拟合：**耗时 = 90.7s + 6.01 ms/字节**

| 常量 | 值 | 依据 |
|---|---|---|
| `INCREMENT_BUDGET` | 135,000 | 子代理模型压缩触发线实测约 140K，减去 system 提示与包裹文本 |
| `CHILD_DEADLINE_BASE_MS` | 60,000 | 拟合截距 90.7s ÷ 1.5 ≈ 60.5s，取 60s |
| `CHILD_DEADLINE_MS_PER_BYTE` | 6 | 见下方「余量是怎么丢的」 |
| `CHILD_DEADLINE_SLACK` | 1.5 | 蒸馏耗时非线性于输入；provider 慢应表现为多等，而非静默失败 |

当前预算线 `90s + 9.00n`，比拟合线 `90.7s + 6.01n` 高出 **45%**（满额）/ **32%**（28KB，底座占比更高）。

### 余量是怎么丢的

值得单独记下来，因为这个错误隐蔽且会复发：

```
旧系数 4 的公式：(60s + 4n) × 1.5 = 90s + 6.00n
拟合的真实成本：                      90.7s + 6.01n
                                   ↑ 几乎完全重合
```

**吻合不是验证，是问题。** 那 1.5 倍 slack 从来就不是余量——最初的 2ms 系数取自 208 秒这个「被砍断的时刻」，按构造就等于预算，等于拿预算乘预算。把系数 2 翻到 4 时，把本就不存在的余量彻底花光，于是每一批都贴着 deadline 结束（-1.2 到 -2.4 秒）。

当时 `writer.ts` 的注释写着「1.5 因子叠加后约为实测的 6.7 倍 headroom」，**而实测 headroom 是负数**。那句话从写下起就是错的，且没有任何测试能发现它——因为它描述的是意图，不是行为。

现在测试直接断言「预算线在任意规模都高于拟合线」，把系数改回 4 会让三个测试同时变红。

### 一个反复出现的取错对象

写这条时我一度把系数反解出来（`(budget / 1.5 - 60_000) / n`）去与拟合斜率 6.01 直接比较，测试红了。**比错了对象**：1.5 因子会乘上每字节项，6ms 的系数已经给出 9ms/字节的预算。正确的比较是**两条整线之间的差**，不是系数与速率之比。

同「验证方法」案例 #2：连续量要比较的是同一层次的量。
