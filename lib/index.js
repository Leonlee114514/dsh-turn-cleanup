import { readdir, stat, lstat, unlink, appendFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, relative, isAbsolute, basename, dirname } from 'node:path'
import { StatsStore, defaultStatsFile } from './stats.js'

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
 * 三条检出通道（都只看「本轮」）：
 *   1. 约定目录 `<cwd>/.agent-tmp/`（可配 tmpDirName）—— 主机制，零误伤。
 *   2. `fs/write-intent` 记录的**本 turn 写入路径**里匹配临时件模式的那些。
 *      **绝不扫全工作区**：本机工作区躺着存量 probe-*，扫全量会天天误报。
 *   3. 备份保留（backupRetention）：本轮碰过的 `<stem>.bak*` 家族按 mtime 只留
 *      最近 N 份。默认 steer（只报清单让模型删）；`mode: 'prune'` 才由插件自己删，
 *      且带四道硬闸（原件仍在且更新、非符号链接、非保护段、每轮条数上限）。
 *
 * 防抖：按 (sessionId, turn) 只拦一次。第二次进 listener 直接 return，
 * 否则模型每多跑一步就再被拦一次，turn 永远结束不了。
 *
 * 不做的事：不跑 git；不扫大目录；子会话（origin==="subagent" 或
 * delegationDepth>0）整段跳过 —— 它们的 cwd 可能是别人的工作区。
 * 通道 1、2 永远只 steer 不删；只有通道 3 的 prune 模式会删，且只删备份副本。
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

/** 这些目录段下的东西一律不报、更不删。 */
const PROTECTED_SEGMENTS = new Set(['.git', 'node_modules', '.tmp-sessions', 'out'])

const DEFAULT_TMP_DIR = '.agent-tmp'

/** 面板取数的 HTTP 路由（同源、只读）。 */
const STATS_PATH = '/turn-cleanup/stats'

/** `x.bak` / `x.bak-<后缀>` / `x.bak.<后缀>` → 家族键是 `x`（被备份的原件名）。 */
const BACKUP_RE = /^(.+)\.bak(?:[-.][\s\S]*)?$/i

function normalizeBackupRetention(raw) {
  const r = raw !== null && typeof raw === 'object' ? raw : {}
  const keepRaw = Number.isFinite(r.keep) ? Math.floor(r.keep) : 3
  return {
    enabled: r.enabled !== false,
    keep: Math.max(1, Math.min(20, keepRaw)),
    // steer（默认）：只把超量的备份列进清单，由模型判断并执行删除。
    // prune：插件自己删。删的是副本，但不可逆，所以必须显式选择。
    mode: r.mode === 'prune' ? 'prune' : 'steer',
    // 原件必须仍在且不比备份旧，才认为这份备份是冗余副本。原件没了，
    // 备份就可能是唯一副本 —— 一条都不删。
    requireOriginalPresent: r.requireOriginalPresent !== false,
    maxPrunePerTurn: Number.isFinite(r.maxPrunePerTurn)
      ? Math.max(1, Math.floor(r.maxPrunePerTurn))
      : 50
  }
}

function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const patterns = Array.isArray(raw.patterns)
    ? raw.patterns.filter((p) => typeof p === 'string' && p.trim().length > 0)
    : []
  // 只剥 "./"、"\\" 前缀与首尾分隔符。不能把裸前导点一起剥掉，
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
    backupRetention: normalizeBackupRetention(raw.backupRetention),
    // ctx.logger.info 只进进程 stdout（Electron 主进程控制台），不落盘、事后无法 grep。
    // 给一个可选落盘通道：绝对路径，或相对 cwd 的路径；空字符串 = 不落盘。
    logFile: typeof raw.logFile === 'string' ? raw.logFile.trim() : '',
    // 统计账本（JSON）。空字符串 = 自动放在 logFile 同目录（无 logFile 则 $DSH_HOME/logs）。
    // stats: false 只关统计、不关闸门 —— 面板是观测面，不该决定闸门装不装。
    stats: raw.stats !== false,
    statsFile: typeof raw.statsFile === 'string' ? raw.statsFile.trim() : ''
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

/** `x.bak-…` → `x`；不是备份形态返回 undefined。 */
function backupFamily(fileName) {
  const m = BACKUP_RE.exec(fileName)
  return m === null ? void 0 : m[1]
}

/**
 * 按「同目录 + 同原件名」把备份聚成家族，返回超量部分。
 * 只处理本轮碰过的家族：seeds 里无论是原件还是备份，都能推导出原件名
 * （`x.bak-…` → `x`，`x` → `x`），然后只看 `x.bak*` 这批兄弟文件。
 * 每个目录只 readdir 一次，不扫全盘。
 */
async function planBackups(cwd, seeds, keep) {
  /** dir → Set<stem> */
  const byDir = new Map()
  for (const abs of seeds) {
    if (!isAbsolute(abs)) continue
    const name = basename(abs)
    if (name.length === 0) continue
    const stem = backupFamily(name) ?? name
    const dir = dirname(abs)
    let stems = byDir.get(dir)
    if (stems === void 0) {
      stems = new Set()
      byDir.set(dir, stems)
    }
    stems.add(stem)
  }

  const plans = []
  for (const [dir, stems] of byDir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const stem of stems) {
      const prefix = `${stem}.bak`
      const members = []
      for (const entry of entries) {
        if (entry.isDirectory()) continue
        if (!entry.name.startsWith(prefix)) continue
        if (backupFamily(entry.name) !== stem) continue
        const abs = join(dir, entry.name)
        const rel = toPosix(relative(cwd, abs))
        if (!insideCwd(cwd, abs)) continue
        if (hasProtectedSegment(rel)) continue
        try {
          const info = await stat(abs)
          if (!info.isFile()) continue
          members.push({ abs, rel, name: entry.name, mtimeMs: info.mtimeMs })
        } catch {
          continue
        }
      }
      if (members.length <= keep) continue
      // 新 → 旧；同 mtime 用文件名兜底，保证每次判定顺序稳定。
      members.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
      // 原件是否还在、是否比最新备份更新 —— 决定这些备份算「冗余副本」还是「唯一副本」。
      let originalMtime = -Infinity
      let originalPresent = false
      try {
        const info = await stat(join(dir, stem))
        originalPresent = info.isFile()
        originalMtime = info.mtimeMs
      } catch {
        originalPresent = false
      }
      plans.push({
        dir,
        stem,
        members,
        kept: members.slice(0, keep),
        excess: members.slice(keep),
        originalPresent,
        originalMtime
      })
    }
  }
  return plans
}

/**
 * prune 模式：删掉超量备份。四道闸，任一不过就跳过该文件：
 *   ① 原件仍在（原件没了，备份可能是唯一副本 —— 整族不碰）
 *   ② lstat 是普通文件、不是符号链接（不跟链，避免删到链外的真文件）
 *   ③ 不在保护段、在工作区之内
 *   ④ 每轮删除条数上限
 * 返回实际删掉的相对路径。
 *
 * 刻意不做「备份比原件新就不删」：那是过度保守。备份是某个历史状态的副本，
 * 原件比它新才是常态（备份完再改原件）；而原件比备份旧往往意味着模型反复备份
 * 却一直没改原件 —— 那正是要清理的重复副本。而且删的永远是最旧的那几份，
 * 最新的 keep 份一律不动，价值损失有上界。
 */
async function pruneBackups(cwd, plans, retention) {
  const deleted = []
  for (const plan of plans) {
    // 原件不在，整族跳过：那几份备份可能是唯一副本，一条都不删。
    if (retention.requireOriginalPresent && !plan.originalPresent) continue
    for (const member of plan.excess) {
      if (deleted.length >= retention.maxPrunePerTurn) return deleted
      if (!insideCwd(cwd, member.abs)) continue
      if (hasProtectedSegment(member.rel)) continue
      try {
        const info = await lstat(member.abs)
        if (!info.isFile() || info.isSymbolicLink()) continue
        await unlink(member.abs)
        deleted.push(member.rel)
      } catch {}
    }
  }
  return deleted
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const retention = cfg.backupRetention

  /**
   * 落盘一条记录。ctx.logger 只写进程 stdout，事后无法取证；logFile 是可选旁路，
   * 写失败绝不影响闸门（fs 沙箱拒绝路径属于路径问题，不是任务问题）。
   */
  const record = async (cwd, line) => {
    if (cfg.logFile.length === 0) return
    const abs = isAbsolute(cfg.logFile) ? cfg.logFile : join(cwd || process.cwd(), cfg.logFile)
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

  /**
   * 统计账本。只在 stats 打开时创建；文件路径与文本日志同目录，便于一起备份。
   * 账本只做观测：任何异常都不许冒泡到闸门（闸门是硬约束，面板是软的）。
   */
  const statsFile = cfg.stats
    ? (() => {
        if (cfg.statsFile.length === 0) return defaultStatsFile(cfg.logFile)
        return isAbsolute(cfg.statsFile)
          ? cfg.statsFile
          : join(process.cwd(), cfg.statsFile)
      })()
    : ''
  const stats = statsFile.length > 0 ? new StatsStore(statsFile, ctx.logger) : null

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
      // 复核：这个 turn 里被 steer 过的文件，模型跑完那一步之后还在不在。
      // 放在 turn/end 而不是下一次 turn-stopping：此刻模型已经拿到清单并动过手，
      // 再晚就分不清「当时清了」与「后来别的原因没了」。
      if (stats !== null) {
        void stats.verify(session.id, data.turn).catch(() => {})
      }
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
      const tmpScanned = await scanTmpDir(cwd, cfg.tmpDirName, cfg.scanDepth)
      // 通道 1：约定目录
      for (const rel of tmpScanned) candidates.add(rel)

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

      // 通道 3：备份保留。seeds = 本轮写过的路径 ∪ 约定目录里的文件。
      let excessBackups = []
      let pruned = []
      if (retention.enabled) {
        const seeds = new Set(recorded)
        for (const rel of tmpScanned) seeds.add(join(cwd, rel))
        const allPlans = await planBackups(cwd, seeds, retention.keep)
        // 原件不在的家族整族不管：那几份备份可能是唯一副本，「留最近 N 份」
        // 这个规则本身就失去了参照物。宁可留垃圾，也不删掉唯一的那份。
        const plans = retention.requireOriginalPresent
          ? allPlans.filter((p) => p.originalPresent)
          : allPlans
        excessBackups = plans.flatMap((p) => p.excess.map((m) => ({ rel: m.rel, stem: p.stem })))
        if (retention.mode === 'prune' && excessBackups.length > 0) {
          pruned = await pruneBackups(cwd, plans, retention)
          const gone = new Set(pruned)
          excessBackups = excessBackups.filter((b) => !gone.has(b.rel))
          // 被 prune 删掉的备份，如果同时也命中了通道 2（模型自己写的 .bak-* 会被
          // 模式匹配到），必须从清单里剔除 —— 否则 steer 文案会列出刚删掉的文件。
          for (const rel of pruned) candidates.delete(rel)
          if (pruned.length > 0) {
            const line = `prune session=${session.id} turn=${turn} cwd=${cwd} deleted=${pruned.length} ` +
              `keep=${retention.keep} paths=[${pruned.slice(0, cfg.maxLogPaths).join(', ')}]`
            try {
              ctx.logger?.info?.(`dsh-turn-cleanup: ${line}`)
            } catch {}
            await record(cwd, line)
          }
        }
      }

      if (candidates.size === 0 && excessBackups.length === 0) return

      tripped.add(key)

      const list = [...candidates].sort()
      const backupList = excessBackups.map((b) => b.rel).sort()

      const shownTemps = list.slice(0, cfg.maxSteerPaths)
      const moreTemps = list.length - shownTemps.length
      const shownBackups = backupList.slice(0, cfg.maxSteerPaths)
      const moreBackups = backupList.length - shownBackups.length

      const logParts = []
      if (list.length > 0) {
        logParts.push(`files=${list.length} paths=[${list.slice(0, cfg.maxLogPaths).join(', ')}]`)
      }
      if (backupList.length > 0) {
        logParts.push(`backups=${backupList.length} keep=${retention.keep} ` +
          `paths=[${backupList.slice(0, cfg.maxLogPaths).join(', ')}]`)
      }
      const line = `steer session=${session.id} turn=${turn} cwd=${cwd} ${logParts.join(' ')}`
      try {
        ctx.logger?.info?.(`dsh-turn-cleanup: ${line}`)
      } catch {}
      await record(cwd, line)

      // 记一笔给面板：报了什么、prune 模式自己删了什么。verify 留空，等 turn/end 复核。
      if (stats !== null) {
        void stats
          .recordGate({
            sid: session.id,
            turn,
            cwd,
            temps: list,
            backups: backupList,
            keep: retention.keep,
            mode: retention.mode,
            pruned
          })
          .catch(() => {})
      }

      const sections = []
      if (list.length > 0) {
        const lines = shownTemps.map((p) => `- ${p}`)
        if (moreTemps > 0) lines.push(`- …还有 ${moreTemps} 个`)
        sections.push(
          [
            '收尾前清场：这些是本轮你留下的临时文件——',
            ...lines,
            '删掉它们；要留的逐条说明理由并挪到明确位置。交付物、用户文件、.tmp-sessions、.git 不要动。'
          ].join('\n')
        )
      }
      if (backupList.length > 0) {
        const lines = shownBackups.map((p) => `- ${p}`)
        if (moreBackups > 0) lines.push(`- …还有 ${moreBackups} 个`)
        sections.push(
          [
            `备份超量：同一原件的 .bak 只保留最近 ${retention.keep} 份，这些是多余的——`,
            ...lines,
            `删掉它们；要留的先挪到明确位置并说明理由。不要动原件本身，也不要动最近 ${retention.keep} 份。`
          ].join('\n')
        )
      }

      try {
        agent.steer({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: sections.join('\n\n') }],
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

  /**
   * 面板数据通道：给 Web 客户端一个只读 JSON 端点。
   *
   * 为什么走 webServer 而不是 remote.* RPC：本插件没有 host 服务对象，
   * 注册一个 HTTP 路由比造一套 service + RPC 契约轻得多，客户端 fetch 相对路径即可
   * （同源，不需要 origin 探测，也不怕 relay/远程模式）。
   * 注册失败（例如 headless profile 没有 webServer）只是没有面板，闸门照旧。
   */
  /**
   * 让 client 半在「装好之后不重启」也能进 boot graph。
   *
   * clientModules 用 pkgMeta 缓存每个包「有没有 dsh.client」的结论，命中即返回（含缓存
   * 的 null），而这份缓存只在进程启动时清一次。于是：先装了插件、后补 dsh.client 声明的
   * 情况，会被永久记成「没有 client 半」，HMR 重跑 apply 也救不回来（它只对新 fiber 重扫）。
   * 这里只清掉**本包自己**那条 null 缓存并手动 flush 一次；拿不到内部字段就安静放弃，
   * 退化成「重启 DSH 才出现面板」——那本来也是正常安装路径。
   */
  const ensureClientEntry = () => {
    try {
      const cm = typeof ctx.get === 'function' ? ctx.get('clientModules') : void 0
      if (cm === void 0) return
      const has = () => (cm.graph?.()?.entries ?? []).some((e) => e.id === name)
      if (has()) return
      if (!(cm.pkgMeta instanceof Map)) return
      let cleared = 0
      for (const key of [...cm.pkgMeta.keys()]) {
        if (key.includes(name) && cm.pkgMeta.get(key) === null) {
          cm.pkgMeta.delete(key)
          cleared += 1
        }
      }
      if (cleared === 0) return
      if (typeof cm.dirty?.add === 'function') cm.dirty.add(name)
      if (typeof cm.flush !== 'function') return
      let failure = ''
      cm.flush((error) => {
        failure = String(error?.message ?? error)
      })
      if (failure.length > 0) {
        try {
          ctx.logger?.warn?.(`dsh-turn-cleanup: client entry recovery failed: ${failure}`)
        } catch {}
        return
      }
      const url = (cm.graph?.()?.entries ?? []).find((e) => e.id === name)?.url
      try {
        ctx.logger?.info?.(`dsh-turn-cleanup: client entry recovered url=${String(url)}`)
      } catch {}
      record('', `client entry recovered url=${String(url)}`)
    } catch (error) {
      try {
        ctx.logger?.warn?.(`dsh-turn-cleanup: client entry recovery skipped: ${error?.message ?? error}`)
      } catch {}
    }
  }
  ensureClientEntry()

  if (stats !== null && typeof ctx.inject === 'function') {
    void ctx
      .inject(['webServer'], (sub) => {
        // 注册必须写在 effect 的 execute 里、把清理闭包当返回值交出去。
        // 反过来（先 register 拿到 disposer，再 `effect(() => disposer)`）实测
        // 路由会立刻消失：effect 的返回值语义与「把 disposer 当返回值」重叠，
        // 结果是注册完就被拆掉。billion-context 在本机用的也是这一种写法。
        sub.effect(() => {
          const off = sub.webServer.register({
            kind: 'exact',
            path: STATS_PATH,
            handler: async (req, res) => {
              try {
                const url = new URL(req.url ?? STATS_PATH, 'http://localhost')
                const scope = url.searchParams.get('scope') === 'session' ? 'session' : 'all'
                const sid = url.searchParams.get('sid') ?? ''
                const turnRaw = url.searchParams.get('turn')
                let body
                if (turnRaw !== null && sid.length > 0 && Number.isFinite(Number(turnRaw))) {
                  // 单 turn 查询：给 turnTail 徽章用，返回 null 表示这一轮没拦过。
                  body = await stats.turnRecord(sid, Number(turnRaw))
                } else if (scope === 'session' && sid.length > 0) {
                  body = await stats.summary('session', sid)
                } else {
                  body = await stats.summary('all')
                }
                res.writeHead(200, {
                  'content-type': 'application/json; charset=utf-8',
                  'cache-control': 'no-store'
                })
                res.end(JSON.stringify(body))
              } catch (error) {
                try {
                  res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
                  res.end(JSON.stringify({ error: String(error?.message ?? error) }))
                } catch {}
              }
            }
          })
          return () => off()
        }, 'dsh-turn-cleanup: stats route')
      })
      .catch((error) => {
        try {
          ctx.logger?.warn?.(`dsh-turn-cleanup: stats route unavailable: ${error?.message ?? error}`)
        } catch {}
      })
  }
}

export default { name, inject, apply }
