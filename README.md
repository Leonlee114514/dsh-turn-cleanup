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

结果就是工作区里慢慢堆起 `probe-*.mjs`、`check-*.sh`、`*.bak-*`——每个都是某次探针的遗骸，
没人知道能不能删。

本插件把这条自觉条款变成代码闸门。

---

## 钩子语义（这是它能工作的原因）

`agent/turn-stopping` 是 `serial` 模式，await 在 turn 边界提交**之前**：

```js
// dsh-agent-loop/lib/index.js:809-816
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

挂 `fs/write-intent` / `fs/edit-intent` / `fs/delete-intent` 三个 waterfall，按 `session.id + turn`
分桶记录写入路径。三个都要挂：宿主把「新建/覆盖」走 write-intent，「原地改」走 edit-intent，
「删除」走 delete-intent（`dsh-tool-fs`、`dsh-tool-str-replace-editor` 各自 emit），只挂 write 的话
模型用 `edit` / `str_replace` 造出来的临时件完全看不见。

turn 结束时只检查**这些路径**里文件名匹配临时件特征的（`probe-*` / `tmp-*` / `scratch-*` /
`check-*` / `check_*` / `diag_*` / `bench-*` / `bench_*` / `*.bak-*`，或位于 `.agent-tmp/`）。
匹配对象是**文件名**（不是路径），大小写不敏感。

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

只处理**本轮碰过的家族**：seeds 来自三个 intent 事件记录 + `.agent-tmp/` 扫描结果，
推不出原件名的直接跳过。每个目录只 `readdir` 一次，不扫全盘。

两种模式：

- `mode: steer`（默认）：只把超量的列进清单，由模型判断并执行删除。和通道 1/2 一样，插件不动手。
- `mode: prune`：插件自己删。删的虽然是副本，但不可逆，所以必须显式选择。

`prune` 的四道闸：

1. **原件必须仍在**。原件没了，那几份备份可能是唯一副本 —— 整族跳过，一条都不删。
2. **`lstat` 是普通文件、不是符号链接**。不跟链，避免删到链外的真文件。
3. **不在保护段**，且在工作区之内。默认保护段是 `.git` / `node_modules` / `out` / `dist` /
   `build` / `target` / `vendor` / `.venv` / `__pycache__`，可用 `protectedSegments` 整体替换。
4. **每轮删除条数上限**（`maxPrunePerTurn`，默认 50）。

刻意**不做**「备份比原件新就不删」：备份是某个历史状态的副本，原件比它新才是常态；
反过来原件比备份旧往往意味着模型反复备份却没改原件 —— 那正是要清的重复副本。而且
删的永远是最旧的那几份，最新 `keep` 份一律不动，价值损失有上界。

### 明确不做

- **通道 1 / 2 永远不删任何文件** —— 只 steer，删不删、留不留由模型判断（交付物、用户文件、
  `.git`、`node_modules`、`out/`、`dist/`、`build/` 等保护段一律不碰）。只有通道 3 的 `prune` 模式会删，
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

## 注入文案

这段文字是**直接注入模型回合**的指令，所以它的语言可配（`messageLocale`，默认 `auto`）。
`auto` 的回退链：`DSH_LOCALE` / `LC_ALL` / `LC_MESSAGES` / `LANGUAGE` / `LANG` → 系统区域设置
（`Intl`）→ `en`。想固定就写 `zh` 或 `en`。

中文（`messageLocale: zh`，或 `auto` 命中中文环境）：

```
收尾前清场：这些是本轮你留下的临时文件——
- .agent-tmp/scratch-run.log
- probe-yyy.mjs
删掉它们；要留的逐条说明理由并挪到明确位置。交付物、用户文件、受保护目录不要动。
```

英文（`messageLocale: en`）：

```
Clean up before you finish: these temporary files were produced in this turn —
- .agent-tmp/scratch-run.log
- probe-yyy.mjs
Delete them. If one must stay, say why for each and move it somewhere deliberate. Do not touch deliverables, user files, or protected directories.
```

超过 `maxSteerPaths` 时追加 `- …还有 N 个`（英文 `- …and N more`）。

临时件与超量备份同时存在时，文案分两段，中间空一行（下面是中文版）：

```
收尾前清场：这些是本轮你留下的临时文件——
- .agent-tmp/scratch-run.log
删掉它们；要留的逐条说明理由并挪到明确位置。交付物、用户文件、受保护目录不要动。

备份超量：同一原件的 .bak 只保留最近 3 份，这些是多余的——
- cfg-demo.yml.bak-r1
- cfg-demo.yml.bak-r2
删掉它们；要留的先挪到明确位置并说明理由。不要动原件本身，也不要动最近 3 份。
```

消息对象带 `source: { kind: 'dsh-turn-cleanup', form: 'notice', summary }`：
`kind` 不自称 `user`（宿主有若干处把 `source.kind === 'user'` 当人类授权，
`dsh-tool-goal` 的 `hasDirectHumanInput()` 就是一例），`form: 'notice'` 与宿主自己的
`modelSwitchNotice()` 对齐。

分两段而不是混在一起，是因为两件事的约束不同：临时件没有「保留几份」的概念，备份有；
而备份段必须显式提醒「不要动原件、不要动最近 N 份」，否则模型容易把整族一起删掉。

---

## 安装

包带 `dsh.bundle`，所以三种装法都行。**装完不需要改任何配置**：包根的
`cordis.patch.yml` 会在安装时自动插入 loader 条目，所有配置项都有内置默认值。

**A. 从市场点安装（最省事）**

插件在 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
目录里，DSH 的 Plugins → Discover（或 dshmarket）搜 `turn-cleanup` 点安装即可。
装完即生效，不用重启。

**B. 命令行（bundle 安装）**

```bash
dsh plugin --profile <profile> add dsh-turn-cleanup
```

`<profile>` 换成你自己的：`~/.dsh/profiles/` 下有哪些目录就用哪个名字。

**C. git 源（想跟 main 分支）**

```bash
dsh plugin --profile <profile> add github:Leonlee114514/dsh-turn-cleanup
# 等价写法：
#   dsh plugin --profile <profile> add https://github.com/Leonlee114514/dsh-turn-cleanup
```

包根的 `cordis.patch.yml` 会被自动应用，闸门默认开启，配置用默认值。要改配置就在自己 profile 的
`cordis.patch.yml` 里按同一个 id 覆盖，不要另加一条 `- insert`（同 id 两条会被 cordis 拒绝注册）。

**D. 手工 link（源码改动时用，改完 HMR 直接生效）**

```bash
# 1. 克隆到本地
git clone https://github.com/Leonlee114514/dsh-turn-cleanup.git ~/.dsh/local-pkgs/dsh-turn-cleanup

# 2. 在 profile 的 package.json 的 dependencies 里加一行
#    "dsh-turn-cleanup": "link:../../local-pkgs/dsh-turn-cleanup"

# 3. 建符号链接（pnpm install 在有远端依赖时会卡住，手工建更可靠）
#    `desktop` 换成你自己的 profile 名：~/.dsh/profiles/ 下有哪些就用哪个
node -e "
const { symlinkSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const profile = process.env.DSH_PROFILE || 'desktop';   // ← 改成你的 profile 名
symlinkSync(
  path.join(os.homedir(), '.dsh/local-pkgs/dsh-turn-cleanup'),
  path.join(os.homedir(), '.dsh/profiles', profile, 'node_modules/dsh-turn-cleanup'),
  'junction'   // POSIX 上被忽略，等价于普通 symlink
)"
```

```yaml
# 4. 只在手工 link 时需要：在 ~/.dsh/profiles/<profile>/cordis.patch.yml 顶层加条目
#    （走 A/B/C 的 bundle 安装则跳过这步，包根的 cordis.patch.yml 已经带了同一条）
- insert:
    - id: turn-cleanup
      name: dsh-turn-cleanup
```

只想改个别默认值时，不要加第二条 `- insert`（同 id 两条会被 cordis 拒绝注册），
而是加一条**顶层**（列 0）的行去合并进已有条目：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml，列 0 开始
- id: turn-cleanup
  config:
    steerMode: steer          # 同轮多跑一步，而不是排进下一轮
    logFile: /tmp/tc.log      # 落盘旁路
```

全部可覆盖项见下面的「配置」表；未写的键一律用内置默认值。

**装完要不要重启？** 走 A（市场）时不用：market 会把刚装的插件热挂载进当前组合，宿主侧
loader 条目和浏览器端面板同时上线。走 B/C 时 `dsh plugin add` 只写 `dsh.profile.bundles`，
下次启动生效；想立刻生效就在 Plugins 页重新启用一次（market 会做同样的热挂载）。
走 D 时 `dsh-hmr` 监听 `cordis.patch.yml` 与 `package.json`，改动即 `reconcileProfile()`
重组合，十几秒后新版本就生效。

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
| `patterns` | `probe-*` `tmp-*` `scratch-*` `check-*` `check_*` `diag_*` `bench-*` `bench_*` `*.bak-*` | 文件名 glob，只支持 `*` / `?`，大小写不敏感；匹配的是 basename |
| `protectedSegments` | `.git` `node_modules` `out` `dist` `build` `target` `vendor` `.venv` `__pycache__` | 这些目录段下的东西一律不报；**给数组则整体替换**默认值 |
| `messageLocale` | `auto` | 注入文案语言：`auto` / `zh` / `en` |
| `scanDepth` | `4` | `.agent-tmp` 递归深度，1..6 |
| `maxLogPaths` | `10` | 日志里最多列几条 |
| `maxSteerPaths` | `20` | steer 文案里最多列几条 |
| `logFile` | `""` | 落盘旁路；相对 cwd 或绝对路径 |
| `steerMode` | `followup` | 交付方式：`followup` 另开一轮；`steer` 同轮多跑一步（见下） |
| `stats` | `true` | `false` → 不记账、不装 `/turn-cleanup/stats` 端点 |
| `statsFile` | `""` | 账本路径；留空 = `logFile` 同目录的 `turn-cleanup-stats.json` |
| `backupRetention.enabled` | `true` | `false` → 整个通道 3 关闭 |
| `backupRetention.keep` | `3` | 同一原件保留几份，1..20 |
| `backupRetention.mode` | `steer` | `steer` 只列清单；`prune` 插件自己删 |
| `backupRetention.requireOriginalPresent` | `true` | 原件不在的家族整族跳过 |
| `backupRetention.maxPrunePerTurn` | `50` | `prune` 模式每轮删除上限 |

---

## 交付方式：另开一轮，还是同轮多跑一步

`agent/turn-stopping` 有两种让模型继续的写法，代价不一样：

| | `followup`（默认） | `steer` |
| --- | --- | --- |
| 清单排进 | `next-turn`，另开一轮 | `next-step`，同轮多跑一步 |
| 本轮 | 正常结束，交付汇报照常显示 | 汇报被这一步顶掉 |
| 闸门硬度 | 模型仍可不理，但下一轮开头就撞见 | 不处理这一轮结束不了 |
| 依从率复核点 | `turn + 1` 的 turn/end | 本轮的 turn/end |

**为什么默认 followup**：chat UI 按 turn 折叠，`latestAnswer(turn)` 取的是
**turn 内最后一个 step 的 assistant 文本**（`latestAnswer(turn)`，在
`@deepseek-ai/dsh-client-ui-chat/lib/client.js` 里 —— 该文件是压缩成 20 行的 bundle，
函数体在第 19 行，别按行号找，按名字搜）。
steer 那一步成为最后一步，于是真正的交付汇报被折进「过程」区，屏幕上只剩清场汇报。
followup 把清单排到下一轮，本轮最后一步仍是汇报本身，折叠不会发生；`kick()` 的
`while (await this.turn())` 会在队列有 next-turn 时自动接着跑，所以清场照样执行。

要更硬的闸门就把 `steerMode` 设成 `steer`，接受汇报被折叠的代价。

---

## 日志

`ctx.logger.info` 只写 Electron 主进程 stdout，进程一关就没了。要事后取证就配 `logFile`，
每次拦截追加一行：

```
2026-11-07T03:43:31.838Z followup session=<id> turn=2 cwd=<cwd> files=2 paths=[.agent-tmp/scratch-run.log, probe-yyy.mjs]
```

行首是实际交付方式（`followup` / `steer`），`prune` 模式自己删东西时另有一行 `prune …`。

写日志失败一律静默——落盘是取证旁路，不能因为路径不可写而拖住 turn 边界。

---

## 可视化面板

拦截了多少次、清掉了多少文件、腾出了多少空间、模型配不配合——光看日志要自己数。插件带一个
Web 面板：

- **设置页 → 收尾清场**：五张卡（已释放空间 / 拦截次数 / 报出文件数 / 已清文件数 / 依从率），
  下面是最近拦截记录与按会话的分布表；范围可切「全部会话 / 当前会话」。
- **每个 turn 末尾一行徽章**：这一轮拦了什么、清没清、腾了多少。没拦过就不显示。

### 「已释放空间」是怎么量的

只量**真正消失的那部分**，不量「报出去多少」。闸门拦下时给清单里的每个条目记一次
`stat().size`（只算普通文件，目录不计），复核时确认已消失的条目才把字节数累加进
`cleanedBytes`——也就是「这一轮确实还给磁盘的空间」。所以：

- 报出去但模型没删的，不进 `cleanedBytes`（进 `remainingBytes`）
- `prune` 模式自己删掉的备份，大小取**删除前**的 `lstat().size`，直接计入
- 量不到就记 0，宁可少报不猜；旧账本（v1）没有 `sizes` 字段，读出来按 0 计，不会崩

体积是「打开面板的人才看」的数据，所以量它这一步放在闸门最后、只在 `stats` 打开时做，
且一次最多量 200 个条目——`agent/turn-stopping` 是串行 await，不该为了统计在 turn 边界上
排队几百次 `stat`。

### 依从率是怎么算的

不靠猜。闸门拦下时把清单记进账本（`statsFile`），**下一轮 turn 结束**再回头 stat 一遍那些路径：

- 文件没了 → 算 `cleaned`
- 文件还在 → 算 `remaining`
- `compliance = cleaned / (cleaned + remaining)`

只复核「同 sid + 同 turn 且还没复核过」的那条记录。跨轮补算会让更早的 turn 在模型早已
清掉之后才算，依从率虚高。

`prune` 模式自己删掉的备份直接计入 `cleaned`（有日志为证，不用等下一轮）。

### 数据通道

Host 半注册一个只读 JSON 端点，客户端同源 `fetch` 相对路径：

```
GET /turn-cleanup/stats                       # 全局汇总
GET /turn-cleanup/stats?scope=session&sid=…   # 单会话汇总
GET /turn-cleanup/stats?sid=…&turn=…          # 单轮记录，null = 这轮没拦过
```

汇总里有三个字节字段：`reportedBytes`（报出去的清单总共多大）、`cleanedBytes`（复核确认已
消失的那部分，**面板的「已释放空间」就是它**）、`remainingBytes`（复核时还在的）。`bySession`
每行带前两个，`recent[].verify` 带后两个，单轮记录带 `cleanedBytes` / `remainingBytes`。

为什么不走 `remote.*` RPC：本插件没有 host 服务对象，注册一条 HTTP 路由比造一套
service + RPC 契约轻得多，也不用管 relay / 远程模式的 origin 探测。

`stats: false` 就完全不记账、不装端点，闸门本身照旧。

---

## 宿主版本兼容

只用 Node 内建（`node:fs/promises`、`node:crypto`、`node:path`）加几个宿主钩子，没有运行时
依赖、没有 `peerDependencies`。宿主兼容闸门读的是**顶层 `engines.dsh`**（见
`dsh-app-boot` 的 `unmetRequirements()`：先看 `fields.engines.dsh`，没有才退到
`peerDependencies` 里名为 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的项）。0.4.0 起这个字段
放在正确的位置，写的是 `">=0.2.1-rc.5"`。

（0.3.x 及以前把它写在 `dsh.engines.dsh` 下面 —— 闸门从来不读那个位置，所以那条声明既拦不住
也不会告警，等于没写。`dsh.bundle.patch` / `dsh.client` 仍在 `dsh` 下面，那两个是真的。）实测跑过的宿主：

| DSH | cordis | 状态 | 差异 |
| --- | --- | --- | --- |
| 0.2.1-rc.5 | 4.0.5 | ✅ | 基线 |
| 0.2.2-rc.2 | 4.1.0 | ✅ 0.3.2 起 | `ctx.inject()` 变 then-only；`client-modules` 删掉 `pkgMeta` 缓存 |

依赖的钩子在两个版本里语义一致：`session/event`（`turn/start` / `turn/end`）、
`session/disposed`、`fs/write-intent` / `fs/edit-intent` / `fs/delete-intent`、
`agent/turn-stopping`、`agent.steer` / `agent.followup`、`ctx.webServer.register`、`ctx.effect`、
以及可选的 `workingDirectory` 服务（存在就用它取运行时 cwd，不存在退回 `session.header.cwd`）。

客户端 half 声明了 `dsh.client.inject: ["@deepseek-ai/dsh-client-ui-chat",
"@deepseek-ai/dsh-client-ui-settings-general"]` —— 它注册的 `conversation.chat.turnTail` 与
`settings.section` 两个 slot 分别由这两个包提供。这个字段是**客户端模块的加载顺序依赖**
（`dsh-client-modules` 按它做拓扑排序，查不到就静默跳过），不是 cordis 服务注入。

0.3.2 之前的版本在 0.2.2 上会在加载时抛 `ctx.inject(...).catch is not a function`，
插件整个不生效（闸门、面板全无）。升级宿主后如果看不到面板、也没有 `turn-cleanup.log`，
先查这一条。

---

## 实测

在一台真实 DSH 桌面上跑过十二项验收，全部通过：

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
| 10 | 统计端点可访问 | ✅ `GET /turn-cleanup/stats` → 200，空账本返回 `gates: 0` |
| 11 | client bundle 进 boot graph | ✅ 日志 `client entry present url=plugins/??dsh-turn-cleanup/client.js&rev=4c809c380972`，该 URL 取到 15825B 可解析 bundle；`rev` 是必需参数，缺了就是 404 |
| 12 | 0.2.2 下插件能加载 | ✅ 修掉 `ctx.inject(...).catch is not a function` 后 apply 不再抛，端点与徽章恢复 |

单元测试（假 ctx 模拟 agent-loop 调用顺序，不依赖 DSH 运行时）：

```bash
npm test        # 57 + 24 + 36 = 117 checks passed
npm run verify  # syntax check + test
```

三份测试各管一段：`test/sim.mjs` 驱动闸门与三个通道（57 项）、`test/web.mjs` 驱动
StatsStore 与 `/turn-cleanup/stats` 端点、体积字段、以及 then-only 的 `ctx.inject` 假实现
（24 项）、`test/client.mjs` 用假 `window.__ModuleLoader__` 加载真实 client bundle、断言 slot
注册形状、locale 字典与 `fmtBytes` 进位（36 项）。三份都在 CI 里跑（ubuntu × node 20/22/24，
加 windows/macos）。

`test/sim.mjs` 里有几项是**可移植性回归**，专门锁住「本机能跑、别人机器上误伤/漏报」的坑：
正常业务文件名（`checkout.js` / `Checklist.md` / `benchmark.ts`）不误伤、带分隔符的
`check-1.sh` / `bench_2.mjs` 仍命中、`protectedSegments` 可整体替换、`fs/edit-intent` 与
`fs/delete-intent` 也记账、`messageLocale` 中英切换、`workingDirectory` 服务优先于
`header.cwd`、cwd 是 junction 时经 realpath 归一仍能命中。

---

## 八个真机踩到的坑

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

**5. `effect(() => disposer)` 会让注册立刻消失**

`webServer.register()` 返回 disposer。写成「先 register 拿到 disposer，再
`sub.effect(() => disposer)`」时，exact 路由注册完就 404——effect 的返回值语义与
「把 disposer 当返回值」重叠，注册被当场拆掉。正确写法是把注册放进 effect 的 execute
内部、把清理闭包交出去：

```js
sub.effect(() => {
  const off = sub.webServer.register({ kind: 'exact', path: '/turn-cleanup/stats', handler })
  return () => off()
}, 'dsh-turn-cleanup: stats route')
```

`@deepseek-ai/dsh-client-modules` 自己也是这种写法。

**6. 后补 `dsh.client` 声明不会自动生效**

`client-modules` 把「这个包有没有 client 半」的结论缓存在 `pkgMeta` 里（含缓存的 `null`），
而这份缓存只在进程启动时清一次；`internal/plugin` 只对新 fiber 重扫，HMR 重跑 `apply`
救不回来。先装插件、后补 `dsh.client` 的情况会永久记成「没有 client 半」。

插件在 `apply` 里自己做一次兜底：清掉**本包自己**那条 `null` 缓存、标 dirty、手动
`flush()` 一次。日志里会有一行 `client entry recovered url=…`。拿不到内部字段就安静放弃，
退化成「重启 DSH 才出现面板」——那本来也是正常安装路径。

**7. steer 会把交付汇报折进「过程」**

`turn-stopping` 里 `agent.steer()` 让同一轮多跑一步，那一步成了 turn 的最后一步。而
chat UI 的 `latestAnswer(turn)` 取的是 **turn 内最后一个 step 的 assistant 文本**
（`latestAnswer(turn)`，见 `@deepseek-ai/dsh-client-ui-chat/lib/client.js`），于是真正的交付汇报被判成
「过程」折叠起来，屏幕上只剩清场汇报。

改成交付走 `agent.followup()`：清单排进 `next-turn`，本轮正常收尾、汇报仍是最后一步；
`kick()` 的 `while (await this.turn())` 会接着跑下一轮执行清场。默认就是这条路，
`steerMode: steer` 保留硬闸门。

**8. `ctx.inject()` 返回的是 thenable，没有 `.catch`**

cordis 4.1.0（DSH 0.2.2）的 `ctx.inject(services, callback)` 这样收尾：

```js
const fiber = new Fiber(this.ctx, config, Inject.resolve(plugin.inject), runtime, getOuterStack)
const wrapped = Object.create(fiber)
wrapped.then = (onFulfilled, onRejected) => fiber.await().then(onFulfilled, onRejected)
return wrapped
```

只挂了 `then`，没有 `catch` / `finally`。写成 `void ctx.inject(...).catch(handler)` 会在
`apply` 里同步抛 `ctx.inject(...).catch is not a function`——整个插件加载失败，闸门和面板
一起没了，而报错信息里连插件名都不出现。0.2.1 及更早时 `inject` 返回 fiber、`.catch`
也不存在，只是那行恰好没被跑到。

正确写法（同时兜住同步抛）:

```js
try {
  const fiber = ctx.inject(['webServer'], (sub) => { /* … */ })
  if (typeof fiber?.then === 'function') fiber.then(undefined, onInjectError)
} catch (error) {
  onInjectError(error)
}
```

`test/web.mjs` 的假 `ctx.inject` 现在照抄这个形状（`Object.create` + 只挂 `then`），
再写 `.catch` 测试当场红。

顺带一个同版本的变化：0.2.2 的 `client-modules` **删掉了 `pkgMeta` 缓存**，
`resolveMeta()` 每次 flush 都重新读 `package.json`。所以坑 6 的兜底不再能靠
「清掉那条 null 缓存」判断要不要干活——现在的写法是「有 `pkgMeta` 就清（老版本需要，
新版本自然是空集合），然后统一 `dirty.add(name)` + `flush()`」。

---

## 回滚

从 `cordis.patch.yml` 删掉 `- id: turn-cleanup` 整条即可，HMR 自动重载后闸门立即失效。
`local-pkgs/dsh-turn-cleanup` 留着不影响（不被 patch 引用就不会加载）。

---

## License

MIT
