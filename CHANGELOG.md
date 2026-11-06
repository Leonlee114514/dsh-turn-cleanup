# 变更记录

按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 组织，版本号走 SemVer。
每条写「为什么」而不只是「改了什么」—— 这个插件的坑大多来自 DSH 宿主的隐式约定，
不记下来下次还会踩。

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
