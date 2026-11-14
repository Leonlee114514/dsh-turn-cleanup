# 变更记录

按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 组织，版本号走 SemVer。
每条写「为什么」而不只是「改了什么」—— 这个插件的坑大多来自 DSH 宿主的隐式约定，
不记下来下次还会踩。

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
