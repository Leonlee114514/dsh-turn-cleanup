# 变更记录

按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 组织，版本号走 SemVer。
每条写「为什么」而不只是「改了什么」—— 这个插件的坑大多来自 DSH 宿主的隐式约定，
不记下来下次还会踩。

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
