// v3 的两条新链路验证：模型自己先清干净时的 auto 记账，以及 report_temp_cleanup 工具。
//
// 背景：实测 110 个会话、49334 次工具调用，模型几乎总在 turn 结束前就 `rm -f` 把临时件
// 删掉（子进程，不触发 fs/delete-intent）。等到 turn-stopping 再 stat，文件早没了，
// v2 的「已释放空间」因此长期为 0。v3 的做法是：
//   1) write/edit intent 落盘那一刻就把体积记进 state（文件还没被删，量得到）；
//   2) 模型用 rm -f 删掉、插件拿不到体积时，靠 report_temp_cleanup 主动上报。
// 这个文件把两条链路各跑一遍，断言账本里真的记上了字节。
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { StatsStore } from '../lib/stats.js'

const results = []
function check(label, pass, detail) {
  results.push({ label, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

const root = await mkdtemp(join(tmpdir(), 'tc-report-'))
const cwd = join(root, 'ws')
await mkdir(cwd, { recursive: true })
const statsFile = join(root, 'logs', 'stats.json')

/** 与宿主 cordis 4.1.0 同形：inject 返回 then-only thenable，没有 catch/finally。 */
function makeCtx({ withTools = true } = {}) {
  const listeners = new Map()
  const registered = []
  const services = withTools ? { tools: { register: (definition) => { registered.push(definition); return () => {} } } } : {}
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
      const fiber = { ok: true, value: out }
      return Object.assign(Object.create(fiber), {
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

const ctx = makeCtx()
apply(ctx, { enabled: true, stats: true, statsFile, logFile: '' })
await new Promise((r) => setTimeout(r, 60))

// ── 工具注册 ────────────────────────────────────────────────────────────────
check('注册了恰好一个工具', ctx.registered.length === 1, `count=${ctx.registered.length}`)
const tool = ctx.registered[0]
check('工具名是 report_temp_cleanup', tool?.name === 'report_temp_cleanup', String(tool?.name))
check('工具声明了 output.render', typeof tool?.output?.render === 'function', typeof tool?.output?.render)
check('工具参数 schema 是 object', tool?.parameters?.type === 'object', String(tool?.parameters?.type))
check('files 是必填数组',
  Array.isArray(tool?.parameters?.required) && tool.parameters.required.includes('files') &&
  tool?.parameters?.properties?.files?.type === 'array',
  JSON.stringify(tool?.parameters?.required))

// ── 场景 1：模型写完又自己 rm -f 删掉（不走 intent）→ 应记 auto + 体积 ──────
{
  const agent = makeAgent('sess-auto')
  await ctx.emitPlain('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })

  // 照抄宿主的真实顺序：waterfall('fs/write-intent') 的 next 是空操作 → 真正写盘 →
  // 写成功后 emit('fs/observed', {kind:'present'})。体积只能靠最后一步拿到。
  const abs = join(cwd, 'probe-auto.mjs')
  await ctx.emitWaterfall('fs/write-intent', { targetKey: abs }, { agent }, () => undefined)
  await writeFile(abs, 'x'.repeat(100))
  await ctx.emitPlain('fs/observed', { targetKey: abs }, { kind: 'present' }, { agent })

  // 模拟 rm -f：直接删，不触发任何 intent
  await rm(abs, { force: true })

  await ctx.emitSerial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  check('1 已清干净 → 不打扰模型', agent.steered.length === 0, `steers=${agent.steered.length}`)

  await ctx.emitPlain('session/event', agent.session, { type: 'turn/end', data: { turn: 1 } })
  await new Promise((r) => setTimeout(r, 80))

  const store = new StatsStore(statsFile)
  const rec = await store.turnRecord('sess-auto', 1)
  check('1 记了一条 auto 事件', rec !== null && rec.kind === 'auto', JSON.stringify(rec?.kind))
  check('1 preCleaned 记到 1 个文件', rec?.preCleaned === 1, String(rec?.preCleaned))
  check('1 记到了 100 字节', rec?.preCleanedBytes === 100, String(rec?.preCleanedBytes))
  check('1 没有把文件报成待清理', rec?.temps === 0, String(rec?.temps))
}

// ── 场景 2：bash 造的文件（无 intent），删完主动上报 → 体积进账 ─────────────
{
  const agent = makeAgent('sess-report')
  await ctx.emitPlain('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })

  // bash 直接落盘：没有 intent，插件完全不知道这个文件存在过
  const abs = join(cwd, 'scratch-bash.log')
  await writeFile(abs, 'y'.repeat(250))
  await rm(abs, { force: true })

  const out = await tool.execute({ files: [{ path: 'scratch-bash.log', bytes: 250 }] }, { agent })
  check('2 上报被接受', out.accepted === 1 && out.bytes === 250, JSON.stringify(out))

  await ctx.emitSerial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  check('2 上报后仍不打扰模型', agent.steered.length === 0, `steers=${agent.steered.length}`)

  await ctx.emitPlain('session/event', agent.session, { type: 'turn/end', data: { turn: 1 } })
  await new Promise((r) => setTimeout(r, 80))

  const store = new StatsStore(statsFile)
  const rec = await store.turnRecord('sess-report', 1)
  check('2 上报的体积进了 preCleaned', rec?.preCleanedBytes === 250, String(rec?.preCleanedBytes))
}

// ── 场景 3：上报一个仍然存在的文件 → 不采信（防虚报） ───────────────────────
{
  const agent = makeAgent('sess-still')
  await ctx.emitPlain('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })

  const abs = join(cwd, 'check-still.ps1')
  await writeFile(abs, 'z'.repeat(999))
  const out = await tool.execute({ files: [{ path: 'check-still.ps1', bytes: 999 }] }, { agent })
  check('3 上报被接受（接口层面）', out.accepted === 1, JSON.stringify(out))

  await ctx.emitSerial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  await ctx.emitPlain('session/event', agent.session, { type: 'turn/end', data: { turn: 1 } })
  await new Promise((r) => setTimeout(r, 80))

  const store = new StatsStore(statsFile)
  const rec = await store.turnRecord('sess-still', 1)
  check('3 文件还在 → 不计入已释放', rec === null || rec.preCleanedBytes === 0, JSON.stringify(rec?.preCleanedBytes))

  const sum = await store.summary('session', 'sess-still')
  check('3 汇总里也没有虚报字节', sum.preCleanedBytes === 0, String(sum.preCleanedBytes))
}

// ── 场景 4：没有 tools 服务时不注册、不崩 ───────────────────────────────────
{
  const bare = makeCtx({ withTools: false })
  let error = null
  try {
    apply(bare, { enabled: true, stats: false })
  } catch (e) {
    error = e
  }
  check('4 无 tools 服务时 apply 不抛', error === null, error ? String(error.message ?? error) : 'no throw')
  check('4 无 tools 服务时不注册工具', bare.registered.length === 0, `count=${bare.registered.length}`)
}

// ── 场景 5：上报空路径被忽略，不产生脏记录 ──────────────────────────────────
{
  const agent = makeAgent('sess-bad')
  const out = await tool.execute({ files: [{ path: '   ' }, { path: '' }] }, { agent })
  check('5 空路径全部 ignored', out.accepted === 0 && out.ignored === 2, JSON.stringify(out))
}

// ── 场景 7：闸门真的发文案时，只有在工具注册成功后才提 report_temp_cleanup ──
{
  const agent = makeAgent('sess-hint')
  await ctx.emitPlain('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })

  // 留一个不删的临时件，逼闸门开口
  const abs = join(cwd, 'probe-leftover.mjs')
  await writeFile(abs, 'w'.repeat(7))
  await ctx.emitWaterfall('fs/write-intent', { targetKey: abs }, { agent }, () => undefined)

  await ctx.emitSerial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  const body = agent.steered[0]?.content?.[0]?.text ?? ''
  check('7 有残留时确实拦了模型', agent.steered.length === 1, `steers=${agent.steered.length}`)
  check('7 工具已注册 → 文案提到 report_temp_cleanup',
    body.includes('report_temp_cleanup'), body.slice(-160))
  check('7 文案仍带原有的删除指令', body.includes('probe-leftover.mjs'), body.slice(0, 120))
}

// ── 场景 8：没有 tools 服务时，文案绝不提这个不存在的工具 ───────────────────
{
  const bare = makeCtx({ withTools: false })
  apply(bare, { enabled: true, stats: false })
  const agent = makeAgent('sess-nohint')
  await bare.emitPlain('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
  const abs = join(cwd, 'probe-nohint.mjs')
  await writeFile(abs, 'v'.repeat(5))
  await bare.emitWaterfall('fs/write-intent', { targetKey: abs }, { agent }, () => undefined)

  await bare.emitSerial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  const body = agent.steered[0]?.content?.[0]?.text ?? ''
  check('8 无工具时仍然拦', agent.steered.length === 1, `steers=${agent.steered.length}`)
  check('8 无工具时文案不提 report_temp_cleanup',
    body.length > 0 && !body.includes('report_temp_cleanup'), body.slice(-160))
  await rm(abs, { force: true })
}

// ── 场景 9：体积只认 fs/observed，不认 intent ───────────────────────────────
// 宿主里 fs/write-intent 的 next 是空操作，写盘发生在 waterfall 之后。所以 intent
// 回调那一刻文件还不存在 —— 若在那里量体积，必然落成 0（0.6.0 线上就是这样）。
{
  const agent = makeAgent('sess-observed')
  await ctx.emitPlain('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })

  // A：只发 intent、不发 observed，然后删掉 → 路径进账，体积只能是 0（量不到）
  const blind = join(cwd, 'probe-blind.mjs')
  await ctx.emitWaterfall('fs/write-intent', { targetKey: blind }, { agent }, () => undefined)
  await writeFile(blind, 'b'.repeat(64))
  await rm(blind, { force: true })

  // B：走完整序列 intent → 写盘 → observed，再删掉 → 体积必须是 64
  const seen = join(cwd, 'probe-seen.mjs')
  await ctx.emitWaterfall('fs/write-intent', { targetKey: seen }, { agent }, () => undefined)
  await writeFile(seen, 's'.repeat(64))
  await ctx.emitPlain('fs/observed', { targetKey: seen }, { kind: 'present' }, { agent })
  await rm(seen, { force: true })

  // C：只「读过」的文件（只有 observed、没有 intent）不能被当成本轮动过手。
  // str_replace_editor 的 view / tool-fs 的 read 都会发 observed，形状与写入后完全一样。
  const readOnly = join(cwd, 'probe-readonly.mjs')
  await writeFile(readOnly, 'r'.repeat(32))
  await ctx.emitPlain('fs/observed', { targetKey: readOnly }, { kind: 'present' }, { agent })

  await ctx.emitSerial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  check('9 都清干净了 → 不打扰模型', agent.steered.length === 0, `steers=${agent.steered.length}`)
  check('9 只读过的文件不算本轮写过的临时件（没被叫去删）',
    !agent.steered.some((m) => JSON.stringify(m).includes('probe-readonly')), `steers=${agent.steered.length}`)

  await ctx.emitPlain('session/event', agent.session, { type: 'turn/end', data: { turn: 1 } })
  await new Promise((r) => setTimeout(r, 80))

  const rec = await new StatsStore(statsFile).turnRecord('sess-observed', 1)
  check('9 两个文件都进了 preCleaned', rec?.preCleaned === 2, String(rec?.preCleaned))
  check('9 体积只来自 observed（64，不是 0）', rec?.preCleanedBytes === 64, String(rec?.preCleanedBytes))
}

// ── 场景 6：账本文件是 v3 且带 kind / preCleaned 字段 ──────────────────────
{
  const raw = JSON.parse(await readFile(statsFile, 'utf8'))
  check('6 账本版本是 3', raw.version === 3, String(raw.version))
  const auto = raw.events.find((e) => e.kind === 'auto')
  check('6 事件带 kind 字段', auto !== undefined, `events=${raw.events.length}`)
  check('6 auto 事件带 preCleaned 数组',
    Array.isArray(auto?.preCleaned) && auto.preCleaned.length > 0,
    JSON.stringify(auto?.preCleaned))
}

await rm(root, { recursive: true, force: true })

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
