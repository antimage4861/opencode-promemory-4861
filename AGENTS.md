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
npm test                    # 38 pass
npm run build               # 必须。dist/ 不会自动重建
npm run check               # 校验 dist 与 src 一致 + agent 产物完整
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

直接改生成物会被 `check` 拦下。

### 版本号

默认只升 patch。`0.6.4` / `0.6.5` / `0.6.6`…，而非 `0.7.0`。

## 调参常量的定标方法

`INCREMENT_BUDGET`、`CHILD_DEADLINE_BASE_MS`、`CHILD_DEADLINE_MS_PER_BYTE` 是 writer 的三个承重常量，改动它们需要实测数据支撑。

**只认「完成耗时」，不认「被中断的时刻」。** 这条已经栽过一次：0.6.3 把系数定为 2ms/字节，来源是「132,497 字节耗时 208 秒」——但那 208 秒是 180 秒硬超时把轮询砍断的时刻，子代理当时还没写完。真实完成耗时是随后跑完的 490 秒。按 2ms 算出的预算是 487.5 秒，余量 **-2.5 秒**，通过纯属侥幸。

定标步骤：

1. 造一个接近满额的真实增量，跑完，**记录完成时刻**
2. `系数 = 完成耗时 ÷ 字节数`
3. 预算需覆盖实测值并留足余量。writer 重试上限 3 次，第三次失败会静默整个会话的沉淀——低估预算的代价远大于多等几秒
4. 线性外推满额耗时，确认余量可接受

当前值与依据：

| 常量 | 值 | 依据 |
|---|---|---|
| `INCREMENT_BUDGET` | 135,000 | 子代理模型压缩触发线实测约 140K，减去 system 提示与包裹文本 |
| `CHILD_DEADLINE_MS_PER_BYTE` | 4 | 490s ÷ 132,497B ≈ 3.7ms/字节，取 4 后叠加 1.5 slack 约为实测的 6.7 倍 |
| `CHILD_DEADLINE_SLACK` | 1.5 | 蒸馏耗时非线性于输入；provider 慢应该表现为多等，而非静默失败 |

线性外推：135,000 字节约需 499 秒，现有 900 秒预算可承受 1.8 倍膨胀。满额实测不是必需。

## 测试约定

- 连续量（耗时、预算、字节数）**不要用 `toBe` 锁精确值**。三次栽在这里：208s 误读、`childDeadlineMs(24_000) === 180_000`（4ms 下合法地变 234s）、`Number("135_000")` 是 `NaN` 导致门禁在全新构建上误报
- 断言要锁**意图**而非**当时读到的数字**。「预算不小于 180 秒」用 `toBeGreaterThanOrEqual`，不要写成 `toBe(180_000)`
- 同一数量在源码与产物里写法可能不同（esbuild 把 `135_000` 写成 `135e3`），比较前先归一化。`Number()` 对带下划线的字符串返回 `NaN`
- 门禁类代码必须做**负向验证**：故意制造它要防的错误，确认真的被拦下
