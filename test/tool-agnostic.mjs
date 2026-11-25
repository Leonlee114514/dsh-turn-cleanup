// v4：不认工具名的采集层。
//
// 背景：v3 靠 `fs/*-intent` 记路径，但那套事件只有宿主自己的 `dsh-tool-fs` /
// `dsh-tool-str-replace-editor` 会发。`dsh-ops`（ops_write_file / ops_bash 等）
// 一条都不发，社区插件更不会有。实测 110 个会话里有 37 次写全走 ops_write_file，
// 插件完全看不见 —— 用户「清了临时文件但面板没变化」就是这个原因。
//
// v4 改从 `session/event` 的 `tool/call` + `tool/result` 收：所有工具调用都会进
// 这条流，与工具名、插件来源无关。判据只有一条 —— 文件 mtime 不早于本轮开始。
// 读文件不改 mtime，写文件一定改，所以「只读过」不会被误算。
//
// 另一条硬边界：cwd 之外的文件（%TEMP%、~/.cache）只进 preCleaned 记账，
// 绝不进 steer 清单 —— 插件不指挥模型去删工作区外面的东西。
import { mkdtemp, writeFile, mkdir, rm, readFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { StatsStore } from '../lib/stats.js'

const results = []
function check(label, pass, detail) {
  results.push({ label, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

const root = await mkdtemp(join(tmpdir(), 'tc-agnostic-'))
const cwd = join(root, 'ws')
const outside = join(root, 'outside')
await mkdir(cwd, { recursive: true })
await mkdir(outside, { recursive: true })
const statsFile = join(root, 'logs', 'stats.json')

/** 与宿主 cordis 4.1.0 同形：inject 返回 then-only thenable，没有 catch/finally。 */
function makeCtx() {
  const listeners = new Map()
  const registered = []
  const services = { tools: { register: (definition) => { registered.push(definition); return () => {} } } }
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      return services[name]
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
    async emitPlain(evt, ...args) {
      for (const cb of listeners.get(evt) ?? []) await cb(...args)
    }
  }
  ctx.registered = registered
  return ctx
}

function makeAgent(id) {
  const steered = []
  return {
    session: { id, header: { cwd, origin: 'user', delegationDepth: 0 } },
    status: 'running',
    steer(m) {
      steered.push(m)
    },
    steered
  }
}

/**
 * 模拟一次「不发任何 fs/*-intent 的工具调用」：只发 tool/call 与 tool/result，
 * 与 dsh-ops 的 ops_write_file 行为一致。实参用 `path` 键（ops_write_file 的形状），
 * 故意不用 `file_path`，验证插件不依赖具体键名。
 */
async function callTool(ctx, agent, name, args, during) {
  const callId = `call-${name}-${Math.random().toString(36).slice(2, 8)}`
  await ctx.emitPlain('session/event', agent.session, {
    type: 'tool/call',
    data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) }
  })
  if (during) await during()
  await ctx.emitPlain('session/event', agent.session, {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text: 'ok' }] }
    }
  })
}

async function stop(ctx, agent) {
  await ctx.emitSerial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
}

async function endTurn(ctx, agent) {
  await ctx.emitPlain('session/event', agent.session, { type: 'turn/end', data: { turn: 1 } })
}

/**
 * 等账本落盘后再读。
 *
 * `StatsStore.save()` 有节流，固定睡 80 ms 在慢机器上会读到旧快照 —— 那会让
 * 断言拿到 undefined，看起来像「没记账」，实际只是还没写完。轮询到出现为止，
 * 上限 ~1.5 s；真的没记就返回 null，让断言如实失败。
 */
async function waitRecord(sid, turn) {
  for (let i = 0; i < 30; i += 1) {
    const rec = await new StatsStore(statsFile).turnRecord(sid, turn)
    if (rec !== null) return rec
    await new Promise((r) => setTimeout(r, 50))
  }
  return null
}

const ctx = makeCtx()
apply(ctx, { enabled: true, stats: true, statsFile, logFile: '' })
await new Promise((r) => setTimeout(r, 60))

// ── 场景 1：不发 intent 的工具写了又删 → 体积照样进账，且不打扰模型 ─────────
{
  const agent = makeAgent('sess-agnostic-auto')
  await ctx.emitPlain('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })

  const abs = join(cwd, 'tmp-ops-written.js')
  await callTool(ctx, agent, 'ops_write_file', { path: 'tmp-ops-written.js', content: 'x'.repeat(96) }, async () => {
    await writeFile(abs, 'x'.repeat(96))
  })
  await rm(abs, { force: true })

  await stop(ctx, agent)
  check('1 都清干净了 → 不打扰模型', agent.steered.length === 0, `steers=${agent.steered.length}`)

  await endTurn(ctx, agent)
  const rec = await waitRecord('sess-agnostic-auto', 1)
  check('1 不发 intent 的写入也被记账', rec?.kind === 'auto', JSON.stringify(rec?.kind))
  check('1 记到 96 字节', rec?.preCleanedBytes === 96, String(rec?.preCleanedBytes))
  check('1 没有把文件报成待清理', rec?.temps === 0, String(rec?.temps))
}

// ── 场景 2：只读不改的老文件不算本轮留下的（mtime 判据） ────────────────────
{
  const agent = makeAgent('sess-agnostic-read')
  const abs = join(cwd, 'tmp-ancient.js')
  await writeFile(abs, 'a'.repeat(500))
  const old = new Date(Date.now() - 3600 * 1000)
  await utimes(abs, old, old)

  await ctx.emitPlain('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
  // 只有一次「读」：实参里带着这个路径，但它没被改过
  await callTool(ctx, agent, 'ops_inspect_local_file', { path: 'tmp-ancient.js', limit: 20 })

  await stop(ctx, agent)
  check('2 只读过的老文件没被叫去删',
    !agent.steered.some((m) => JSON.stringify(m).includes('tmp-ancient.js')),
    `steers=${agent.steered.length}`)

  await endTurn(ctx, agent)
  const rec = await waitRecord('sess-agnostic-read', 1)
  check('2 老文件不计入已释放', rec === null || rec.preCleanedBytes === 0, JSON.stringify(rec?.preCleanedBytes))
}

// ── 场景 3：cwd 之外被写又被删 → 记账，但不进 steer 清单 ────────────────────
{
  const agent = makeAgent('sess-agnostic-foreign')
  await ctx.emitPlain('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })

  // 名字故意不符合任何临时件模式，且不在 cwd 内 —— 两条老通道都看不见它
  const abs = join(outside, 'hydra.out')
  await callTool(ctx, agent, 'ops_write_file', { path: abs, content: 'h'.repeat(240) }, async () => {
    await writeFile(abs, 'h'.repeat(240))
  })
  await rm(abs, { force: true })

  await stop(ctx, agent)
  check('3 cwd 之外的东西不指挥模型去删', agent.steered.length === 0, `steers=${agent.steered.length}`)

  await endTurn(ctx, agent)
  const rec = await waitRecord('sess-agnostic-foreign', 1)
  check('3 cwd 之外的删除也计入已释放', rec?.preCleanedBytes === 240, String(rec?.preCleanedBytes))
  check('3 但没被报成待清理', rec?.temps === 0, String(rec?.temps))
}

// ── 场景 4：不发 intent 的工具留下残留 → 仍然要拦（不能因为换了通道就漏） ────
{
  const agent = makeAgent('sess-agnostic-leftover')
  await ctx.emitPlain('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })

  const abs = join(cwd, 'probe-from-ops.mjs')
  await callTool(ctx, agent, 'ops_write_file', { path: 'probe-from-ops.mjs', content: 'p'.repeat(12) }, async () => {
    await writeFile(abs, 'p'.repeat(12))
  })

  await stop(ctx, agent)
  const body = agent.steered[0]?.content?.[0]?.text ?? ''
  check('4 不发 intent 的残留照样拦', agent.steered.length === 1, `steers=${agent.steered.length}`)
  check('4 文案里点到了这个文件', body.includes('probe-from-ops.mjs'), body.slice(0, 120))
  await rm(abs, { force: true })
  await endTurn(ctx, agent)
}

// ── 场景 5：命令串里的路径也能捞出来（用户自己的清理脚本常是 rm -f a b） ────
{
  const agent = makeAgent('sess-agnostic-bash')
  await ctx.emitPlain('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })

  const one = join(outside, 'niu-a.js')
  const two = join(outside, 'niu-b.js')
  await writeFile(one, '1'.repeat(30))
  await writeFile(two, '2'.repeat(70))

  // ops_bash 的实参只有 command 一个字符串键，路径混在命令里
  await callTool(ctx, agent, 'ops_bash', {
    command: `cd "${outside}" && rm -f niu-a.js niu-b.js`,
    description: '清掉本轮两个脚本'
  }, async () => {
    await rm(one, { force: true })
    await rm(two, { force: true })
  })

  await stop(ctx, agent)
  check('5 命令串里的删除不打扰模型', agent.steered.length === 0, `steers=${agent.steered.length}`)

  await endTurn(ctx, agent)
  const rec = await waitRecord('sess-agnostic-bash', 1)
  check('5 命令串里的两个文件都被记到', rec?.preCleaned === 2, String(rec?.preCleaned))
  check('5 字节数合计 100', rec?.preCleanedBytes === 100, String(rec?.preCleanedBytes))
}

// ── 场景 6：实参被截断（JSON 解析失败）不能把插件搞崩 ──────────────────────
{
  const agent = makeAgent('sess-agnostic-broken')
  await ctx.emitPlain('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
  await ctx.emitPlain('session/event', agent.session, {
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'broken-1', name: 'write', arguments: '{"file_path": "tmp-x.js", "content": "xxx' }
  })
  await ctx.emitPlain('session/event', agent.session, {
    type: 'tool/result',
    data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'broken-1', content: [{ type: 'text', text: 'bad' }] } }
  })
  let threw = null
  try {
    await stop(ctx, agent)
  } catch (e) {
    threw = e
  }
  check('6 实参截断不影响闸门', threw === null, threw ? String(threw.message ?? threw) : 'no throw')
  await endTurn(ctx, agent)
}

// ── 场景 7：账本升到 v4，新字段没破坏结构 ──────────────────────────────────
{
  const raw = JSON.parse(await readFile(statsFile, 'utf8'))
  // v4 引入了 unknown 三态、preCleanedOmitted、seq 等字段；版本号必须跟着走，
  // 否则 v3 账本与 v4 账本无法区分，迁移逻辑没有判据。
  check('7 账本版本是 4', raw.version === 4, String(raw.version))
  const auto = raw.events.find((e) => e.sid === 'sess-agnostic-auto')
  check('7 auto 事件的 preCleaned 带体积', Array.isArray(auto?.preCleaned) && auto.preCleaned[0]?.size === 96,
    JSON.stringify(auto?.preCleaned))
}

await rm(root, { recursive: true, force: true })

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
