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
check(typeof tail?.descriptor.inject === 'function', 'turn tail inject is a factory function')

const injected = typeof tail?.descriptor.inject === 'function' ? tail.descriptor.inject('session-abc') : {}
check(injected.sessionId === 'session-abc', 'turn tail inject forwards the session id')
check(typeof injected.t === 'function', 'turn tail inject forwards the translator')
const injectedEmpty = typeof tail?.descriptor.inject === 'function' ? tail.descriptor.inject('') : {}
check(
  injectedEmpty.sessionId === undefined,
  'turn tail inject omits an empty session id instead of forwarding ""'
)
check(typeof tail?.component === 'function', 'turn tail has a component')

// --- render smoke: TurnBadge must return null when the turn was never gated --
const rendered = tail.component({ turn: 7, sessionId: 'session-abc', t: (k) => `t:${k}` })
check(rendered === null, 'TurnBadge renders nothing before the stats fetch resolves')

// --- panel smoke: CleanupPanel must render without throwing -----------------
const panel = settings.component({ close: () => {}, t: (k) => `t:${k}` })
check(panel !== null && typeof panel === 'object', 'CleanupPanel renders a tree')

console.log('')
console.log(`${passed}/${passed + failed} checks passed`)
process.exit(failed === 0 ? 0 : 1)
