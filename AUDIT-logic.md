# dsh-turn-cleanup 代码逻辑层审查报告

- 审查对象：本仓库工作树（`package.json` 0.8.0，审查基线 git HEAD `95bdfde` / tag v0.7.3）
- 审查范围：`lib/index.js`(1725) / `lib/stats.js`(675) / `lib/client.js`(551) / `lib/messages.js`(103) / `cordis.patch.yml` / `test/*.mjs`(2005)（括号内为审查时的行数，修复后为 1820 / 726 / 561 / 103 / 2312）
- 方法：全文逐函数阅读 → 建立数据流图 → 对每条可疑路径写最小探针实测 → 回读宿主源码（`@deepseek-ai/dsh-agent-loop`、`dsh-fs-local`、`dsh-tool-fs`）确认事件契约
- 基线：`npm test` 全绿（sim 82 / web 42 / client 48 / report 43 / tool-agnostic 17）
- 修复后：`npm test` 全绿（同上 + `test/regress.mjs` 26 = 258 checks），详见第十节

---

## 一、结论摘要

架构判断：**核心链路是正确的**。闸门的四道安全阀（`insideCwd` / `hasProtectedSegment` / `lstat`+`isSymbolicLink` / `requireOriginalPresent`）全部落实到了删除动作前，`pruneBackups` 只删 `plan.excess` 而不动 `kept`，双层 catch 保证闸门异常永不阻断 turn 结束。台账的写盘原子性（tmp+rename）、读盘并发门（`loading` 是 Promise 而非布尔）、坏账本隔离（`.corrupt-` 后缀）都做对了，注释里保留了历史事故，这些是罕见的工程纪律。

问题集中在**统计与展示层**，而非删除层。一共 13 条，按影响排序：

| # | 严重度 | 位置 | 一句话 | 状态 |
| --- | --- | --- | --- | --- |
| A | **P1** | `lib/stats.js:398-411` | `verify()` 只复核最后一条匹配事件，followup 模式下 gate 事件被同轮 auto 事件永久顶掉 | 已修 |
| L | **P1** | `lib/stats.js:614-620` | `turnRecord()` 把上一轮清单串进本轮徽章，干净轮也显示残留数字 | 已修 |
| C | **P1** | `lib/stats.js:620,643` | 同一函数把 gate 与 auto 聚合，`kind` 被改写成 `auto` | 已修 |
| B | P2 | `lib/stats.js:545-552` | 最近记录按 (sid,turn) 去重，gate 行被后写的 auto 行挤掉 | 已修 |
| K | P2 | `lib/stats.js:585` + `lib/client.js:17,419` | 「拦截次数」把没拦的轮也算进去；连带让「还没有拦截记录」提示永不出现 | 已修 |
| E | P2 | `lib/index.js:294,322` | 路径提取先按空白切再剥引号，含空格的路径被切碎 | 已修 |
| M | P2 | `lib/index.js:620-641` | 体积按 `stat` 全量计，符号链接记目标体积、硬链接记整份 inode | 已修 |
| G | P2 | `lib/index.js:1064` | `turn-stopping` 不读 `signal`，abort 后仍能通过 followup 唤醒下一轮 | 已修 |
| I | P3 | 全文 | 无熔断：模型连续多轮不配合时闸门不会自我收敛 | 不改（见 §九） |
| J | P3 | `lib/index.js:661` | 相对 `logFile` 跟会话 cwd 漂移，与 `statsFile` 的基准不一致 | 已修（打点） |
| N | P3 | `lib/index.js:1102-1133` | 只拿到占位 `undefined` 体积的路径，最终按 0 字节计入已释放 | 已修（文案） |
| D | P3 | `lib/index.js:961-971` | `state`/`tripped` 仅靠 turn/end 清理，进程崩溃时残留（仅内存） | 不改（见 §九） |
| H | P3 | `lib/index.js:430-436` | `targetPath` 丢弃 `displayPath`，只认 `targetKey`；宿主契约下安全，第三方工具传未归一 key 时漏记 | 已修 |

另有 1 条**口径说明缺失**（F）和 8 条**读起来像 bug 但实际正确**的疑点，见第四、五节。逐条修复记录见第九节。

---

## 二、P1：统计链路的三处断裂

A、L、C 三条共用同一个根因：**`(sid, turn)` 不是账本事件的唯一键**，而 followup 模式刻意让 `turn` 与 `verifyAtTurn` 错位一轮。三处消费方各自用不同方式弥补这个错位，结果三种错法。

### A. `verify()` 只取最后一条匹配事件 → gate 永久悬空

现场 `lib/stats.js:398-411`：

```js
// 只取**最后一条**匹配事件。sid + turn 不是唯一键：会话 resume 后轮次会复用、
// fork 出来的是同一个 sid，一次 verify 把两条不同 cwd 的事件一起复核会让
// 「已清」虚高。新事件永远在尾部，取最后一条就是当前这一轮。
let target = null
for (const event of this.events) {
  if (event.sid !== String(sid)) continue
  const when = Number.isFinite(event.verifyAtTurn) ? event.verifyAtTurn : event.turn
  if (when !== at) continue
  if (event.verify !== null && event.verify !== undefined) continue
  target = event
}
if (target === null) return
```

注释的顾虑（resume 复用轮次、fork 同 sid）是真实的，但修法选错了。看两条事件的 `verifyAtTurn` 取值：

- gate 事件：`lib/index.js:1341` `verifyAtTurn: cfg.steerMode === 'followup' ? turn + 1 : turn`
- auto 事件：`lib/index.js:1282` `verifyAtTurn: turn`（注释理由是「这一轮没有清单可复核…用 turn + 1 会让这条账永远挂着待复核」）

默认 `steerMode: 'followup'` 下，turn N 拦了东西 → gate 事件 `verifyAtTurn = N+1`；turn N+1 模型自己清干净 → auto 事件 `verifyAtTurn = N+1`。两个 `when` 相等，auto 写得更晚，`target` 停在 auto 上。turn/end(N+1) 调 `stats.verify(sid, N+1)`（`lib/index.js:968-971` 固定传 `data.turn`）→ gate 事件永远 `verify === null`。

而 auto 事件 `temps: []`、`backups: []`、`sizes: {}`，「复核」它只产生一条 `cleaned: 0, remaining: 0` 的空记录。

**实测**（探针复刻两个 store 的完整状态机）：

```
[followup] gate(t1).verified = false | auto(t2).verified = true
gates=2 verified=1 unverified=1 compliance=null
```

**影响**：`unverifiedEvents` 系统性偏高（每个被 auto 跟随的 gate 全部计入）、`cleaned`/`remaining` 丢失该轮的整个清单、依从率分母偏小。面板「最近记录」的复核列永远显示 `pending`。数据不说话，账本就失去意义。

**修法**（改 `lib/stats.js:398-411`，其余不动）：

```js
const pending = []
for (const event of this.events) {
  if (event.sid !== String(sid)) continue
  const when = Number.isFinite(event.verifyAtTurn) ? event.verifyAtTurn : event.turn
  if (when !== at) continue
  if (event.verify !== null && event.verify !== undefined) continue
  pending.push(event)
}
if (pending.length === 0) return
// gate 事件带清单，必须复核；auto 事件没有清单，复核它只会产生一条空记录
// 并抢走本该给 gate 的复核机会。resume 复用轮次时 pending 可能多于一条，
// 每条各自 stat 自己的 temps/backups，不会互相污染（清单已按事件隔离）。
const actionable = pending.filter((event) => event.kind !== 'auto')
for (const target of (actionable.length > 0 ? actionable : pending)) {
  /* 原 verify 主体，把 `target` 改成循环变量即可 */
}
```

这也顺带解决了「auto 白占一次复核机会」。

### L. `turnRecord()` 把上一轮清单串进本轮徽章

现场 `lib/stats.js:615-621`：

```js
// 匹配 turn **或** verifyAtTurn：followup 模式下事件记在 turn N、复核在 N+1，
// 徽章在第 N+1 轮挂载时查的是 N+1，只比对 e.turn 会永远返回 null（徽章整轮不渲染）。
const hit = this.events.filter(
  (e) => e.sid === String(sid) && (e.turn === at || (Number.isFinite(e.verifyAtTurn) && e.verifyAtTurn === at))
)
```

注释解释了动机（徽章要在下一轮显示复核结果），但**没有区分「本轮自己的记录」与「为了显示复核结果而带上的上一轮记录」**，两者被平铺进同一组累加器。

**实测**（turn 7 拦 2 临时件 + 1 备份，turn 8 完全干净）：

```
turnRecord('sess-B', 8) = {"kind":"gate","turn":8,"verifyAtTurn":8,"temps":2,"backups":1}
判定：本轮干净却在徽章上显示上一轮的清单 ← 缺陷
```

**影响**：默认 followup 模式下，**每一条拦截之后的那一轮，徽章都会挂着上一轮的数字**。用户在第 8 轮看到「2 temps · 1 backup」，理解成第 8 轮有东西没清。这与 `README.md:395`「每个 turn 末尾一行徽章：这一轮拦了什么……没拦过就不显示」直接矛盾。

**修法**：`turnRecord` 增加自有标记，客户端据此决定渲染。

```js
// lib/stats.js turnRecord 返回值增加：
const own = hit.some((e) => e.turn === at && e.kind !== 'auto')
return { ..., own, ... }
```

```js
// lib/client.js TurnBadge（:434-518）在 record 判定处：
if (record === null) return null
// 只有 carry（本轮无自有记录、仅带出上一轮的复核结果）时不渲染清单数字，
// 避免「没拦过就不显示」的承诺被打破。
if (!record.own && record.verified !== true) return null
```

若希望保留「上一轮的东西现在清了」这层信息，更干净的做法是徽章文案改成「上轮 2 个临时件已清」，而不是把 `temps/backups` 混进本轮计数。

### C. `turnRecord()` 聚合 gate + auto，且 `kind` 被改写

同函数 `lib/stats.js:643`：

```js
if (e.kind === 'auto') kind = 'auto'
```

`hit` 同时包含 gate(N) 与 auto(N+1) 时，`temps`/`backups`/`pruned`/`preCleaned` 全部相加，`kind` 被后到的 auto 覆盖，`verifyAtTurn`/`steerMode` 也是「每条覆盖」（最终值取决于数组顺序）。

**实测**（steer 模式，同轮 gate 带 1 个临时件 + auto 带 1 个 preCleaned）：

```
turnRecord = {"kind":"auto","temps":1,"preCleaned":1,"verified":true}
```

即徽章显示「1 temps」但 `kind` 是 auto —— 一个从未拦过东西的记录被标成了拦截，两个不同来源的数字被折叠成一个。

**修法**：与 L 同源。`own` 标记落地后，`kind` 应取自有记录的值；聚合只对同一 `turn` 的事件做。

---

## 三、P2

### B. 最近记录去重方向反了

现场 `lib/stats.js:545-552`：

```js
const seen = new Set()
const rounds = []
for (let i = all.length - 1; i >= 0 && rounds.length < 20; i -= 1) {
  const e = all[i]
  const key = `${e.sid}\u0000${e.turn}`
  if (seen.has(key)) continue
  seen.add(key)
  rounds.push(e)
}
```

注释说「auto 与 gate 会同时出现，单轮最多两条，按条截断实际只覆盖约 10 轮」—— 目标达成，但**倒序扫描让同轮保留的是后写的那条**，而 gate 总在 auto 之前写。于是「最近拦截」列表里，被 auto 跟随的 gate 行全部消失。

**实测**：turn 5 同轮 gate + auto → `recent = 5:auto`，gate 行不存在。

**修法**：同轮优先保留 gate。

```js
const byTurn = new Map()
for (const e of all) {
  const key = `${e.sid}\u0000${e.turn}`
  const prev = byTurn.get(key)
  // 同轮优先留 gate（带清单、有语义的那条）
  if (prev === undefined || (prev.kind === 'auto' && e.kind === 'gate')) byTurn.set(key, e)
}
const rounds = [...byTurn.values()].slice(-20)
```

`Kind` 的显示也需要跟着看：如果确实要展示 auto 行，图标或标签要能让用户区分。

### K. 「拦截次数」把没拦的轮也算进去

现场 `lib/stats.js:585` `gates: all.length`，而 `all` 包含 `kind: 'auto'` 事件。 `bySession` 的 `row.gates += 1` 同样。

文案 `lib/client.js:17-18`：

```js
cardGates: '拦截次数',
cardGatesHint: 'turn 结束被拦下的次数',
```

auto 事件的语义是「这一轮有东西被清，但闸门没开口」（`lib/index.js:1256` 的 `askNothing` 分支）。它记进账本是为了算「已释放空间」，不是一次拦截。

**实测**：只写一条 auto 事件 → `summary('all').gates === 1`。

**连带**：`lib/client.js:419-420`

```js
stats !== null && stats.gates === 0 ? h('p', ... t('noData')) : null
```

只要有 auto 事件，`gates > 0`，空状态提示「还没有拦截记录」就再也不出现 —— 即使一次拦截都没有。

**修法**：

```js
// lib/stats.js summary()
gates: all.filter((e) => e.kind !== 'auto').length,
autoRounds: all.filter((e) => e.kind === 'auto').length,   // 可选，用于面板说明
```

```js
// lib/client.js:419
stats !== null && stats.gates === 0 && stats.preCleaned === 0 ? h('p', ...) : null
```

### E. 含空格的路径被切碎

现场 `lib/index.js:291-296` 与 `:322-324`：

```js
const tokens = raw.split(/[\s;&|()<>]+/)
...
for (let i = 0; i < tokens.length; i += 1) {
  const piece = unquote(tokens[i])
  ...
function unquote(token) {
  return token.replace(/^["']+|["']+$/g, '')
}
```

`unquote` 只处理**已经切开**的单 token。引号在切分时就被当成普通字符留在 token 端点，跨空格的引用无法重建。

**实测**（5 个用例）：

| 输入 | 结果 |
| --- | --- |
| `C:\Users\me\Desktop\my project\tmp-a.txt` | `[{path:"C:\\...\\my"}, {path:"project\\tmp-a.txt"}]` ← 切两段，都 stat 不到 |
| `rm -f "C:\...\my project\tmp-a.txt"` | 同上两段（引号救不回来） |
| `cd "C:\...\my project" && rm -f tmp-a.txt` | `[{path:"tmp-a.txt", base:"C:\\...\\my"}]` ← base 被切坏 |
| `cd .agent-tmp && rm -f a.txt` | 正常 |
| `bash -c 'rm -rf ./out/*.log'` | 正常 |

**影响面**：只影响 `s.touched` / `s.foreign`（这两个 Map 只进 `preCleaned` 记账，永不进 steer 清单）。`s.paths` 由 `fs/*-intent` 直接给绝对路径，不受影响。但 Windows 用户名含空格（`C:\Users\John Doe\`）是常见形态，属真实漏记 → 「已释放空间」偏低。

**修法**：把切分改成引号感知。最小实现：

```js
function shellTokens(raw) {
  const out = []
  let cur = ''
  let quote = ''
  for (const ch of raw) {
    if (quote !== '') {
      if (ch === quote) quote = ''
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (/[\s;&|()<>]/.test(ch)) { if (cur !== '') { out.push(cur); cur = '' } continue }
    cur += ch
  }
  if (cur !== '') out.push(cur)
  return out
}
```

配合一条回归用例：`test/sim.mjs` 加一个 cwd 含空格 + `cd "…/my dir" && rm -f x.txt` 的场景。现有 82 条测试里**没有任何含空格路径用例**，这条一直没被抓到。

### M. 体积按 `stat` 全量计，符号链接与硬链接都虚增

现场 `lib/index.js:620-641`（`measureSizes`）：

```js
const info = await stat(isAbsolute(rel) ? rel : join(cwd, rel))
if (info.isFile()) out[rel] = Number(info.size) || 0
```

对比 `measureOne`（`lib/index.js:993-999`）用的是 `lstat`，`pruneBackups`（`lib/index.js:585-604`）用 `lstat` + `isSymbolicLink()` 拒删。三个量体积/判删除的地方口径不一致。

**两条虚增路径**：

1. **符号链接**：`scanTmpDir`（`lib/index.js:470-476`）明确「符号链接当文件报出来，但不跟进目录」→ `out.push(rel)`。该 rel 进 candidates，`measureSizes` 用 `stat` 跟随链接 → 记下**目标文件体积**。模型后来 unlink 掉那个链接，`verify` 的 `probe()` 看到 absent → `cleanedBytes += 目标体积`。实际释放 ≈ 0（链接自身只有几十字节，且目标还在）。
2. **硬链接**（同一 inode 多份链接，`cp -l` 备份、pnpm store、Git worktree 常见）：`stat` 与 `lstat` 都返回完整 inode 体积，unlink 一份链接后其他链接仍在，实际释放 0。

**实测**（符号链接版因 Windows 非管理员 `symlink` 抛 `EPERM`，改用无需特权的硬链接复刻同一路径）：

```
stat(hl).size = 5242880
cleanedBytes = 5242880   （原件 big-target.bin 仍在，实际释放 = 0）
```

**修法**：`measureSizes` 改 `lstat`，并对 `nlink > 1` 的体积记 0 或标注。

```js
const info = await lstat(abs)
if (!info.isFile()) return
// 符号链接：unlink 只释放链接自身，不该按目标体积记账
if (info.isSymbolicLink()) { out[rel] = 0; return }
// 多链接 inode：删掉一份链接不代表释放空间（还有其他链接指着同一个 inode）
out[rel] = info.nlink > 1 ? 0 : (Number(info.size) || 0)
```

注意 `measureOne` 也应同步加 `nlink` 判据。

### G. `turn-stopping` 不读 `signal`，abort 后仍能唤醒下一轮

`grep -c "signal" lib/index.js` → **0**。回调签名 `lib/index.js:1064`：

```js
ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
```

而宿主确实传了 signal —— `dsh-agent-loop/lib/index.js:810-816`：

```js
await this.dispatch.serial("agent/turn-stopping", { turn, signal });
signal.throwIfAborted();
if (turnEnds && this.inbox.nextStep.length === 0) break;
```

派发返回后宿主立刻 `throwIfAborted()`。插件在 `measureSizes`（最多 200 次 stat、分批并发）期间用户按了中断，插件跑完后仍会走到 `agent.followup(message)` / `agent.steer(message)`。

`followup` 的语义在 `dsh-agent-loop/lib/index.js:579-592`：

```js
followup(input) { this.send(input, "next-turn", true) }   // 新开一轮
steer(input)    { this.send(input, "next-step", true) }
```

`sender` 里 `resolvedTarget = wakingAfterAbort ? "next-turn" : target` —— **abort 后发 followup 会唤醒一个用户没要求的下一轮**。这不是「白做功」，是行为越界。

**修法**：签名解构出 signal，在三个 await 点后各查一次。

```js
ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
  const aborted = () => signal !== undefined && signal.aborted === true
  ...
  const tmpScanned = await scanTmpDir(...)
  if (aborted()) return
  ...
  if (aborted()) return
  ...  // 发消息之前
  if (aborted()) return
```

注意不要用 `signal.throwIfAborted()`（会把异常抛进 catch 里记成 `gate error`，污染日志）。

### I. 无熔断

`grep -n "attempt|retry|streak|maxRound|consecutive|count" lib/index.js` → **无命中**。插件只有 `tripped`（`lib/index.js:1069-1070`）防同一 turn 二次触发，没有跨轮的记忆。

设计上「插件只拦不删，判定和执行都由模型完成」是清晰的，但没有上限意味着：模型连续 20 轮不配合时，闸门连续 20 轮 followup。每一轮都在 turn-stopping 的 serial 路径上跑 `scanTmpDir` + `planBackups` + `measureSizes`，且每轮都新开一个 turn。

**这不是 bug 而是设计缺口**，但如果要补，最小形态是给 `state` 加 `strikes: Map<abs, count>`，同一路径被报出 N 次（默认 3）后转成「只记账、不拦」，并在日志里打 `escalate`。

---

## 四、P3

### J. 相对 `logFile` 跟会话 cwd 漂移

`lib/index.js:661`：

```js
const abs = isAbsolute(cfg.logFile) ? cfg.logFile : join(cwd || process.cwd(), cfg.logFile)
```

`cwd` 是当前会话的，所以 `logFile: 'turn-cleanup.log'` 在 A 会话写 `A/turn-cleanup.log`、B 会话写 `B/turn-cleanup.log`。而 `statsFile` 的解析（`lib/index.js:704-711`）显式用 `process.cwd()` 并加了注释说明「账本全机一本、apply 早于任何会话」。同一份配置里两个路径字段用了两套基准。

**修法**：统一用 `process.cwd()`，或统一用 `$DSH_HOME`（`defaultStatsFile` 已有一半逻辑）。若刻意要按会话分文件，注释要写明理由 —— 现在读起来像疏漏。

### N. 占位 `undefined` 体积最终按 0 计入

`s.paths.set(abs, void 0)`（`lib/index.js:1020`）是「知道有文件、还不知道多大」的占位。两条补偿路径：`fs/observed` 的 CAS 回填（`lib/index.js:1036-1062`）、`early` 快照（`lib/index.js:1003`）。

但若某工具既不经过 `fs/*-intent` 也不发 `fs/observed`（注释 `lib/index.js:896-900` 提到 `dsh-ops` 一条都不发），体积就永久停在 `undefined`。走到 `preCleaned.push({ rel, size: knownSize })` 时 `size: undefined`，`recordGate` 里 `Number.isFinite(Number(undefined))` → false → 0。

**影响**：这类文件的「已释放空间」贡献为 0，但计数 +1（体积与计数口径分裂）。属可接受的降级（宁可少报，与 `probe` 的三态哲学一致），但面板上「报了 N 个文件、释放 0 B」会让用户困惑 —— 建议在 `cardReportedHint` 里说明「部分文件体积未采到」。

### D. `state`/`tripped` 残留

`state` 在 turn/end（`lib/index.js:961-966`）与 `session/disposed` 清理。已核宿主 `dsh-agent-loop/lib/index.js:846-860`：abort 与 error 都会在 `finally` 里 append `turn/end`，所以只有**进程崩溃 / sessions-quarantine** 才残留。残留量级是一个 `Map<session, 若干 Map>`，仅内存、不落盘，进程重启即清。

**结论：不改也可**。若想彻底，用 `WeakMap`（session 对象作键，天然随 GC 回收）替代 `Map` —— 但 `tripped` 的键是 `session.id` 字符串，得跟着改成 `WeakMap<session, Set<turn>>`。

### H. `targetPath` 丢弃 `displayPath`

`lib/index.js:430-436`：

```js
function targetPath(target) {
  if (typeof target === 'string') return target
  ...
  if (typeof target.targetKey === 'string') return target.targetKey
```

已核宿主契约：`dsh-fs-local/lib/index.js:180-220` 的 `resolveLocalTarget` 返回 `{ displayPath, targetKey: FsTargetKey(await realpath(displayPath)) }`，**`targetKey` 恒为 realpath 身份**（目标不存在时走「最近存在祖先 realpath + 拼缺失后缀」）。所以真实宿主下这个函数拿到的一直是归一化路径，与 `canonicalCwd` 的归一方向一致。

风险只在**第三方工具或插件自己构造 target 对象**时：若传 `{targetKey: '未归一路径'}`，`insideCwd(cwd, abs)` 会算出 `..\..` → 该路径被当成 cwd 外 → 通道 2 `continue` 丢弃。

**实证边界**（junction 探针）：A「cwd 上报 junction、abs 也带 junction」→ `steered=0`（漏）；B「cwd 上报 junction、abs 走 realpath」→ `steered=1`（正常）；C 对照组（无 junction）→ `steered=1`。A 形态在真实宿主里不会出现。

**修法**：`collectTouched` 与 `recorded` 遍历时对 abs 再做一次 `realpathSync(..., {throwIfNoEntry:false}) ?? abs`，或 `insideCwd` 两侧都归一。成本是每条路径一次 syscall，在 `MAX_TOUCHED_PATHS=200` 的上界下可接受。

---

## 五、读起来像 bug 但实际正确的 8 处

这些我在审查中逐条做了源码核对或实测，**结论是不用改**，但值得记下来避免后来者重复怀疑。

1. **`pruneBackups` 会不会删太多**：不会。`lib/index.js:586` `for (const member of plan.excess)`，而 `plan.kept = members.slice(0, keep)`，最新 `keep` 份从不进入循环。
2. **Windows 大小写导致 `insideCwd` 误判**：不会。实测 `relative('C:\\Users\\me\\proj', 'c:\\users\\me\\proj\\probe-x.mjs')` → `'probe-x.mjs'`，Node 在 win32 下对盘符与路径做不区分大小写比较。
3. **`save()` 非原子 / `load()` 竞态 / 坏账本覆盖**：均已修。`save` 用 `tmp-${pid}-${seq}` + `rename`；`load` 的门是 `Promise | null` 而非布尔（这个区别是真 bug 与正确实现的分界）；坏 JSON 走 `quarantine()` 改名 `.corrupt-` 后空开。
4. **`probe()` 把 stat 报错当已删除**：不会。三态实现（`lib/stats.js:102-111`）：`ENOENT`/`ENOTDIR` → `absent`，其他错误 → `unknown`，`unknown` 不进依从率分母。
5. **`ctx.inject` 漏写 `.catch()`**：代码里没有误用。`lib/index.js:1605-1638` / `1645-1720` 都是 `const fiber = ctx.inject(...); if (typeof fiber?.then === 'function') fiber.then(undefined, onError)` —— cordis 4.1.0 的 `inject` 是 then-only thenable，没有 `.catch`，写了会抛 `ctx.inject(...).catch is not a function`。`test/sim.mjs:25-30` 刻意把这个形态做进 mock 里，误写当场红。
6. **闸门自身抛异常会不会阻断 turn**：不会。双层 catch（`lib/index.js:1395-1405`），内层记 `${steerMode} failed`，外层记 `gate error`，都只 `logger.warn`。
7. **`trim()` 丢事件会不会丢未来的复核**：不会。`lib/stats.js:369-385` 第一轮优先丢 `verify != null` 的，只有还不够才按最旧 slice。
8. **`report_temp_cleanup` 不核 `insideCwd` 是否越权**：不是问题。`s.reported` 里可能存 cwd 外绝对路径，但 reported 通道（`lib/index.js:1182-1199`）在消费时会 `insideCwd` 判定，cwd 外的只在计数与求和中出现，不进文案、不进清单。

另有一条**口径说明缺失**（原 F）：

- `compliance = cleaned / (cleaned + remaining)`，`preCleaned` 与 `unknown` 都不进分母。`preCleaned` 不进是对的（那些文件根本没进清单，模型不是被拦了才清的）；`unknown` 不进也是对的（量不到就不猜）。但**未复核事件（`verify === null`）同样不在分母**，意味着「拦了但永远没复核」的会话也会拿 100%。这是设计取舍，建议在 `cardComplianceHint` 里补一句「基于已复核的轮次」。

---

## 六、测试覆盖缺口

现有 232 条断言（82+42+48+43+17）覆盖了主链路，但有三个组合完全没测到，恰好是 A/L/C/E 四条缺陷的藏身处：

| 缺口 | 逃掉的缺陷 |
| --- | --- |
| 没有任何用例同时构造 `gate(N)` + `auto(N+1)` | A、B、C、L |
| 没有任何含空格路径用例（`cd "…/my dir"`） | E |
| 没有 `kind: 'auto'` 事件参与 `gates` 计数断言（`test/report.mjs:129,281` 只断言 `kind === 'auto'`，不查 `summary().gates`） | K |

补测建议（按性价比排序）：

1. `test/web.mjs` 加一条：turn 1 造 gate（followup），turn 2 造 auto，断言 `summary().verifiedEvents === 2`、`gates === 1`、`recent[0].kind === 'gate'`。
2. `test/report.mjs` 加一条：只写 auto 事件，断言 `gates === 0`。
3. `test/sim.mjs` 加一条：cwd 含空格 + `cd "…/my dir" && rm -f x.txt`，断言 `preCleaned` 命中。
4. `test/client.mjs` 加一条：`turnRecord` 返回 `own === false` 时徽章不渲染。

---

## 七、建议的修复顺序

按「改动量 ÷ 用户可感知收益」排：

1. **A**（`stats.js:398-411`，约 15 行）—— 一切统计失真的总闸。修完 A，B/C/L 的症状会自动减轻一半。
2. **C + L**（`stats.js:614-650` + `client.js:434-518`，约 25 行）—— 徽章是用户唯一每轮可见的东西，串轮最伤信任。
3. **K**（`stats.js:585` + `client.js:419`，约 6 行）—— 三行改动，指标语义立刻正常。
4. **B**（`stats.js:545-552`，约 10 行）—— 与 K 一起改。
5. **E**（`index.js:277-330`，约 30 行）—— 换成引号感知分词，加一条测试。
6. **M**（`index.js:620-641` + `:993-999`，约 10 行）—— `stat` → `lstat` + `nlink` 判据。
7. **G**（`index.js:1064`，约 8 行）—— 解构 signal，三个 abort 检查点。
8. J / N / D / H（各 5 行以内）—— 有空再说。
9. **I**（熔断）—— 需要设计决策，不要顺手加。

前 4 项加起来不到 60 行，能消掉全部 P1 与两个 P2，且互不冲突，可以一次提交。

---

## 八、附：探针与验证记录

审查过程中写的只读探针（全部复刻生产代码路径，非臆测）：

| 探针 | 验的什么 | 结论 |
| --- | --- | --- |
| `probe-verify-pick.mjs` | `verify()` 在 gate+auto 撞轮时选谁 | gate 永久未复核（A） |
| `probe-badge-bleed.mjs` | 干净轮的 `turnRecord` 是否带上一轮清单 | 带（L） |
| `probe-gates-count.mjs` | 纯 auto 账本的 `gates` | `1`（K） |
| `probe-extract.mjs` | 5 个含空格/引用/通配的路径提取 | 3 个错（E） |
| `probe-case.mjs` | win32 大小写是否影响 `insideCwd` | 不影响（排除） |
| `probe-realpath.mjs` | cwd 归一、abs 未归一时的 `insideCwd` | `false`（H 的机制） |
| `probe-junction.mjs` | 端到端 junction 三形态 | A 漏、B/C 正常（H 边界） |
| 硬链接内联探针 | 多链接 inode 的体积记账 | 5 MB 全量虚增（M） |

宿主侧核对过的源码（判据优先级：运行时行为 > 事件契约源码 > 注释）：

- `@deepseek-ai/dsh-agent-loop/lib/index.js:579-592`（followup/steer 语义）、`:805-820`（turn-stopping 派发与 signal）、`:846-860`（turn/end 在 finally 里 append）
- `@deepseek-ai/dsh-fs-local/lib/index.js:180-220`（`targetKey` 恒 realpath）
- `@deepseek-ai/dsh-tool-fs/lib/index.js:605-608`（write 工具的 waterfall 形态）
- `@deepseek-ai/dsh-fs-observation-policy/lib/index.js:90`（`fs/write-intent` 消费方）

---

## 九、逐条修复记录

本节记录上表 13 条的处置。总原则：**只改缺陷，不夹带设计变更**；两条判定「不改」的（D / I）
在末尾说明理由，避免后来者以为漏了。

### A · `verify()` 只复核最后一条匹配事件 — 已修

- **改法**（`lib/stats.js:398-460`）：`let target = null` 覆盖式循环改成 `const pending = []`
  收集**全部**未复核匹配事件；`if (pending.length === 0) return`；`for (const target of pending)`
  逐个复核，`await this.save()` 从「每事件一次」移到循环外整批一次。
- **为什么排除 auto 的方案被否**：先试过 `actionable = pending.filter(e => e.kind !== 'auto')`、
  `targets = actionable.length > 0 ? actionable : pending` 的二选一，但它把「复核 auto」变成
  有条件的 —— auto 事件的 `verify` 会一直是 null，`unverifiedEvents` 永远差那几条。auto 本来就
  没有 `temps`/`backups`，探针循环空转一次就得到「已复核的空结果」，代价可以忽略，所以全量。
- **验证**：`test/regress.mjs` 第一组（turn 7 gate + turn 8 auto 撞同一复核点）断言
  `verifiedEvents === 2`、`unverifiedEvents === 0`、`remaining === 1`。把 `pending.push(event)`
  前面加一句 `pending.length = 0` 退回旧行为 → 该组 3 条全红（`verified=1 events=2`）。

### L · `turnRecord()` 把上一轮清单串进本轮徽章 — 已修

- **改法**：命中集合拆成 `own`（`e.turn === at`）与 `carried`（`e.turn !== at`，即上一轮带来复核的）；
  `temps`/`backups`/`pruned`/`steerMode`/`preCleaned` 只累加 `own`，`verify` 五字段仍从 `hit` 收
  （这样干净轮能报「上一轮那批清了没」）。返回值新增 `own: ownGate` 与 `carried: carried.length > 0`。
- **客户端配套**（`lib/client.js:486`）：`if (record.own === false && record.verified !== true) return null`
  —— 本轮什么都没发生且上一轮那批还没复核时整轮不渲染，免得出现一行只有「待复核」的徽章。
  退避重取条件同步加 `&& next.own !== false`（等下去也没有新东西）。
- **验证**：`test/regress.mjs` L 组断言 turn 7 `own === true && temps === 1`、turn 8
  `own === false && temps === 0 && backups === 0`。退回 `const own = hit` → turn 8 变
  `{"own":true,"temps":1}`，红。

### C · `turnRecord()` 聚合 gate + auto 且改写 `kind` — 已修

- **改法**：删掉遍历里的 `if (e.kind === 'auto') kind = 'auto'`；`kind` 只由本轮自己的事件决定
  —— `let kind = ownGate ? 'gate' : own.length > 0 ? 'auto' : 'gate'`。
- **验证**：regress C 组断言 turn 8 的 `kind === 'auto'`（不是 gate）。退回旧写法 → 变 `gate`，红。

### B · 最近记录去重方向反了 — 已修

- **改法**（`lib/stats.js:555-585`）：倒序 `seen` 集合改成 `byTurn` Map 正序扫描；同键只做两种替换
  —— `if (prev.event.kind === 'auto' && e.kind !== 'auto') prev.event = e`（**优先留 gate**），
  以及 `prev.index = i`（同 kind 留更晚的那条）；最后 `[...byTurn.values()].sort((a,b)=>a.index-b.index)
  .slice(-20).map(e => e.event).reverse()`。
- **验证**：regress B 组两条 —— 同轮只出一条 recent、留下的是 gate、且带着清单（`recent=1`、
  `kind=gate`、`temps` 计数非 0）。退回 `prev.event = e` → `kind=auto` 且清单为 0，红两条。

### K · 「拦截次数」把没拦的轮也算进去 — 已修

- **改法**：`summary()` 新增 `let gateEvents = 0` / `let autoRounds = 0`，循环里
  `if (e.kind === 'auto') autoRounds += 1; else gateEvents += 1`；返回对象的 `gates: all.length`
  改成 `gates: gateEvents` 并新增 `autoRounds` / `events: all.length`（`events` 保留原语义，
  读旧字段的地方不受影响）；`bySession` 行的 `row.gates += 1` 加 `if (e.kind !== 'auto')` 前置。
- **客户端配套**：`lib/client.js:424` 的 noData 判定改成
  `stats.gates === 0 && (Number(stats.preCleaned) || 0) === 0` —— auto 轮 `gates` 不涨但
  `preCleaned` 涨，两者都为 0 才是真没记录。
- **验证**：regress 两组 —— 撞轮场景 `gates === 1 && autoRounds === 1 && events === 2`；
  纯 auto 账本 `gates === 0 && autoRounds === 1 && preCleaned === 1 && bySession[0].gates === 0`。
  两处退回（`row.gates += 1`、`gates: all.length`）→ 4 条红，其中纯 auto 账本变 `gates=1`。

### E · 含空格的路径被切碎 — 已修

- **改法**（`lib/index.js:331-360`）：新增 `shellTokens(raw)` 引号感知分词（单/双引号状态机，
  空白与 `;&|()<>` 为分隔符），`extractPaths` 里 `const tokens = raw.split(/[\s;&|()<>]+/)`
  改成 `const tokens = shellTokens(raw)`。明确不展开 `$VAR`、不处理反斜杠转义 —— 只在「路径
  出现在命令串里」时用，够用即可。
- **验证**：regress E 组用两个**不发 `fs/write-intent`**、名字也不带临时件前缀的文件
  （`cwd/my dir/junk-e.dat`、`junk-f.dat`），只靠 `ops_bash` 实参抽取发现 —— 那是唯一会走
  `shellTokens` 的通道。断言 `preCleaned === 2`（两个完整路径，不是一个碎片加一个目录名）、
  `preCleanedBytes === 5`。退回 `split` → `preCleaned=undefined`，红两条。

### M · 体积按 `stat` 全量计 — 已修

- **改法**（`lib/index.js:678-712`）：`measureSizes` 的 `stat` 改 `lstat`，`!info.isFile()` 返回，
  新增 `if (Number(info.nlink) > 1) return`（多链接删一个名字不释放字节，记 0 是唯一诚实答案）。
  `planBackups` 的成员收集同步改 `lstat` —— 符号链接 `.bak` 白占一个 `keep` 名额会把真备份
  挤进 `excess`。
- **验证**：regress M 组用 `fs.link` 造 5 MiB 硬链接（符号链接在 Windows 非开发者模式下 `EPERM`），
  断言「闸门照样报它」（`reportedTemps === 1`）但「体积记 0」（`reportedBytes === 0`）。
  去掉 `nlink` 判据 → `reportedBytes = 5242880`，红。

### G · `turn-stopping` 不读 `signal` — 已修

- **改法**（`lib/index.js:1130-1150` 起）：签名解构 `signal`，`const aborted = () => signal != null
  && signal.aborted === true`；6 个检查点 —— 入口、`canonicalCwd` 后、`scanTmpDir` 后、
  **prune 之前**（唯一不可逆动作）、记账之前、发消息之前。
- **为什么不用 `signal.throwIfAborted()`**：它抛的 `AbortError` 会被外层 `catch` 记成
  `gate error`，把用户主动中断污染成插件故障日志。
- **验证**：现有 `test/sim.mjs` 全部场景都传 `new AbortController().signal`（未 abort），
  改后仍全绿；`npm test` 六个套件一起跑无回归。

### J · 相对 `logFile` 跟会话 cwd 漂移 — 已修（打点，不改解析）

- **为什么不动解析**：改成 `process.cwd()` 会让已有配置的日志文件换位置，对已经装了插件的人
  是静默的行为变更。保留原语义，改为可观测。
- **改法**：`record()` 里新增 `const loggedLogFiles = new Set()`，每个**首次出现**的绝对路径
  打一行 `dsh-turn-cleanup: log file=<abs>`，事后可从进程日志查全集。

### N · 占位 `undefined` 体积静默按 0 计入 — 已修（文案）

- **为什么不动记账**：写入侧先 `set(abs, undefined)` 占位、等 `fs/observed` 回填；`dsh-ops`
  这类不发 `fs/observed` 的工具永远回填不上。0 是唯一可得的答案，猜一个数更糟。
- **改法**：`cardReportedHint` 补「（个别未采到体积的按 0 计）」，代码注释写清成因。

### F · 依从率口径说明缺失 — 已修（文案）

- `cardComplianceHint` 由「已清 / (已清 + 仍在)」改成「已清 / (已清 + 仍在)，只算已复核的轮次」，
  中英同步。

### H · `targetPath` 只认 `targetKey` — 已修

- **改法**（`lib/index.js:470-490`）：`targetKey` 缺失时依次回退
  `displayPath` / `path` / `filePath` / `file_path` / `absPath`，拿未归一路径让 `insideCwd` 兜。
- **为什么值得改**：宿主 `dsh-fs-local` 恒给 realpath 过的 `targetKey`（这一层安全），但第三方
  工具 / 自定义 fs 实现 / 手工构造的 target 可能只填 `displayPath` —— 判空返回 `undefined`
  会让写入侧一个路径都记不到，本轮临时件**全部静默漏报**，而且不会有任何报错。

### D · `state`/`tripped` 残留 — 不改

核过宿主：`turn/end` 在 `finally` 里 append，`abort` 与 `error` 都走到，只有进程崩溃或
`sessions-quarantine` 才残留；残留纯内存、不落盘、重启即清。改成 `WeakMap<session, Set<turn>>`
要动 `tripped` 的键格式（现在是 `${session.id}\u0000${turn}` 字符串），收益不抵风险。

### I · 无熔断 — 不改（设计缺口，需单独立项）

同一路径每轮都拦，模型连续多轮不配合时闸门不会自我收敛。这不是 bug：加 `strikes` 阈值会改变
插件对外行为语义（什么时候放弃拦截、放弃之后账怎么记、和 `tripped` 怎么交互），需要单独设计。
可选方向记在这里：`state` 加 `strikes: Map<abs, count>`，同路径报出 N 次（默认 3）后转
「只记账不拦」并落 `escalate` 日志。

---

## 十、验证

### 新增测试套件

`test/regress.mjs`（26 checks）专收**在别的套件里构造不出来**的反例 —— 现有 232 条断言全绿却
漏掉了 A/B/C/K/L/E/M，缺的不是分支覆盖而是**组合**：

| 组合 | 逃掉的缺陷 | regress 里的用例 |
| --- | --- | --- |
| 同轮 `gate(N)` + `auto(N+1)` 抢一个复核点 | A、B、C、L | 第 1、2 组 |
| 纯 auto 账本参与 `gates` 断言 | K | 第 3 组 |
| cwd 含空格 + `cd "…/my dir" && rm` | E | 第 4 组 |
| 多链接文件删一个名字 | M | 第 5 组 |

关键设计：**E 组的文件不发 `fs/write-intent`**（否则路径由 `targetKey` 直接给出，绕过了
`shellTokens`，测不到东西），只能靠 `tool/call` 实参被抽取；记账是 `void stats.recordGate(...)`
起的后台链，所以断言用**带谓词的轮询**（60 × 50 ms）而不是固定睡眠 —— 只等「有事件」会读到
「gate 刚写、auto 还没写、复核还没跑」的中间态。

### 反向验证（这条比「改完还是绿」更能说明问题）

把 `lib/` 与 `test/` 复制到临时目录，用脚本把六处修复逐一退回旧行为（`pending.length = 0`、
`prev.event = e`、`row.gates += 1`、`gates: all.length`、`const own = hit`、`split(/[\s;&|()<>]+/)`、
去掉 `nlink` 判据），跑同一份 regress：

- 修复版：**26/26 passed**
- 退回版：**12/26 passed**，14 条 FAIL，失败详情与本文档的症状逐字吻合 ——
  `verified=1 events=2`、`unverified=1`、`gates=2`、`recent=["8:auto:done","7:gate:pending"]`、
  turn 8 `own=true temps=1` / `kind=gate`、纯 auto 账本 `gates=1`、`preCleaned=undefined`、
  `reportedBytes=5242880`。

临时目录与反向验证脚本已清场。

### 全量回归

```
node --check lib/index.js lib/stats.js lib/client.js lib/messages.js   # 全过
npm test
  sim           82/82
  web           42/42
  client        48/48
  report        43/43
  tool-agnostic 17/17
  regress       26/26      ← 新增，合计 258 checks
```

`package.json` 的 `check` / `test` 已接入 `test/regress.mjs`；`.github/workflows/test.yml` 的
`test` 与 `cross-platform` 两个 job 各加一步（Windows 是含空格路径与多链接文件最真实的地方）。

### 交付物清单

| 文件 | 改动 |
| --- | --- |
| `lib/stats.js` | A / B / C / K / L（`verify`、`summary`、`turnRecord`） |
| `lib/index.js` | E / M / G / J / H（`shellTokens`、`measureSizes`、`planBackups`、`turn-stopping`、`record`、`targetPath`） |
| `lib/client.js` | K / L / F / N（noData 判定、徽章 `own` 判断、两条 hint 文案） |
| `test/regress.mjs` | 新增，26 checks |
| `CHANGELOG.md` | 0.8.0 新增「统计链路」「路径与体积」「中断与配置」「不改的两条」四节 + 补「为什么测试没拦住」 |
| `README.md` | 复核范围（全量而非最后一条）、`gates` 口径、徽章 `own`/`carried` |
| `package.json` / `.github/workflows/test.yml` | 接入 regress |
