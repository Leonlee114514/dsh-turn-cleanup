/**
 * Client-half contract test.
 *
 * The client bundle only runs inside the Harness Web shell, which loads it through
 * `window.__ModuleLoader__`. That makes it easy to ship a bundle that parses but
 * registers nothing — this file drives the factory against a fake loader, a fake
 * ctx and a minimal React, then asserts the two slot registrations and the locale
 * dictionary. No browser, no Harness, no build step.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')

let passed = 0
let failed = 0

function check(ok, name, detail = '') {
  if (ok) {
    passed += 1
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`)
  }
}

/** Minimal React: enough for module-level definition and for one render. */
function fakeReact() {
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children })
  return {
    createElement,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (v) => ({ current: v }),
    Fragment: 'fragment'
  }
}

/** Flatten a rendered tree to its text nodes — enough to assert on cell contents. */
function flatten(node) {
  if (node === null || node === undefined || node === false) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(flatten)
  if (typeof node === 'object') return flatten(node.children)
  return []
}

/** Fake loader capture: the bundle calls window.__ModuleLoader__.load({id, factory}). */
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded = spec
    }
  }
}

const source = readFileSync(bundlePath, 'utf8')
// The bundle is a plain script that self-registers; evaluate it with the fake window.
new Function('window', 'globalThis', source)(globalThis.window, globalThis)

check(loaded !== null, 'bundle self-registers through window.__ModuleLoader__')
check(loaded?.id === 'dsh-turn-cleanup', 'module id is the package name', String(loaded?.id))
check(typeof loaded?.factory === 'function', 'factory is a function')

const react = fakeReact()
const require = (name) => {
  if (name === 'react') return react
  throw new Error(`unexpected require(${name})`)
}

const plugin = loaded.factory(require)

check(Array.isArray(plugin.inject), 'exports an inject list')
check(
  plugin.inject.includes('slots') && plugin.inject.includes('locale'),
  'inject asks for slots + locale',
  plugin.inject.join(', ')
)
check(typeof plugin.apply === 'function', 'exports apply()')

// --- fake ctx -------------------------------------------------------------
const registrations = []
const localeRegistrations = []
const effects = []
let localeBound = null

const ctx = {
  effect(fn) {
    // Real cordis runs the execute callback immediately and keeps its return value
    // as the disposer; the fake does the same so a bundle that only registers inside
    // an effect is still exercised.
    const disposer = fn()
    effects.push(disposer)
    return () => {
      if (typeof disposer === 'function') disposer()
    }
  },
  locale: {
    bind(ns) {
      localeBound = ns
      return (key) => `t:${ns}:${key}`
    },
    register(ns, dict) {
      localeRegistrations.push({ ns, dict })
      return () => {}
    }
  },
  slots: {
    inject(name, fn) {
      const out = fn()
      return typeof out === 'function' ? out : () => {}
    },
    register(descriptor, component) {
      registrations.push({ descriptor, component })
      return () => {}
    }
  }
}

plugin.apply(ctx)

check(localeBound === 'turn-cleanup', 'locale namespace bound', String(localeBound))
check(localeRegistrations.length === 1, 'registers exactly one locale namespace')
const dict = localeRegistrations[0]?.dict ?? {}
check(
  typeof dict.zh === 'object' && typeof dict.en === 'object',
  'locale dictionary carries zh and en',
  `${Object.keys(dict.zh ?? {}).length} zh keys / ${Object.keys(dict.en ?? {}).length} en keys`
)
const zhKeys = Object.keys(dict.zh ?? {}).sort()
const enKeys = Object.keys(dict.en ?? {}).sort()
check(
  zhKeys.length === enKeys.length && zhKeys.every((k, i) => k === enKeys[i]),
  'zh and en dictionaries have identical key sets'
)

check(registrations.length === 2, 'registers two slots', String(registrations.length))

const settings = registrations.find((r) => r.descriptor.name === 'settings.section')
const tail = registrations.find((r) => r.descriptor.name === 'conversation.chat.turnTail')

check(settings !== undefined, 'registers settings.section')
check(settings?.descriptor.id === 'turn-cleanup', 'settings section id', String(settings?.descriptor.id))
check(settings?.descriptor.order === 32, 'settings section order', String(settings?.descriptor.order))
check(typeof settings?.descriptor.label === 'function', 'settings label is a thunk (locale-following)')
check(
  typeof settings?.descriptor.label === 'function' && settings.descriptor.label() === 't:turn-cleanup:nav',
  'settings label resolves through the bound locale'
)
check(typeof settings?.component === 'function', 'settings section has a component')

check(tail !== undefined, 'registers conversation.chat.turnTail')
check(tail?.descriptor.id === 'turn-cleanup-turn', 'turn tail id', String(tail?.descriptor.id))
check(tail?.descriptor.order === 12, 'turn tail order', String(tail?.descriptor.order))
// renderer 的 standardKit 已经按 entry.locale 提供 locale 绑定的 `t`
// （localeSeat(face, entry.locale)），slot 自己再 inject 一个 `t` 就是重名 prop：
// assertNoPropOverlap 会抛 `received duplicate prop 't'`。
check(
  tail?.descriptor.inject === undefined,
  'turn tail does not inject `t` (standardKit already provides it)',
  String(tail?.descriptor.inject)
)
check(
  tail?.descriptor.locale === 'turn-cleanup',
  'turn tail binds the locale namespace so standardKit can seat `t`',
  String(tail?.descriptor.locale)
)
check(typeof tail?.component === 'function', 'turn tail has a component')

// --- fmtBytes: 面板里「已释放空间」唯一的数字来源 ------------------------------
// 0 / 负数 / NaN / 非数字都必须落到 '0 B'，不能让面板显示 NaN 或空白。
check(typeof plugin.fmtBytes === 'function', 'exports fmtBytes for the size card')
const bytes = plugin.fmtBytes ?? (() => '')
check(bytes(0) === '0 B', 'fmtBytes(0) → 0 B', bytes(0))
check(bytes(-5) === '0 B', 'fmtBytes(negative) → 0 B', bytes(-5))
check(bytes(Number.NaN) === '0 B', 'fmtBytes(NaN) → 0 B', bytes(Number.NaN))
check(bytes(undefined) === '0 B', 'fmtBytes(undefined) → 0 B', bytes(undefined))
check(bytes(512) === '512 B', 'fmtBytes(512) → 512 B', bytes(512))
check(bytes(1024) === '1.00 KB', 'fmtBytes(1024) → 1.00 KB', bytes(1024))
check(bytes(1536) === '1.50 KB', 'fmtBytes(1536) → 1.50 KB', bytes(1536))
check(bytes(75 * 1024) === '75.0 KB', 'fmtBytes(75 KiB) → 75.0 KB', bytes(75 * 1024))
check(bytes(1024 * 1024) === '1.00 MB', 'fmtBytes(1 MiB) → 1.00 MB', bytes(1024 * 1024))
check(bytes(3 * 1024 * 1024 * 1024) === '3.00 GB', 'fmtBytes(3 GiB) → 3.00 GB', bytes(3 * 1024 * 1024 * 1024))

// --- freedBytes: 面板「已释放空间」的真正口径 ---------------------------------
// 只看 cleanedBytes 会长期显示 0 B：模型几乎总在复核之前就把临时件 rm 掉了。
check(typeof plugin.freedBytes === 'function', 'exports freedBytes for the size card')
const freed = plugin.freedBytes ?? (() => -1)
check(freed({ cleanedBytes: 100, preCleanedBytes: 250 }) === 350, 'freedBytes sums both sources', String(freed({ cleanedBytes: 100, preCleanedBytes: 250 })))
check(freed({ cleanedBytes: 100 }) === 100, 'freedBytes tolerates missing preCleanedBytes', String(freed({ cleanedBytes: 100 })))
check(freed({ preCleanedBytes: 40 }) === 40, 'freedBytes tolerates missing cleanedBytes', String(freed({ preCleanedBytes: 40 })))
check(freed({}) === 0, 'freedBytes({}) → 0', String(freed({})))
check(freed(null) === 0, 'freedBytes(null) → 0', String(freed(null)))
check(freed({ cleanedBytes: 1, preCleanedBytes: 2 }) === 3, 'freedBytes is not a max', String(freed({ cleanedBytes: 1, preCleanedBytes: 2 })))

// --- recent 表: 字节必须取整行, 不能取 verify 子对象 ---------------------------
// 模型几乎总在复核前就自己 rm 掉了, 所以 verify 里只剩 cleaned=0/remaining=0,
// 真正的字节全在行顶层的 preCleanedBytes。早先这里把 freedBytes(r.verify) 拼在
// 复核列后面, 于是每一行都显示「已清 0 / 仍在 0」——卡片有数字、这张表没有。
check(typeof plugin.RecentTable === 'function', 'exports RecentTable for the recent-table contract')
const RecentTable = plugin.RecentTable ?? (() => null)
const recentRow = {
  at: '2026-11-19T17:01:44.363Z',
  turn: 21,
  sid: 'session-bfdc2247-0000-0000-0000-000000000000',
  temps: 0,
  backups: 0,
  preCleaned: 23,
  preCleanedBytes: 105953,
  cleanedBytes: 0,
  verify: { cleaned: 0, remaining: 0, cleanedBytes: 0, remainingBytes: 0 }
}
const recentText = flatten(RecentTable({ stats: { recent: [recentRow] }, t: (k) => `t:${k}` })).join(' | ')
check(
  recentText.includes(bytes(105953)),
  'recent 行把 preCleanedBytes 显示成释放体积（不只 cleanedBytes）',
  recentText
)
check(
  recentText.includes('t:resultCleaned 0 / t:resultRemaining 0'),
  'recent 行的复核列仍如实显示 已清 0 / 仍在 0',
  recentText
)
const pendingText = flatten(
  RecentTable({ stats: { recent: [{ ...recentRow, verify: null }] }, t: (k) => `t:${k}` })
).join(' | ')
check(
  pendingText.includes('t:resultPending') && pendingText.includes(bytes(105953)),
  '待复核的行同样带出释放体积（数据已落账，只是还没 stat）',
  pendingText
)
// 两个加数都要算: 行顶层 cleanedBytes（闸门报出去、之后真消失的）与 preCleanedBytes
// （模型抢在复核前自己删的）。只取其一会让这类轮次少算一半。
const mixedText = flatten(
  RecentTable({
    stats: { recent: [{ ...recentRow, cleanedBytes: 2419, preCleanedBytes: 105953 }] },
    t: (k) => `t:${k}`
  })
).join(' | ')
check(
  mixedText.includes(bytes(105953 + 2419)),
  'recent 行的释放体积 = 行顶层 cleanedBytes + preCleanedBytes',
  mixedText
)

// --- render smoke: TurnBadge must return null when the turn was never gated --
const rendered = tail.component({ turn: 7, sessionId: 'session-abc', t: (k) => `t:${k}` })
check(rendered === null, 'TurnBadge renders nothing before the stats fetch resolves')

// --- panel smoke: CleanupPanel must render without throwing -----------------
const panel = settings.component({ close: () => {}, t: (k) => `t:${k}` })
check(panel !== null && typeof panel === 'object', 'CleanupPanel renders a tree')

console.log('')
console.log(`${passed}/${passed + failed} checks passed`)
process.exit(failed === 0 ? 0 : 1)
