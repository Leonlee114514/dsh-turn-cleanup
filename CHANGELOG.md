# 变更记录

按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 组织，版本号走 SemVer。
每条写「为什么」而不只是「改了什么」—— 这个插件的坑大多来自 DSH 宿主的隐式约定，
不记下来下次还会踩。

## [0.8.1] - 2026-11-26

0.8.0 发出去之后，有人问了一句「不同环境兼容与适配性仍能保持吧」。查 GitHub Actions 的历史，
答案是**不能** —— 而且不是 0.8.0 引入的。

### Fixed · 测试在非中文 locale 的机器上必然红

`test/sim.mjs` 场景 8/10/13 的断言比的是中文原文（`最近 3 份` / `收尾前清场` / `备份超量`），
但场景没钉 `messageLocale`，走的是 `auto` 回退链（`DSH_LOCALE` → `LC_ALL` → `LC_MESSAGES` →
`LANGUAGE` → `LANG` → `Intl` → `'en'`）。GitHub 的 ubuntu runner `LANG` 是 `C.UTF-8`，解析成
`en`，文案变英文，三条断言全红。同一段代码在中文机器上永远绿、在 CI 上永远红 —— 这是测试
的隐式假设，不是产品缺陷。三处显式钉 `messageLocale: 'zh'`。

### Fixed · 测试的 root 未归一，在 macOS 与 Windows runner 上整机失效

五个套件都用 `mkdtemp(join(tmpdir(), …))` 当 root/D 工作区，而插件在 `agent/turn-stopping` 里
对 cwd 做 `canonicalCwd`（realpath）。两处偏差让 `insideCwd` 恒判否：

- **macOS**：`tmpdir()` 是 `/var/folders/…`，它本身是指向 `/private/var/…` 的符号链接。
  CI 日志里能直接看到成对的两行：插件记的是 `cwd=/private/var/folders/q2/…`，而测试写的是
  `/var/folders/q2/…`。
- **Windows runner**：`tmpdir()` 落在 `C:\Users\RUNNER~1\…` 这个 8.3 短名形态下，插件记的
  是 `C:\Users\runneradmin\…`。

后果是 `steers=0` 淹没几乎所有场景，连「1 正例」都不拦 —— 在 CI 上看起来像插件完全失效。
现在五个套件统一 `const root = await realpath(rootRaw)`。Windows/Linux 本机上 realpath 是
恒等变换，既有行为不变。

### Fixed · `planBackups` 被误改成 `lstat`，符号链接备份导致整族不产出 plan

0.8.0 修 `measureSizes` 的体积口径时（AUDIT 缺陷 M），顺手把 `planBackups` 里收集成员的
`stat` 也改成了 `lstat`，理由写的是「符号链接 `.bak` 白占 keep 名额」。这条**没有**在审查
报告里，是修 bug 时自己加的。

它是错的：`test/sim.mjs` 场景 11 原本就写明 `stat`（跟链）是刻意设计 —— 指向别处的 `.bak`
要**算作一个成员**，因为它确实占了「最近 keep 份」的一个名额，也因此该被列进清单让模型
看一眼。改成 `lstat` 后链接被 `!info.isFile()` 排除，`members` 少一个就可能掉到
`members.length <= keep`，于是整族不产出 plan：既不删该删的，也不再报链接。删除环节本来
就由 `pruneBackups` 的 `lstat + isSymbolicLink` 拒绝，那里才是该守卫的地方。已回退为 `stat`。

### Fixed · CI 前一步失败会把后面五个套件全 skip

GitHub Actions 默认在前一个 step 失败后跳过后续 step。`Behaviour simulation` 自 2026-11-14
`18b96b3` 起连续红 9 次（含 `6462a35`），于是 `web` / `client` / `report` / `tool-agnostic` /
`regress` 这五个套件在 CI 里**一次都没跑过**。七个测试 step 现在都带 `if: always()`：
一个套件红不该把其余证据一起吞掉。

### 顺带记录

这次核查的结论是「CI 自 2026-11-14 起就没有绿过」，最后一次 success 是 `da7be93`
（2026-11-11，v0.3.2）。失败全部集中在 `test/sim.mjs`，也就是唯一一个真正跑在 CI 里的套件。
本地一直绿是因为 Windows 非管理员建不了 file symlink，场景 11 走 SKIP —— 这个 SKIP 分支
本身是对的（区分「跳过了」和「失败了」），但它掩盖了 Linux 上真跑时的失败。

修完 `5892e4b` 的 CI（run `45728490518`）五个 job 全绿：`test (20/22/24)`、
`cross-platform (windows-latest)`、`cross-platform (macos-latest)`。逐 step 核对过，
七个测试 step 都是真的执行（各自有独立时间戳），不是被 skip 后算作通过。

**一个需要注意的数字差**：本机 `sim` 报 **82** 项，CI 报 **87** 项。差的那 5 项正是场景 11
的符号链接断言 —— 本机建不了 symlink 走一条 `SKIP`（计 1 项通过），runner 上真跑 6 项。
所以本地合计 258、CI 合计 263。看到本机比 CI 少 5 项是正常的，反过来才要查。
`test/sim.mjs` 里那 5 条符号链接断言现在在 CI 上真跑并通过（`alive=0,2,3`、
`steers=1`、链接目标未受影响），这是 0.8.0 那个 `lstat` 回归被真正堵住的证据。

## [0.8.0] - 2026-11-25

这一版没有新功能，是一次从头到尾的代码逻辑审查之后的集中修复。三轮只读审查共 72 条发现
（28 + 26 + 18），按 P0–P3 定级，全部处理完。下面按「会伤到用户的东西」优先排。

### Fixed · 会删错文件或丢数据

- **`prune` 模式会删掉用户文档（P0）。** `BACKUP_RE` 原来写成 `/\.bak(?:\..*)?$/`
  这类形状，于是 `README.bak.md` 被当成原件 `README` 的备份家族成员。同族够多时
  `prune` 会把它当超量备份 `unlink` —— 用户的文档。现在只认两种后缀：`.bak-<任意>`
  与 `.bak.<数字/时间戳/v<数字>>`，`README.bak.md` / `notes.bak.txt` 不再进任何家族。
- **`x.bak.bak` 曾能被并入 `x` 家族。** 家族判定改成 `backupFamily(name) === stem` 之后
  不再递归剥离，`a.txt.bak.bak` 的 stem 是 `a.txt.bak`，与 `a.txt` 不同族。
- **`keep: 0` 被静默夹成 1，等同于「只剩一份」。** 现在 0 / 负数 / NaN 一律回落默认 3。
  配错一个 0 不该变成「几乎全删」。
- **账本 `save()` 没有原子性（P0）。** 原来直接 `writeFile` 目标文件，进程中途被杀就是
  半截 JSON；下次 `load` 解析失败当空账本，再 `save` 就把历史永久抹掉（实测一次丢 40 条）。
  现在写 `同名文件.tmp-<pid>-<序号>` 再 `rename`，失败会 `unlink` 残留。
- **`load()` 有竞态（P0）。** 原来 `this.loaded = true` 写在 `await readFile` 之前，第二个
  并发调用者拿到空 `events`，随后 `recordGate` 与 `load` 交错时 `this.events = parsed.events`
  把刚落的新事件整块覆盖。现在用一个 Promise 当门（`this.loading`），幂等且只读一次盘。
- **坏账本一律静默覆盖。** 现在先 `rename` 成 `同名文件.corrupt-<ISO>` 留证，再以空账本
  继续；日志里说明发生了什么。

### Fixed · 会虚报或错报数字

- **`stat` 失败被当成「文件已删除」。** 网盘断连、`EACCES` 原先都进 `cleaned`，
  `cleanedBytes` 凭空涨、依从率冲到 100%。`probe()` 改成三态，只有 `ENOENT` / `ENOTDIR`
  算消失，其余进 `unknown`，且 `unknown` 不进依从率分母。
- **同一文件被两个通道重复计入 `preCleaned`。** 通道 2（消失的已记账路径）与通道 3
  （`reported` 主动上报）各记一次，同一个文件能进两次，已释放空间虚增一倍。去重键统一
  为 `rel` + `abs` 双记。
- **`measureSizes` 的 `limit` 让 `backupList` 一个都量不到。** 原来整份清单共用一个上限，
  临时件先占满，备份永远量不出体积。现在预算对半分。
- **`collectTouched` 的 mtime 容差是硬编码 1000 ms。** FAT32 / exFAT 的时间戳粒度是 2 秒、
  SMB 是 1 秒，1 秒容差在这三种盘上必假阴性——本轮真正写过的文件被当成老文件丢掉。
  新增配置 `mtimeToleranceMs`，默认 2000，夹 0..60000。
- **`scanTmpDir` 实际只报到第 2 层，文档写的是 4。** 深度语义修正为「根下文件算第 1 层」，
  `scanDepth: 4` 现在真的报到第 4 层。
- **`preCleaned` 明细会无限增长。** 一轮清上千个文件时账本被撑爆。现在只存前 100 条，
  余量折成 `preCleanedOmitted` / `preCleanedOmittedBytes`，总量口径不变。

### Fixed · 会卡住或拖慢每一轮

- **`turn-stopping` 里 `await` 记账。** 宿主对 `agent/turn-stopping` 是 `dispatch.serial`
  串行 `await`（`dsh-agent-loop` 里搜 `dispatch.serial('agent/turn-stopping'`；0.2.2-rc.2 在
  `lib/index.js:809-816`，行号随版本漂移），插件在里面 `await record()` +
  `measureSizes()`（200 次串行 `stat`）等于把每轮退出拖长。现在记账走内部串行队列
  `recordChain`，9 处调用全改 `void record(...)`。
- **`measureSizes` 串行 stat。** 200 个文件逐个 `await` 改成 16 条一批 `Promise.all`。
- **徽章在 `followup` 模式下永远停在「待复核」。** 记录写的是 `verifyAtTurn = turn + 1`，
  但客户端的 `useEffect` deps 只有 `[sid, turnNo]`，到下一轮时组件没重取。`TurnBadge` 改成
  有限次退避重取（2 s / 5 s / 10 s / 20 s），带 `clearTimeout` 清理。
- **面板的会话下拉恒只有一个选项、对比表恒隐藏。** `bySession` 原来由**过滤后**的事件聚合，
  `?scope=session` 时只剩一行。现在恒基于全量事件，新增 `sessionCount`（`sessions` 是别名）。
- **`fs/observed` 的 async 监听器与 `delete-intent` 抢同一份 `s.paths`。** 读文件也会发
  `fs/observed`，一次晚到的 `stat` 会把刚记下的体积覆盖成旧值。现在用 CAS：写回前比对
  `s.paths.get(abs)` 是否仍是进函数时那个值。

### Fixed · 配置与路径

- **`tmpDirName` 含反斜杠时约定目录通道恒失效。** 原代码用 `${cfg.tmpDirName}/` 直接和
  `toPosix(rel)` 比，`tmp\agent` 永远匹配不上。`normalizeConfig` 现在先归一成 posix；
  绝对路径 / 盘符（`D:\x`、`/tmp/x`）一律回落 `.agent-tmp`，不再让约定目录跑到工作区外。
- **`.agent-tmp` 的前导点曾被剥掉。** 归一逻辑现在保留前导点（曾归一成 `agent-tmp`）。
- **`maxLogPaths` / `maxSteerPaths` / `scanDepth` 传小数会进 `slice` 报错或行为诡异。** 全部
  `Math.floor` 并夹范围。
- **`statsFile` 相对路径的基准写错了。** 现在显式 `resolvePath(process.cwd(), …)` 并加注释：
  账本是全机一本，基准是进程 cwd 而不是会话 cwd。
- **`globToRegExp` 只匹配 basename，用户写带目录的模式永不命中。** 配置表已写明「匹配的是
  basename」，文档与实现对齐。

### Fixed · 路由与面板

- **`/turn-cleanup/stats` 不校验 method。** 宿主按 path 派发、任何 method 都会进 handler。
  现在非 `GET` / `HEAD` 一律 405 + `allow: GET, HEAD`。
- **`500` 把内部异常文本回给浏览器（等于暴露账本路径）。** 现在只回固定文案
  `stats unavailable`，完整堆栈进 `logger.warn`。
- **缺字段的事件让 `summary()` / `turnRecord()` 抛 `TypeError`，面板永久 500 白屏。**
  `normalizeEvent()` 按白名单重建每条记录，坏记录直接丢弃；`load()` 也兼容 v2 无 `verify` 键
  的旧账本。
- **`turn=` 非法时回 200 + `null`。** 现在是 400。
- **`client.js` 的 `catch` 把 `stats` 置 `null` 导致整页清空。** 现在保留上一次结果并显示
  错误提示；`select` 的 value 改用 `effectiveSid`（原先下拉空白但数字是全量）；tooltip 的
  `badgeTurn` 进 `DICT`，不再硬编码英文。
- **`prune` 的 `catch {}` 吞掉所有 `unlink` 失败。** `pruneBackups` 现在返回
  `{ deleted, failed, hitLimit }`：失败的进 `failed`（带 `error.code`），撞上限时 `hitLimit`
  为真且**不中断其余家族的处理**，两者分别落 `prune-failed` / `prune-limit` 日志。

### Fixed · 统计链路（`AUDIT-logic.md` A/B/C/K/L）

这一组有一个共同根因：**`(sid, turn)` 不是唯一键，而 `followup` 让 `turn` 与 `verifyAtTurn`
错开一轮。** 两者单独看都成立，叠在一起就让同一条 gate 事件和下一轮的 auto 事件抢同一个
复核点。

- **`verify()` 只复核最后一条匹配事件（A）。** 原来循环里 `target = event` 一路覆盖，同轮
  后写的 auto 事件（`verifyAtTurn: turn`）把上一轮 gate 事件（`verifyAtTurn: turn + 1`）顶掉，
  那条 gate 永远停在 `verify === null` —— 面板「待复核」计数只涨不落、依从率分母偏小。
  现在收集**全部**待复核事件逐个复核、`save()` 整批一次落盘。没有对 auto 做特殊排除：
  auto 本来就没有 `temps`/`backups`，探针空转一次就得到「已复核的空结果」，成本可以忽略。
- **`turnRecord()` 把上一轮清单串进本轮徽章（L）。** 匹配式同时认 `e.turn === at` 与
  `e.verifyAtTurn === at`，于是 turn N 拦下的清单会以「turn N+1 的徽章」出现。默认 `followup`
  模式下每条拦截后**必现**：干净轮显示「3 个临时件待复核」。现在把命中事件切成 `own`
  （本轮自己的）与 `carried`（上一轮带来复核的），只累加 `own` 的清单；返回值新增
  `own` / `carried` 两个字段。
- **`turnRecord()` 把 gate 与 auto 聚合、`kind` 被改写（C）。** 原来遍历里
  `if (e.kind === 'auto') kind = 'auto'`，只要命中集合里有 auto 就改写整轮的 `kind`。现在
  `kind` 只由本轮自己的事件决定（`ownGate ? 'gate' : own.length > 0 ? 'auto' : 'gate'`）。
- **「最近记录」去重方向反了（B）。** 原来从尾部倒序扫、同轮只留最后一条，而 auto 通常晚于
  gate 写入 —— 恰恰把真正拦过的那条挤掉。改成按 `(sid, turn)` 归并、同轮优先留 gate，再取
  最后 20 轮。
- **「拦截次数」把没拦的轮也算进去（K）。** `gates: all.length` 数的是事件条数，auto 轮也涨；
  连带 `stats.gates === 0` 判断的「还没有拦截记录」提示**永不出现**。现在 `gates` 只数
  `kind !== 'auto'` 的事件，另加 `autoRounds` / `events` 两个字段把口径拆开（`events` 保留原
  `all.length` 语义，读旧字段的地方不受影响），`bySession` 行的 `gates` 同步修正，面板的
  noData 判定改为「`gates === 0 && preCleaned === 0`」。

### Fixed · 路径与体积（E/M）

- **含空格的路径被切碎（E）。** 原来 `raw.split(/[\s;&|()<>]+/)` 先切、`unquote()` 只剥单个
  token 的引号 —— 引号在切分前就没了。`rm -f "C:\Users\John Doe\a.txt"` 切成
  `C:\Users\John` 与 `Doe\a.txt`，两段都 stat 不到；`cd "…/my dir" && rm x` 的 base 同样被切坏。
  Windows 用户名带空格是常态，后果是「已释放空间」系统性少报。现在新增 `shellTokens()`
  引号感知分词（单/双引号状态机，空白与 `;&|()<>` 为分隔符），明确不展开 `$VAR`、不处理
  反斜杠转义 —— 只在「路径出现在命令串里」时用，够用即可。
- **`measureSizes` 用 `stat` 记账（M）。** `stat` 跟随符号链接，链接目标的体积被记成「删掉
  链接能腾出的空间」；硬链接（pnpm store、`cp -l`、Git worktree）删掉一个名字根本不释放
  字节，却按整份 inode 计入。实测一条 5 MB 硬链接显示 `cleanedBytes = 5242880`，实际 0。
  现在改 `lstat`，`isSymbolicLink()` 或 `nlink > 1` 一律记 0。`planBackups` 的成员收集同步改
  `lstat`：符号链接 `.bak` 白占一个 `keep` 名额会把真备份挤进 `excess`。

### Fixed · 中断与配置（G/J/H/N）

- **`turn-stopping` 不读 `signal`（G）。** 宿主在派发前后都 `throwIfAborted()`，而插件在用户
  按 Esc 之后仍会跑完 `scanTmpDir` + 每通道 `stat` + `planBackups` + `pruneBackups` +
  `measureSizes`，最后还 `followup` 唤醒下一轮。现在解构 `signal` 并在 6 个位置检查：
  入口、`canonicalCwd` 后、`scanTmpDir` 后、**prune 之前**（唯一不可逆动作）、记账之前、
  发消息之前。刻意不用 `signal.throwIfAborted()` —— 它抛的 `AbortError` 会被外层 `catch`
  记成 `gate error`，把用户主动中断污染成插件故障日志。
- **相对 `logFile` 跟会话 cwd 漂移（J）。** 与 `statsFile` 显式用 `process.cwd()` 的基准不一致，
  多会话会把日志写散到不同目录。保留原解析（改成 `process.cwd()` 会让已有配置换位置），但
  每个**首次出现**的绝对路径打一行 `dsh-turn-cleanup: log file=<abs>`，事后可从进程日志查全集。
- **`targetPath` 只认 `targetKey`（H）。** 宿主 `dsh-fs-local` 恒给 realpath 过的 `targetKey`，
  但第三方工具 / 自定义 fs 实现 / 手工构造的 target 可能只填 `displayPath` —— 判空返回
  `undefined` 会让写入侧一个路径都记不到、本轮临时件**全部静默漏报**。现在 `targetKey` 缺失
  时依次回退 `displayPath` / `path` / `filePath` / `file_path` / `absPath`，拿未归一路径让
  `insideCwd` 兜。
- **占位 `undefined` 体积静默按 0 计入（N）。** 写入侧先 `set(abs, undefined)` 占位、等
  `fs/observed` 回填；`dsh-ops` 这类不发 `fs/observed` 的工具就永远回填不上。不改记账（0 是
  唯一可得的答案），在 `cardReportedHint` 补一句「个别未采到体积的按 0 计」。
- **`cardComplianceHint` 没说清分母（F）。** 补「只算已复核的轮次」—— 未复核事件不进分母，
  否则「拦了但永远没复核」的会话也拿 100%。

### 不改的两条（`AUDIT-logic.md` D/I）

- **`state`/`tripped` 残留（D）。** 核过宿主：`abort` 与 `error` 都会在 `finally` 里 append
  `turn/end`，只有进程崩溃或 `sessions-quarantine` 才残留；残留纯内存、不落盘、重启即清。
  改成 `WeakMap<session, Set<turn>>` 要动 `tripped` 的键格式，收益不抵风险。
- **无熔断（I）。** 模型连续多轮不配合时闸门不会自我收敛（同一路径每轮都拦）。这是设计
  缺口不是 bug：加 `strikes` 阈值会改变插件对外行为语义（什么时候放弃拦截、放弃后账怎么记），
  需要单独设计，不夹在修缺陷里做。

### Added

- 配置 `mtimeToleranceMs`（默认 2000，0..60000）。
- 账本 `version: 4`：`emptyVerify()` 增 `unknown` / `unknownTemps` / `unknownBackups`；
  `summary()` 增 `unknown` 与 `sessionCount`；`turnRecord()` 同时按 `turn` 与 `verifyAtTurn`
  匹配（修 `followup` 模式下徽章取不到记录）。
- 日志 `prune-failed` 与 `prune-limit` 两行，形状见 README「日志」一节。
- `trim()` 超 1000 条时**优先丢已复核过**的事件，保留还能被复核的。
- `summary()` 增 `autoRounds` 与 `events` 两个字段（`gates` 改口径的配套，见上）；
  `turnRecord()` 增 `own` 与 `carried`（徽章不再串轮）。
- 测试从 57 / 32 / 48 / 31 / 17 涨到 **82 / 42 / 48 / 43 / 17 / 26**（合计 258 checks）：
  备份家族识别、`keep: 0`、`x.bak.bak`、`scanDepth` 深度与越界、`tmpDirName` 归一、
  `mtimeToleranceMs`、`maxPrunePerTurn`、路由 405 / 400、`bySession` 会话视图、账本并发
  `load`、坏账本隔离，以及第六套 `test/regress.mjs` 专收 `AUDIT-logic.md` 里**在别的套件
  构造不出来**的反例。CI 的 cross-platform job 补上 web / report / tool-agnostic / regress 四步。

### 为什么测试没拦住

三条 P0 全在测试的盲区里，共同形状是**测了「正常路径产出什么」，没测「异常路径毁掉什么」**：

- `README.bak.md` 被删：所有备份家族测试都用 `makeFamily()` 造 `.bak-v<n>`，从来没有
  「名字里带 `.bak` 但不是备份」的样本。补的断言是「`.bak.md` 仍在 + 同族只留 keep 份」，
  把 `BACKUP_RE` 改回旧形状立刻红。
- 账本被抹掉：所有账本测试都是「写完读回来」，进程没在中途被杀过，也就没有半截 JSON。
  补的断言直接写一段截断 JSON 进 `statsFile`，验「不抛 + 留下 `.corrupt-` + 能继续追加」。
- 并发 `load` 丢事件：测试全程是 `await` 串行的，`recordGate` 与读盘从不重叠。补的断言用
  `Promise.all` 同时发三条 `recordGate`，并验 `load()` 两次返回同一个 Promise 身份。

另一组（A/L/C/B/K/E/M）的盲区是**组合**，不是分支：232 条断言里没有一条同时构造
`gate(N)` + `auto(N+1)`，于是「同轮两个事件抢一个复核点」「同轮去重留谁」这两种交互一次都
没被跑到；也没有一条用例让 cwd 含空格，`shellTokens` 与旧 `split` 的差别无从暴露；`auto`
事件从来只断言 `kind`，不问 `gates`。`test/regress.mjs` 的 26 条就是照这三个缺口长的：
把六处修复逐一退回旧行为后，它会红 14 条（`12/26`），且失败详情与审查报告的症状逐字吻合 ——
这条反向验证比「改完还是绿」更能说明测试确实卡在缺陷上。

另外两条是「文档和实现对不上但都自洽」：`scanDepth` 文档写 4、实现只到 2；`tmpDirName`
文档说相对 cwd、实现没做归一。这类只有把断言写成「第 4 层命中、第 5 层不命中」和
「反斜杠输入命中 posix 路径」才会红。

## [0.7.3] - 2026-11-25

0.7.2 把「最近记录」的释放体积改成喂整行 `freedBytes(row)`，但 0.7.2 那天没说清的一件
事：`recent[]` 这一行**根本没有顶层 `cleanedBytes`**。

`lib/stats.js` 构造 `recent[]` 时只写了 `preCleanedBytes`，`cleanedBytes` 只存在于
`row.verify` 里；`bySession[]` 和单轮记录都是两份都写。而 `lib/client.js` 的
`freedBytes(row)` 读的是 `row.cleanedBytes + row.preCleanedBytes`——

```js
const cleaned = typeof row?.cleanedBytes === 'number' ? row.cleanedBytes : 0
```

`undefined` 被 `typeof` 挡下，静默变 0。于是「释放」列其实只显示了模型自己先清掉的那半。

现在看不出来，是因为当前账本 recent 20 行的 `verify.cleanedBytes` 全是 0：模型几乎总在
复核之前就把临时件删了，闸门去 stat 时只剩空目录，`cleaned` 自然记 0。但只要有一轮闸门
真的核到了被删的东西（例如 `prune` 模式删掉的备份），那一行就会少算，而且少得无声无息
—— 这正是 0.7.2 修掉的那个「只取一半」的形状，只是换了个方向。

### Fixed

- `recent[]` 每行补顶层 `cleanedBytes: Number(e.verify?.cleanedBytes) || 0`，与
  `bySession[]`、单轮记录三处口径统一。面板「释放」列从此 = 闸门核到已消失的 +
  模型抢在复核前自己删的。

### 为什么测试没拦住

`test/web.mjs` 只断言了 `recent[0].verify.cleanedBytes === 1`，没断言行顶层有没有这个
字段——测的是「verify 里有」，而面板读的是「行里有」。现在补一条
`recent 行顶层带 cleanedBytes 与 preCleanedBytes`；`test/client.mjs` 补一条
`recent 行的释放体积 = 行顶层 cleanedBytes + preCleanedBytes`（喂 `cleanedBytes: 2419`
+ `preCleanedBytes: 105953`，断言渲染出 `108372`），锁住「两个加数都要算」。
把 `lib/stats.js` 的改动 stash 掉，web.mjs 立刻红：
`FAIL recent 行顶层带 cleanedBytes 与 preCleanedBytes — {"preCleanedBytes":0}`。

## [0.7.2] - 2026-11-21

两个都是「数据对、界面不对」和「代码在、时机不对」的错，共同点是**测试把要验证的前提
自己写死了**。

### Fixed

- 「最近记录」的释放体积恒显示 0。`recent[]` 每行是
  `{ at, kind, turn, sid, preCleaned, preCleanedBytes, cleanedBytes, verify }`，
  `preCleanedBytes` 在**行顶层**；`verify` 只装复核那一刻的
  `{ cleaned, remaining, cleanedBytes, remainingBytes }`。面板里那句
  `freedBytes(r.verify)` 读的是没有该字段的子对象，于是永远 0。这不是某个会话的
  个别现象：本机账本 recent 20 行全部如此，最大一行 `preCleanedBytes = 241948873`。
  而模型手脚越快、复核时文件早已不在，就越是必然命中——会话 bfdc2247 turn 21 那
  105953 B 就是这样被吞的（后端三个端点全返回它）。现在「复核」列只留
  「已清 N / 仍在 M」，新增独立「释放」列喂整行；导出 `RecentTable` 供测试直接渲染。
- client 半边没进 boot graph，面板永远是旧代码。日志里 40+ 行
  `client entry check: clientModules service absent` 横跨 11-11 到 11-21，中间只夹着
  6 次 present。服务一直都在、`/plugins` 路由也一直挂着（非 GET 拿 405，404 来自
  responses 表里没有那条 URL）。根因是 cordis 4.1.0 的 `ctx.get(name)` 就是
  `ctx.reflect.get(name, strict = true)`，而 `_getImpl` 里
  `if (strict && impl.ctx.fiber.state !== 2) return` —— **只返回提供者 fiber 已 ACTIVE
  的实现**，value 早就 provide 了也照样 undefined。本插件随 profile 装，`apply`
  必定早于 clientModules 走到 state 2，所以冷启动恒 absent；偶发那几次 present 是
  HMR 重跑 apply（那时已 ACTIVE）。改 `ctx.inject(['clientModules'], (sub) => …)`
  等就绪再干活，子 fiber 依赖不满足只让它自己不加载，闸门本体不受影响。
- 同一个坑还吃掉了上报工具：`if (ctx.get('tools') !== void 0)` 冷启动恒 false →
  `report_temp_cleanup` 静默不注册（日志 46 次 `apply` 只配到 2 次 `report`）。
  两处都改成只判 `typeof ctx.inject === 'function'`，交给 inject 等。

### 为什么测试没拦住

`test/client.mjs` 只测纯函数 `freedBytes`，不看渲染树；`test/web.mjs` 的假 ctx 只桩了
`get()` 且**永远返回完整服务**，等于把「服务随时可读」这个被测前提写死了。现在补
`flatten()` 摊平渲染树做体积断言，另加冷启动现场 `ctx3`：`get()` 故意恒返回
`undefined`（模拟已 provide 但未 ACTIVE），断言那时仍会 dirty + flush 一次。

## [0.7.1] - 2026-11-16

0.7.0 的通道 4 把 `tool/result` 的采集排进了异步链：

```js
s.chain = s.chain.then(() => collectTouched(ctx, session, s, found)).catch(() => {})
```

监听器本身是同步返回的（宿主 `invokeContainedSessionObservers` 只做
`Promise.resolve(returned).catch()`，不 await），所以这句只把工作塞进微任务队列就返回了，
**工具本体紧接着执行**。对 `rm -f x` 来说，等微任务真正跑到 `collectTouched` 时文件已经没了，
`lstat` 抛 ENOENT，体积永久丢失。

这不是理论问题：`npm test` 连跑五次得到 `17/17, 15/17, 17/17, 15/17, 17/17`，
失败恒为场景 3（cwd 之外的删除也计入已释放）。差一次 `console.log` 的时间就能让它通过 ——
典型的时序竞态。

### Fixed

- `collectTouched` 改为**全同步**：`lstat` → `statSync`，`canonicalCwd` → `canonicalCwdSync`
  （新增，用 `realpathSync`）。函数不再是 `async`，`tool/result` 分支直接同步调用它，
  不再经过 `s.chain`。同步调用与工具本体在同一个 tick 里，`rm` 删得再快也抢不过。
- 删掉 `s.chain` 这个状态字段与 `turn-stopping` 里的 `await pending.chain`：
  采集既然同步，就不存在「半截数据」，那句等待已经是空转。
- `snapshotTouched`（0.7.0 加的 `tool/call` 同步快照）保留 —— 它负责「删除发生在本轮中间」的
  情形，与 `collectTouched` 的「还在的文件」互补，两条路都要。

代价：`tool/result` 监听器里多了几次同步 IO。清单有上界（`MAX_TOUCHED_PATHS = 200`），
且只在模型真的调了工具时触发，实测无感。

### 验证

`test/tool-agnostic.mjs` 连跑 20 次全部 17/17；`npm run verify` 连跑 3 轮全部
`57 + 27 + 43 + 31 + 17 = 175` 全绿。

## [0.7.0] - 2026-11-16

0.6.x 的采集全靠 `fs/*-intent`。这套钩子**只有 `dsh-tool-fs` 与 `dsh-tool-str-replace-editor`
会发** —— `dsh-ops` 一条都不发（`ops_write_file` / `ops_bash` 直接走它自己的执行层），
第三方插件、用户自己写的工具更不会有。真实会话里 `ops_write_file` 的出现次数与 `write`
相当，于是「清了临时文件但面板没变化」成了常态：

```
session-77f00ae4 turn 2:  cd "$TEMP" && rm -f hydra.out repairpatch.js
```

这两个文件既在 cwd 之外、名字也不符合临时件模式，两条老通道都看不见。

### Added — 通道 4：与工具无关的采集

不认工具名、不认参数键名，只认 `session/event` 里的 `tool/call` + `tool/result`。
宿主对**每个**已提交事件都同步派发 `(session, event)`（`collectSessionCallbacks` →
`invokeContainedSessionObservers`），这是唯一不依赖具体工具实现的立足点。

- `tool/call` 时把实参里所有像路径的字符串捞出来：递归扫值、跳过 `content` / `text` /
  `patch` 之类的正文键；命令串按 `[\s;&|()<>]+` 切开，并跟踪 `cd` / `pushd` 换基准目录
  （用户自己的清理脚本几乎总是 `cd <目标目录> && rm -f <相对名>`）。
- `tool/result` 时对每个候选 `lstat`，**mtime 在本轮开始之后的**才算「本轮碰过」。
  读文件不改 mtime，写文件一定改 —— 这条判据把 `read` / `grep` / `glob` 顺手扫到的老文件
  全挡在外面，不需要知道调用的是哪个工具。容差 1 秒防 mtime 精度与时钟回拨的假阴性。
- 分两本账：`s.paths`（cwd 内 + mtime 是本轮的）进 steer 清单；`s.foreign`（cwd 之外）
  只记账、**永不进 steer 清单** —— 工作区之外的东西不该由插件指挥模型去删，但删掉了多少
  空间照样该算。

### Fixed — 「写完又立刻删」的体积丢失（真实竞态）

`tool/call` 那一刻必须**同步**拍一次体积快照，`statSync` 而不是 `await lstat`。
宿主的 `invokeContainedSessionObservers` 只做 `Promise.resolve(returned).catch()`，
**不 await 监听器**，工具本体在监听器返回后立刻执行；`rm -f x` 从发起到删完只有几毫秒，
任何 `await` 都会让快照落在删除之后。这条正是 `test/tool-agnostic.mjs` 场景 3/5
「加一行 `console.log` 就从 FAIL 变 PASS」的原因 —— 不是测试不稳，是产品有竞态。

快照进 `s.touched`，只用于记账，**不进 steer 清单**：这里没有 mtime 过滤，`read` 顺手
看一眼老临时件也会被拍进来，拿它指挥模型删文件就会误伤。

### 测试

新增 `test/tool-agnostic.mjs`（17 项），覆盖：不发 intent 的写入被记账、只读老文件不被
叫去删也不计入、cwd 之外的删除计入已释放但不打扰模型、不发 intent 的残留照样拦、
命令串里 `cd` + `rm -f` 的多个文件都记到且字节合计正确、实参被截断时不抛。

`npm run verify` → `57 + 27 + 43 + 31 + 17 = 175` 全绿。

## [0.6.1] - 2026-11-14

0.6.0 把体积的测量点挂在 `fs/write-intent` 上，实测**永远是 0**。根因是宿主里这个
waterfall 的 `next` 是个空操作，真正写盘发生在其后：

```js
// dsh-tool-fs 的 write 工具
const intent = await ctx.waterfall("fs/write-intent", target, exec, () => void 0);
outcome = await ctx.fs.writeText(target, input.content, intent, ...);   // ← 文件到这里才存在
return mutationResult(ctx, target, outcome, exec);                      // ← 这里才 emit fs/observed
```

插件在 `await next()` 之后 `lstat`，那一刻文件还没落盘，量不到 → 记 0。`edit` 同理
（`dsh-tool-fs` 的 `fs/edit-intent` 也是空 `next`）。只有 `fs/delete-intent` 因为传了
`sizeBefore=true`（在 `next()` **之前**量）一直是对的。

### Fixed — 体积改挂 `fs/observed`

- 新增 `ctx.on('fs/observed', ...)`：宿主工具在**写入成功之后**才 emit 这个事件
  （`dsh-tool-fs` 的 `write`/`edit` 都走 `mutationResult`；`dsh-tool-str-replace-editor`
  写完后也发同形 payload），此时 `lstat` 才拿得到真实大小。
- **只给「本轮已经有 intent 记过的路径」补体积**：`fs/observed` 在读文件时也会发
  （`str_replace_editor` 的 `view`、`tool-fs` 的 `read`），payload 与写入后**完全同形**，
  无法从事件本身区分。若无条件写入，读一个早就存在的 `probe-*.mjs` 就会被当成本轮写过的
  临时件，下一轮闸门会叫模型去删一个它只读过的东西。intent 才是「动过手」的证据。
- `fs/*-intent` 只记路径，体积留 `undefined`（**未知 ≠ 0 字节**）。之前把未知写成 0，
  会让「没量到」和「确实是空文件」在账本里长得一样。

### 测试

- `test/sim.mjs` 与 `test/report.mjs` 的写入序列改为照抄宿主真实顺序：
  `emitWaterfall(intent)` → `writeFile` → `emitPlain('fs/observed', {kind:'present'})`。
- 新增场景 9：A 只发 intent 不发 observed 再删（体积只能是 0）；B 走完整序列写 64 B 再删
  （体积必须是 64）；C 只发 observed 不发 intent（不能被当成本轮写过的临时件）。这三条
  正是 0.6.0 线上失败的复现。
- `npm run verify` → `57 + 27 + 43 + 31 = 158` 项全绿。

## [0.6.0] - 2026-11-14

「已释放空间」这张卡从上线起就一直显示 0 B。不是统计坏了，是**量错了地方**：账本只认
「插件发现残留 → 复核确认消失」的那部分，而实测下来模型几乎总在 turn 结束前就自己
`rm -f` 删干净了 —— 闸门去 `stat` 的时候文件早就不在，于是永远没有可计入的字节。

这次把口径改成「**本轮碰过、到 turn 结束时确实不存在的文件，都算已释放**」，并给模型一个
主动上报的通道，把「用 shell 删掉、插件根本看不见」的那部分体积也捞回来。

### Added — `report_temp_cleanup` 工具

- 模型删完临时件后调一次，把路径与字节数报上来，插件据此记账。
- **为什么必须有它**：模型删临时件最常用的手段是 `rm -f` / `Remove-Item`，走子进程，
  不触发 `fs/delete-intent`；等闸门去 `stat`，文件没了，体积永久丢失。模型自己删的时候
  明明知道删了什么、多大 —— 让它顺手说一句，是唯一不靠猜的补法。
- **只在确实已不存在时才采信**：上报后仍 `stat` 得到的文件不计入已释放，防止虚报。
- **不硬 `inject: ['tools']`**：那会让插件在缺该服务的 profile 里整个不加载，闸门跟着
  一起消失。改成软探测 + 可选注入，拿不到就退化成「没有上报工具，靠 `stat` 猜」。
- **不 import `@deepseek-ai/dsh-tools`**：`ctx.tools.register()` 接受裸 JSON Schema，
  `defineTool` 只是帮忙编译作者侧 DSL。传裸 schema 就能保持零运行时依赖。
- 闸门文案只在工具**真的注册成功**后才提它 —— 让模型去调一个不存在的工具比不给提示更糟。

### Changed — 「已释放空间」= `cleanedBytes + preCleanedBytes`

- 账本升到 **v3**，事件多一个 `kind`（`gate` / `auto`）与 `preCleaned: [{rel, size}]`。
- 体积在**写入那一刻**就记下（`fs/write-intent` / `fs/edit-intent` 在 `next()` 之后量，
  `fs/delete-intent` 在 `next()` 之前量 —— 之后文件就没了），`state.paths` 从 `Set<abs>`
  升级为 `Map<abs, bytes>`。
  **（这条在 0.6.1 被证伪：宿主的 `fs/write-intent` / `fs/edit-intent` 的 `next` 是空操作，
  真正的写盘发生在其后，所以那时量不到体积。已改挂 `fs/observed`。）**
- turn-stopping 分流：还在的进候选清单照旧提醒模型；**已不在的记 `preCleaned`**。
  两者都用 `preSeen` 去重，避免同一个文件既算待清又算已清。
- 没有需要提醒的东西、但本轮确实清掉过 → 记一条 `kind: 'auto'` 的账，**不打扰模型**，
  只在日志留一行 `auto session=... preCleaned=N bytes=N`。
- 面板第五张卡改用 `freedBytes(row) = cleanedBytes + preCleanedBytes`；按会话表、
  最近记录、turn 徽章同步。

### 兼容

- v1 / v2 账本照常读：缺 `kind` 按 `gate`、缺 `preCleaned` 按空数组，体积按 0 计。
- `stats: false` 时上述全部不启用，闸门行为与 0.5.0 一致。

## [0.5.0] - 2026-11-14

面板能回答「到底腾出了多少空间」了。此前账本只记路径、不记字节，「清掉了 12 个文件」和
「清掉了 12 个 3 GB 的镜像」在面板上长得一模一样。

### Added — 体积统计

- **账本升到 v2，每条事件多一个 `sizes: {rel: bytes}`**，复核时分流出 `cleanedBytes` /
  `remainingBytes`。汇总、按会话、最近记录、单轮记录都带上了字节字段。
- **面板第五张卡「已释放空间」**（`fmtBytes` 进位到 B/KB/MB/GB/TB，3 位有效数字），
  按会话表多一列「释放」，turn 徽章多一段「释放 X」。旧账本（v1）读出来体积按 0 计，不崩。

### 为什么只量「消失的那部分」

「报出去多少」不是用户想看的数字——报出去但模型没删的，磁盘一点没省。所以闸门只负责给
清单里的条目记下 `stat().size`，真正累加发生在复核：确认已消失才计入 `cleanedBytes`。
`prune` 模式自己删掉的备份没有复核环节，大小取**删除前**的 `lstat().size`（删完再问就没了）。

### 为什么不在扫描时顺手量

`scanTmpDir` 跑在 `agent/turn-stopping` 这条串行 await 上，每多一次系统调用就多一分
turn 边界延迟，而绝大多数用户从不打开面板。体积是「读面板的人才看」的数据，所以量体积放在
闸门最后、只在 `stats` 打开时做，并用 `MAX_MEASURE_FILES = 200` 封顶：配置被调到极宽时
宁可少报几个字节，也不要在 turn 边界上排队几百次 `stat`。目录不计入（`isFile()` 才记）。

## [0.4.0] - 2026-11-14

可移植性修复：把「在作者这台机器上成立」的默认值、路径判定与安装说明，改成在别人机器上
也成立。全部改动都由一次针对性的可移植性审计驱动，每一条都有可复现的现场。

### Fixed — 会误伤别人的默认值

- **默认 patterns 去掉裸 `check*` / `bench*`，改成要求分隔符的 `check-*` / `check_*` /
  `bench-*` / `bench_*`**。匹配对象是**文件名**（不是路径），裸前缀会把正常业务代码一起吃掉：
  `checkout.js`、`CheckoutService.ts`、`checklist.md`、`benchmark.ts` 全部命中，于是模型每写
  一个正常文件都会被要求删除。改成带分隔符后，本来要抓的 `check-1.sh` / `bench_gpu.py` 仍命中。
- **默认保护段去掉 `.tmp-sessions`，补上各生态通用构建目录**（`.git` / `node_modules` /
  `out` / `dist` / `build` / `target` / `vendor` / `.venv` / `__pycache__`）。`.tmp-sessions` 是
  作者本机的临时会话目录，宿主 326 个包里 0 命中 —— 把本机约定写进默认值，在别人机器上只是
  一个永不适用的名字。
- 保护段改为可配 `protectedSegments`：显式给数组**整体替换**默认值（不是追加，否则用户没法
  取消某个默认保护段）。

### Fixed — 会静默漏报的路径判定

- **`insideCwd()` 现在先用 realpath 归一 cwd**。写入侧路径来自 fs 服务（`dsh-fs-local` 用
  realpath 后的值），而 `session.header.cwd` 是会话创建时的原始字符串。两者只要差一个符号
  链接 / Windows 短名（`PROGRA~1`）/ macOS 的 `/tmp`→`/private/tmp` / 大小写，`relative()` 就会
  算出 `../..`，本轮的临时件**全部静默漏报**。已用 NTFS junction 复现。
- **运行时 cwd 改为优先读 `workingDirectory` 服务**。`session.header.cwd` 只在会话创建时写一次，
  模型跑 `working_directory(cd: ...)` 之后不会更新 —— 只看 header 的话闸门会一直守着旧目录。
  该服务是**可选**的，所以用 `ctx.get('workingDirectory')` 试探而不是加进 `inject`（加了会让
  headless profile 整个不激活），取不到就退回 header。

### Fixed — 看不见的写入

- **三个 intent 事件都挂上**：`fs/write-intent`（新建/覆盖）、`fs/edit-intent`（原地改）、
  `fs/delete-intent`（删除）。此前只挂 write，模型用 `edit` / `str_replace` 造出来的临时件在
  通道 2 里完全看不见，只能靠 tmp 目录扫描和 `*.bak-*` 兜。delete-intent 记进来的路径在
  `stat()` 那步自然失败 → 跳过，不会误报已删除的文件。

### Fixed — 把作者的语言环境当成普遍默认

- **注入文案不再硬编码中文**。新增 `lib/messages.js`（zh / en，纯函数、无依赖）与配置项
  `messageLocale`（`auto` | `zh` | `en`，默认 `auto`）。`auto` 的回退链是
  `DSH_LOCALE` / `LC_ALL` / `LC_MESSAGES` / `LANGUAGE` / `LANG` → 系统区域设置（`Intl`）→ `en`。
  这段文字是**直接注入模型回合**的指令，不是 UI 装饰，非中文用户每轮都会多撞一条中文命令。
  没用宿主语言服务，是因为宿主侧没有任何「当前语言」API 能在 turn-stopping 里廉价读到。
- 消息对象补 `source.form = 'notice'` 与 `source.summary`，与宿主自己的 `modelSwitchNotice()`
  对齐。`source.kind` 仍然不自称 `user` —— 宿主有若干处把 `source.kind === 'user'` 当人类授权
  （`dsh-tool-goal` 的 `hasDirectHumanInput()`）。

### Fixed — 装不上 / 声明了没人读

- **`cordis.patch.yml` 收成两行纯 insert**。市场的「装完即用」靠热挂载实现：它把 patch 里的
  insert 行重放进当前组合，让插件和它的面板不重启就上线。而 `dshmarket/lib/hot.js` 的
  `scanPatch()` 只认 `id` / `name` / `config` / `disabled`，碰到别的键就整份拒绝 —— 0.3.x 的
  `inject: []` 排在 `config:` 前面，正好撞上 `blocker: 'other'`，于是用户点完安装看到的是
  「需重启」。现在条目只有 `id` + `name`，全部默认值交给 `normalizeConfig()` 兜底
  （缺键即默认值），热挂载 `blocker: null`，装完立刻生效。想改默认值仍可用列 0 的顶层行合并。
- **`engines.dsh` 移到顶层**。兼容闸门（`dsh-app-boot` 的 `unmetRequirements()`）读的是
  `fields.engines.dsh`，没有才退到 `peerDependencies`；0.3.x 写在 `dsh.engines.dsh` 下面，
  **那个位置从来没人读**，所以那条声明既拦不住也不会告警，等于没写。0.4.0 放到正确位置，
  市场的预判闸门（`dshmarket` 的 `peerGateAt()`，注释写明「own `engines.dsh` decides ALONE」）
  与宿主 boot 闸门从此读同一个字段。
- **安装说明改写**。0.3.x 让用户 `add dsh-turn-cleanup`，而当时包没发布到 npm（`npm view` →
  E404），任何人照做都会失败。0.4.0 起包发布到 npm，README 给出四条路径：市场点安装、
  `add dsh-turn-cleanup`、`add github:Leonlee114514/dsh-turn-cleanup`（插件管理器的
  `GIT_SHORTHAND` / `HOSTED_REPOSITORY_URL` 都接受）、以及手工 link；手工 link 步骤里的
  profile 名改成 `<profile>` 占位。
- **补上 `dsh.client.inject`**（`@deepseek-ai/dsh-client-ui-chat`、
  `@deepseek-ai/dsh-client-ui-settings-general`）。它注册的 `conversation.chat.turnTail` 与
  `settings.section` 分别由这两个包提供；这个字段是客户端模块的**加载顺序依赖**
  （`dsh-client-modules` 按它拓扑排序），兄弟插件都声明了。

### Fixed — 客户端 slot 装配

- 去掉 `conversation.chat.turnTail` 的 `inject: () => ({ t })`。renderer 的 `standardKit` 已经
  按 `entry.locale` 提供 locale 绑定的 `t`（`localeSeat(face, entry.locale)`），再 inject 一个
  同名 prop 会被 `assertNoPropOverlap` 判成 ``received duplicate prop 't'``。

### Changed — 测试与 CI

- `test/sim.mjs` 从 16 场景 / 39 项扩到 26 场景 / 57 项，新增的全部是**可移植性回归**：
  正常业务文件名不误伤、带分隔符的临时件仍命中、`protectedSegments` 整体替换、三个 intent
  事件、`messageLocale` 中英切换、`workingDirectory` 优先于 `header.cwd`、junction cwd 归一。
- **CI 现在也跑 `test/web.mjs` 与 `test/client.mjs`**。此前只有 ubuntu 上的 `sim.mjs`，
  等于把最容易随宿主升级漂移的两块（webServer 路由、浏览器 bundle 契约）留在了没人看的角落。
  顺带修掉过期的步骤标签（写着「14 scenarios / 35 assertions」，实际早就是 39）。

## [0.3.2] - 2026-11-12

适配 DSH 0.2.2（cordis 4.1.0）。0.3.1 在 0.2.2 上**加载即失败**，闸门与面板同时消失。

### Fixed

- `apply` 末尾 `void ctx.inject(['webServer'], …).catch(handler)` 抛
  `ctx.inject(...).catch is not a function`。cordis 4.1.0 的 `inject()` 返回
  `Object.create(fiber)` 再挂一个 `then` 的 thenable，**只有 `then`，没有 `catch` / `finally`**。
  改成 `try { const fiber = ctx.inject(...); if (typeof fiber?.then === 'function') fiber.then(undefined, onError) } catch (error) { onError(error) }`，
  同步抛出也兜住。
- `ensureClientEntry()` 原先把 `cm.pkgMeta instanceof Map` 当前置条件，0.2.2 删掉了这份缓存后
  整个自救逻辑变成 no-op。现在 `pkgMeta` 只作为「老版本才需要清」的可选步骤，
  真正的动作统一是 `dirty.add(name)` + `flush(onError)`。
- `test/web.mjs` 的假 `ctx.inject` 返回 `undefined`，`.catch` 那行在测试里根本跑不到。
  改成照抄 cordis 的实现形状（`Object.create(fiber)` + 只挂 `then`），并新增断言
  「apply 在 then-only thenable 下不抛」。

### Added

- `test/web.mjs` 新增「0.2.2 无 pkgMeta 时仍会 dirty+flush」场景，用只有 `graph` / `dirty` /
  `flush` 的假 `clientModules` 验证自救路径。
- README 新增「宿主版本兼容」一节，列出实测过的 DSH/cordis 组合与依赖的钩子清单。

### 为什么这个 bug 只在真机暴露

本地三份测试全绿（84 项），因为假 ctx 的 `inject` 返回的是 `Promise` 或 `undefined`，
两条都有 `.catch` 或压根不会走到。函数签名层面的不兼容，靠假实现是测不出来的——
假实现必须照抄真实返回值的**形状**（这里就是「有 `then`、没有 `catch`」），
否则测的是自己编的契约。

## [0.3.1] - 2026-11-07

修一个只有真机用起来才会暴露的问题：闸门把交付汇报顶掉了。

`agent.steer()` 让同一轮多跑一步，那一步成了 turn 的最后一步；而 chat UI 的
`latestAnswer(turn)` 取的是 turn 内**最后一个 step** 的 assistant 文本
（`latestAnswer(turn)`，见 `@deepseek-ai/dsh-client-ui-chat/lib/client.js`），于是真正的交付汇报被判成
「过程」折叠起来，屏幕上只剩清场汇报。功能没错，但用户看到的东西反了。

### Changed

- **默认交付方式改 `followup`**。`agent.followup()` 把清单排进 `next-turn`：本轮正常收尾、
  汇报仍是最后一步，紧接着 `kick()` 的 `while (await this.turn())` 自动开一轮执行清场。
  跨 turn 折叠互不干扰，闸门硬度只降一点（模型仍可不理，但下一轮开头就撞见）。
- 新增配置 `steerMode`（`followup` | `steer`，默认 `followup`）。要「不处理这一轮就结束不了」
  的硬闸门就把 `steerMode` 设成 `steer`，接受汇报被折叠的代价。老 agent 没有 `followup()`
  时自动退回 `steer`，不会崩。
- 日志行首从固定的 `steer ` 改成实际交付方式（`followup ` / `steer `），一眼能分出是哪条路。

### Fixed

- **依从率复核时机跟着交付方式走**。followup 模式下清单要等下一轮才被执行，若仍在
  `turn/end` 按本轮复核，会读到「全都还在」的假数字，把依从率压成 0。账本新增
  `verifyAtTurn`（followup = `turn + 1`）与 `steerMode` 两个字段，`verify()` 按
  `verifyAtTurn` 匹配；`turnRecord` / `summary.recent` 一并透出。
- `test/web.mjs` 按真实时序重写复核段：turn 7 被拦 → turn 7 结束断言「还没复核」→
  turn 8 结束才算 cleaned/remaining。另加一条断言 `verifyAtTurn === 8 && steerMode === 'followup'`。
- `test/sim.mjs` 的假 agent 补上 `followup()` 并记录走的哪条路；新增场景 15（显式
  `steerMode: 'steer'`）与 16（无 `followup()` 时退回 `steer`）。39 项。

## [0.3.0] - 2026-11-07

加可视化：拦截了多少次、清掉多少文件、模型配不配合，光看日志得自己数。参考
billion-context 的总览页形态，做一个「本插件干了多少活」的面板。

指标口径上刻意不做「只报拦截次数」——那证明不了任何事。插件真正想说的是**模型配不配合**，
所以每条拦截记录会在下一轮 turn 结束时回头 stat 一遍，算出 `cleaned / (cleaned + remaining)`。

### Added

- **`lib/stats.js` 统计账本**。每次闸门拦下记一条 `{at, sid, turn, cwd, temps[], backups[], keep, mode, pruned[], verify}`；
  `verify` 只复核「同 sid + 同 turn 且还没复核过」的那条——跨轮补算会让更早的 turn 在模型早已清掉之后才算，
  依从率虚高。`prune` 自己删掉的备份直接计入 `cleaned`（有日志为证，不用等下一轮）。账本上限 1000 条。
- **`GET /turn-cleanup/stats` 只读端点**。三种 query：全局汇总、`?scope=session&sid=`、`?sid=&turn=`（单轮，`null` = 没拦过）。
  走 `webServer.register()` 而不是 `remote.*` RPC：本插件没有 host 服务对象，一条 HTTP 路由比一套 service + RPC 契约轻得多，
  客户端同源 `fetch` 相对路径即可，不用管 relay / 远程模式的 origin 探测。
- **设置页面板**（`settings.section`，id `turn-cleanup`，order 32）。四张卡 + 最近拦截表 + 按会话分布表，范围可切全局/当前会话。
- **turn 末尾徽章**（`conversation.chat.turnTail`，id `turn-cleanup-turn`，order 12）。这一轮拦了什么、清没清；没拦过不显示。
- 配置项 `stats`（默认 `true`）与 `statsFile`（默认 `logFile` 同目录的 `turn-cleanup-stats.json`）。`stats: false` 就完全不记账、不装端点，闸门照旧。
- `test/web.mjs`（15 项）与 `test/client.mjs`（27 项）。后者用假 `window.__ModuleLoader__` 加载真实 bundle，断言 slot 注册形状与 locale 字典——client 半的错在 Node 里跑不出来，只能靠契约测试挡。

### Fixed

- **`effect(() => disposer)` 会让注册立刻消失**。`webServer.register()` 返回 disposer，写成「先 register 拿 disposer，再
  `sub.effect(() => disposer)`」时，exact 路由注册完就 404——effect 的返回值语义与「把 disposer 当返回值」重叠，注册被当场拆掉。
  正确写法是把注册放进 effect 的 execute 内部、把清理闭包交出去（`@deepseek-ai/dsh-client-modules` 自己也是这种写法）。
- **后补 `dsh.client` 声明不会自动生效**。`client-modules` 把「有没有 client 半」缓存在 `pkgMeta`（含缓存的 `null`），
  只在进程启动时清一次；`internal/plugin` 只对新 fiber 重扫，HMR 重跑 `apply` 救不回来。插件在 `apply` 里自己兜底：
  清掉本包那条 `null` 缓存、标 dirty、手动 `flush()` 一次；拿不到内部字段就安静放弃，退化成「重启 DSH 才出现面板」。
- 假 ctx 的 `effect` 只存不执行，导致 locale 字典注册没发生（25/27）。真实 cordis 是「立即执行 execute、返回值当 disposer」，
  假 ctx 改成同样的语义后 27/27。这条与上面那条 404 是同一个语义的两个侧面。

## [0.2.0] - 2026-11-06

加通道 3：备份保留。模型干活爱留 `.bak` 当回滚点，任务一长就堆成山——本机 profile 目录
实测躺着 35 个 `*.bak-*`，同一个 `cordis.patch.yml` 就有 28 份。备份不是垃圾，但超量的
备份就是垃圾，而且它们和临时件一样没人清。

### Added

- **通道 3 — 备份保留**。按「同目录 + 同原件名」把 `.bak` 聚成家族，只留最近 `keep`
  份（默认 3），其余列进 steer 清单。家族键只认 `.bak` 及其后的 `-` / `.` 分隔，不假定
  时间戳格式——实测命名有 `.bak-0926`、`.bak-1793445543005`、
  `.bak-autodetect-20261102-080912`、`.bak-purge`、裸 `.bak`，任何按日期正则解析的做法
  都会漏掉一半。
- `backupRetention.mode` 两档：`steer`（默认，只列清单，由模型删）与 `prune`（插件自己删）。
- `prune` 四道闸：原件必须仍在（否则整族跳过，备份可能是唯一副本）、`lstat` 必须是普通
  文件且非符号链接、不在保护段、每轮删除上限。
- `backupRetention.requireOriginalPresent`（默认 true）与 `maxPrunePerTurn`（默认 50）。
- 排序用 `mtimeMs` 降序、同 mtime 用文件名兜底，保证多次运行结果稳定。
- steer 文案分两段：临时件段与备份段之间空一行。备份段显式写「不要动原件本身，也不要动
  最近 N 份」，否则模型容易把整族一起删掉。
- `test/sim.mjs` 扩到 14 组场景 / 35 项断言（新增 6 组备份场景）。

### Fixed

- **`prune` 的 mtime 守卫方向写反且不该存在**。初版有
  `plan.originalMtime < member.mtimeMs → skip`，真机一跑 5 份备份只删掉 1 份
  （`deleted=1`，实际剩 4 份）——原件刚被写、mtime 最新，于是每份「比原件旧」的备份都被
  当成「不能删」。守卫的意图（原件内容还没落进备份）站不住：备份是历史状态的副本，原件
  比它新才是常态。删掉后 `deleted=2`，剩 3 份 + 原件，符合预期。
- `prune` 删掉的备份会同时命中通道 2 的 `*.bak-*` 模式，导致文案里列出刚删掉的文件。
  现在删除后从候选集里一并剔除。

### 为什么不默认 `prune`

删副本虽然安全，但不可逆；而「哪几份该留」需要看上下文（比如某份备份是唯一记得某个
实验参数的副本）。默认 `steer` 把判断交给模型，需要全自动的人自己开 `prune`。

## [0.1.0] - 2026-11-06

首个版本。核心是把「交付前清掉本轮临时件」这条自觉条款变成代码闸门。

### Added

- `agent/turn-stopping` listener：turn 边界提交前检查，发现临时件就 `agent.steer(...)`，
  同一 turn 多跑一步让模型处理。
- **通道 1 约定目录**：`<cwd>/.agent-tmp/`（`tmpDirName` 可配）。不进这个目录就不是临时件，
  目录初始为空，没有存量包袱。
- **通道 2 本 turn 写入追踪**：挂 `fs/write-intent`，按 `session.id + turn` 分桶记路径。
  只检查这些路径里匹配临时件模式的。
- **三重条件判定**：本 turn 记录 ∩ 模式匹配 ∩ 文件仍存在。绝不扫全工作区。
- 防抖：按 `(sessionId, turn)` 记 tripped，每 turn 只拦一次。
- 子会话跳过：`origin === "subagent"` 或 `delegationDepth > 0` 直接 return。
- `logFile` 可选落盘旁路：`ctx.logger` 只写进程 stdout，事后无法取证。

### 为什么不做 git 兜底

`git status --short` 里 mtime 落在本 turn时间窗内的未跟踪文件，看起来是个好兜底。但：

1. 大仓库里 `git status` 本身慢，而 `turn-stopping` 是串行 await，慢了拖住每次 turn 结束；
2. 存量未跟踪文件极多，mtime 判据容易被 checkout / 批量操作误伤；
3. 前两个通道已经能覆盖绝大多数情况。

先跑一周看漏没漏，再考虑加。

### Fixed（真机暴露的三个）

- **配置归一化削掉裸前导点**：`replace(/^[./\\]+/, '')` 把 `.agent-tmp` 变成 `agent-tmp`，
  约定目录形同失效。改为只剥 `./`、`.\` 前缀与首尾分隔符。
- **`ctx.logger.info` 不落盘**：`~/.dsh/logs/` 里只有 startup 日志，拦截记录走 stdout，
  事后无法 grep。加 `logFile` 配置项。
- **插件中途热加载会漏检**：`recorded` 原本判 `s.turn === turn`，但插件若在本 turn 中途才
  apply，没赶上 `turn/start`，`s.turn` 是 `undefined`，会被误判成非本 turn而漏检。
  改为 `s.turn === undefined || s.turn === turn`。

### 实测

七项验收在真实 DSH 桌面全部通过：正例被拦、约定目录被拦、`.xlsx` 交付物不拦、
存量 `probe-*` 不拦、防抖只拦一次、subagent 跳过、`enabled: false` 完全失效。
