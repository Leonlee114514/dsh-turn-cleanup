// 回归测试：AUDIT-logic.md 里那批缺陷的「反例」现场。
//
// 每个用例都对着一条具体的判定，且都能在最老的实现上复现失败 —— 这是它们的价值。
// 已有四个套件（sim / web / client / report / tool-agnostic）全绿而缺陷仍存在，
// 原因是它们从没同时造出「上一轮拦了 + 本轮自己清干净」这种组合。
//
//   A  同一 turn 的两条待复核事件必须都复核（auto 不能抢走 gate 的复核权）
//   B  同一 (sid, turn) 的 gate 与 auto，recent 里必须留 gate 那条
//   C/L turnRecord 只累加本轮自己的事件，上一轮的清单不许串进本轮徽章
//   K  kind='auto' 不算一次拦截
//   E  带引号的含空格路径不许被切碎
//   M  多链接文件删掉一个名字不释放字节，体积记 0
import { mkdtemp, writeFile, mkdir, rm, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { StatsStore } from '../lib/stats.js'

const results = []
function check(label, pass, detail) {
  results.push({ label, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

const root = await mkdtemp(join(tmpdir(), 'tc-regress-'))
const cwd = join(root, 'ws')
await mkdir(cwd, { recursive: true })

/** 与宿主 cordis 4.1.0 同形：inject 返回 then-only thenable，没有 catch/finally。 */
function makeCtx() {
  const listeners = new Map()
  const registered = []
  const services = { tools: { register: (definition) => { registered.push(definition); return () => {} } } }
  const ctx = {
    logger: { info() {}, warn() {} },
    get() {
      return undefined
    },
    on(evt, cb) {
      if (!listeners.has(evt)) listeners.set(evt, [])
      listeners.get(evt).push(cb)
    },
    effect(fn) {
      const dispose = fn()
      return () => dispose?.()
    },
    inject(_wanted, callback) {
      const sub = {
        tools: services.tools,
        effect(fn) {
          const dispose = fn()
          return () => dispose?.()
        }
      }
      const out = callback(sub)
      return Object.assign(Object.create({ ok: true, value: out }), {
        then(onFulfilled, onRejected) {
          return Promise.resolve(out).then(onFulfilled, onRejected)
        }
      })
    },
    async emitSerial(evt, payload) {
      let out
      for (const cb of listeners.get(evt) ?? []) out = await cb(payload)
      return out
    },
    async emitWaterfall(evt, ...args) {
      const cbs = listeners.get(evt) ?? []
      const next = args.pop()
      const step = async (i) => (i >= cbs.length ? next() : cbs[i](...args, () => step(i + 1)))
      return step(0)
    },
    async emitPlain(evt, ...args) {
      for (const cb of listeners.get(evt) ?? []) await cb(...args)
    }
  }
  ctx.registered = registered
  return ctx
}

function makeAgent(id, dir = cwd) {
  const steered = []
  return {
    session: { id, header: { cwd: dir, origin: 'user', delegationDepth: 0 } },
    status: 'running',
    steer(m) {
      steered.push(m)
    },
    followup(m) {
      steered.push(m)
    },
    steered
  }
}

async function startTurn(ctx, agent, turn) {
  await ctx.emitPlain('session/event', agent.session, { type: 'turn/start', data: { turn } })
}

async function endTurn(ctx, agent, turn) {
  await ctx.emitPlain('session/event', agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
}

async function stop(ctx, agent, turn) {
  await ctx.emitSerial('agent/turn-stopping', { agent, turn, signal: new AbortController().signal })
}

/** 走完整链路写一个文件：intent → 落盘 → observed（宿主真实顺序）。 */
async function writeThrough(ctx, agent, abs, body = 'x') {
  await mkdir(join(abs, '..'), { recursive: true })
  await ctx.emitWaterfall('fs/write-intent', { targetKey: abs }, { agent }, () => undefined)
  await writeFile(abs, body)
  await ctx.emitPlain('fs/observed', { targetKey: abs }, { kind: 'present' }, { agent })
}

/** 只发 tool/call + tool/result（不发 intent），实参里带命令串。 */
async function callTool(ctx, agent, turn, name, args, during) {
  const callId = `call-${name}-${Math.random().toString(36).slice(2, 8)}`
  await ctx.emitPlain('session/event', agent.session, {
    type: 'tool/call',
    data: { turn, step: 1, callId, name, arguments: JSON.stringify(args) }
  })
  if (during) await during()
  await ctx.emitPlain('session/event', agent.session, {
    type: 'tool/result',
    data: {
      turn,
      step: 1,
      message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text: 'ok' }] }
    }
  })
}

/**
 * 记账是 `void stats.recordGate(...)` / `void stats.verify(...)` 起的后台链，
 * turn/end 返回时落盘还没完成。轮询到判定成立为止，而不是只等「有事件」——
 * 只等事件数的话会读到「第一个事件刚写进去、还没复核」的中间态。
 */
async function waitSummary(file, scope, sid, done) {
  const read = () => new StatsStore(file, { info() {}, warn() {} }).summary(scope, sid)
  let sum = await read()
  for (let i = 0; i < 60; i += 1) {
    if (done(sum)) return sum
    await new Promise((r) => setTimeout(r, 50))
    sum = await read()
  }
  return sum
}

async function waitTurnRecord(file, sid, turn, done) {
  const read = () => new StatsStore(file, { info() {}, warn() {} }).turnRecord(sid, turn)
  let rec = await read()
  for (let i = 0; i < 60; i += 1) {
    if (done(rec)) return rec
    await new Promise((r) => setTimeout(r, 50))
    rec = await read()
  }
  return rec
}

// ── A + K：gate(turn 7) 与 auto(turn 8) 撞在同一复核点 ────────────────────────
// 旧实现：verify(8) 只取最后一条匹配事件（auto），gate 永远停在待复核
//         → verifiedEvents=1、依从率分母偏小、reportedBytes 那一份体积永远缺。
{
  const statsFile = join(root, 'a', 'stats.json')
  const ctx = makeCtx()
  apply(ctx, { enabled: true, stats: true, statsFile, logFile: '' })
  const agent = makeAgent('sess-a')
  const leftover = join(cwd, 'probe-a7.mjs')

  await startTurn(ctx, agent, 7)
  await writeThrough(ctx, agent, leftover, 'x')
  await stop(ctx, agent, 7)
  check('A · turn 7 拦了', agent.steered.length === 1, `steers=${agent.steered.length}`)
  await endTurn(ctx, agent, 7) // verify(7)：这一刻还没有轮到复核

  await startTurn(ctx, agent, 8)
  const selfCleaned = join(cwd, 'tmp-a8.mjs')
  await writeThrough(ctx, agent, selfCleaned, 'y')
  await rm(selfCleaned, { force: true })
  await stop(ctx, agent, 8) // 自己清干净了 → 写一条 kind='auto'，verifyAtTurn=8
  check('A · turn 8 没有可拦的', agent.steered.length === 1, `steers=${agent.steered.length}`)
  await endTurn(ctx, agent, 8) // verify(8)：gate(7) 与 auto(8) 都在这里等着

  const sum = await waitSummary(statsFile, 'all', '', (s) => s.events === 2 && s.unverifiedEvents === 0)
  check('A · 两条待复核事件都复核了', sum.verifiedEvents === 2,
    `verified=${sum.verifiedEvents} events=${sum.events}`)
  check('A · 没有事件停在待复核', sum.unverifiedEvents === 0, `unverified=${sum.unverifiedEvents}`)
  check('A · gate 那条的残留被算成仍在', sum.remaining === 1 && sum.cleaned === 0,
    `cleaned=${sum.cleaned} remaining=${sum.remaining}`)
  check('K · auto 不算拦截', sum.gates === 1, `gates=${sum.gates}`)
  check('K · auto 轮单独计数', sum.autoRounds === 1, `autoRounds=${sum.autoRounds}`)
  check('K · events 保留总条数', sum.events === 2, `events=${sum.events}`)
  check('B · recent 两条都在而且都已复核',
    (sum.recent ?? []).length === 2 && sum.recent.every((r) => r.verify !== null),
    JSON.stringify((sum.recent ?? []).map((r) => `${r.turn}:${r.kind}:${r.verify === null ? 'pending' : 'done'}`)))

  const ownTurn = await waitTurnRecord(statsFile, 'sess-a', 7, (r) => r?.own === true)
  check('L · turn 7 的徽章是自己的清单', ownTurn?.own === true && ownTurn?.temps === 1,
    JSON.stringify({ own: ownTurn?.own, temps: ownTurn?.temps }))
  const quietTurn = await waitTurnRecord(statsFile, 'sess-a', 8, (r) => r?.own === false)
  check('L · turn 8 徽章不串上一轮的清单',
    quietTurn?.own === false && quietTurn?.temps === 0 && quietTurn?.backups === 0,
    JSON.stringify({ own: quietTurn?.own, temps: quietTurn?.temps, backups: quietTurn?.backups }))
  check('C · turn 8 的 kind 由自己决定（auto，不是 gate）', quietTurn?.kind === 'auto', String(quietTurn?.kind))
  check('C · turn 8 知道自己带了上一轮的复核', quietTurn?.carried === true, String(quietTurn?.carried))
  await rm(join(root, 'a'), { recursive: true, force: true })
}

// ── B：同一 (sid, turn) 同时有 gate 与 auto（resume/fork 复用轮次时的真实形状）──
{
  const file = join(root, 'b', 'stats.json')
  const store = new StatsStore(file, { info() {}, warn() {} })
  const base = { cwd, sid: 'sess-b', steerMode: 'followup', keep: 3, mode: 'steer', sizes: {}, preCleaned: [] }
  await store.recordGate({ ...base, turn: 5, kind: 'gate', verifyAtTurn: 5, temps: ['probe-b5.mjs'], backups: ['probe-b5.mjs.bak-1'], pruned: [] })
  await store.recordGate({ ...base, turn: 5, kind: 'auto', verifyAtTurn: 5, temps: [], backups: [], pruned: [] })
  const sum = await new StatsStore(file, { info() {}, warn() {} }).summary('all', 'sess-b')
  check('B · 同轮只出一条 recent', (sum.recent ?? []).length === 1, `recent=${(sum.recent ?? []).length}`)
  check('B · 留下的是 gate 那条（auto 不许挤掉它）', sum.recent?.[0]?.kind === 'gate', String(sum.recent?.[0]?.kind))
  check('B · 留下的那条带着清单', sum.recent?.[0]?.temps === 1, String(sum.recent?.[0]?.temps))
  await rm(join(root, 'b'), { recursive: true, force: true, maxRetries: 5 })
}

// ── K：一整本账里只有 auto 事件时，gates 必须是 0 ────────────────────────────
// 旧实现 gates = 事件总数 → 面板「拦截次数」长期虚高，且 noData 提示永不出现。
{
  const file = join(root, 'k', 'stats.json')
  const store = new StatsStore(file, { info() {}, warn() {} })
  await store.recordGate({
    cwd, sid: 'sess-k', turn: 1, kind: 'auto', verifyAtTurn: 1, temps: [], backups: [],
    pruned: [], sizes: {}, keep: 3, mode: 'steer', steerMode: 'followup',
    preCleaned: [{ rel: 'tmp-k.mjs', size: 100 }]
  })
  const sum = await new StatsStore(file, { info() {}, warn() {} }).summary('all', 'sess-k')
  check('K · 纯 auto 账本 gates=0', sum.gates === 0, `gates=${sum.gates}`)
  check('K · 纯 auto 账本 autoRounds=1', sum.autoRounds === 1, `autoRounds=${sum.autoRounds}`)
  check('K · 但 preCleaned 有数（面板据此判断「有记录」）', sum.preCleaned === 1, `preCleaned=${sum.preCleaned}`)
  check('K · bySession 行的 gates 也不含 auto', sum.bySession?.[0]?.gates === 0,
    String(sum.bySession?.[0]?.gates))
  await rm(join(root, 'k'), { recursive: true, force: true, maxRetries: 5 })
}

// ── E：带引号的含空格路径 ───────────────────────────────────────────────────
// 旧实现先 split(/[\s;&|()<>]+/) 再 unquote，引号在切分前就丢了：
//   `rm -f "…/my dir/junk-e.dat"`  → 切成 `…/my` 与 `dir\junk-e.dat`
//       第一段是目录（不是文件）、第二段相对 cwd 解析到错处 → 两个都 stat 不到
//   `cd "…/my dir" && rm -f junk-f.dat` → cd 的 base 被切成 `…/my`，相对名解析到错处
// 后果：这两个文件明明被删了，却一条都记不进来 ——「已释放空间」少报。
// Windows 用户目录带空格是常态（`C:\Users\John Doe\`）。
//
// 这两个文件刻意不叫 probe-*/tmp-*/…，也不发 fs/write-intent：
// 只有这样它们才只能靠 tool/call 实参抽取（touched 通道）被发现，
// 也就是唯一会走 shellTokens 的那条路。
{
  const statsFile = join(root, 'e', 'stats.json')
  const ctx = makeCtx()
  apply(ctx, { enabled: true, stats: true, statsFile, logFile: '' })
  const agent = makeAgent('sess-e')
  const spaced = join(cwd, 'my dir')
  await mkdir(spaced, { recursive: true })

  await startTurn(ctx, agent, 1)
  const absoluteTarget = join(spaced, 'junk-e.dat')
  await writeFile(absoluteTarget, 'zzz')
  await callTool(ctx, agent, 1, 'ops_bash', { command: `rm -f "${absoluteTarget}"` }, async () => {
    await rm(absoluteTarget, { force: true })
  })
  const relativeTarget = join(spaced, 'junk-f.dat')
  await writeFile(relativeTarget, 'yy')
  await callTool(ctx, agent, 1, 'ops_bash', { command: `cd "${spaced}" && rm -f junk-f.dat` }, async () => {
    await rm(relativeTarget, { force: true })
  })
  await stop(ctx, agent, 1)
  check('E · 两个都清掉了 → 不打扰模型', agent.steered.length === 0, `steers=${agent.steered.length}`)
  await endTurn(ctx, agent, 1)

  const rec = await waitTurnRecord(statsFile, 'sess-e', 1, (r) => (r?.preCleaned ?? 0) > 0)
  check('E · 引号内的空格路径被完整认出（两个，不是一个碎片）',
    rec?.preCleaned === 2, `preCleaned=${rec?.preCleaned}`)
  check('E · 体积按真实字节记（3 + 2）', rec?.preCleanedBytes === 5, `bytes=${rec?.preCleanedBytes}`)
  await rm(join(root, 'e'), { recursive: true, force: true, maxRetries: 5 })
}

// ── M：多链接文件删掉一个名字，不释放任何字节 ────────────────────────────────
// 旧实现用 stat：链接目标的体积被记成「清掉它能腾出的空间」。
// 硬链接不需要管理员权限，所以这里用它（符号链接在 Windows 非开发者模式下 EPERM）。
{
  const statsFile = join(root, 'm', 'stats.json')
  const ctx = makeCtx()
  apply(ctx, { enabled: true, stats: true, statsFile, logFile: '' })
  const agent = makeAgent('sess-m')
  const original = join(cwd, 'payload-big.bin')
  const hardCopy = join(cwd, 'probe-m.mjs')

  await startTurn(ctx, agent, 1)
  await writeFile(original, 'z'.repeat(5 * 1024 * 1024))
  await ctx.emitWaterfall('fs/write-intent', { targetKey: hardCopy }, { agent }, () => undefined)
  await link(original, hardCopy)
  await ctx.emitPlain('fs/observed', { targetKey: hardCopy }, { kind: 'present' }, { agent })
  await stop(ctx, agent, 1)
  check('M · 多链接的临时件照样被报出来', agent.steered.length === 1, `steers=${agent.steered.length}`)
  await endTurn(ctx, agent, 1)

  const sum = await waitSummary(statsFile, 'all', '', (s) => s.events > 0 && s.reportedTemps > 0)
  check('M · 清单条数照常', sum.reportedTemps === 1, `reportedTemps=${sum.reportedTemps}`)
  check('M · 但体积记 0（inode 还挂在原名下）', sum.reportedBytes === 0, `reportedBytes=${sum.reportedBytes}`)
  await rm(join(root, 'm'), { recursive: true, force: true, maxRetries: 5 })
}

await rm(root, { recursive: true, force: true, maxRetries: 5 })

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  FAILED: ${f.label}`)
  process.exit(1)
}
