# dsh-turn-cleanup

给 [DeepSeek Harness](https://github.com/deepseek-ai) 加一道收尾闸门：每轮 turn 结束前检查本轮留下的临时文件和超量 `.bak` 备份，一旦非空就把清单推回模型，要求清理或逐条说明理由。模型不处理，这一轮就结束不了。

分工很明确：插件负责**发现和提醒**，删不删由模型判断。唯一会自己动手的是可选开启的备份 `prune`，且只删备份副本。

装完即生效，无需改配置。

---

## 它解决什么

DSH 有三层机制本来都可能清理临时文件，实际上都不清理：

| 层 | 现状 |
| --- | --- |
| **框架层** | `agent/turn-stopping` 是天然的闸门（`serial`，await 在 turn 边界提交前），但现有消费者只用来记变更、写记忆，都不清理。 |
| **组件层** | 各组件只清自己的 `mkdtemp` scratch（`dsh-workspace-changes`、`dsh-sandbox-local`、`dsh-session-persistence-jsonl`、`dsh-attachment-local`），管不到别人留下的文件。 |
| **提示词层** | `AGENTS.md` 里「交付前把本轮临时件清掉」这类条款只有自觉力，模型忙着收尾时就忘了。 |

于是工作区逐渐堆起 `probe-*.mjs`、`check-*.sh`、`*.bak-*`，都是某次排查的遗骸，没人判断得了还能不能删。本插件把这条自觉条款变成代码闸门。

---

## 工作方式

### 闸门挂在哪

`agent/turn-stopping` 是 `serial` 模式，await 发生在 turn 边界提交**之前**。宿主 `dsh-agent-loop` 的收尾分支（行号随版本漂移，搜 `await this.dispatch.serial('agent/turn-stopping'` 更可靠）：

```js
if (turnEnds && this.inbox.nextStep.length === 0) {
  await this.dispatch.serial('agent/turn-stopping', { turn, signal });
  signal.throwIfAborted();
}
if (turnEnds && this.inbox.nextStep.length === 0) break;
```

`agent.steer(input)` 走 `send(input, 'next-step', true)`。listener 里 steer 之后 `nextStep.length` 变为 1，循环继续，**同一个 turn 多跑一步**。闸门的全部机制就在这一处。

### 四条检出通道

四条通道各自独立判定，命中任意一条即拦。

#### 通道 1 — 约定目录（主机制）

临时件放 `<cwd>/.agent-tmp/`（`tmpDirName` 可配）。turn 结束时该目录存在且非空，就拦。

边界清楚：不进这个目录的不算临时件。目录初始为空，没有存量包袱。

#### 通道 2 — 本轮写入追踪

挂 `fs/write-intent` / `fs/edit-intent` / `fs/delete-intent` 三个 waterfall，按 `session.id + turn` 分桶记录写入路径。三个都必须挂：宿主把「新建 / 覆盖」走 write-intent，「原地改」走 edit-intent，「删除」走 delete-intent（`dsh-tool-fs`、`dsh-tool-str-replace-editor` 各自 emit）。只挂 write 的话，模型用 `edit` / `str_replace` 造出来的临时件完全看不见。

体积另挂 `fs/observed`（写入成功之后才发），因为 write-intent 的 `next` 是空操作，回调那一刻文件还没落盘。

通道 2 只能覆盖两个宿主工具。`fs/*-intent` 由 `dsh-tool-fs` 与 `dsh-tool-str-replace-editor` 自己 emit，`dsh-ops` 一条都不发（`ops_write_file` / `ops_bash` 走自己的执行层），第三方工具更不会有。这部分由通道 4 兜底。

turn 结束时只检查**这些路径**里文件名匹配临时件特征的（`probe-*` / `tmp-*` / `scratch-*` / `check-*` / `check_*` / `diag_*` / `bench-*` / `bench_*` / `*.bak-*`，或位于 `.agent-tmp/`）。匹配对象是**文件名**，不是路径，大小写不敏感。

**绝不扫全工作区。** 存量未跟踪文件不参与判定，判定严格等于：

```
本 turn 记录 ∩ 模式匹配 ∩ 文件仍存在
```

用了几个月的工作区里躺着几十个 `probe-*`，扫全量的插件第一天就会被关掉。

#### 通道 3 — 备份保留

模型干活爱留备份当回滚点，任务一长就积压。实测一个 `cordis.patch.yml` 曾堆到 28 份 `.bak`。这条通道按「同目录 + 同原件名」把备份聚成家族，只留最近 `keep` 份（默认 3），其余列出来。

家族键只认 `.bak` 及其后的 `-` / `.` 分隔：`x` / `x.bak` / `x.bak-<后缀>` / `x.bak.<后缀>` 同族，`x.bakfoo` 不同族。**不假定时间戳格式**：实测命名五花八门（`.bak-0926`、`.bak-1793445543005`、`.bak-autodetect-20261102-080912`、`.bak-purge`、裸 `.bak`），按日期正则解析会漏掉一半。

只处理**本轮碰过的家族**。seeds 来自三个 intent 事件记录加 `.agent-tmp/` 扫描结果，推不出原件名的直接跳过。每个目录只 `readdir` 一次，不扫全盘。

两种模式：

- `mode: steer`（默认）：只把超量的列进清单，由模型判断并执行删除。和通道 1 / 2 / 4 一样，插件不动手。
- `mode: prune`：插件自己删。删的是副本，但不可逆，必须显式选择。

`prune` 有四道闸，任一不过就跳过该文件：

1. **原件必须仍在**。原件没了，那几份备份可能是唯一副本，整族跳过，一条都不删。
2. **`lstat` 是普通文件、不是符号链接**。不跟链，避免删到链外的真文件。
3. **不在保护段，且在工作区之内**。默认保护段 `.git` / `node_modules` / `out` / `dist` / `build` / `target` / `vendor` / `.venv` / `__pycache__`，可用 `protectedSegments` 整体替换。
4. **每轮删除条数上限**（`maxPrunePerTurn`，默认 50）。

刻意**不做**「备份比原件新就不删」：备份是某个历史状态的副本，原件比它新才是常态；原件比备份旧，往往意味着模型反复备份却一直没改原件，那正是要清的重复副本。而删的永远是最旧的那几份，最新 `keep` 份一律不动，价值损失有上界。

#### 通道 4 — 与工具无关的采集

通道 2 依赖 `fs/*-intent`，覆盖面只有两个组件。真实会话里 `ops_write_file` 的出现次数与 `write` 相当，光靠通道 2 会漏掉一半。

通道 4 不认工具名、不认参数键名，只认 `session/event` 里的 `tool/call` 加 `tool/result`：

1. `tool/call` 时把实参里所有像路径的字符串捞出来（递归扫值，跳过 `content` / `text` / `patch` 这类正文键；命令串按空白切开并跟踪 `cd` / `pushd` 换基准目录）。
2. `tool/result` 时对每个候选 `stat`，**mtime 在本轮开始之后的**才算「本轮碰过」。读文件不改 mtime，写文件一定改，这条判据把 `read` / `grep` / `glob` 顺手扫到的老文件挡在外面，不需要知道调用的是哪个工具。
3. `tool/call` 那一刻同步拍一次体积。宿主的 `invokeContainedSessionObservers` 不 `await` 监听器，工具本体紧接着执行；`rm -f x` 从发起到删完只有几毫秒，任何 `await` 都会让快照落在删除之后。这次快照只用于「已释放空间」记账，不进 steer 清单。

**这两步必须同步跑完**（`statSync` / `realpathSync`）。把 `tool/result` 的采集排进 `s.chain.then(...)` 之后，监听器一返回工具本体就执行了，等微任务真正跑到时文件已被 `rm` 删掉，体积永久丢失。同步调用与工具本体在同一个 tick 里，删得再快也抢不过。

分两本账：

| 账 | 范围 | 用途 |
| --- | --- | --- |
| `s.paths` | cwd 内 + mtime 是本轮的 | 进 steer 清单（可能叫模型去删） |
| `s.foreign` | cwd 之外（`%TEMP%`、`~/.cache`、别的盘） | 只记账，**永不进 steer 清单** |

工作区之外的东西不该由插件指挥模型去删，但删掉了多少空间照样该算。用户自己的清理脚本（`cd "$TEMP" && rm -f ...`）清的就是这一类：既不在 cwd 内，名字也常常不符合模式，两条老通道都看不见。

### 防抖：每 turn 只拦一次

按 `(sessionId, turn)` 记 `tripped` Set，第二次进 listener 直接 return，不管还剩几个文件。

没有这一条，模型每多跑一步就被再拦一次，turn 永远结束不了。`turn/end` 与 `session/disposed` 负责清 key。

### 明确不做

- **通道 1 / 2 / 4 永不删除任何文件**，只 steer，删不删、留不留由模型判断（交付物、用户文件、`.git`、`node_modules`、`out/`、`dist/`、`build/` 等保护段一律不碰）。只有通道 3 的 `prune` 模式会删，且只删备份副本，四道闸见上。
- **不做 `git status` 兜底**：大仓库慢，且存量未跟踪文件极多，容易误判。
- **子会话整段跳过**：`origin === "subagent"` 或 `delegationDepth > 0` 时直接 return，它们的 cwd 可能是别人的工作区。
- **listener 里不做慢操作**：只有 `readdir` / `stat` / `statSync`（同步的那几次只针对单次工具调用里捞出的有限路径，上界 200），不跑子进程、不扫大目录。`turn-stopping` 是串行 await，慢了会拖住每一次 turn 结束。

---

## 安装

包带 `dsh.bundle`，几种装法都行。**装完不用改任何配置**：包根的 `cordis.patch.yml` 会在安装时自动插入 loader 条目，所有配置项都有内置默认值。

**A. 从市场点安装（最省事）**

插件在 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 目录里，DSH 的 Plugins → Discover（或 dshmarket）搜 `turn-cleanup` 点安装即可。装完即生效，不用重启。

**B. 命令行（git 源，最通用）**

```bash
dsh plugin --profile <profile> add github:Leonlee114514/dsh-turn-cleanup
# 等价写法：
#   dsh plugin --profile <profile> add https://github.com/Leonlee114514/dsh-turn-cleanup
```

`<profile>` 换成你自己的：`~/.dsh/profiles/` 下有哪些目录就用哪个名字。这条不依赖 npm 上有没有这个包。

**C. npm 名（仅在这个包已发布到 registry 时可用）**

```bash
dsh plugin --profile <profile> add dsh-turn-cleanup
```

没发布过会报 `404 Not Found`，这时用 B。

包根的 `cordis.patch.yml` 会被自动应用，闸门默认开启，配置用默认值。要改配置就在自己 profile 的 `cordis.patch.yml` 里按同一个 id 覆盖，不要另加一条 `- insert`（同 id 两条会被 cordis 拒绝注册）。

**D. 手工 link（源码改动时用，改完 HMR 直接生效）**

```bash
# 1. 克隆到本地
git clone https://github.com/Leonlee114514/dsh-turn-cleanup.git ~/.dsh/local-pkgs/dsh-turn-cleanup

# 2. 在 profile 的 package.json 的 dependencies 里加一行
#    "dsh-turn-cleanup": "link:../../local-pkgs/dsh-turn-cleanup"

# 3. 建符号链接（pnpm install 在有远端依赖时会卡住，手工建更可靠）
#    <profile> 换成你自己的：~/.dsh/profiles/ 下有哪些目录就用哪个名字
DSH_PROFILE=<profile> node -e "
const { symlinkSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const profile = process.env.DSH_PROFILE;
if (!profile) { console.error('set DSH_PROFILE to your profile name'); process.exit(1) }
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

只想改个别默认值时，不要加第二条 `- insert`（同 id 两条会被 cordis 拒绝注册），而是加一条**顶层**（列 0）的行，合并进已有条目：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml，列 0 开始
- id: turn-cleanup
  config:
    steerMode: steer          # 同轮多跑一步，而不是排进下一轮
    logFile: /tmp/tc.log      # 落盘旁路
```

全部可覆盖项见下面的配置表；没写的键一律用内置默认值。

**装完要不要重启？** 走 A 不用：market 会把刚装的插件热挂载进当前组合，宿主侧 loader 条目和浏览器端面板同时上线。走 B / C 时 `dsh plugin add` 只写 `dsh.profile.bundles`，下次启动生效；想立刻生效就在 Plugins 页重新启用一次（market 会做同样的热挂载）。走 D 时 `dsh-hmr` 监听 `cordis.patch.yml` 与 `package.json`，改动即 `reconcileProfile()` 重组合，十几秒后新版本生效。

验证加载成功：

```
cordis_inspect_query → host / Config / listConfigs, name: dsh-turn-cleanup
```

`status: "absent"` 是正常的：它表示 fiber 已启动、未 disabled，但插件没导出 Config schema（本插件故意不导出，避免 schemastery 依赖）。显示 `inactive` 才是 import 失败。

---

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` → 完全不装闸门（连 listener 都不注册） |
| `tmpDirName` | `.agent-tmp` | 约定目录名，相对 cwd。反斜杠归一成 `/`；绝对路径 / 盘符一律回落 `.agent-tmp`（不让它跑出工作区） |
| `patterns` | `probe-*` `tmp-*` `scratch-*` `check-*` `check_*` `diag_*` `bench-*` `bench_*` `*.bak-*` | 文件名 glob，只支持 `*` / `?`，大小写不敏感；匹配的是 basename |
| `protectedSegments` | `.git` `node_modules` `out` `dist` `build` `target` `vendor` `.venv` `__pycache__` | 这些目录段下的东西一律不报；**给数组则整体替换**默认值 |
| `messageLocale` | `auto` | 注入文案语言：`auto` / `zh` / `en` |
| `scanDepth` | `4` | `.agent-tmp` 递归深度，1..6（根下文件算第 1 层） |
| `mtimeToleranceMs` | `2000` | 通道 4 的 mtime 容差，0..60000。`mtime + 容差 < 本轮开始` 才算老文件 |
| `maxLogPaths` | `10` | 日志里最多列几条 |
| `maxSteerPaths` | `20` | steer 文案里最多列几条 |
| `logFile` | `""` | 落盘旁路；相对 cwd 或绝对路径 |
| `steerMode` | `followup` | 交付方式：`followup` 另开一轮；`steer` 同轮多跑一步（见下） |
| `stats` | `true` | `false` → 不记账、不装 `/turn-cleanup/stats` 端点 |
| `statsFile` | `""` | 账本路径；留空 = `logFile` 同目录的 `turn-cleanup-stats.json` |
| `backupRetention.enabled` | `true` | `false` → 整个通道 3 关闭 |
| `backupRetention.keep` | `3` | 同一原件保留几份，1..20。`0` / 负数 / 非数字一律回落 `3`（不是夹成 1） |
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

默认 `followup` 是因为 chat UI 按 turn 折叠：`latestAnswer(turn)` 取的是 turn 内**最后一个 step** 的 assistant 文本（见 `@deepseek-ai/dsh-client-ui-chat/lib/client.js`，该文件是压缩过的 bundle，按函数名搜而不是行号）。steer 那一步成了最后一步，真正的交付汇报就被折进「过程」区，屏幕上只剩清场汇报。followup 把清单排到下一轮，本轮最后一步仍是汇报本身，折叠不会发生；`kick()` 的 `while (await this.turn())` 会在队列有内容时接着跑。

要更硬的闸门就设 `steerMode: steer`，接受汇报被折叠的代价。

---

## 注入文案

这段文字**直接注入模型回合**，语言可配（`messageLocale`，默认 `auto`）。`auto` 的回退链：`DSH_LOCALE` / `LC_ALL` / `LC_MESSAGES` / `LANGUAGE` / `LANG` → 系统区域设置（`Intl`）→ `en`。想固定就写 `zh` 或 `en`。

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

分两段而不是混在一起，是因为两件事的约束不同：临时件没有「保留几份」的概念，备份有；备份段还必须显式提醒「不要动原件、不要动最近 N 份」，否则模型容易把整族一起删掉。

消息对象带 `source: { kind: 'dsh-turn-cleanup', form: 'notice', summary }`。`kind` 不自称 `user`：宿主有若干处把 `source.kind === 'user'` 当人类授权（`dsh-tool-goal` 的 `hasDirectHumanInput()` 就是一例）。`form: 'notice'` 与宿主自己的 `modelSwitchNotice()` 对齐。

---

## 日志

`ctx.logger.info` 只写 Electron 主进程 stdout，进程一关就没了。要事后取证就配 `logFile`，每次拦截追加一行：

```
2026-11-07T03:43:31.838Z followup session=<id> turn=2 cwd=<cwd> files=2 paths=[.agent-tmp/scratch-run.log, probe-yyy.mjs]
```

行首是实际交付方式（`followup` / `steer`）。`prune` 模式自己删东西时另有三行，按结果分流：

```
prune        session=<id> turn=2 cwd=<cwd> deleted=3 bytes=12288 keep=3 paths=[a.bak-v0, a.bak-v1, a.bak-v2]
prune-failed session=<id> turn=2 cwd=<cwd> failed=1 keep=3 items=[a.bak-v0 (EACCES)]
prune-limit  session=<id> turn=2 cwd=<cwd> limit=1 deleted=1
```

- `prune` → `logger.info`：真删掉的清单，`bytes` 取自**删除前**的 `lstat().size`；
- `prune-failed` → `logger.warn`：`unlink` 抛错的条目，括号里是 `error.code`（没有 code 时退到 `error.message`）；
- `prune-limit` → `logger.warn`：撞到 `maxPrunePerTurn` 就停下，本轮不再删。没删完的备份下一轮仍会被列为超量，不会漏掉。

三条同样写进 `logFile`。写日志失败一律静默——落盘只是取证旁路，不能因为路径不可写而拖住 turn 边界。

---

## Web 面板

拦截了多少次、清掉多少文件、腾出多少空间、模型配不配合，光看日志要自己数。插件带一个面板：

- **设置页 → 收尾清场**：五张卡（已释放空间 / 拦截次数 / 报出文件数 / 已清文件数 / 依从率），下面是最近记录与按会话的分布表；范围可切「全部会话 / 当前会话」。模型自己先清干净、闸门没开口的轮次也记账（`kind: 'auto'`），所以「已释放空间」不会因为手脚太快停在 0。「拦截次数」只数**真拦下东西**的轮次（`kind !== 'auto'`）；`auto` 轮另有 `autoRounds` 字段，面板据此判断「有没有记录」而不是「有没有拦过」。
- **每个 turn 末尾一行徽章**：这一轮拦了什么、清没清、腾了多少。没拦过就不显示。徽章只播本轮的清单：`turnRecord()` 区分 `own`（本轮自己的事件）与 `carried`（上一轮 gate 带来复核的），`own === false` 且还没复核时整轮不渲染——否则 `followup` 模式下每个干净轮都会挂着上一轮的数字，看起来像「这一轮又留下 3 个临时件」。

### 「已释放空间」的算法

口径是「**本轮碰过、到 turn 结束时确实不存在的文件，都算已释放**」，由三部分相加：

| 字段 | 含义 | 什么时候有 |
| --- | --- | --- |
| `preCleanedBytes` | 本轮碰过、turn 结束前就已经不在了的文件 | 模型自己 `rm -f` 删的、或主动上报的；含 cwd 之外 |
| `cleanedBytes` | 闸门报出去、复核确认消失的文件 | 模型在闸门提醒之后才删的 |
| `pruned` | `prune` 模式插件亲手删的备份 | 取**删除前**的 `lstat().size` |

面板的「已释放空间」= `preCleanedBytes + cleanedBytes + pruned`。

第一项不能省。只算 `cleanedBytes` 时这张卡会长期显示 0 B——不是统计坏了，是模型几乎总在 turn 结束前就自己删干净了，闸门去 `stat` 时文件早就不在。110 个会话、49334 次工具调用的实测数据就是这样：清了就是清了，只是没经过闸门。

体积有四个来源，按可靠性排序：

1. **写完之后立刻量**。`fs/observed` 是宿主工具**写入成功之后**才发的事件，那时才拿得到真实大小，`state.paths` 因此是 `Map<abs, bytes>` 而不是 `Set<abs>`。不能挂在 `fs/write-intent` 上：那个 waterfall 的 `next` 是空操作，真正写盘发生在它之后，回调那一刻文件还不存在，量出来永远是 0。`fs/delete-intent` 例外，它在 `next()` **之前**量，因为之后文件就没了。
2. **`tool/call` 那一刻同步拍快照**（通道 4）。专治「不经过 `fs/*-intent` 的工具」和「写完又立刻删」，所以用 `statSync` 全同步拍，结果进 `s.touched`（只记账，不进 steer 清单）。
3. **模型主动上报**。`rm -f` 走子进程、不触发任何 intent，插件根本不知道那个文件存在过，所以有一个 `report_temp_cleanup` 工具（见下）。
4. **闸门自己 `stat`**。清单里还在的条目照旧量一次（只算普通文件，目录不计，一次最多 200 个）。

`fs/observed` 在读文件时也会发（`str_replace_editor` 的 `view`、`tool-fs` 的 `read`），payload 与写入后完全同形，所以只有「本轮已经有 intent 记过的路径」才补体积。否则读一个早就存在的 `probe-*.mjs` 会被当成本轮写过的临时件。

量不到就记为「未知」而不是 0，宁可少报不猜。第 4 条放在闸门最后、且只在 `stats` 打开时做：`agent/turn-stopping` 是串行 await，不该为了统计在 turn 边界上排队几百次 `stat`。

### `report_temp_cleanup` 工具

模型删完临时件后调一次：

```json
{ "files": [ { "path": "scratch/run.log", "bytes": 2048 }, { "path": "probe-x.mjs" } ] }
```

返回 `{ accepted, ignored, bytes }`。规则：

- `bytes` 可以省略（不知道就别猜，按 0 计）；
- **只采信确实已经不存在的**：上报后仍 `stat` 得到的文件不计入已释放，防止虚报；
- 闸门文案只在工具**真的注册成功**后才提它——让模型去调一个不存在的工具，比不给提示更糟；
- 宿主没有 `tools` 服务时不注册、不报错，退化成「靠 `stat` 猜」。

不硬写 `inject: ['tools']`：那会让插件在缺该服务的 profile 里整个不加载，闸门跟着一起消失。也不 import `@deepseek-ai/dsh-tools`：`ctx.tools.register()` 接受裸 JSON Schema，传裸 schema 就能保持零运行时依赖。

### 依从率

闸门拦下时把清单记进账本（`statsFile`），**下一轮 turn 结束**再回头 `stat` 一遍那些路径，结果是三态：

- 文件没了（`ENOENT` / `ENOTDIR`）→ `cleaned`
- 文件还在 → `remaining`
- **stat 报了别的错**（`EACCES`、`EBUSY`、网络盘断连 `ETIMEDOUT` / `EIO`…）→ `unknown`

`compliance = cleaned / (cleaned + remaining)`，`unknown` **不进分母**。

第三态不是可有可无：把「stat 失败」和「文件不在」当成同一件事，网盘掉线、权限不足就会一律按「已删除」计入 `cleaned`，`cleanedBytes` 凭空涨、依从率冲到 100%。汇总里对应 `unknown` / `recent[].verify.unknown` / `verify.unknownTemps` / `verify.unknownBackups`；面板的「复核」列显示成「已清 N / 仍在 M / 未知 K」，K 为 0 时不显示。

复核范围是**所有**「同 sid + 同 turn、且还没复核过」的记录，不是只取一条。同一 sid + turn 可能对应多条（resume 复用轮次、fork 出同 sid；`followup` 模式下上一轮 gate 的 `verifyAtTurn` 正好等于本轮的 `turn`，而本轮自己也可能写一条 `auto`）。只留最后一条的话，后写的 `auto` 会把真正拦过的那条 gate 挤掉，于是「待复核」只涨不落、`cleaned` / `remaining` 丢失、依从率分母偏小。现在逐个复核、`save()` 整批一次落盘。`auto` 事件不排除在外：它本来就没有清单，探针空转一次就得到「已复核的空结果」，成本可以忽略。

`prune` 自己删掉的备份直接计入 `cleaned`（有日志为证，不用等下一轮），且只加条数与字节，不重复累加 `preCleaned`——那部分在 `recordGate` 落账时已经由 `summary()` 计入。

### 数据端点

Host 半注册一个只读 JSON 端点，客户端同源 `fetch` 相对路径：

```
GET /turn-cleanup/stats                       # 全局汇总
GET /turn-cleanup/stats?scope=session&sid=…   # 单会话汇总
GET /turn-cleanup/stats?sid=…&turn=…          # 单轮记录，null = 这轮没拦过
```

只认 `GET` / `HEAD`，其余方法一律 `405` 并回 `allow: GET, HEAD`——宿主按 path 派发、不校验 method，任何 method 都会进到 handler，这一层得插件自己挡。`turn=` 给了但不是数字、或者给了 `turn=` 却没给 `sid` → `400`。`500` 只回固定文案 `stats unavailable`，完整堆栈进 `logger.warn`，不把账本路径暴露给页面。

`scope=session` 但没给 `sid` 时退回全局，否则前端切「当前会话」而会话 id 还没到位会拿到空面板。

汇总里的字节字段：`reportedBytes`（报出去的清单总共多大）、`cleanedBytes`（复核确认已消失的部分）、`preCleanedBytes`（模型在复核之前就自己清掉的）、`remainingBytes`（复核时还在的）。面板的「已释放空间」= `cleanedBytes + preCleanedBytes`（`prune` 删掉的备份已计入 `cleanedBytes`）。`bySession` 每行带前三个，`recent[].verify` 带 `cleanedBytes` / `remainingBytes`，`recent[]` 与单轮记录还带 `kind`（`gate` = 拦过模型，`auto` = 模型自己清干净了、只记账没打扰）与 `preCleaned`。

**体积字段在行顶层，不在 `verify` 里。** `recent[]` 每行是 `{ at, kind, turn, sid, preCleaned, preCleanedBytes, cleanedBytes, verify }`，`verify` 只装复核那一刻的 `{ cleaned, remaining, cleanedBytes, remainingBytes }`。面板算「已释放」时必须把**整行**喂给 `freedBytes(row)`：喂 `row.verify` 会让「最近记录」那一列在模型自己先清干净的轮次上恒显示 0，而那正是最常见的情形。两个字节字段缺一不可，而 `freedBytes` 用 `typeof row?.cleanedBytes === 'number'` 把 `undefined` 静默当 0，只写一个不会报错，只会悄悄少算。

**`bySession` 恒基于全量事件，不随 `scope` 收窄。** 它是会话下拉与对比表的唯一数据源；拿过滤后的事件累加，`?scope=session` 时就只剩一行——下拉永远一个选项、对比表恒隐藏，而数字卡又确实是全量，两边看起来互相矛盾。现在 `bySession.length === sessionCount`（字段 `sessions` 是别名，保留给老前端），表有没有内容由行数决定，与 `scope` 无关。

**`preCleaned` 明细只存前 100 条。** 一轮里模型自己清掉的文件数可能上千，账本不该被它撑爆。超出的部分折成 `preCleanedOmitted`（条数）与 `preCleanedOmittedBytes`（字节），`preCleaned` 与 `preCleanedBytes` 仍是**完整**口径（`preCleaned + preCleanedOmitted`），面板和汇总不受影响。

### 账本文件

`statsFile` 是一份 `{ version: 4, events: [...] }` 的 JSON，超过 1000 条时先丢**已复核过**的老事件（`verify !== null`），不够再按时间丢最旧的。

写入是「先写 `同名文件.tmp-<pid>-<序号>` 再 `rename`」：`rename` 在同一分区上是原子的，进程中途被杀只会留下一个孤儿 tmp，账本本身不会截断。直接 `writeFile` 目标文件的话，中途被杀就是半截 JSON，下次 `load` 当空账本、再 `save` 把历史永久抹掉——账本丢过一次就再也回不来。

读到坏 JSON 不会让插件炸掉，也不会静默覆盖：先 `rename` 成 `同名文件.corrupt-<ISO 时间>` 留证，再以空账本继续跑。`load()` 是**幂等**的（第一个调用者建 Promise，后续全等同一个），所以 `recordGate` 与面板请求并发时不会出现「一个拿到空账本、另一个把它的 events 整块覆盖」的竞态。

不走 `remote.*` RPC 的原因：本插件没有 host 服务对象，注册一条 HTTP 路由比造一套 service 加 RPC 契约轻得多，也不用管 relay / 远程模式的 origin 探测。

`stats: false` 就完全不记账、不装端点，闸门本身照旧。

---

## 宿主兼容

只用 Node 内建（`node:fs/promises`、`node:crypto`、`node:path`）加几个宿主钩子，没有运行时依赖、没有 `peerDependencies`。

宿主兼容闸门读的是**顶层 `engines.dsh`**（见 `dsh-app-boot` 的 `unmetRequirements()`：先看 `fields.engines.dsh`，没有才退到 `peerDependencies` 里名为 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的项）。这个字段必须在顶层，写在 `dsh.engines.dsh` 下面既拦不住也不会告警。`dsh.bundle.patch` / `dsh.client` 仍在 `dsh` 下面，那两个是真的。

实测跑过的宿主：

| DSH | cordis | 状态 | 差异 |
| --- | --- | --- | --- |
| 0.2.1-rc.5 | 4.0.5 | ✅ | 基线 |
| 0.2.2-rc.2 | 4.1.0 | ✅ | `ctx.inject()` 变 then-only；`client-modules` 删掉 `pkgMeta` 缓存 |

依赖的钩子在这两个版本里语义一致：`session/event`（`turn/start` / `turn/end` / `tool/call` / `tool/result`）、`session/disposed`、`fs/write-intent` / `fs/edit-intent` / `fs/delete-intent`、`fs/observed`、`agent/turn-stopping`、`agent.steer` / `agent.followup`、`ctx.webServer.register`、`ctx.effect`，以及可选的 `workingDirectory` 服务（存在就用它取运行时 cwd，不存在退回 `session.header.cwd`）。

`session/event` 是通道 4 的立足点：宿主对**每个**已提交事件都同步派发 `(session, event)` 给所有监听器（`collectSessionCallbacks` → `invokeContainedSessionObservers`），`tool/call` / `tool/result` 也在其中，所以不必依赖任何具体工具的实现。

客户端 half 声明了 `dsh.client.inject: ["@deepseek-ai/dsh-client-ui-chat", "@deepseek-ai/dsh-client-ui-settings-general"]`，它注册的 `conversation.chat.turnTail` 与 `settings.section` 两个 slot 分别由这两个包提供。这个字段是**客户端模块的加载顺序依赖**（`dsh-client-modules` 按它做拓扑排序，查不到就静默跳过），不是 cordis 服务注入。

`ctx.inject()` 在 0.2.2 变成 then-only，对着它 `.catch()` 会在加载时抛错，插件整个不生效（闸门、面板全无）。升级宿主后如果看不到面板、也没有 `turn-cleanup.log`，先查这一条。

---

## 测试

单元测试用假 ctx 模拟 agent-loop 的调用顺序，不依赖 DSH 运行时：

```bash
npm test        # 82 + 42 + 48 + 43 + 17 + 26 = 258 checks passed（本机）
                # CI 上是 87 + 42 + 48 + 43 + 17 + 26 = 263 —— 见下
npm run verify  # syntax check + test
```

六份测试各管一段：

| 套件 | 覆盖 | 项数 |
| --- | --- | --- |
| `test/sim.mjs` | 闸门与通道 1 / 2 / 3 | 82（本机）/ 87（CI） |
| `test/web.mjs` | StatsStore 与 `/turn-cleanup/stats`、体积字段、405 / 400 契约、`bySession`、then-only 的 `ctx.inject`、冷启动 | 42 |
| `test/client.mjs` | 用假 `window.__ModuleLoader__` 加载真实 bundle，断言 slot 形状、locale 字典、`fmtBytes` 进位、recent 行释放体积 | 48 |
| `test/report.mjs` | `report_temp_cleanup` 上报、`fs/observed` 体积、账本并发 `load`、坏账本隔离 | 43 |
| `test/tool-agnostic.mjs` | 通道 4 的不认工具名采集 | 17 |
| `test/regress.mjs` | `AUDIT-logic.md` 里在别的套件构造不出来的反例：同轮 `gate(N)` + `auto(N+1)` 抢复核点、纯 `auto` 不涨拦截次数、cwd 含空格、多链接体积 | 26 |

六份都在 CI 里跑（ubuntu × node 20/22/24，加 windows / macos），七个测试 step 全部带 `if: always()`：一个套件红不该把其余证据一起吞掉。

`sim` 在本机是 82 项、CI 上是 87 项。差的 5 项是场景 11 的符号链接断言——Windows 非管理员建不了 file symlink，本机走一条 `SKIP`（计 1 项通过），runner 上真跑 6 项。**本机比 CI 少 5 项是正常的，反过来才要查。**

### 几组关键回归

**可移植性**：正常业务文件名（`checkout.js` / `Checklist.md` / `benchmark.ts`）不误伤，带分隔符的 `check-1.sh` / `bench_2.mjs` 仍命中，`protectedSegments` 可整体替换，`fs/edit-intent` 与 `fs/delete-intent` 也记账，`messageLocale` 中英切换，`workingDirectory` 服务优先于 `header.cwd`，cwd 是 junction 时经 realpath 归一仍能命中。

**数据安全**，每一条都对应「本来会毁掉东西」的场景：

- `README.bak.md` 名字里带 `.bak` 但不是备份，`keep: 1` + `prune` 之后必须仍在；
- `x.bak.bak` 不并入 `x` 的家族（家族判定不递归剥离）；
- `keep: 0` 回落 3 而不是夹成 1（6 份只删 3 份，不是删 5 份）；
- `scanDepth: 4` 报到第 4 层、第 5 层不报；`tmpDirName: '../escape'` 越界后被 `insideCwd` 拦下；
- `tmpDirName: 'tmp\\agent'` 归一成 posix 后仍命中，`'D:\\x'` 回落 `.agent-tmp`；
- `mtimeToleranceMs: 0` 时刚被改过的文件不算老文件，默认 2000 时算；
- `maxPrunePerTurn: 1` 时只删 1 份并留 `prune-limit` 日志，剩余备份下轮继续。

### 真实桌面验收

在一台真实 DSH 桌面上跑过十二项，全部通过：

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
| 11 | client bundle 进 boot graph | ✅ bundle 可取到且可解析；URL 上的 `rev` 是必需参数，缺了返回 404 |
| 12 | 插件加载不抛错 | ✅ apply 无异常，端点与徽章正常 |

---

## 回滚

从 `cordis.patch.yml` 删掉 `- id: turn-cleanup` 整条即可，HMR 自动重载后闸门立即失效。`local-pkgs/dsh-turn-cleanup` 留着不影响（不被 patch 引用就不会加载）。

---

## License

MIT
