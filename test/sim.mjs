// 本地行为验证：用假 ctx 模拟 agent-loop 的调用顺序，不依赖 DSH 运行时。
// 覆盖：正例 / 约定目录 / 交付物反例 / 存量反例 / 防抖 / 子会话 / 禁用 /
//       备份保留（steer 模式、prune 模式、原件缺失、符号链接、keep 边界）。
import { mkdir, writeFile, rm, stat, symlink, utimes } from 'node:fs/promises'
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

async function exists(abs) {
  try {
    await stat(abs)
    return true
  } catch {
    return false
  }
}

async function scenario(label, { root, setup, origin, delegationDepth, files, recorded, expectSteer, expectFiles, config = {}, steps = 1 }) {
  const ctx = makeCtx()
  apply(ctx, { enabled: true, ...config })
  const { agent, steered } = makeAgent(root, { origin, delegationDepth })
  if (setup) await setup()

  // turn 1 开始
  await ctx.emitPlain('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })

  // 模拟本 turn 的写入（真写，会刷新 mtime）
  for (const f of files ?? []) {
    const abs = join(root, f)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, 'x')
    await ctx.emitWaterfall('fs/write-intent', { targetKey: abs }, { agent }, () => undefined)
  }

  // 只登记写入意图、不重写文件（保住 mtime 顺序，用于备份家族判定）
  for (const f of recorded ?? []) {
    const abs = join(root, f)
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
      if (await exists(join(root, f))) alive.push(f)
    }
    check(label + ' · 文件仍在（插件不删文件）', alive.length === expectFiles.length, `alive=${alive.join(',') || '-'}`)
  }
  return { steered, steers }
}

/** 造一份带确定 mtime 的备份家族：mtime 越大越新。 */
async function makeFamily(root, stem, count, { withOriginal = true, startSec = 1700000000 } = {}) {
  await mkdir(root, { recursive: true })
  if (withOriginal) {
    await writeFile(join(root, stem), 'original')
    await utimes(join(root, stem), startSec + count + 1, startSec + count + 1)
  }
  const names = []
  for (let i = 0; i < count; i++) {
    const n = `${stem}.bak-v${i}`
    await writeFile(join(root, n), `backup-${i}`)
    await utimes(join(root, n), startSec + i, startSec + i)
    names.push(n)
  }
  return names
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
await scenario('4 反例 存量 probe-*', {
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

// 8 备份 steer 模式：6 份备份，keep=3 → 只报最旧 3 份，一个都不删
{
  const root = base + '/s8'
  const names = await makeFamily(root, 'cordis.patch.yml', 6)
  const r = await scenario('8 备份 steer 6 份 keep=3', {
    root,
    // 本轮碰过原件（写它），家族才会被纳入
    recorded: ['cordis.patch.yml'],
    expectSteer: true,
    expectFiles: names,
    config: { backupRetention: { keep: 3 } }
  })
  const text = r.steered[0]?.content[0].text ?? ''
  const listed = (text.match(/\.bak-v\d/g) ?? []).length
  check('8 备份 · 只列超量 3 份', listed === 3, `listed=${listed}`)
  check('8 备份 · 文案含保留份数', text.includes('最近 3 份'), text.split('\n')[0] ?? '')
  check('8 备份 · 最新的没被列进清单', !text.includes('bak-v5') && !text.includes('bak-v4') && !text.includes('bak-v3'), 'excess only')
}

// 9 备份 prune 模式：6 份 keep=3 → 删掉最旧 3 份，留最新 3 份 + 原件
{
  const root = base + '/s9'
  const names = await makeFamily(root, 'cordis.patch.yml', 6)
  const r = await scenario('9 备份 prune 6 份 keep=3', {
    root,
    recorded: ['cordis.patch.yml'],
    expectSteer: false, // 全删干净，无残留 → 不 steer
    config: { backupRetention: { keep: 3, mode: 'prune' } }
  })
  const alive = []
  for (const n of names) if (await exists(join(root, n))) alive.push(n)
  check('9 备份 prune · 只剩最新 3 份', alive.length === 3, `alive=${alive.join(',')}`)
  check('9 备份 prune · 留下的正好是 v5/v4/v3', alive.sort().join(',') === 'cordis.patch.yml.bak-v3,cordis.patch.yml.bak-v4,cordis.patch.yml.bak-v5', alive.join(','))
  check('9 备份 prune · 原件还在', await exists(join(root, 'cordis.patch.yml')), 'original')
  check('9 备份 prune · 无 steer', r.steers === 0, `steers=${r.steers}`)
}

// 10 备份 prune + 原件缺失 → 备份保留逻辑整族不管，一条都不删
// 注意：本轮写过的 .bak-* 本身仍会被通道 2 当临时件报出来（模式命中），
// 所以这里断言的是「备份段不出现、一份都不删」，不是「完全不 steer」。
{
  const root = base + '/s10'
  const names = await makeFamily(root, 'gone.txt', 6, { withOriginal: false })
  // 本轮确实碰过这个家族的备份（例如模型自己又存了一份），但原件早已不在
  const r = await scenario('10 prune 原件缺失 6 份 keep=3', {
    root,
    recorded: ['gone.txt.bak-v0'],
    expectSteer: true, // 通道 2 把 .bak-v0 当临时件报出，这是预期行为
    config: { backupRetention: { keep: 3, mode: 'prune' } }
  })
  const text = r.steered[0]?.content[0].text ?? ''
  const alive = []
  for (const n of names) if (await exists(join(root, n))) alive.push(n)
  check('10 原件缺失 · 一份都没删', alive.length === 6, `alive=${alive.length}/6`)
  check('10 原件缺失 · 备份段不出现（无参照物不催删）', !text.includes('备份超量'), text.slice(0, 40))
}

// 11 备份 prune + 符号链接 → 不删链接，但列入清单交模型处理
// Windows 非管理员默认不能建 file symlink（EPERM），这种情况下明确标 SKIP，
// 不把「建不出链接」伪装成「守卫通过」。GitHub 的 windows-latest 开了开发者模式，
// 能建链接 —— 这条分支只在 CI 上真跑，本地 SKIP。
//
// 注意 utimes 会顺着符号链接改到目标，要改链接自身的时间戳必须用 lutimes。
{
  const root = base + '/s11'
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'real.txt'), 'real')
  await utimes(join(root, 'real.txt'), 1700000100, 1700000100)
  const target = join(root, 'link-target.txt')
  await writeFile(target, 'outside')

  let canSymlink = true
  try {
    await symlink(target, join(root, 'probe-link'))
    await rm(join(root, 'probe-link'), { force: true })
  } catch {
    canSymlink = false
  }

  if (!canSymlink) {
    check('11 符号链接 · 跳过（本机不能建 file symlink）', true, 'SKIP: EPERM without admin/developer mode')
  } else {
    // 造 4 个备份：最旧的是指向 link-target.txt 的符号链接（v0），另三个是真文件。
    // planBackups 用 stat（跟链）取 mtime，v0 拿到的是目标的 1700000000 —— 最旧。
    // keep=2 ⇒ 排序 v3,v2,v1,v0 ⇒ kept=[v3,v2]、excess=[v1,v0]。
    // prune 应当删 v1（真文件），跳过 v0（符号链接），并把 v0 留在清单里交模型处理。
    await utimes(target, 1700000000, 1700000000)
    await symlink(target, join(root, 'real.txt.bak-v0'))
    for (let i = 1; i < 4; i++) {
      const p = join(root, `real.txt.bak-v${i}`)
      await writeFile(p, `b${i}`)
      await utimes(p, 1700000000 + i, 1700000000 + i)
    }
    await scenario('11 prune 符号链接不删但列入清单', {
      root,
      recorded: ['real.txt'],
      expectSteer: true,
      config: { backupRetention: { keep: 2, mode: 'prune' } }
    })
    const alive = []
    for (let i = 0; i < 4; i++) if (await exists(join(root, `real.txt.bak-v${i}`))) alive.push(i)
    check('11 符号链接 · 链接本身未被删', alive.includes(0), `alive=${alive.join(',')}`)
    check('11 符号链接 · 链接目标未受影响', await exists(target), 'target alive')
    check('11 符号链接 · 超量真文件备份已删', !alive.includes(1), `alive=${alive.join(',')}`)
    check('11 符号链接 · 最新 keep 份未动', alive.includes(2) && alive.includes(3), `alive=${alive.join(',')}`)
    const line = log.map(([, m]) => m).filter((m) => m.includes('turn=1') && m.includes('real.txt.bak-v0')).pop() ?? ''
    check('11 符号链接 · 跳过的链接进了 steer 清单', line.includes('real.txt.bak-v0'), line.slice(0, 120))
  }
}

// 12 keep 边界：正好 3 份 → 不报、不删
{
  const root = base + '/s12'
  const names = await makeFamily(root, 'exact.yml', 3)
  await scenario('12 边界 正好 keep=3 份', {
    root,
    recorded: ['exact.yml'],
    expectSteer: false,
    expectFiles: names,
    config: { backupRetention: { keep: 3, mode: 'prune' } }
  })
  const alive = []
  for (const n of names) if (await exists(join(root, n))) alive.push(n)
  check('12 边界 · 3 份全留', alive.length === 3, `alive=${alive.length}/3`)
}

// 13 与临时件共存：备份 + probe-* 同时命中，一段 steer 覆盖两件事
{
  const root = base + '/s13'
  const names = await makeFamily(root, 'cfg.yml', 5)
  const r = await scenario('13 共存 备份 + 临时件', {
    root,
    files: ['probe-z.mjs'],
    recorded: ['cfg.yml'],
    expectSteer: true,
    config: { backupRetention: { keep: 3 } }
  })
  const text = r.steered[0]?.content[0].text ?? ''
  check('13 共存 · 文案含临时件段', text.includes('收尾前清场'), 'temp section')
  check('13 共存 · 文案含备份段', text.includes('备份超量'), 'backup section')
  check('13 共存 · 备份一份没删', (await Promise.all(names.map((n) => exists(join(root, n))))) .filter(Boolean).length === 5, 'all backups alive')
}

// 14 backupRetention.enabled:false → 备份完全不参与
{
  const root = base + '/s14'
  const names = await makeFamily(root, 'off.yml', 6)
  await scenario('14 backupRetention 关闭', {
    root,
    recorded: ['off.yml'],
    expectSteer: false,
    expectFiles: names,
    config: { backupRetention: { enabled: false, keep: 3, mode: 'prune' } }
  })
  const alive = []
  for (const n of names) if (await exists(join(root, n))) alive.push(n)
  check('14 关闭 · 6 份全留', alive.length === 6, `alive=${alive.length}/6`)
}

console.log('\n=== 日志样本 ===')
for (const [lvl, m] of log) console.log(`[${lvl}] ${m}`)

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
