// 本地行为验证：用假 ctx 模拟 agent-loop 的调用顺序，不依赖 DSH 运行时。
// 覆盖：正例 / 约定目录 / 交付物反例 / 存量反例 / 防抖 / 子会话 / 禁用 /
//       备份保留（steer 模式、prune 模式、原件缺失、符号链接、keep 边界）。
import { mkdir, writeFile, rm, stat, symlink, utimes, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, name, inject } from '../lib/index.js'

const log = []
function makeCtx(services = {}) {
  const listeners = new Map()
  const logger = {
    info: (m) => log.push(['info', m]),
    warn: (m) => log.push(['warn', m])
  }
  // 工具注册收集器：插件通过 ctx.inject(['tools'], …) 注册 report_temp_cleanup，
  // 这里把定义存下来，测试可以直接调 definition.execute(args, exec) 走一遍真实逻辑。
  const registeredTools = []
  const ctx = {
    logger,
    // 可选服务探测口：插件用 ctx.get('workingDirectory') 取运行时 cwd，
    // 拿不到就退回 session.header.cwd。这里按需注入假服务。
    get(name) {
      return services[name]
    },
    // 与宿主 cordis 4.1.0 同形：then-only thenable，没有 catch/finally。
    // 插件若误写 .catch() 会在这里当场炸，测试立刻红。
    inject(wanted, callback) {
      const sub = {
        tools: {
          register(definition) {
            registeredTools.push(definition)
            return () => {}
          }
        },
        webServer: { register: () => () => {} },
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
    effect(fn) {
      const dispose = fn()
      return () => dispose?.()
    },
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
  ctx.registeredTools = registeredTools
  return ctx
}

function makeAgent(root, { origin = 'user', delegationDepth = 0, id = 'sess-1', noFollowup = false, headerCwd } = {}) {
  const steered = []
  const modes = []
  // headerCwd 用来模拟「会话创建时的 cwd」与「实际写入目录」不一致（符号链接 / junction）。
  const session = { id, header: { cwd: headerCwd ?? root, origin, delegationDepth } }
  const agent = {
    session,
    status: 'running',
    steer(msg) {
      modes.push('steer')
      steered.push(msg)
    }
  }
  // 老版本 agent 没有 followup；插件应当退回 steer 而不是崩。
  if (!noFollowup) {
    agent.followup = (msg) => {
      modes.push('followup')
      steered.push(msg)
    }
  }
  return { agent, steered, modes }
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

async function scenario(label, { root, setup, origin, delegationDepth, files, recorded, expectSteer, expectFiles, expectMode, noFollowup, config = {}, steps = 1, services = {}, headerCwd, intentEvent = 'fs/write-intent' }) {
  const ctx = makeCtx(services)
  // 默认关掉统计账本：假 ctx 没有 $DSH_HOME 概念，开着会把测试数据写进真实账本。
  // 需要验证统计的场景显式传 stats: true + statsFile。
  apply(ctx, { enabled: true, stats: false, ...config })
  const { agent, steered, modes } = makeAgent(root, { origin, delegationDepth, noFollowup, headerCwd })
  if (setup) await setup()

  // turn 1 开始
  await ctx.emitPlain('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })

  // 模拟本 turn 的写入（真写，会刷新 mtime）
  //
  // 顺序照抄宿主：先 waterfall('fs/write-intent')（next 是空操作），再真正写盘，
  // 写成功后 emit('fs/observed', target, {kind:'present'}, exec)。插件的体积就靠最后
  // 这一步拿到 —— intent 回调里量必然量到「文件还不存在」。
  for (const f of files ?? []) {
    const abs = join(root, f)
    await mkdir(join(abs, '..'), { recursive: true })
    await ctx.emitWaterfall(intentEvent, { targetKey: abs }, { agent }, () => undefined)
    await writeFile(abs, 'x')
    await ctx.emitPlain('fs/observed', { targetKey: abs }, { kind: 'present' }, { agent })
  }

  // 只登记写入意图、不重写文件（保住 mtime 顺序，用于备份家族判定）
  for (const f of recorded ?? []) {
    const abs = join(root, f)
    await ctx.emitWaterfall(intentEvent, { targetKey: abs }, { agent }, () => undefined)
  }

  // 模拟 agent-loop 的 turn-stopping 闸门，最多允许 steps 次交付
  let steers = 0
  for (let i = 0; i < steps; i++) {
    const before = steered.length
    await ctx.emitSerial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
    if (steered.length > before) steers++
  }

  await ctx.emitPlain('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  const passSteer = expectSteer ? steers > 0 : steers === 0
  check(label + ' · steer', passSteer, `steers=${steers}`)

  // 默认交付方式是 followup（另开一轮），否则同一轮多跑一步会把交付汇报折叠掉。
  if (expectMode !== undefined) {
    const seen = modes[0] ?? '-'
    check(label + ' · 交付方式', seen === expectMode, `mode=${seen}`)
  }

  if (expectFiles !== undefined) {
    const alive = []
    for (const f of expectFiles) {
      if (await exists(join(root, f))) alive.push(f)
    }
    check(label + ' · 文件仍在（插件不删文件）', alive.length === expectFiles.length, `alive=${alive.join(',') || '-'}`)
  }
  return { steered, steers, modes }
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

const baseRaw = join(tmpdir(), 'dsh-turn-cleanup-test')
await rm(baseRaw, { recursive: true, force: true })
await mkdir(baseRaw, { recursive: true })
// 必须归一：macOS 上 tmpdir() 是 /var/folders/…，它本身是指向 /private/var/… 的
// 符号链接。插件在 turn-stopping 里对 cwd 做 canonicalCwd（realpath），而这里的
// root 若停在未归一的写法，insideCwd 会算出 ../../..，整机所有场景都不拦。
// Windows 与 Linux 上 realpath 是恒等变换，不影响既有行为。
const base = await realpath(baseRaw)

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
    // 下面的断言比的是中文原文，必须把语言钉死。默认 auto 会走 LANG/LC_ALL 回退链，
    // CI 的 ubuntu runner 是 C.UTF-8/en_US.UTF-8 → 解析成 en → 文案变英文 → 断言红。
    config: { backupRetention: { keep: 3 }, messageLocale: 'zh' }
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
    config: { backupRetention: { keep: 3, mode: 'prune' }, messageLocale: 'zh' }
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
    config: { backupRetention: { keep: 3 }, messageLocale: 'zh' }
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

// === 17-22 可移植性回归：这些是审计里实测过的误伤/漏报，锁住不让它回来 ===

// 17 裸 check* / bench* 曾按文件名前缀吃掉正常业务代码 —— 现在不该再报
await scenario('17 正常业务文件名不误伤', {
  root: base + '/s17',
  files: ['checkout.js', 'Checklist.md', 'benchmark.ts', 'checks.py'],
  expectSteer: false
})

// 18 但带分隔符的临时件仍然要报（模式的本来用途）
await scenario('18 带分隔符的临时件仍命中', {
  root: base + '/s18',
  files: ['check-1.sh', 'bench_2.mjs'],
  expectSteer: true,
  expectFiles: ['check-1.sh', 'bench_2.mjs']
})

// 19 默认保护段覆盖各生态通用构建目录（dist/build/target/vendor/...）
await scenario('19 默认保护段 dist', {
  root: base + '/s19',
  files: ['dist/probe-a.mjs'],
  expectSteer: false
})

// 20 protectedSegments 显式给值时**整体替换**默认值 —— 用户要能取消某个默认保护段
await scenario('20 protectedSegments 可覆盖默认值', {
  root: base + '/s20',
  files: ['dist/probe-a.mjs'],
  expectSteer: true,
  config: { protectedSegments: ['.git'] }
})

// 21 fs/edit-intent 也要记账：模型用 edit/str_replace 造临时件时不会走 write-intent
await scenario('21 fs/edit-intent 也记账', {
  root: base + '/s21',
  files: ['probe-edited.mjs'],
  intentEvent: 'fs/edit-intent',
  expectSteer: true
})

// 22 fs/delete-intent 记账后 stat 失败 → 自然跳过，不该报已删除的路径
await scenario('22 fs/delete-intent 不误报', {
  root: base + '/s22',
  recorded: ['probe-deleted.mjs'],
  intentEvent: 'fs/delete-intent',
  expectSteer: false
})

// 23 注入文案的语言可配（原先把中文硬编码进了模型回合）
{
  const rZh = await scenario('23 messageLocale zh', {
    root: base + '/s23zh',
    files: ['probe-lang.mjs'],
    expectSteer: true,
    config: { messageLocale: 'zh' }
  })
  const zhText = rZh.steered[0]?.content[0].text ?? ''
  check('23 zh · 文案是中文', zhText.includes('收尾前清场'), zhText.split('\n')[0])

  const rEn = await scenario('23 messageLocale en', {
    root: base + '/s23en',
    files: ['probe-lang.mjs'],
    expectSteer: true,
    config: { messageLocale: 'en' }
  })
  const enText = rEn.steered[0]?.content[0].text ?? ''
  check('23 en · 文案是英文', enText.includes('Clean up before you finish'), enText.split('\n')[0])
  check('23 en · 不再混入中文', !/[\u4e00-\u9fff]/.test(enText), 'no CJK')

  // source.form = 'notice' 让 chat UI 知道这不是用户说的话
  const src = rEn.steered[0]?.source ?? {}
  check('23 · source.kind 不自称用户', src.kind === 'dsh-turn-cleanup', String(src.kind))
  check('23 · source.form = notice', src.form === 'notice', String(src.form))
  check('23 · source.summary 存在', typeof src.summary === 'string' && src.summary.length > 0, String(src.summary))
}

// 24b header.cwd 缺失时不能拿 workingDirectory 的 defaultDirectory 顶替：
//     宿主 projection 的 init 是 `header.cwd ?? null`，state 为 null 时 get() 返回
//     process.cwd() —— 那是进程目录，不是这个会话的目录。
{
  const strayDir = base + '/s24b-stray'
  await mkdir(strayDir, { recursive: true })
  await scenario('24b header.cwd 缺失时不越界扫进程目录', {
    root: strayDir,
    headerCwd: '',
    files: ['probe-stray.mjs'],
    expectSteer: false,
    services: { workingDirectory: { get: () => strayDir } }
  })
}

// 24 运行时 cwd 跟随 working_directory(cd: ...)：header.cwd 是会话创建时的旧目录
{
  const oldDir = base + '/s24-old'
  const newDir = base + '/s24-new'
  await mkdir(oldDir, { recursive: true })
  await mkdir(newDir, { recursive: true })
  await scenario('24 workingDirectory 服务优先于 header.cwd', {
    root: newDir,
    headerCwd: oldDir,
    files: ['probe-cd.mjs'],
    expectSteer: true,
    services: { workingDirectory: { get: () => newDir } }
  })
}

// 25 cwd 是符号链接/junction 时，写入侧路径是 realpath —— 归一后仍要能命中
{
  const realDir = base + '/s25-real'
  const linkDir = base + '/s25-link'
  await mkdir(realDir, { recursive: true })
  let linked = true
  try {
    await symlink(realDir, linkDir, 'junction')
  } catch {
    linked = false
  }
  if (!linked) {
    console.log('SKIP  25 junction cwd · 本机不能建目录联接')
  } else {
    await scenario('25 junction cwd 归一后命中', {
      root: realDir,
      headerCwd: linkDir,
      files: ['probe-junction.mjs'],
      expectSteer: true
    })
  }
}

// 26 README.bak.md 不是 README 的备份。老 BACKUP_RE 把 .bak 之后的任何后缀都当家族成员，
//    prune 模式下会连带删掉用户自己命名的文档 —— README.bak.md 被算成 README 的备份。
{
  const root = base + '/s26'
  await makeFamily(root, 'README', 4)
  await writeFile(join(root, 'README.bak.md'), 'user doc')
  await scenario('26 README.bak.md 不算备份', {
    root,
    recorded: ['README'],
    expectSteer: false,
    config: { backupRetention: { keep: 1, mode: 'prune' } }
  })
  check('26 用户文档存活', await exists(join(root, 'README.bak.md')))
  const alive = []
  for (const n of ['README.bak-v0', 'README.bak-v1', 'README.bak-v2', 'README.bak-v3']) {
    if (await exists(join(root, n))) alive.push(n)
  }
  check('26 只删最旧的 3 份', alive.join(',') === 'README.bak-v3', alive.join(',') || '-')
}

// 27 keep=0 回落到默认 3。老实现把它静默夹成 1 —— 配 3 份的人醒来发现只剩 1 份。
{
  const root = base + '/s27'
  const names = await makeFamily(root, 'app.log', 6)
  await scenario('27 keep=0 回落 3', {
    root,
    recorded: ['app.log'],
    expectSteer: false,
    config: { backupRetention: { keep: 0, mode: 'prune' } }
  })
  const alive = []
  for (const n of names) if (await exists(join(root, n))) alive.push(n)
  check('27 删 3 留 3', alive.length === 3, 'alive=' + (alive.join(',') || '-'))
}

// 28 a.txt.bak.bak 不并入 a.txt 家族（老实现按前缀 startsWith 归桶，会把它算进去）。
//    把它的 mtime 设成最旧：真被算进家族，prune 一定先删它。
{
  const root = base + '/s28'
  const names = await makeFamily(root, 'a.txt', 5)
  await writeFile(join(root, 'a.txt.bak.bak'), 'double')
  await utimes(join(root, 'a.txt.bak.bak'), 1699999900, 1699999900)
  await scenario('28 x.bak.bak 不并入原件家族', {
    root,
    recorded: ['a.txt'],
    expectSteer: false,
    config: { backupRetention: { keep: 3, mode: 'prune' } }
  })
  const alive = []
  for (const n of names) if (await exists(join(root, n))) alive.push(n)
  check('28 只删最旧 2 份', alive.sort().join(',') === 'a.txt.bak-v2,a.txt.bak-v3,a.txt.bak-v4', alive.join(',') || '-')
  check('28 a.txt.bak.bak 未被牵连', await exists(join(root, 'a.txt.bak.bak')))
}

// 29 约定目录扫描深度：scanDepth=4 报到第 4 层，第 5 层不报（老实现只到第 2 层）。
{
  const root = base + '/s29'
  // files 里必须是 root 相对路径（scenario 内部再 join(root, f)）
  const tooDeep = join(root, '.agent-tmp/a/b/c/d/probe-too-deep.mjs')
  await mkdir(join(tooDeep, '..'), { recursive: true })
  await writeFile(tooDeep, 'x')
  const r = await scenario('29 scanDepth=4 报到第 4 层', {
    root,
    files: ['.agent-tmp/a/b/c/probe-deep.mjs'],
    expectSteer: true
  })
  const text = r.steered[0]?.content[0].text ?? ''
  check('29 第 4 层命中', text.includes('probe-deep.mjs'), text.slice(0, 60))
  check('29 第 5 层不报', !text.includes('probe-too-deep'), text.slice(0, 60))
}

// 29b 约定目录越界（../escape 指到工作区外）必须直接放弃，不能顺着走。
{
  const root = base + '/s29b'
  const escapeDir = join(root, '..', 'escape-s29b')
  await mkdir(escapeDir, { recursive: true })
  await writeFile(join(escapeDir, 'probe-out.mjs'), 'x')
  const r = await scenario('29b 约定目录越界不扫', {
    root,
    expectSteer: false,
    config: { tmpDirName: '../escape-s29b' }
  })
  check('29b 工作区外文件不报', r.steers === 0, 'steers=' + r.steers)
  await rm(escapeDir, { recursive: true, force: true })
}

// 30 tmpDirName 反斜杠归一成 posix；绝对路径 / 盘符回落默认目录。
{
  const root = base + '/s30a'
  await mkdir(join(root, 'tmp/agent'), { recursive: true })
  await writeFile(join(root, 'tmp/agent/junk.log'), 'x')
  const r = await scenario('30a tmpDirName 反斜杠可用', {
    root,
    expectSteer: true,
    config: { tmpDirName: 'tmp\\agent' }
  })
  const text = r.steered[0]?.content[0].text ?? ''
  check('30a 反斜杠归一后命中', text.includes('tmp/agent/junk.log'), text.slice(0, 80))
}
{
  const root = base + '/s30b'
  await mkdir(join(root, '.agent-tmp'), { recursive: true })
  await writeFile(join(root, '.agent-tmp/junk.log'), 'x')
  await writeFile(join(root, 'probe-no.mjs'), 'x')
  const r = await scenario('30b 盘符绝对路径回落默认', {
    root,
    expectSteer: true,
    config: { tmpDirName: 'D:\\x' }
  })
  const text = r.steered[0]?.content[0].text ?? ''
  check('30b 回落 .agent-tmp', text.includes('.agent-tmp/junk.log'), text.slice(0, 80))
  check('30b 不用盘符目录', !text.includes('D:/x'), text.slice(0, 80))
}

// 31 mtime 容差：容差 0 时「本轮开始前 500ms 写的」算老文件；容差 2000 时算本轮产物。
//    FAT32/exFAT 2s 粒度、SMB 1s 粒度下，硬编码 1000ms 会必假阴性。
async function toleranceProbe(label, toleranceMs) {
  const root = base + '/' + label
  const abs = join(root, 'probe-tol.mjs')
  const ctx = makeCtx()
  const cfg = toleranceMs === null ? {} : { mtimeToleranceMs: toleranceMs }
  apply(ctx, { enabled: true, stats: false, ...cfg })
  const { agent, steered } = makeAgent(root)
  const session = agent.session
  await mkdir(root, { recursive: true })
  await writeFile(abs, 'x')
  ctx.emitPlain('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  const callId = 'call-tol-' + label
  ctx.emitPlain('session/event', session, {
    type: 'tool/call',
    data: { turn: 1, step: 1, callId, name: 'write_file', arguments: JSON.stringify({ path: abs }) }
  })
  const old = (Date.now() - 500) / 1000
  await utimes(abs, old, old)
  ctx.emitPlain('session/event', session, {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text: 'ok' }]
      }
    }
  })
  await ctx.emitSerial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  return steered.length
}
{
  const zero = await toleranceProbe('s31-zero', 0)
  check('31 容差 0 · 500ms 前的不算本轮', zero === 0, 'steers=' + zero)
  const dflt = await toleranceProbe('s31-default', null)
  check('31 默认 2000ms · 500ms 前的算本轮', dflt === 1, 'steers=' + dflt)
}

// 32 每轮删除条数上限：maxPrunePerTurn=1 时只删 1 份，其余留给下一轮，并留 prune-limit 告警。
{
  const root = base + '/s32'
  const names = await makeFamily(root, 'cap.yml', 6)
  const before = log.length
  const r = await scenario('32 maxPrunePerTurn 生效', {
    root,
    recorded: ['cap.yml'],
    expectSteer: true,
    config: { backupRetention: { keep: 2, mode: 'prune', maxPrunePerTurn: 1 } }
  })
  const alive = []
  for (const n of names) if (await exists(join(root, n))) alive.push(n)
  check('32 只删 1 份', alive.length === 5, 'alive=' + alive.length)
  const lines = log.slice(before).map(([, m]) => m)
  const pruneLine = lines.find((m) => m.includes('prune ') && m.includes('deleted=1'))
  check('32 留 prune 日志', pruneLine !== undefined, pruneLine?.slice(0, 70) ?? 'missing')
  const limitLine = lines.find((m) => m.includes('prune-limit'))
  check('32 留 prune-limit 告警', limitLine !== undefined, limitLine?.slice(0, 70) ?? 'missing')
  check('32 未删完仍催模型', r.steers > 0, 'steers=' + r.steers)
}

console.log('\n=== 日志样本 ===')
// 15 steerMode:'steer' → 同轮多跑一步（硬闸门），文案照旧
await scenario('15 steerMode steer', {
  root: base + '/s15',
  files: ['probe-mode.mjs'],
  expectSteer: true,
  expectMode: 'steer',
  config: { steerMode: 'steer' }
})

// 16 老 agent 没有 followup() → 退回 steer，不崩
await scenario('16 无 followup 时退回 steer', {
  root: base + '/s16',
  files: ['probe-legacy.mjs'],
  noFollowup: true,
  expectSteer: true,
  expectMode: 'steer'
})

for (const [lvl, m] of log) console.log(`[${lvl}] ${m}`)

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
