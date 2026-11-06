// 本地行为验证：用假 ctx 模拟 agent-loop 的调用顺序，不依赖 DSH 运行时。
// 覆盖：正例 / 约定目录 / 交付物反例 / 存量反例 / 防抖 / 子会话 / 禁用。
import { mkdir, writeFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, name, inject } from '../lib/index.js'

const log = []
function makeCtx() {
  const listeners = new Map()
  const logger = {
    info: (m) => log.push(['info', m]),
    warn: (m) => log.push(['warn', m])
  }
  return {
    logger,
    on(evt, cb) {
      if (!listeners.has(evt)) listeners.set(evt, [])
      listeners.get(evt).push(cb)
    },
    async emitSerial(evt, payload) {
      let out
      for (const cb of listeners.get(evt) ?? []) out = await cb(payload)
      return out
    },
    async emitWaterfall(evt, ...args) {
      // 最后一个参数是 default
      const cbs = listeners.get(evt) ?? []
      const next = args.pop()
      const chain = [...cbs]
      const step = async (i) => {
        if (i >= chain.length) return next()
        return chain[i](...args, () => step(i + 1))
      }
      return step(0)
    },
    async emitPlain(evt, ...args) {
      for (const cb of listeners.get(evt) ?? []) await cb(...args)
    }
  }
}

function makeAgent(root, { origin = 'user', delegationDepth = 0, id = 'sess-1' } = {}) {
  const steered = []
  const session = { id, header: { cwd: root, origin, delegationDepth } }
  const agent = {
    session,
    status: 'running',
    steer(msg) {
      steered.push(msg)
    }
  }
  return { agent, steered }
}

const results = []
function check(label, pass, detail) {
  results.push({ label, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

async function scenario(label, { root, setup, origin, delegationDepth, files, expectSteer, expectFiles, config = {}, steps = 1 }) {
  const ctx = makeCtx()
  apply(ctx, { enabled: true, ...config })
  const { agent, steered } = makeAgent(root, { origin, delegationDepth })
  if (setup) await setup()

  // turn 1 开始
  await ctx.emitPlain('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })

  // 模拟本 turn 的写入
  for (const f of files ?? []) {
    const abs = join(root, f)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, 'x')
    await ctx.emitWaterfall('fs/write-intent', { targetKey: abs }, { agent }, () => undefined)
  }

  // 模拟 agent-loop 的 turn-stopping 闸门，最多允许 steps 次 steer
  let steers = 0
  for (let i = 0; i < steps; i++) {
    const before = steered.length
    await ctx.emitSerial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
    if (steered.length > before) steers++
  }

  await ctx.emitPlain('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  const passSteer = expectSteer ? steers > 0 : steers === 0
  check(label + ' · steer', passSteer, `steers=${steers}`)

  if (expectFiles !== undefined) {
    const alive = []
    for (const f of expectFiles) {
      try {
        await stat(join(root, f))
        alive.push(f)
      } catch {}
    }
    check(label + ' · 文件仍在（插件不删文件）', alive.length === expectFiles.length, `alive=${alive.join(',') || '-'}`)
  }
  return { steered, steers }
}

const base = join(tmpdir(), 'dsh-turn-cleanup-test')
await rm(base, { recursive: true, force: true })

// 1 正例：probe-test-*.mjs
const r1 = await scenario('1 正例 probe-test', {
  root: base + '/s1',
  files: ['probe-test-1700000000.mjs'],
  expectSteer: true,
  expectFiles: ['probe-test-1700000000.mjs']
})
console.log('   steer 文案:\n' + (r1.steered[0]?.content[0].text ?? '').split('\n').map((l) => '     ' + l).join('\n'))

// 2 约定目录
await scenario('2 约定目录 .agent-tmp', {
  root: base + '/s2',
  setup: async () => {
    await mkdir(join(base, 's2', '.agent-tmp'), { recursive: true })
    await writeFile(join(base, 's2', '.agent-tmp', 'junk.log'), 'x')
  },
  expectSteer: true,
  expectFiles: ['.agent-tmp/junk.log']
})

// 3 交付物反例
await scenario('3 反例 交付物 .xlsx', {
  root: base + '/s3',
  files: ['report-2026.xlsx'],
  expectSteer: false,
  expectFiles: ['report-2026.xlsx']
})

// 4 存量反例
await scenario('4 反例 84 个存量 probe-*', {
  root: base + '/s4',
  setup: async () => {
    await mkdir(join(base, 's4'), { recursive: true })
    for (let i = 0; i < 84; i++) await writeFile(join(base, 's4', `probe-stale-${i}.mjs`), 'x')
  },
  files: [],
  expectSteer: false
})

// 5 防抖：3 个文件不删，跑 3 次闸门
await scenario('5 防抖 3 文件跑 3 次闸门', {
  root: base + '/s5',
  files: ['probe-a.mjs', 'tmp-b.log', 'scratch-c.txt'],
  expectSteer: true,
  steps: 3
})

// 6 子会话
await scenario('6 子会话 subagent', {
  root: base + '/s6',
  origin: 'subagent',
  files: ['probe-x.mjs'],
  expectSteer: false
})

// 7 禁用
{
  const ctx = makeCtx()
  apply(ctx, { enabled: false })
  const { agent, steered } = makeAgent(base + '/s7')
  await mkdir(join(base, 's7'), { recursive: true })
  await writeFile(join(base, 's7', 'probe-y.mjs'), 'x')
  await ctx.emitPlain('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
  await ctx.emitWaterfall('fs/write-intent', { targetKey: join(base, 's7', 'probe-y.mjs') }, { agent }, () => undefined)
  await ctx.emitSerial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  check('7 禁用 enabled:false · steer', steered.length === 0, `steers=${steered.length}`)
  check('7 禁用 · 无 listener 注册', log.some(([lvl, m]) => lvl === 'info' && m.includes('disabled')), 'disabled log')
}

console.log('\n=== 日志样本 ===')
for (const [lvl, m] of log) console.log(`[${lvl}] ${m}`)

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
