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

## 检出范围：三个通道，各自独立判定

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

### 通道 3 — 备份保留（同一原件的 `.bak` 家族只留最近 N 份）

模型干活爱留备份当回滚点，任务一长就堆成山。本机 profile 目录实测躺着 35 个
`*.bak-*`，同一个 `cordis.patch.yml` 就有 28 份。这条按「同目录 + 同原件名」把备份聚成
家族，只留最近 `keep` 份（默认 3），其余列出来。

家族键只认 `.bak` 及其后的 `-` / `.` 分隔：`x` / `x.bak` / `x.bak-<后缀>` / `x.bak.<后缀>`
都算同一家族，`x.bakfoo` 不算。**不假定时间戳格式** —— 实测命名五花八门
（`.bak-0926`、`.bak-1793445543005`、`.bak-autodetect-20261102-080912`、`.bak-purge`、
裸 `.bak`），任何「按日期正则解析」的做法都会漏掉一半。

只处理**本轮碰过的家族**：seeds 来自 `fs/write-intent` 记录 + `.agent-tmp/` 扫描结果，
推不出原件名的直接跳过。每个目录只 `readdir` 一次，不扫全盘。

两种模式：

- `mode: steer`（默认）：只把超量的列进清单，由模型判断并执行删除。和通道 1/2 一样，插件不动手。
- `mode: prune`：插件自己删。删的虽然是副本，但不可逆，所以必须显式选择。

`prune` 的四道闸：

1. **原件必须仍在**。原件没了，那几份备份可能是唯一副本 —— 整族跳过，一条都不删。
2. **`lstat` 是普通文件、不是符号链接**。不跟链，避免删到链外的真文件。
3. **不在保护段**（`.git` / `node_modules` / `.tmp-sessions` / `out`），且在工作区之内。
4. **每轮删除条数上限**（`maxPrunePerTurn`，默认 50）。

刻意**不做**「备份比原件新就不删」：备份是某个历史状态的副本，原件比它新才是常态；
反过来原件比备份旧往往意味着模型反复备份却没改原件 —— 那正是要清的重复副本。而且
删的永远是最旧的那几份，最新 `keep` 份一律不动，价值损失有上界。

### 明确不做

- **通道 1 / 2 永远不删任何文件** —— 只 steer，删不删、留不留由模型判断（交付物、用户文件、
  `.tmp-sessions`、`.git`、`node_modules`、`out/` 一律不碰）。只有通道 3 的 `prune` 模式会删，
  且只删备份副本，四道闸见上。
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

临时件与超量备份同时存在时，文案分两段，中间空一行：

```
收尾前清场：这些是本轮你留下的临时文件——
- .agent-tmp/scratch-run.log
删掉它们；要留的逐条说明理由并挪到明确位置。交付物、用户文件、.tmp-sessions、.git 不要动。

备份超量：同一原件的 .bak 只保留最近 3 份，这些是多余的——
- cfg-demo.yml.bak-r1
- cfg-demo.yml.bak-r2
删掉它们；要留的先挪到明确位置并说明理由。不要动原件本身，也不要动最近 3 份。
```

分两段而不是混在一起，是因为两件事的约束不同：临时件没有「保留几份」的概念，备份有；
而备份段必须显式提醒「不要动原件、不要动最近 N 份」，否则模型容易把整族一起删掉。

---

## 安装

包带 `dsh.bundle`，所以两种装法都行。

**A. 走市场 / bundle 安装（推荐）**

```
plugin_manager install_bundle → "dsh-turn-cleanup"
```

或命令行：

```bash
dsh plugin --profile <name> add dsh-turn-cleanup
```

包根的 `cordis.patch.yml` 会被自动应用，闸门默认开启，配置用默认值。要改配置就在自己 profile 的
`cordis.patch.yml` 里按同一个 id 覆盖，不要另加一条 `- insert`（同 id 两条会被 cordis 拒绝注册）。

**B. 手工 link（源码改动时用，改完 HMR 直接生效）**

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
# 4. 只在手工 link 时需要：在 ~/.dsh/profiles/desktop/cordis.patch.yml 顶层加条目
#    （走 A 的 bundle 安装则跳过这步，包根的 cordis.patch.yml 已经带了同一条）
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
| `backupRetention.enabled` | `true` | `false` → 整个通道 3 关闭 |
| `backupRetention.keep` | `3` | 同一原件保留几份，1..20 |
| `backupRetention.mode` | `steer` | `steer` 只列清单；`prune` 插件自己删 |
| `backupRetention.requireOriginalPresent` | `true` | 原件不在的家族整族跳过 |
| `backupRetention.maxPrunePerTurn` | `50` | `prune` 模式每轮删除上限 |

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

在一台真实 DSH 桌面上跑过九项验收，全部通过：

| # | 项 | 结果 |
| --- | --- | --- |
| 1 | 正例 `probe-*.mjs` 被拦 | ✅ turn 3 拦到 `probe-wi3-*.mjs` |
| 2 | `.agent-tmp/` 被拦 | ✅ turn 2 拦到 `.agent-tmp/scratch-run.log` |
| 3 | `.xlsx` 交付物不拦 | ✅ 日志 0 次出现，文件保留 |
| 4 | 存量 `probe-*` 不拦 | ✅ 3 个存量 ps1 全 0 次出现 |
| 5 | 防抖只 steer 一次 | ✅ 4 文件全不删，第二趟 `tripped=true` 直接 return |
| 6 | subagent 跳过 | ✅ subagent 写文件有 `wi` 行，gate 行数 = 0 |
| 7 | `enabled: false` 完全失效 | ✅ 放 `.agent-tmp/` 文件结束 turn，无任何 steer |
| 8 | 备份 steer 模式 | ✅ turn 8 拦到 `cfg-demo.yml.bak-r1` / `-r2`，`backups=2 keep=3`，r3–r5 未被列 |
| 9 | 备份 prune 模式 | ✅ 5 份备份 → 删 p1/p2、剩 p3/p4/p5，原件保留，`deleted=2 keep=3` |

单元测试（假 ctx 模拟 agent-loop 调用顺序，不依赖 DSH 运行时）：

```bash
npm test        # 35/35 checks passed
npm run verify  # syntax check + test
```

---

## 四个真机踩到的坑

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

**4. 「备份比原件新就不删」这条守卫写反了，且本来就不该有**

`prune` 初版带一条 `plan.originalMtime < member.mtimeMs → skip`。真机一跑，5 份备份
只删掉 1 份（`deleted=1`，实际剩 4 份）。原因是原件刚被写、mtime 最新，于是每一份
「比原件旧」的备份都被当成「不能删」。守卫的意图（原件内容还没落进备份）根本站不住：
备份是历史状态的副本，原件比它新才是常态。删掉后 `deleted=2`，剩 3 份 + 原件，符合预期。

---

## 回滚

从 `cordis.patch.yml` 删掉 `- id: turn-cleanup` 整条即可，HMR 自动重载后闸门立即失效。
`local-pkgs/dsh-turn-cleanup` 留着不影响（不被 patch 引用就不会加载）。

---

## License

MIT
