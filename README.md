# dsh-turn-cleanup

给 [DeepSeek Harness](https://github.com/deepseek-ai) 装一道**硬闸门**：每轮 turn 即将结束时检查
本轮 agent 留下的临时文件，非空就用 `agent.steer(...)` 把清单推回给模型，逼它在同一个 turn 里
再走一步——删掉，或逐条说明理由后挪走。

不是提醒，是拦路。模型不处理，turn 就结束不了。

---

## 为什么需要它

DSH 三层都缺自动清理：

| 层 | 现状 |
| --- | --- |
| **框架层** | 有 `agent/turn-stopping` 钩子（`serial`，await 在边界提交前），是天然闸门。但全仓只有 2 个消费者——`dsh-workspace-changes` 记变更、`dsh-mnemon` 写记忆，**都不清理**。 |
| **组件层** | 只清自己的 `mkdtemp` scratch（`dsh-workspace-changes`、`dsh-sandbox-local`、`dsh-session-persistence-jsonl`、`dsh-attachment-local`），全是「自己拉屎自己擦」。 |
| **提示词层** | `AGENTS.md` 里那类「交付前把本轮临时件清掉」的条款只有自觉力，没有强制力。模型忙着收尾时就忘了。 |

结果就是工作区里慢慢堆起 `probe-*.mjs`、`check*.sh`、`*.bak-*`——每个都是某次探针的遗骸，
没人知道能不能删。

本插件把这条自觉条款变成代码闸门。

---

## 钩子语义（这是它能工作的原因）

`agent/turn-stopping` 是 `serial` 模式，await 在 turn 边界提交**之前**：

```js
// dsh-agent-loop/lib/index.js:1009
if (turnEnds && this.inbox.nextStep.length === 0) {
  await this.dispatch.serial('agent/turn-stopping', { turn, signal });
  signal.throwIfAborted();
}
if (turnEnds && this.inbox.nextStep.length === 0) break;
```

`agent.steer(input)` 走 `send(input, 'next-step', true)`。listener 里 steer 之后
`nextStep.length` 变 1，循环继续，**同一个 turn 多跑一步**。这就是闸门的全部机制。

---

## 检出范围：两个通道，三重条件

### 通道 1 — 约定目录（主机制，零误伤）

临时件一律放 `<cwd>/.agent-tmp/`（`tmpDirName` 可配）。turn 结束时该目录存在且非空 → 拦。

好处：不进这个目录就不是临时件。目录一开始是空的，没有存量包袱。

### 通道 2 — 本 turn 写入追踪（覆盖不守约定的情况）

挂 `fs/write-intent` waterfall，按 `session.id + turn` 分桶记录写入路径。turn 结束时只检查
**这些路径**里文件名匹配临时件特征的（`probe-*` / `tmp-*` / `scratch-*` / `check*` / `diag_*` /
`bench*` / `*.bak-*`，或位于 `.agent-tmp/`）。

**绝不扫全工作区。** 存量未跟踪文件不参与判定——判定严格等于：

```
本 turn 记录 ∩ 模式匹配 ∩ 文件仍存在
```

这条不是洁癖。一个用了几个月的工作区里躺着几十个 `probe-*`，扫全量的插件第一天就会被
关掉。

### 明确不做

- **不删任何文件** —— 只 steer。删不删、留不留由模型判断（交付物、用户文件、`.tmp-sessions`、
  `.git`、`node_modules`、`out/` 一律不碰）。
- **不做 `git status` 兜底** —— 大仓库慢，且存量未跟踪文件极多，容易误判。
- **子会话整段跳过** —— `origin === "subagent"` 或 `delegationDepth > 0` 时直接 return，它们的
  cwd 可能是别人的工作区。
- **listener 里不做慢操作** —— 只有 `readdir` / `stat`，不跑子进程、不扫大目录。
  `turn-stopping` 是串行 await，慢了会拖住每一次 turn 结束。

---

## 防抖：每 turn 只拦一次

按 `(sessionId, turn)` 记 `tripped` Set。第二次进 listener 直接 return，不管还剩几个文件。

没有这一条，模型每多跑一步就被再拦一次，turn 永远结束不了。`turn/end` 与 `session/disposed`
清 key。

---

## steer 文案

```
收尾前清场：这些是本轮你留下的临时文件——
- .agent-tmp/scratch-run.log
- probe-yyy.mjs
删掉它们；要留的逐条说明理由并挪到明确位置。交付物、用户文件、.tmp-sessions、.git 不要动。
```

超过 `maxSteerPaths` 时追加 `- …还有 N 个`。

---

## 安装

插件没有 `dsh.bundle`，走手工 link + patch 注册（`plugin_manager install_bundle` 只接受带
`dsh.bundle` 的包）。

```bash
# 1. 克隆到本地
git clone https://github.com/Leonlee114514/dsh-turn-cleanup.git ~/.dsh/local-pkgs/dsh-turn-cleanup

# 2. 在 profile 的 package.json 的 dependencies 里加一行
#    "dsh-turn-cleanup": "link:../../local-pkgs/dsh-turn-cleanup"

# 3. 建符号链接（pnpm install 在有远端依赖时会卡住，手工建更可靠）
node -e "
const { symlinkSync } = require('node:fs');
symlinkSync(
  require('node:path').join(require('node:os').homedir(), '.dsh/local-pkgs/dsh-turn-cleanup'),
  require('node:path').join(require('node:os').homedir(), '.dsh/profiles/desktop/node_modules/dsh-turn-cleanup'),
  'junction'
)"
```

```yaml
# 4. 在 ~/.dsh/profiles/desktop/cordis.patch.yml 顶层加条目
- insert:
    - id: turn-cleanup
      name: dsh-turn-cleanup
      inject: []
      config:
        enabled: true
        tmpDirName: .agent-tmp
        patterns:
          - "probe-*"
          - "tmp-*"
          - "scratch-*"
          - "check*"
          - "diag_*"
          - "bench*"
          - "*.bak-*"
        scanDepth: 4
        maxLogPaths: 10
        maxSteerPaths: 20
        logFile: ""     # 可选：落盘旁路，留空 = 只走 ctx.logger
```

**不需要重启 DSH。** `dsh-hmr` 监听 `cordis.patch.yml` 与 `package.json`，改动即
`reconcileProfile()` 重组合，十几秒后新版本就生效。

验证加载成功：

```
cordis_inspect_query → host / Config / listConfigs, name: dsh-turn-cleanup
```

`status: "absent"` 就是正常的——它表示 fiber 已启动、未 disabled，但插件没导出 Config
schema（本插件故意不导出，避免 schemastery 依赖）。若显示 `inactive`，说明 import 失败。

---

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` → 完全不装闸门（连 listener 都不注册） |
| `tmpDirName` | `.agent-tmp` | 约定目录名，相对 cwd |
| `patterns` | 见上 | 文件名 glob，只支持 `*` / `?`，大小写不敏感 |
| `scanDepth` | `4` | `.agent-tmp` 递归深度，1..6 |
| `maxLogPaths` | `10` | 日志里最多列几条 |
| `maxSteerPaths` | `20` | steer 文案里最多列几条 |
| `logFile` | `""` | 落盘旁路；相对 cwd 或绝对路径 |

---

## 日志

`ctx.logger.info` 只写 Electron 主进程 stdout，进程一关就没了。要事后取证就配 `logFile`，
每次拦截追加一行：

```
2026-11-06T03:43:31.838Z steer session=<id> turn=2 cwd=<cwd> files=2 paths=[.agent-tmp/scratch-run.log, probe-yyy.mjs]
```

写日志失败一律静默——落盘是取证旁路，不能因为路径不可写而拖住 turn 边界。

---

## 实测

在一台真实 DSH 桌面上跑过七项验收，全部通过：

| # | 项 | 结果 |
| --- | --- | --- |
| 1 | 正例 `probe-*.mjs` 被拦 | ✅ turn 3 拦到 `probe-wi3-*.mjs` |
| 2 | `.agent-tmp/` 被拦 | ✅ turn 2 拦到 `.agent-tmp/scratch-run.log` |
| 3 | `.xlsx` 交付物不拦 | ✅ 日志 0 次出现，文件保留 |
| 4 | 存量 `probe-*` 不拦 | ✅ 3 个存量 ps1 全 0 次出现 |
| 5 | 防抖只 steer 一次 | ✅ 4 文件全不删，第二趟 `tripped=true` 直接 return |
| 6 | subagent 跳过 | ✅ subagent 写文件有 `wi` 行，gate 行数 = 0 |
| 7 | `enabled: false` 完全失效 | ✅ 放 `.agent-tmp/` 文件结束 turn，无任何 steer |

单元测试（假 ctx 模拟 agent-loop 调用顺序，不依赖 DSH 运行时）：

```bash
npm test        # 11/11 checks passed
npm run verify  # syntax check + test
```

---

## 两个真机踩到的坑

**1. 配置归一化把裸前导点削掉**

原实现 `replace(/^[./\\]+/, '')` 会把 `.agent-tmp` 变成 `agent-tmp`，约定目录形同失效。
现在只剥 `./`、`.\` 前缀与首尾分隔符。

**2. `ctx.logger.info` 不落盘**

`~/.dsh/logs/` 里只有 startup 日志，拦截记录走 stdout，事后无法 grep。所以有了 `logFile`
配置项。

**3. 插件中途热加载会漏检**

`recorded` 原本判 `s.turn === turn`。但插件若在本 turn 中途才 apply，没赶上 `turn/start`，
`s.turn` 是 `undefined`，会被误判成非本 turn 而漏检。改为
`s.turn === undefined || s.turn === turn`。

---

## 回滚

从 `cordis.patch.yml` 删掉 `- id: turn-cleanup` 整条即可，HMR 自动重载后闸门立即失效。
`local-pkgs/dsh-turn-cleanup` 留着不影响（不被 patch 引用就不会加载）。

---

## License

MIT
