# 0.6.5 (2026-09-29)

- **修复:增量超过预算时,截断点之后的消息永久丢失**。这是已确认的静默数据丢失,实测规模 240KB 增量投喂 6 条 120,114 字节、永久丢失 6 条 120,118 字节,无任何报错。历史上一次 18 小时 469KB 增量只沉淀出 204 字节,就是这个原因。
  - 机制:`readIncrement` 读到 `INCREMENT_BUDGET` 就停,但结算时 `markCheckpoint` 用的是 `settleStart` —— 子代理派发那一刻的时间戳,不是最后一条真正读过消息的时间。截断点之后的消息 `created` 全部低于这个跳过去的水位,后续任何 checkpoint 都再也选不到它们。唯一的信号是派发时那行 `truncated=true` 的 warn。
  - 根因是 `settleStart` 兼任了两个语义不同的角色。**幂等令牌**(`appendProjectMemory` / `mergeProjectMemory` / `mergeGlobalMemory`)需要唯一且单调,`settleStart` 够用,保持不动;**游标**(`markCheckpoint`)需要「最后一条真正读过的消息」,只有这处要改。
  - `readIncrement` 返回 `lastConsumed` / `lastConsumedId`,且**只在一条消息的所有 text part 都装入后才记录**。中途被预算截断则停在上一条,下轮整条重读 —— 重复由追加幂等消化,换取不丢 part。
  - 同毫秒去重:`created <= since` 会连带跳过同一毫秒的后续消息,改用 id 区分边界。老库无 `scanner_id` 键时退化为原比较,无需迁移。
  - stale 命中时**不推水位**:该批内容没写进文件,推进游标等于声称已消化。无游标时也不推,不再回退到派发时刻。游标经 `PendingWriter` 与孤儿文件传递,进程重启后续写路径不会退回旧行为。
  - **宿主循环**:结算后若该批被截断则重新派发一轮。终止性可证 —— 每批游标固定前进,消息集合单调收缩;退化情形(单条消息超预算)由 `lastConsumed <= 0` 拦下,不会自旋。
- **修复:`npm run check` 存在第二处陈旧产物盲区**。游标修复落在 `src/` 后,`deploy/` 里的副本没同步,而 check 全绿通过 —— 与当初 `dist/` 那次同一性质:门禁只校验它自己看得见的那部分。`gen:deploy-entry --check` 只比对入口文件的 13 个导入路径,完全不碰 deploy 下的共享模块。
  - 新增逐字节比对 18 个共享文件。共享清单直接从 `scripts/sync-deploy.mjs` 的 `SHARED_REL` 解析而非另抄一份:第二份清单会漂移,而漂移会读成「deploy 没问题」。
  - 三个负向方向各自验证:deploy 内容不同、deploy 缺文件、src 改了未同步,均能拦下。
- 测试:46 pass / 292 expect(原 38 / 265)。
  - 四处负向验证:水位改回 `settleStart`、游标改「最后选中」、删除 re-arm 调用、stale 时也推水位,各自都能让对应测试失败。
  - 新增门禁的实现过程中自身错了三次,均由负向验证抓出 —— 递归未返回相对路径导致比了个空、URL 多一层 `../` 导致读到空集、把 7 个本就不共享的文件误报为缺失。门禁自己「通过」并不等于它在检查。

# 0.6.4 (2026-09-29)

- **修复:0.6.3 的超时系数建立在一个误读上,余量为负**。该版把系数定为 2ms/字节,来源是「132,497 字节耗时 208 秒」这个读数。但 208 秒不是完成耗时 —— 它是 180 秒硬超时把轮询砍断的时刻,子代理当时还没写完。真实的完成耗时是随后一次跑完的 490 秒。
  - 按 2ms 算出的预算是 487.5 秒,实际需要 490 秒,余量 **-2.5 秒**。上一轮能过纯属侥幸,provider 慢 1% 就会重演 `writer_fail` 递增;重试上限 3 次意味着第三次失败后该会话被永久静默。
  - 改为按完成耗时定系数:490s ÷ 132,497B ≈ 3.7ms/字节,取 **4ms**,叠加原有的 1.5 倍 slack 后约为实测成本的 6.7 倍。132,497 字节从 487s 变为 885s,135,000 字节满额从 495s 变为 900s。按实测值线性外推,135,000 字节约需 499 秒,现有 900 秒预算可承受 1.8 倍耗时膨胀。
  - 测试同步收紧两处。断言基准从 208s 换成实测的 490s,并要求至少 1.25 倍余量 —— 单「大于 490s」不够,2ms/byte 恰好满足却留下 -2.5s,那不叫余量。「小增量不低于 180 秒」原先断言等于 180s,但 4ms 下 24KB 合法地拿到 234s,改为 `>= 180_000`:预算是上限不是等待时长(小增量提前 idle 即结算),真正要守的是不得低于旧下限。
- **修复:`npm run check` 拦不住陈旧的 `dist/`,可静默发布旧代码**。`dist/` 在 `.gitignore` 里,源码改动不会让它失效,磁盘上的 bundle 可能比 `src/` 旧任意多个版本。这次就撞上了:超时系数已在源码改成 4ms 而 `dist/index.js` 仍是 2ms,`npm pack` 照常打包,shasum 与已发布的 0.6.3 逐字相同 —— 看上去毫无异常,实际准备发布的是旧代码。原先的 check 只校验 `dist/agent/` 是否存在。
  - 新增比对两个调参常量(`CHILD_DEADLINE_MS_PER_BYTE`、`INCREMENT_BUDGET`),不一致则退出非 0。只在两侧都声明了同名常量时比较(bundle 会丢弃部分 const,缺失不算漂移);两侧数值归一化后再比,esbuild 把 `135_000` 写成 `135e3`,而 `Number("135_000")` 是 `NaN`,直接比较会在全新构建上误报。
  - 负向验证:改源码而不重新 build 时,两个常量各自都能被拦下。
- 未发布的行为变更:0.6.3 的 2ms 系数从未在 npm 上跑过一次真实满额增量。

# 0.6.3 (2026-09-28)

- **修复:writer 子代理的权限边界实际从未生效**。0.3.0 当初把子会话工具白名单收紧为空,是为防止蒸馏时检索到其他项目内容污染本项目记忆。这次实测发现它一直是失效的:
  - `promptAsync` 的 `tools` 参数是**白名单**语义(SDK 类型 `{[key: string]: boolean}`),传 `{}` 意为「未指定」而非「全部禁用」,宿主照旧装配默认工具集。`writer-prompt.txt` 里那句「不要调用任何工具」是请求不是约束。
  - 一次 132,497 字节的子会话实际发起 **9 次 bash 调用**,全部撞权限审批。文件里那句规则此前从未被触发过,是碰巧。
  - 改为在 `.opencode/agent/promem-writer.md` 定义专用 agent(`permission: {"*": deny}` 逐工具 deny 15 条规则、`mode: subagent`、`hidden: true`),spawn 时指定 `agent`。实测工具调用 9 次 → **0 次**。
- **修复:子代理会卡在无人应答的审批界面直到硬超时**。`createBody.parentID` 字段一直存在、类型也声明了,但两处调用点都没赋值,子会话建出来 parentID 为 undefined。宿主的 ask 路由拿不到可继承授权的父会话,退回交互式审批 —— 子代理在无人看管的界面上干等,一次沉淀都没做。
  - `parentID` 因此是承重字段而非记账字段,补 `target.parentID ?? target.sessionID` 兜底。实测 132K 增量无人干预跑完 490 秒正常落盘。
- **修复:投喂上限 24K → 135K,硬超时按增量大小缩放**。两个固定常量都是在 24KB 投喂量下定的,到 135KB 时都成了瓶颈:
  - `INCREMENT_BUDGET` 24,000 → **135,000**。子会话把增量原文原样装进自己的上下文,超过压缩线时宿主会先压缩,于是 writer 蒸馏的对象变成一份已被摘要过的文本(实测把 483KB 一次性喂进去,子会话第一步就触发 compaction)。135K 是子代理模型压缩触发线实测值(约 140K)减去 system 提示与包裹文本的余量。
  - 硬超时 180 秒 → `max(180s, (60s + 字节数 × 2ms) × 1.5)`。180 秒是在 24KB 下测的;132,497 字节实测需 208 秒,旧上限在子会话写完前 28 秒就砍断轮询,读到空结果并报 `produced no output` —— 白烧一个子代理、还消耗一次重试配额(实测 `writer_fail` 从 0 涨到 1)。系数来自实测 208s ÷ 132,497B ≈ 1.57ms/字节,取 2ms 留约 27% 内建余量;60 秒底座覆盖建会话与 prompt 往返等固定开销,让小增量不吃亏;乘 1.5 之后仍不小于原来的 180 秒下限。
  - 派发与超时两条路径补日志(字节数、预算、实际耗时)。此前这两处失败完全不可见 ——「丢数据」和「投喂量太大」看起来是同一个现象。
- **新增:`promem-writer` 定义纳入仓库管理**。`WRITER_AGENT` 常量引用的文件此前只存在于本机,仓库里没有。任何人 clone 备份后装上插件,宿主按名字找不到定义会**静默回退**到默认 agent,上面两个问题原样复现且无报错。
  - 定义作为源码(`src/agent/`)而非安装步骤的产物管理:`build` 复制到 `dist/agent/` 随包分发;`publish-check` 校验它存在、含工具/权限限制、声明 `mode: subagent`,缺任一条则 `check` 退出非 0。
  - `promem-install` 一并安装:与命令模板的差别只是目标目录名不同(`agent/` 而非 `command/`),把两者抽成 `SETS` 表成对出现。命令模板那段逻辑一字未改 —— 仍是全位置安装、按内容而非 mtime 比对、装完交叉校验字节一致后退出码非 0,只是同一个循环跑两遍。
- 测试 35 → **38**(新增 3 个覆盖超时缩放的边界:132KB 必须给到 208 秒以上、小增量不得低于 180 秒下限、随增量单调递增)。
- 实测(132,497 字节):checkpoint 7396 → 9622 字节落盘,`writer_fail` 归零,水位推进,13.7:1 压缩比下 Facts 段逐条准确。

# 0.6.2 (2026-09-28)

- **删除:`session.idle` / `session.status` 里两处无效的 `settleWriter` 调用**。`settleWriterOnce` 按 `p.childSessionID === childSessionID` 匹配在途 writer,而 `state` 的键是**父**会话 id、值里的 `childSessionID` 是**子**会话 id,`session.idle` 事件只带父会话 id —— 查找永远匹配不上,两条路径实际都是 no-op。
  - 结算一直由 `watchChildCompletion` 的 5 秒轮询 + 180 秒硬超时承担,删除无功能损失。
  - `expireWriters` 保留:它遍历整个 map、不依赖传入的 id,有效。
  - `session.status` 分支整体删除后,idle 分支仍保留 dream 事后核对(`reportDreamIfDue`)—— 那条依赖的是事件本身而非参数,有效。
  - 风险在认知层面:这段代码让人误以为 idle 是结算主路径。README 原文「触发通道有两个」是对的,误读来自未区分**派发**(`runWriter`,2 处)与**结算**(`settleWriter`,6 处)。
- **文档:新增 `docs/ARCHITECTURE.md`**(477 行),并修正 README 三处与代码不符:
  - 重点展开 checkpoint 的两条触发路径。压缩前触发**不只是抢救原文**,更关键的是保护蒸馏输入的保真度 —— writer 提示词要求 Facts 段逐字保留精确值,而 `readIncrement` 从 `session.messages()` 重新拉取;压缩后那段历史已被摘要改写,此时蒸馏等于拿二手摘要当输入,精确值在摘要那一步就丢了,再蒸馏只是把丢失固化。
  - 结算机制:完成检测靠轮询,不依赖任何事件。
  - README 补上漏列的三个配置项,其中 `WRITER_MAX_RETRIES` 关键(它在**派发前**检查,防止磁盘满这类永久故障每次触发都烧一个子会话);澄清 10KB 是拒绝线、section 预算是警告线(分开是刻意的:被拒的 checkpoint 会静默丢失);「追加项目 MEMORY.md」更正为「按 delta 块分节合并」。

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