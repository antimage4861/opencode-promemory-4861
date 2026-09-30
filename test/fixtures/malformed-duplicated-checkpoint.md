# Checkpoint
Date: 2026-09-30

## Summary
本增量完成 0.6.7 发布与 PR #21–#25 合并，并完成 deadline 系数三轮定标与两次纠错。核心发现是 `/session/status` 端点不接受 `path` 参数、返回的是「活跃会话→状态」映射表且 idle 会话会被从表中删除，导致 idle 分支一直是死代码，每批只能等满 deadline（132KB 批次 1293s，子代理实际只需 36s）。修复后同一批次 76s（子会话实耗 74s），首次拿到 idle 路径下的真实速率 ≈ 11.6s + 0.473 ms/字节，系数随之从 6 降到 1，checkpoint 上限从 10KB 抬到 24KB，并开出 0.6.8 release PR。另发现子代理偶发输出结构畸形（`## Notes` 落在 delta 块内部被 stripDelta 剥掉），正用 `tools/malformed-scan.mjs` 多轮采样统计畸形率。

## Decisions
- 先修 idle 检测再谈系数定标：定标等于在给一个不生效的上限调参。
- 系数定为 1（`fix/deadline-coefficient-1`，`674b775`）：基于 idle 路径 3 个真实样本，满额上限 1278s → 288s，对最慢实测 111s 仍有 2.6x 余量。
- `MAX_CHECKPOINT_BYTES` 10*1024 → 24*1024（`2687159`）：依据实测 131,544B 增量产出 16,067B 检查点（超旧上限 56%），24KB 是分段预算之和 7400 的 3.2 倍并留 50% 余量，64KB 仍拒。
- 不采用「stripDelta 容错回退」方案（C）：会让机器可读 delta 内容泄漏进记忆文件，破坏原设计。
- AGENTS.md 定标章节整章重写：铁律从「只认完成耗时」改为「先确认测量链路是通的，再采信任何数字」；系数 6 明确标注为「错误定标的结果」而不再正面描述。
- 0.6.8 与系数 1 拆成两个 PR 并行提出，等待用户开 PR/合并。

## Facts
- 仓库 `antimage4861/opencode-promemory-4861`，gitee 为镜像；main/gitee 需每次同步。
- 0.6.7：npm `0.6.7`，shasum `3514eca2…`；tag `v0.6.7` 已从 `16c72c5` 移到 `8a0dadb`（该 commit 的 package.json 为 0.6.7）。
- 0.6.7 曾漏提交 release commit 就 `npm publish`，导致 tag 指向版本号为 0.6.6 的 commit；npm 内容正确（从工作区打包）但检出该 tag 得 0.6.6。
- 常量现状：`INCREMENT_BUDGET = 135e3`、`MAX_CHECKPOINT_BYTES = 24 * 1024`、`CHILD_DEADLINE_SLACK = 1.5`、系数 `1`、底座 `60_000`。
- SDK 权威定义（`~/.opencode/node_modules/@opencode-ai/sdk`，v1.18.26）：
  - `SessionStatusData = { body?: never; path?: never; query?: {directory?}; url: "/session/status" }`
  - `SessionStatusResponses = { 200: { [key: string]: SessionStatus } }`
  - `SessionStatus = { type: "idle" } | { type: "retry", ... } | { type: "busy" }`
- 服务端实现 `anomalyco/opencode/packages/opencode/src/session/status.ts`：`if (status.type === "idle") { …; data.delete(sessionID); return }` / `data.set(sessionID, status)` —— 即「不在 map 里」= idle。
- 旧错误读法：`const status = res?.data as { type?: string }; if (status?.type === "idle")` —— 从 map 上读 `type` 恒为 `undefined`，idle 分支为死代码。
- 正确读法：`client.session.status()`（不带 `path`）→ 从返回 map 取 `map[childID]`，`!map[id]` 即 idle。
- 修复前后对比（132KB 批次）：轮询等待 1293s → 76s；子会话自身 `time_updated - time_created` 74s；浪费倍率 36x → 1.03x。
- idle 路径真实样本（子会话自身时间戳）：39KB/30s/0.751 ms/B；129KB/68s/0.517；129KB/111s/0.846；132KB/89s/0.655。均值 0.672、标准差 0.135、CV 20.1%、最大/最小 1.64x。
- 两点/三点拟合：耗时 ≈ 11.5~11.6 s + 0.473 ms/字节；此前所有数字（3.7 / 6.01 / 9.0 ms/字节）均为 deadline 伪影。
- deadline 伪影特征：每批恰好超出预算 1–3 秒。
- 畸形样本偏移：输出 20,802B；`## Files` @6896、`<!-- project-memory-delta` @7455、`## Notes` @8278（落在块内）、`-->` @12854；`stripDelta` 剥掉 9,175B 后 `## Notes` 消失 → 校验失败 → 水位不推进 → `writer loop stopped watermark did not reach cursor`。
- `stripDelta` 只删 delta 块起点到 `-->` 之间的内容。
- 本地 API 端口 4096，进程 PID 14872（09-28 启动），与 TUI 内进程内 client 不是同一实例。
- 测试演进：49 pass/301 expect → 51 pass/308 → 54 pass/318 → 55 pass。
- 负向验证已多次执行：系数改回 2/4/6 各触发测试变红；上限改回 10KB 触发 2 个变红；status 改回 map.type 读法触发 2 个变红。
- 备份目录：`/tmp/cal-155339`、`/tmp/ver-165415`、`/tmp/idle-213415`、`/tmp/samples-081027`；待清理遗留 `/tmp/loop2-130814`、`/tmp/promem-bak-2052`。
- `.gitattributes` 声明 `eol=lf`，push 时的 CRLF 警告为预期行为；行尾已核 99/99、925/925、1425/1425 无混合。
- 本地 API 端口 4096 下的 `/session/status` 带与不带 `path` 返回完全相同。

## Open
- 用户需开/合并 PR：`fix/deadline-coefficient-1`（`674b775`）与 `release/0.6.8`（`c946fac`）。
- 用户需重启 TUI（当前进程 `19136` @ 09:32:42 早于代码 mtime，系数仍是 6）后才能验证系数 1。
- 畸形采样：每轮 5 批，需 15–20 个样本才能区分 10% 与 40% 畸形率，剩 3–4 轮；每轮跑 `bun tools/malformed-scan.mjs` 累积。
- 畸形修复方向未定（B 改提示词 / C stripDelta 容错 / D 剥离前探测、只剥最后一个 delta 块），需先确认畸形形态是否唯一。
- 60 秒底座存疑：真实截距 11.5s，公式底座 ×1.5 = 90s，是其 7.8 倍，来源同样是错误拟合。
- 若畸形率真达 33%，需单独评估 `INCREMENT_BUDGET = 135e3` 是否本身过大。
- 备份清理：实测结束后删 `/tmp/loop2-130814`、`/tmp/promem-bak-2052`。

## Files
- `tools/malformed-scan.mjs`：新建的可复用畸形分析器，按形态归类并累积统计。
- `AGENTS.md`（219 行，commit `1416ae2`）：定标章节整章重写 + 案例表补 #13（API 语义读错）/#14（判据恒为真）+ 硬性要求 D 补两条。
- `src/**` 中 `watchChildCompletion` / deadline 系数相关文件：系数 4→6→1，status 调用改为无参 + map 读法，注释依据重写。
- `src/**` 校验文件：`MAX_CHECKPOINT_BYTES` 改 `24 * 1024`，`validateCheckpoint` 相关测试改用实测 16,067 字节规模。
- `package.json`：0.6.7（分支补提交后）、0.6.8 release 分支。
- `.gitattributes`：`eol=lf`（已核，未改）。

## Notes
- 「成功掩盖了没做」：`npm publish` 不因为你没提交 release commit 就报错 —— publish 成功反而让 commit 缺失隐形。
- 判据恒为真是最危险的错误类型：`status=busy` 被当成「子代理仍在工作」的证据用了三轮，实则该字段零信息（status 恒为 `{}` 时 busy 与 idle 两种情况都记成 busy）。
- 调第三方 API 前必须先读类型与实现：`path?: never` 会被静默丢弃，不报错。
- 验「轮询到的东西」不等于验「真实工作量」，判据应取子进程自身时间戳（`time_created` / `time_updated`）；`created` 与 `updated` 时间戳本身不反映实际工作时间，须用二者之差。
- 「精确超出预算 1–3 秒、耗时完全跟随预算变化」是伪影特征，说明测的是被中断的时刻而非完成耗时。
- 测试 mock 的 key 必须用实际派发的 child id（如 `child-0`），硬编码 key 会让 child 缺席，而缺席在新语义下意味着 idle，导致测试提前退出、自欺。
- 拟合系数去和速率直接比较是错的（1.5 因子会乘每字节项），必须比较两条整线：`90.7s + 6.01n` vs `90s + 9.00n`。
- 子代理并不遵守分段预算（16KB 输出每段超支约 10 倍），分段超支仅 warning，唯一闸门是总上限 —— 本次只是把悬崖从 10KB 移到 24KB。
- `checkpoint.md` 只写不读，抬高上限不增加自动注入的上下文。
- 先验进程启动时间晚于代码 mtime 再触发，是每轮实测的固定前置条件。
- 用 heredoc 往 `/tmp` 写脚本时 Python 侧看不到该路径，改用 edit 工具直接替换更可控。
- 用 `end` 索引切文件章节时，若目标章节位于参照章节之前会因 `end < start` 切片错乱导致重复章节；尾部章节改用文件末尾作边界。
- 自写断言有时会替实现背书：首次写「预算线在任意规模都高于拟合成本线」时把系数反解值与 6.01 比，断言对象错了，应比整线。

<!-- project-memory-delta
## Project context
- `antimage4861/opencode-promemory-4861`：opencode 插件，按会话增量蒸馏记忆（`MEMORY.md` / `checkpoint.md` / project memory），gitee 为镜像。
- 核心链路：scanner 维护水位与 cursor → writer 循环按 `INCREMENT_BUDGET` 派发子代理蒸馏 → 写入记忆文件并推进水位。
- 蒸馏子代理输出为固定六段结构（`## Summary` / `## Decisions` / `## Facts` / `## Open` / `## Files` / `## Notes`）加一个 `<!-- project-memory-delta … -->` 机器可读块。
- 仓库用 `.gitattributes` 声明 `eol=lf` 做行尾归一化，push 时的 CRLF 警告属预期。

## Rules
- 验证对象必须与运行对象是同一个：先确认进程启动时间晚于代码 mtime，再触发实测。
- 定标第一步不是测量，而是确认测量链路是通的。
- 每次改常量/上限/读法都必须做负向验证：改回旧值必须让对应测试变红。
- 调第三方 API 前先读其类型声明与实现，不靠猜。
- 验「轮询到的东西」不等于验「真实工作量」，判据取子进程自身时间戳之差。
- 发版流程：建 release 分支 → bump 版本 → 提交 release commit → tag → publish → 开 PR 合入 main。
- 门禁 `check` 会在 deploy 陈旧时拦下，需按 check → sync → deploy 顺序重跑。
- 机器可读 delta 块不进记忆文件（因此不接受让 `stripDelta` 容错回退）。
- 不主动 commit，仅在用户明确要求时提交。

## Architecture decisions
- deadline 公式 `(60s + n×k ms) × 1.5`：k 定为 1（`674b775`），因 idle 路径真实速率 0.473 ms/字节、最坏/最好比 1.64x，k=1 仍有 2.6x 余量。
- 60 秒底座保持不变：虽真实截距仅 11.5s，但改动依据不足，先收集样本。
- `MAX_CHECKPOINT_BYTES` 定为 24KB：分段预算之和 7400 的 3.2 倍，覆盖实测最坏 16KB 并留 50% 余量，64KB 仍拒。
- idle 判定采用「map 中无该 id 即 idle」而非 `type === "idle"`，依据服务端 `status.ts` 中 idle 会 `data.delete`。
- 系数分支与 release 分支拆成两个 PR，便于独立审阅与回滚。

## Discovered durable knowledge
- `GET /session/status` 返回 `{ [sessionID]: SessionStatus }` 映射表，不是单会话对象；`path?: never`，传 `path` 会被静默丢弃且不报错。
- idle 会话会被服务端从 status map 中删除，因此「不在 map 里」= idle；`{}` 意味着当前无活跃会话。
- `status=busy` 日志字段在 status 恒空时 busy/idle 两态都会记成 busy，不携带信息。
- 子代理不遵守分段预算（实测每段超支约 10 倍），分段超支仅 warning，唯一硬闸门是 `MAX_CHECKPOINT_BYTES`。
- 子代理偶发把 delta 块开在 `## Notes` 之前，`stripDelta` 从 delta 起点剥到 `-->`，会连带剥掉中间段落导致校验失败、水位不推进、`writer loop stopped watermark did not reach cursor`。
- deadline 伪影特征：每批恰好超出预算 1–3 秒，耗时随预算等比例变化，与工作量无关。
- 测试 mock 若硬编码 child id 而非 `create` 实际返回的 `child-0`，会让 child 缺席，而缺席在新语义下等于 idle，造成提前退出的假通过。
- 用 `end` 索引切文件章节做批量替换时，目标章节在参照章节之后会导致 `end < start` 切片错乱。
- `MAX_CHECKPOINT_BYTES` 拒收时日志为 `ERROR checkpoint rejected errors=["size exceeds 10240 bytes"]`；用 heredoc 写 `/tmp` 脚本时 Python 侧看不到该路径。
- 本地 API 在 4096，但其进程实例可能与 TUI 内的进程内 client 不同，用它探测 session 状态会得到误导性空结果。
- 拟合系数与速率直接比较是错的（1.5 slack 因子会乘每字节项），须比较两条整线。
- `child.time_created` / `child.time_updated` 单看都不反映实际工作时间，须取二者之差。

## Global (cross-project facts)
- 本机为 Windows（win32），bash 通过 Git Bash 运行，路径形如 `D:\RMANBAK`。
- 本地 opencode API 服务在端口 4096；SDK 类型定义位于 `~/.opencode/node_modules/@opencode-ai/sdk`（当前 v1.18.26，opencode 1.18.33）。
- opencode 会话状态可用 `history` / `memory` 工具检索；子会话原始数据含 `time_created` / `time_updated`。
- Python 侧不可见 heredoc 写入 `/tmp` 的文件，需改用管道或 edit 工具。
- 仓库工作区为 CRLF 与 LF 混存场景，`.gitattributes` 的 `eol=lf` 会让 push 出现 CRLF 警告，属预期非异常。
-->

CHECKPOINT_DONE