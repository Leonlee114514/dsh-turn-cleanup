// 面板数据通道的本地验证：用假 ctx 把 apply 跑起来，断言
//   1) stats 账本在闸门触发时落盘
//   2) turn/end 之后 verify 把「已清 / 仍在」算对
//   3) 注册的 HTTP 路由按 query 返回三种形状（汇总 / 单会话 / 单 turn）
// 不依赖 DSH 运行时，几秒跑完。
import { mkdtemp, writeFile, mkdir, unlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const results = []
function check(label, pass, detail) {
  results.push({ label, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

const root = await mkdtemp(join(tmpdir(), 'tc-web-'))
const cwd = join(root, 'ws')
await mkdir(cwd, { recursive: true })
const statsFile = join(root, 'logs', 'stats.json')
const logFile = join(root, 'logs', 'cleanup.log')

const listeners = new Map()
const routes = []
const injected = []
let cmFlushed = 0
const ctx = {
  logger: { info() {}, warn() {} },
  on(evt, cb) {
    if (!listeners.has(evt)) listeners.set(evt, [])
    listeners.get(evt).push(cb)
  },
  effect(fn) {
    const dispose = fn()
    return () => dispose?.()
  },
  inject(services, callback) {
    injected.push([...services])
    const sub = {
      webServer: services.includes('webServer')
        ? {
            register(route) {
              routes.push(route)
              return () => {}
            }
          }
        : undefined,
      clientModules: services.includes('clientModules')
        ? {
            graph: () => ({ entries: [] }),
            dirty: new Set(),
            // 真的把本包收进 graph：记录「自救成功」这条路也跑一遍。
            flush(onError) {
              cmFlushed += 1
              this.entries = [{ id: 'dsh-turn-cleanup', url: 'plugins/??dsh-turn-cleanup/client.js&rev=fedcba987654' }]
              onError?.(null)
            },
            entries: []
          }
        : undefined,
      tools: services.includes('tools') ? { register() { return () => {} } } : undefined,
      effect(fn) {
        const dispose = fn()
        return () => dispose?.()
      }
    }
    // clientModules 桩的 graph 要读得到 flush 后写进去的 entries。
    if (sub.clientModules) sub.clientModules.graph = () => ({ entries: sub.clientModules.entries })
    const out = callback(sub)
    // cordis 4.1.0 的 ctx.inject() 返回 Object.create(fiber) 再挂一个 then 的 thenable：
    // 有 then，没有 catch / finally。这里照抄这个形状——插件的 apply 一旦误写 .catch()，
    // 这一行就会抛 `ctx.inject(...).catch is not a function`，测试当场红。
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

let applyError = null
try {
  apply(ctx, { enabled: true, stats: true, statsFile, logFile, logFile2: undefined })
} catch (error) {
  applyError = error
}
await new Promise((r) => setTimeout(r, 60))

check('apply 在 then-only thenable 下不抛', applyError === null,
  applyError ? String(applyError.message ?? applyError) : 'no throw')
check('注册了 /turn-cleanup/stats 路由', routes.length === 1 && routes[0].path === '/turn-cleanup/stats',
  routes.map((r) => `${r.kind}:${r.path}`).join(','))
check('路由是 exact', routes[0]?.kind === 'exact', String(routes[0]?.kind))

// 冷启动自救：apply 时 clientModules 的 fiber 还没 ACTIVE（reflect.get strict 返回 undefined），
// 所以 apply 必须走 ctx.inject 等它就绪，而不是同步 ctx.get 一下就放弃。
// 这三条断言的靶子就是日志里 40+ 行 `client entry check: clientModules service absent`。
check('inject 请求了 webServer', injected.some((s) => s.includes('webServer')),
  JSON.stringify(injected))
check('inject 请求了 clientModules（不靠 ctx.get 同步探测）',
  injected.some((s) => s.includes('clientModules')), JSON.stringify(injected))
check('inject 请求了 tools（不靠 ctx.get 同步探测）',
  injected.some((s) => s.includes('tools')), JSON.stringify(injected))
check('clientModules 就绪后真的 dirty+flush 一次', cmFlushed === 1, `flushed=${cmFlushed}`)

const session = { id: 'sess-web-1', header: { cwd, origin: 'user', delegationDepth: 0 } }
const agent = { session, status: 'running', steered: [], steer(m) { this.steered.push(m) } }

await ctx.emitPlain('session/event', session, { type: 'turn/start', data: { turn: 7 } })

// 本轮写了两个临时件（一个会被删，一个留着）+ 一个交付物
const keepMe = join(cwd, 'probe-keep.mjs')
const deleteMe = join(cwd, 'probe-gone.mjs')
const deliverable = join(cwd, 'report.xlsx')
for (const abs of [keepMe, deleteMe, deliverable]) {
  await writeFile(abs, 'x')
  await ctx.emitWaterfall('fs/write-intent', { targetKey: abs }, { agent }, () => undefined)
}

await ctx.emitSerial('agent/turn-stopping', { agent, turn: 7, signal: new AbortController().signal })
check('闸门拦了（只报两个 probe）', agent.steered.length === 1,
  agent.steered[0]?.content?.[0]?.text?.split('\n').slice(0, 4).join(' | '))
check('交付物没被报', !String(agent.steered[0]?.content?.[0]?.text).includes('report.xlsx'), '')

// 模型删掉一个
await unlink(deleteMe)
await ctx.emitPlain('session/event', session, { type: 'turn/end', data: { turn: 7 } })
await new Promise((r) => setTimeout(r, 80))

/** 调一次路由，拿 JSON。 */
async function callRoute(url) {
  return await new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      headers: null,
      body: '',
      writeHead(code, headers) { this.statusCode = code; this.headers = headers },
      end(chunk) { this.body += chunk ?? ''; resolve({ code: this.statusCode, headers: this.headers, json: JSON.parse(this.body || 'null') }) }
    }
    Promise.resolve(routes[0].handler({ url }, res)).catch(reject)
  })
}

// 默认交付方式是 followup：清单排进下一轮，本轮 turn/end 时模型还没动手，
// 所以复核点落在 turn + 1。按真实时序先确认「本轮结束不复核」。
const early = await callRoute('/turn-cleanup/stats')
check('followup · 本轮结束不复核', early.json.verifiedEvents === 0 && early.json.cleaned === 0,
  `verified=${early.json.verifiedEvents} cleaned=${early.json.cleaned}`)

// 下一轮（turn 8）结束才是「已经动过手」。
await ctx.emitPlain('session/event', session, { type: 'turn/end', data: { turn: 8 } })
await new Promise((r) => setTimeout(r, 80))

const all = await callRoute('/turn-cleanup/stats')
check('汇总 gates=1', all.json.gates === 1, JSON.stringify({ gates: all.json.gates }))
check('汇总 reported=2', all.json.reported === 2, String(all.json.reported))
check('汇总 cleaned=1 / remaining=1', all.json.cleaned === 1 && all.json.remaining === 1,
  `cleaned=${all.json.cleaned} remaining=${all.json.remaining}`)
check('依从率 0.5', Math.abs((all.json.compliance ?? -1) - 0.5) < 1e-9, String(all.json.compliance))
check('content-type 是 json', String(all.headers?.['content-type']).includes('application/json'), String(all.headers?.['content-type']))

// 体积：两个 probe 各写 1 字节 'x'，一个被删一个留着。
// reportedBytes 是「报出去的清单有多大」，cleanedBytes 才是真正释放掉的。
check('汇总 reportedBytes=2', all.json.reportedBytes === 2, String(all.json.reportedBytes))
check('汇总 cleanedBytes=1 / remainingBytes=1',
  all.json.cleanedBytes === 1 && all.json.remainingBytes === 1,
  `cleanedBytes=${all.json.cleanedBytes} remainingBytes=${all.json.remainingBytes}`)
check('bySession 行带体积',
  all.json.bySession?.[0]?.reportedBytes === 2 && all.json.bySession?.[0]?.cleanedBytes === 1,
  JSON.stringify({ reportedBytes: all.json.bySession?.[0]?.reportedBytes, cleanedBytes: all.json.bySession?.[0]?.cleanedBytes }))
check('recent 行的复核带体积',
  all.json.recent?.[0]?.verify?.cleanedBytes === 1 && all.json.recent?.[0]?.verify?.remainingBytes === 1,
  JSON.stringify(all.json.recent?.[0]?.verify))
// 行顶层也要有 cleanedBytes：面板的 freedBytes(row) 读整行，不是读 row.verify。
// 缺这个字段时 typeof 把 undefined 当 0，那列会静默少算 cleanedBytes 那部分。
check('recent 行顶层带 cleanedBytes 与 preCleanedBytes',
  all.json.recent?.[0]?.cleanedBytes === 1 && all.json.recent?.[0]?.preCleanedBytes === 0,
  JSON.stringify({ cleanedBytes: all.json.recent?.[0]?.cleanedBytes, preCleanedBytes: all.json.recent?.[0]?.preCleanedBytes }))

// v3：模型自己先清干净的那部分单独记，面板的「已释放空间」= cleanedBytes + preCleanedBytes。
// 这个场景里模型没抢在闸门之前动手（闸门当场就报了两个 probe），所以 preCleaned 应为 0，
// 但字段必须存在——缺字段会让面板拿到 undefined 而不是 0。
check('汇总带 preCleaned / preCleanedBytes 字段',
  all.json.preCleaned === 0 && all.json.preCleanedBytes === 0,
  JSON.stringify({ preCleaned: all.json.preCleaned, preCleanedBytes: all.json.preCleanedBytes }))
check('recent 行带 kind 与 preCleaned',
  all.json.recent?.[0]?.kind === 'gate' && all.json.recent?.[0]?.preCleaned === 0,
  JSON.stringify({ kind: all.json.recent?.[0]?.kind, preCleaned: all.json.recent?.[0]?.preCleaned }))
check('bySession 行带 preCleanedBytes',
  all.json.bySession?.[0]?.preCleanedBytes === 0,
  String(all.json.bySession?.[0]?.preCleanedBytes))

const perSession = await callRoute('/turn-cleanup/stats?scope=session&sid=sess-web-1')
check('单会话 gates=1', perSession.json.scope === 'session' && perSession.json.gates === 1,
  `${perSession.json.scope}/${perSession.json.gates}`)

const perTurn = await callRoute('/turn-cleanup/stats?sid=sess-web-1&turn=7')
check('单 turn 记录形状', perTurn.json !== null && perTurn.json.temps === 2 && perTurn.json.cleaned === 1,
  JSON.stringify(perTurn.json))
check('单 turn 记录带复核时机', perTurn.json?.verifyAtTurn === 8 && perTurn.json?.steerMode === 'followup',
  `verifyAtTurn=${perTurn.json?.verifyAtTurn} steerMode=${perTurn.json?.steerMode}`)
check('单 turn 记录带体积', perTurn.json?.cleanedBytes === 1 && perTurn.json?.remainingBytes === 1,
  `cleanedBytes=${perTurn.json?.cleanedBytes} remainingBytes=${perTurn.json?.remainingBytes}`)

const missTurn = await callRoute('/turn-cleanup/stats?sid=sess-web-1&turn=99')
check('未拦截的 turn 返回 null', missTurn.json === null, JSON.stringify(missTurn.json))

const badScope = await callRoute('/turn-cleanup/stats?scope=session')
check('session 但无 sid → 退回汇总', badScope.json.scope === 'all', badScope.json.scope)

// 路由的 method / 参数校验：宿主 handler 型路由任何 method 都会派发进来，
// 老实现只管 GET，POST/PUT 也能跑通并返回数据；turn 非数字时抛到 500 而不是 400。
async function callRouteWith(url, method) {
  return await new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      headers: null,
      body: '',
      writeHead(code, headers) { this.statusCode = code; this.headers = headers },
      end(chunk) { this.body += chunk ?? ''; resolve({ code: this.statusCode, headers: this.headers, json: (() => { try { return JSON.parse(this.body || 'null') } catch { return undefined } })() }) }
    }
    Promise.resolve(routes[0].handler({ url, method }, res)).catch(reject)
  })
}

const post = await callRouteWith('/turn-cleanup/stats', 'POST')
check('非 GET → 405', post.code === 405, 'code=' + post.code)
check('405 带 allow 头', String(post.headers?.allow ?? '').includes('GET') && String(post.headers?.allow ?? '').includes('HEAD'),
  String(post.headers?.allow))
check('405 body 是错误对象', post.json?.error === 'method not allowed', JSON.stringify(post.json))

const head = await callRouteWith('/turn-cleanup/stats', 'HEAD')
check('HEAD 放行', head.code === 200, 'code=' + head.code)

const badTurn = await callRouteWith('/turn-cleanup/stats?sid=sess-web-1&turn=abc', 'GET')
check('turn 非数字 → 400', badTurn.code === 400, 'code=' + badTurn.code + ' body=' + JSON.stringify(badTurn.json))
check('400 带说明', typeof badTurn.json?.error === 'string' && badTurn.json.error.length > 0, JSON.stringify(badTurn.json))

const noSid = await callRouteWith('/turn-cleanup/stats?turn=7', 'GET')
check('turn 有值但 sid 空 → 400', noSid.code === 400, 'code=' + noSid.code)

// 会话视图死锁：bySession 曾用「过滤后的事件」聚合，?scope=session 时只剩一行，
// 面板的会话下拉永远只有一个选项、对比表恒隐藏。现在恒基于全量。
const second = { id: 'sess-web-2', header: { cwd, origin: 'user', delegationDepth: 0 } }
const agent2 = { session: second, status: 'running', steered: [], steer(m) { this.steered.push(m) } }
await ctx.emitPlain('session/event', second, { type: 'turn/start', data: { turn: 1 } })
const probe2 = join(cwd, 'probe-second.mjs')
await writeFile(probe2, 'y')
await ctx.emitWaterfall('fs/write-intent', { targetKey: probe2 }, { agent: agent2 }, () => undefined)
await ctx.emitPlain('fs/observed', { targetKey: probe2 }, { kind: 'present' }, { agent: agent2 })
await ctx.emitSerial('agent/turn-stopping', { agent: agent2, turn: 1, signal: new AbortController().signal })
await ctx.emitPlain('session/event', second, { type: 'turn/end', data: { turn: 1 } })
await new Promise((r) => setTimeout(r, 80))

const scoped = await callRoute('/turn-cleanup/stats?scope=session&sid=sess-web-1')
check('会话视图仍列出全部会话', (scoped.json.bySession ?? []).length === 2,
  JSON.stringify((scoped.json.bySession ?? []).map((r) => r.sid)))
check('会话视图 sessionCount=2', scoped.json.sessionCount === 2, String(scoped.json.sessionCount))
check('会话视图只统计本会话的 gates', scoped.json.gates === 1, String(scoped.json.gates))

// 统计关闭时不该注册路由
const injects2 = []
const ctx2 = {
  logger: { info() {}, warn() {} },
  on() {},
  effect(fn) { fn() },
  inject(services) {
    injects2.push([...services])
    // 没有服务可用：模拟最精简 profile（连 tools / clientModules 都不在）。
    return { then(_, onRejected) { onRejected?.(new Error('no such service')) } }
  }
}
apply(ctx2, { enabled: true, stats: false })
check('stats:false 时不碰 webServer', !injects2.some((s) => s.includes('webServer')),
  JSON.stringify(injects2))

// 冷启动形状（就是日志里 40+ 次 absent 的那个现场）：
// clientModules 服务早就 provide 了，但提供它的 fiber 还没 ACTIVE，
// 于是 `ctx.get('clientModules')`（= reflect.get strict=true，cordis/lib/index.js:1347-1356）
// 返回 undefined。自救必须走 `ctx.inject(['clientModules'], …)` 等它就绪，
// 而不是同步探一下就 record('clientModules service absent') 然后放弃。
// 这个桩故意**不提供** get()，谁再退回去用 ctx.get 就会当场红。
const cmState = { entries: [], dirty: new Set(), flushed: 0, getCalls: 0 }
const stubClientModules = {
  graph: () => ({ entries: cmState.entries }),
  dirty: cmState.dirty,
  flush(onError) {
    cmState.flushed += 1
    cmState.entries = [{ id: 'dsh-turn-cleanup', url: 'plugins/??dsh-turn-cleanup/client.js&rev=abc123456789' }]
    onError?.(null)
  }
}
const ctx3 = {
  logger: { info() {}, warn() {} },
  on() {},
  effect(fn) { fn() },
  get(service) {
    cmState.getCalls += 1
    // 模拟「服务已 provide 但 fiber 未 ACTIVE」——strict 语义下就是 undefined。
    return undefined
  },
  inject(services, callback) {
    const sub = { effect(fn) { fn() } }
    if (services.includes('clientModules')) sub.clientModules = stubClientModules
    if (services.includes('tools')) sub.tools = { register() { return () => {} } }
    callback(sub)
    return { then() {} }
  }
}
apply(ctx3, { enabled: true, stats: false })
check('0.2.2 无 pkgMeta 时仍会 dirty+flush', cmState.flushed === 1 && cmState.dirty.has('dsh-turn-cleanup'),
  `flushed=${cmState.flushed} dirty=${[...cmState.dirty].join(',')}`)
check('服务未 ACTIVE 时不靠 ctx.get 下结论（走 inject 等就绪）',
  cmState.flushed === 1, `flushed=${cmState.flushed} getCalls=${cmState.getCalls}`)

await rm(root, { recursive: true, force: true })

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  FAILED: ${f.label}`)
  process.exit(1)
}
