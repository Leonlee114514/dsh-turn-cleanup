import { readdir, stat, appendFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, relative, isAbsolute, basename, dirname } from 'node:path'

/**
 * dsh-turn-cleanup — 收尾清场硬闸门。
 *
 * 背景：DSH 三层都缺自动清理。框架层有 `agent/turn-stopping`（serial，await 在
 * turn 边界提交前），全仓只有 workspace-changes（记变更）与 mnemon（写记忆）两个
 * 消费者，都不清理；组件层只清自己的 mkdtemp scratch；提示词层 AGENTS.md §C2
 * 只有自觉条款。这里把「自觉」升级成代码闸门。
 *
 * 语义：listener 里 `agent.steer(...)` 会让 inbox.nextStep.length 变 1，
 * agent-loop 的 `if (turnEnds && this.inbox.nextStep.length === 0) break;`
 * 因此不成立 —— 同一个 turn 多跑一步，模型拿到清单去删或说明理由。
 *
 * 两条检出通道（都只看「本轮」）：
 *   1. 约定目录 `<cwd>/.agent-tmp/`（可配 tmpDirName）—— 主机制，零误伤。
 *   2. `fs/write-intent` 记录的**本 turn 写入路径**里匹配临时件模式的那些。
 *      **绝不扫全工作区**：本机工作区躺着 84 个存量 probe-*，扫全量会天天误报。
 *
 * 防抖：按 (sessionId, turn) 只拦一次。第二次进 listener 直接 return，
 * 否则模型每多跑一步就再被拦一次，turn 永远结束不了。
 *
 * 不做的事：不删任何文件（只 steer 让模型自己判断）；不跑 git；不扫大目录；
 * 子会话（origin==="subagent" 或 delegationDepth>0）整段跳过 —— 它们的 cwd
 * 可能是别人的工作区。
 */

export const name = 'dsh-turn-cleanup'
export const inject = []

const DEFAULT_PATTERNS = [
  'probe-*',
  'tmp-*',
  'scratch-*',
  'check*',
  'diag_*',
  'bench*',
  '*.bak-*'
]

/** 这些目录段下的东西一律不报（不删整体目录，也不建议模型动它们）。 */
const PROTECTED_SEGMENTS = new Set(['.git', 'node_modules', '.tmp-sessions', 'out'])

const DEFAULT_TMP_DIR = '.agent-tmp'

function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const patterns = Array.isArray(raw.patterns)
    ? raw.patterns.filter((p) => typeof p === 'string' && p.trim().length > 0)
    : []
  // 只剥 "./"、"\" 前缀与首尾分隔符。不能把裸前导点一起剥掉，
  // 否则 `.agent-tmp` 会变成 `agent-tmp`，约定目录直接失效（v3 实测踩到）。
  const rawTmpDir = typeof raw.tmpDirName === 'string' ? raw.tmpDirName.trim() : ''
  const tmpDirName = rawTmpDir
    .replace(/^(?:\.\/)+/, '')
    .replace(/^(?:\.\\)+/, '')
    .replace(/^[/\\]+/, '')
    .replace(/[/\\]+$/, '')
  const normalizedTmpDir = tmpDirName.length > 0 ? tmpDirName : DEFAULT_TMP_DIR
  return {
    enabled: raw.enabled !== false,
    tmpDirName: normalizedTmpDir,
    patterns: patterns.length > 0 ? patterns : DEFAULT_PATTERNS.slice(),
    maxLogPaths: Number.isFinite(raw.maxLogPaths) ? Math.max(1, raw.maxLogPaths) : 10,
    maxSteerPaths: Number.isFinite(raw.maxSteerPaths) ? Math.max(1, raw.maxSteerPaths) : 20,
    scanDepth: Number.isFinite(raw.scanDepth) ? Math.max(1, Math.min(6, raw.scanDepth)) : 4,
    // ctx.logger.info 只进进程 stdout（Electron 主进程控制台），不落盘、事后无法 grep。
    // 给一个可选落盘通道：绝对路径，或相对 cwd 的路径；空字符串 = 不落盘。
    logFile: typeof raw.logFile === 'string' ? raw.logFile.trim() : ''
  }
}
/** glob → RegExp，只支持 `*` 与 `?`（够覆盖临时件模式，且不会误吃别的字符）。 */
function globToRegExp(glob) {
  let body = ''
  for (const ch of glob) {
    if (ch === '*') body += '.*'
    else if (ch === '?') body += '.'
    else body += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${body}$`, 'i')
}

function matchesAny(patterns, fileName) {
  for (const re of patterns) if (re.test(fileName)) return true
  return false
}

/** 与 dsh-workspace-changes 同一套判定：子会话 / 委派链一律不管。 */
function eligible(session) {
  const header = session === null || session === void 0 ? void 0 : session.header
  if (header === null || header === void 0) return void 0
  const { cwd, origin, delegationDepth } = header
  if (origin === 'subagent' || (delegationDepth ?? 0) > 0) return void 0
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : void 0
}

/** 绝对路径是否落在 cwd 之内（且不是 cwd 本身）。 */
function insideCwd(cwd, absPath) {
  const rel = relative(cwd, absPath)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

function hasProtectedSegment(relPath) {
  const parts = relPath.split(/[/\\]+/)
  for (const part of parts) if (PROTECTED_SEGMENTS.has(part)) return true
  return false
}

function toPosix(relPath) {
  return relPath.split(/[/\\]+/).join('/')
}

/** target 对象 → 绝对路径字符串（不依赖 fs 服务，避免 inject 依赖）。 */
function targetPath(target) {
  if (typeof target === 'string') return target
  if (target === null || target === void 0) return void 0
  const key = target.targetKey
  return typeof key === 'string' && key.length > 0 ? key : void 0
}

/** 只做 readdir + dirent 判断，不 stat、不跑子进程 —— turn-stopping 是串行 await。 */
async function scanTmpDir(cwd, tmpDirName, depthLimit) {
  const out = []
  const root = join(cwd, tmpDirName)
  const walk = async (dir, depth) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      const rel = toPosix(relative(cwd, abs))
      if (hasProtectedSegment(rel)) continue
      if (entry.isDirectory()) {
        if (depth + 1 < depthLimit) await walk(abs, depth + 1)
        continue
      }
      // 符号链接当文件报出来，但不跟进目录，避免绕出工作区。
      out.push(rel)
    }
  }
  await walk(root, 0)
  return out
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)

  /**
   * 落盘一条记录。ctx.logger 只写进程 stdout，事后无法取证；logFile 是可选旁路，
   * 写失败绝不影响闸门（fs 沙箱拒绝路径属于路径问题，不是任务问题）。
   */
  const record = async (cwd, line) => {
    if (cfg.logFile.length === 0) return
    const abs = isAbsolute(cfg.logFile) ? cfg.logFile : join(cwd, cfg.logFile)
    try {
      await mkdir(dirname(abs), { recursive: true })
      await appendFile(abs, `${new Date().toISOString()} ${line}\n`, 'utf8')
    } catch {}
  }

  if (!cfg.enabled) {
    try {
      ctx.logger?.info?.('dsh-turn-cleanup: disabled by config, no gate installed')
    } catch {}
    // 也落盘一行，好让「禁用」这件事事后可查（否则 stdout 里的信息会随进程消失）。
    void record('', 'disabled by config, no gate installed')
    return
  }

  const patternRes = cfg.patterns.map(globToRegExp)
  const tmpPrefix = `${cfg.tmpDirName}/`

  /** session → { turn, paths:Set<abs> } */
  const state = new Map()
  /** `${sessionId}\u0000${turn}` → true */
  const tripped = new Set()

  const stateFor = (session) => {
    let s = state.get(session)
    if (s === void 0) {
      s = { turn: void 0, paths: new Set() }
      state.set(session, s)
    }
    return s
  }

  const keyOf = (session, turn) => `${session.id}\u0000${turn}`

  ctx.on('session/event', (session, event) => {
    if (event === null || event === void 0) return
    const data = event.data ?? {}
    if (event.type === 'turn/start') {
      const s = stateFor(session)
      s.turn = data.turn
      s.paths = new Set()
      return
    }
    if (event.type === 'turn/end') {
      const s = state.get(session)
      if (s !== void 0 && (s.turn === void 0 || s.turn === data.turn)) state.delete(session)
      tripped.delete(keyOf(session, data.turn))
    }
  })

  ctx.on('session/disposed', (session) => {
    state.delete(session)
    for (const key of [...tripped]) {
      if (key.startsWith(`${session.id}\u0000`)) tripped.delete(key)
    }
  })

  // 本 turn 的写入路径。prepend 保证在别的消费者之前拿到原始 target。
  ctx.on('fs/write-intent', async (target, actor, next) => {
    const intent = await next()
    try {
      const session = actor === null || actor === void 0 ? void 0 : actor.agent?.session
      const abs = targetPath(target)
      if (session !== void 0 && session !== null && abs !== void 0 && isAbsolute(abs)) {
        // 用 stateFor 而不是 state.get：插件可能在本 turn 中途才加载，错过 turn/start，
        // 此时也要开始记账（turn 字段留空，turn-stopping 按「本 turn」处理）。
        stateFor(session).paths.add(abs)
      }
    } catch {}
    return intent
  }, { prepend: true })

  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    try {
      const session = agent?.session
      if (session === null || session === void 0) return
      const cwd = eligible(session)
      if (cwd === void 0) return

      const key = keyOf(session, turn)
      if (tripped.has(key)) return

      // turn/end 会清 state，所以此刻还存在的 state 一定属于本 turn；s.turn === undefined
      // 只发生在插件中途热加载（没赶上本 turn 的 turn/start），此时同样按本 turn 处理。
      const s = state.get(session)
      const recorded = s !== void 0 && (s.turn === void 0 || s.turn === turn) ? s.paths : new Set()

      const candidates = new Set()
      // 通道 1：约定目录
      for (const rel of await scanTmpDir(cwd, cfg.tmpDirName, cfg.scanDepth)) candidates.add(rel)

      // 通道 2：本 turn 记录的路径 + 模式匹配 + 仍然存在
      for (const abs of recorded) {
        if (!insideCwd(cwd, abs)) continue
        const rel = toPosix(relative(cwd, abs))
        if (hasProtectedSegment(rel)) continue
        const isInTmpDir = rel.startsWith(tmpPrefix)
        if (!isInTmpDir && !matchesAny(patternRes, basename(rel))) continue
        try {
          const info = await stat(abs)
          if (!info.isFile()) continue
        } catch {
          continue
        }
        candidates.add(rel)
      }

      if (candidates.size === 0) return

      const list = [...candidates].sort()
      tripped.add(key)

      const shown = list.slice(0, cfg.maxSteerPaths)
      const more = list.length - shown.length
      const lines = shown.map((p) => `- ${p}`)
      if (more > 0) lines.push(`- …还有 ${more} 个`)

      try {
        ctx.logger?.info?.(
          `dsh-turn-cleanup: steer session=${session.id} turn=${turn} cwd=${cwd} files=${list.length} ` +
            `paths=[${list.slice(0, cfg.maxLogPaths).join(', ')}]`
        )
      } catch {}
      await record(
        cwd,
        `steer session=${session.id} turn=${turn} cwd=${cwd} files=${list.length} ` +
          `paths=[${list.slice(0, cfg.maxLogPaths).join(', ')}]`
      )

      const text = [
        '收尾前清场：这些是本轮你留下的临时文件——',
        ...lines,
        '删掉它们；要留的逐条说明理由并挪到明确位置。交付物、用户文件、.tmp-sessions、.git 不要动。'
      ].join('\n')

      try {
        agent.steer({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'dsh-turn-cleanup' }
        })
      } catch (error) {
        try {
          ctx.logger?.warn?.(`dsh-turn-cleanup: steer failed: ${error?.message ?? error}`)
        } catch {}
      }
    } catch (error) {
      try {
        ctx.logger?.warn?.(`dsh-turn-cleanup: gate error: ${error?.message ?? error}`)
      } catch {}
    }
  })
}

export default { name, inject, apply }
