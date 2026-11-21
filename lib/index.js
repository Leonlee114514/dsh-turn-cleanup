import { readdir, stat, lstat, unlink, appendFile, mkdir, realpath } from 'node:fs/promises'
import { statSync, realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, relative, isAbsolute, basename, dirname, sep, resolve as resolvePath } from 'node:path'
import { StatsStore, defaultStatsFile } from './stats.js'
import { resolveMessageLocale, messagesFor, summaryFor } from './messages.js'

/**
 * dsh-turn-cleanup — 收尾清场硬闸门。
 *
 * 背景：DSH 三层都缺自动清理。框架层有 `agent/turn-stopping`（serial，await 在
 * turn 边界提交前），全仓只有 workspace-changes（记变更）与 mnemon（写记忆）两个
 * 消费者，都不清理；组件层只清自己的 mkdtemp scratch；提示词层 AGENTS.md §C2
 * 只有自觉条款。这里把「自觉」升级成代码闸门。
 *
 * 交付方式（steerMode）：
 *   followup（默认）：`agent.followup(...)` 把清单排进 next-turn。本轮正常结束、
 *     **汇报继续占着答案位**，紧接着自动开一轮清场。
 *     为什么默认它：chat UI 的 `latestAnswer(turn)` 取的是 `turn.steps.at(-1)` 的
 *     assistant 文本。同轮 steer 多跑的那一步成了最后一步，于是「已删除 3 个文件」
 *     顶替了交付汇报，真正的汇报被折进「过程」里 —— 这就是 v0.3.0 的实测症状。
 *   steer：`agent.steer(...)` 让 inbox.nextStep.length 变 1，
 *     `if (turnEnds && this.inbox.nextStep.length === 0) break;` 不成立 ——
 *     同一个 turn 多跑一步。闸门更硬（本轮结束不了），但代价就是上面那个折叠。
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

/**
 * 默认临时件模式。匹配对象是**文件名**（不是路径），大小写不敏感。
 *
 * 这里刻意不写裸 `check*` / `bench*`：按文件名前缀匹配时它们会吃掉正常业务代码 ——
 * `checkout.js`、`CheckoutService.ts`、`checklist.md`、`benchmark.ts` 全部命中，
 * 于是模型每写一个正常文件都会被要求删除。要求分隔符（`check-*` / `check_*`）之后，
 * 本意要抓的 `check-1.sh`、`bench_gpu.py` 仍然命中，上面那批不再命中。
 * 需要更宽的集合自己配 patterns。
 */
const DEFAULT_PATTERNS = [
  'probe-*',
  'tmp-*',
  'scratch-*',
  'check-*',
  'check_*',
  'diag_*',
  'bench-*',
  'bench_*',
  '*.bak-*'
]

/**
 * 默认保护段：这些目录下的东西一律不报、更不删（可用 protectedSegments 覆盖）。
 *
 * 只放「任何生态都成立的构建/依赖目录」。这里**不**包含 `.tmp-sessions` —— 那是作者
 * 本机的临时会话目录，宿主 326 个包里 0 命中；把本机约定写进默认值，在别人机器上
 * 只是一个永不适用的名字。
 */
const DEFAULT_PROTECTED_SEGMENTS = [
  '.git',
  'node_modules',
  'out',
  'dist',
  'build',
  'target',
  'vendor',
  '.venv',
  '__pycache__'
]

const DEFAULT_TMP_DIR = '.agent-tmp'

/** 面板取数的 HTTP 路由（同源、只读）。 */
const STATS_PATH = '/turn-cleanup/stats'

/**
 * 一次闸门最多为多少条目量体积。
 *
 * 量体积是为了让面板能说「已释放 X MB」，但它是纯锦上添花的统计，不该拖慢
 * `agent/turn-stopping` 这条串行 await。清单本身有上界（maxSteerPaths 20 +
 * 备份家族），200 只是防御性封顶：配置被调到极宽时宁可少报几个字节，也不要
 * 在 turn 边界上排队几百次 stat。
 */
const MAX_MEASURE_FILES = 200

/**
 * 一次工具调用最多从实参里收多少个路径候选。
 *
 * `extractPaths` 对命令串是按空白切开的，一条 `grep -rn "a|b" .` 就能吐出几十个
 * 词。这些候选只是拿来对照「本轮碰过什么」，不是真相来源，收多了纯浪费；
 * 真正的写入路径通常排在最前面（`write` 的 file_path、`ops_write_file` 的 path）。
 */
const MAX_TOUCHED_PATHS = 200

/**
 * 待配对的 tool/call 候选上限。
 *
 * 正常情况下一对 tool/call + tool/result 是紧挨着的，这个 Map 里几乎永远只有 0~1 项。
 * 但流式中断、宿主崩溃、工具被取消时 result 不会来，候选就会一直挂着。给个硬上限，
 * 超了丢最旧的 —— 丢掉的只是「本来也没人认领」的候选，不影响已经落账的路径。
 */
const MAX_PENDING_CALLS = 64

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
  // 保护段可配：显式给数组则**整体替换**默认值（而不是追加），否则用户无法取消
  // 某个默认保护段。
  const protectedRaw = Array.isArray(raw.protectedSegments)
    ? raw.protectedSegments.filter((p) => typeof p === 'string' && p.trim().length > 0)
    : []
  const protectedSegments = protectedRaw.length > 0
    ? protectedRaw.map((p) => p.trim())
    : DEFAULT_PROTECTED_SEGMENTS.slice()
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
    protectedSegments,
    maxLogPaths: Number.isFinite(raw.maxLogPaths) ? Math.max(1, raw.maxLogPaths) : 10,
    maxSteerPaths: Number.isFinite(raw.maxSteerPaths) ? Math.max(1, raw.maxSteerPaths) : 20,
    scanDepth: Number.isFinite(raw.scanDepth) ? Math.max(1, Math.min(6, raw.scanDepth)) : 4,
    backupRetention: normalizeBackupRetention(raw.backupRetention),
    // 'followup'（默认）：另开一轮清场，本轮汇报继续是「答案」。
    // 'steer'：同轮多跑一步，闸门更硬但会把汇报折进「过程」。
    steerMode: raw.steerMode === 'steer' ? 'steer' : 'followup',
    // 注入文案的语言：'auto'（默认，按环境推断）| 'zh' | 'en'。见 lib/messages.js。
    messageLocale: raw.messageLocale === 'zh' || raw.messageLocale === 'en' ? raw.messageLocale : 'auto',
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

/**
 * 参数对象里那些「不是路径、但长得很像」的键。整个 value 递归时会撞上它们：
 * `write` 的 content 是文件正文，`edit` 的 old_string/new_string 是代码片段，
 * 把这些文本当路径扫，会把正文里的每一行都试一遍，白烧 CPU 还制造假路径。
 */
const NON_PATH_KEYS = new Set([
  'content',
  'contents',
  'text',
  'body',
  'data',
  'patch',
  'diff',
  'old_string',
  'new_string',
  'old_text',
  'new_text',
  'old_str',
  'new_str',
  'source',
  'code',
  'script',
  'stdin'
])

/** 形如 `https://…` / `file://…` 的串不是本地路径。 */
const URL_LIKE_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//

/** 单个字符串最长按路径处理多少字符（再长基本是正文，不是路径）。 */
const MAX_PATH_CANDIDATE_CHARS = 1024

/**
 * 从任意工具的实参里捞出「可能是文件路径」的字符串。
 *
 * 这是 v4 兼容层的核心：**不认工具名、不认 schema**。宿主的 `fs/*-intent` 只有
 * `dsh-tool-fs` / `dsh-tool-str-replace-editor` 会发，`dsh-ops` 的 `ops_write_file`
 * 一条都不发（实测：`grep -rn "fs/write-intent" dsh-ops/lib` → 0 命中），社区插件
 * 的写入工具更不会有。但**所有**工具调用都会以 `tool/call` 事件进 `session/event`，
 * 实参里必然带着它要动的路径。所以从实参里捞路径，比挂宿主内部事件稳。
 *
 * 捞得宽一点没关系 —— 这层结果只用于「本轮碰过、结束时已经不在」的记账，
 * 永远不会被拿来 steer 模型去删东西（见 turn-stopping 里的用法）。
 */
function extractPaths(value, out, depth) {
  if (depth > 6 || out.length >= MAX_TOUCHED_PATHS) return
  if (typeof value === 'string') {
    const raw = value.trim()
    if (raw.length === 0 || raw.length > MAX_PATH_CANDIDATE_CHARS) return
    if (URL_LIKE_RE.test(raw)) return
    // 命令串：`rm -f a b`、`cd /x && rm y`。按空白切开逐段看，引号与分隔符先剥掉。
    if (/\s/.test(raw)) {
      const tokens = raw.split(/[\s;&|()<>]+/)
      // `cd` 之后的相对名要按新目录解析 —— 用户自己的清理脚本几乎总是
      // `cd <目标目录> && rm -f <相对名>`，只认 cwd 会把这类全部漏掉。
      // 不追求真正的 shell 语义：`$TEMP` 这类变量展开不了就退回 cwd，
      // 解错了顶多多 stat 几个不存在的路径，不会记错账。
      let base
      for (let i = 0; i < tokens.length; i += 1) {
        const piece = unquote(tokens[i])
        if (piece.length === 0 || piece.length > MAX_PATH_CANDIDATE_CHARS) continue
        if (piece === 'cd' || piece === 'pushd') {
          const dir = i + 1 < tokens.length ? unquote(tokens[i + 1]) : ''
          if (dir.length > 0 && (isAbsolute(dir) || /[/\\]/.test(dir))) base = dir
          i += 1
          continue
        }
        // 命令串里的裸词大多是命令名/选项（`rm`、`-f`、`echo`），只有像文件名的才收。
        if (!isAbsolute(piece) && !/[/\\]/.test(piece) && !/\.[A-Za-z0-9_~-]{1,16}$/.test(piece)) continue
        out.push({ path: piece, base })
      }
      return
    }
    out.push({ path: raw })
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) extractPaths(item, out, depth + 1)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (NON_PATH_KEYS.has(key)) continue
      extractPaths(item, out, depth + 1)
    }
  }
}

/** 剥掉一层首尾引号。命令串里的路径常被 `"` 或 `'` 包着。 */
function unquote(token) {
  return token.replace(/^["']+|["']+$/g, '')
}

/**
 * 会话的当前工作目录。
 *
 * `session.header.cwd` 只在会话创建时写一次，模型之后跑 `working_directory(cd: ...)`
 * 不会改它 —— 只看 header 的话，闸门会一直守着旧目录（扫错的 .agent-tmp、用错的
 * 边界做 insideCwd）。宿主的 `workingDirectory` 服务维护着运行时真值的投影
 * （projection key `workingDirectory`，事件 `working-directory/change`），这里优先读它。
 *
 * 但它是**可选服务**：headless / 精简 profile 里可能不存在，而本插件 `inject` 是空数组
 * （不想因为一个可选服务缺席就整个不激活），所以用 ctx.get 试探，取不到就退回 header。
 */
function eligible(ctx, session) {
  const header = session === null || session === void 0 ? void 0 : session.header
  if (header === null || header === void 0) return void 0
  const { cwd, origin, delegationDepth } = header
  // 子会话 / 委派链整段跳过：它们的 cwd 可能是别人的工作区。
  if (origin === 'subagent' || (delegationDepth ?? 0) > 0) return void 0
  // 没有 header.cwd 就整段跳过（照旧）。这一条同时是下面那步的前提：
  // 宿主 projection 的 init 是 `header.cwd ?? null`，而 get() 在 state 为 null 时
  // 返回服务的 defaultDirectory（process.cwd()）—— 那是**进程**的目录，不是这个
  // 会话的目录。不先卡住 header.cwd，就会拿一个无关目录去扫。
  if (typeof cwd !== 'string' || cwd.length === 0) return void 0

  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('workingDirectory') : void 0
    const live = typeof service?.get === 'function' ? service.get(session) : void 0
    if (typeof live === 'string' && live.length > 0) return live
  } catch {}

  return cwd
}

/**
 * 会话当前的工作目录，只读、不抛。
 *
 * 工具调用发生在 turn 中间，此刻 `workingDirectory` 投影通常已经是最新值；但工具
 * 也可能在 turn 之外被调到（模型补一次上报），所以 `eligible()` 返回 undefined 时
 * 退回 `header.cwd`。两者都没有才交给调用方用 `process.cwd()` 兜底。
 */
function cwdOf(ctx, session) {
  const live = eligible(ctx, session)
  if (typeof live === 'string' && live.length > 0) return live
  const header = session === null || session === void 0 ? void 0 : session.header
  const cwd = header === null || header === void 0 ? void 0 : header.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : void 0
}

/**
 * cwd 归一。
 *
 * 写入侧拿到的绝对路径是 fs 服务给的（`dsh-fs-local` 用 realpath 后的值），而 cwd 是
 * 会话创建时的字符串。两者只要差一个符号链接 / Windows 短名（`PROGRA~1`）/
 * macOS 的 `/tmp`→`/private/tmp` / 大小写，`relative()` 就会算出 `../..`，
 * 本轮的临时件**全部静默漏报**。这里对 cwd 做一次 realpath，失败就退回原值。
 */
async function canonicalCwd(cwd) {
  try {
    return await realpath(cwd)
  } catch {
    return cwd
  }
}

/**
 * 同上，同步版。只给 tool/result 那条必须同步跑完的采集路径用。
 *
 * 为什么这里非要同步：见 collectTouched 的注释 —— 采集若挂在微任务/异步链上，
 * 真实的 `rm -f` 会抢在 lstat 前面把文件删掉，体积就永久丢了。
 */
function canonicalCwdSync(cwd) {
  try {
    return realpathSync(cwd)
  } catch {
    return cwd
  }
}

/**
 * 绝对路径是否落在 cwd 之内（且不是 cwd 本身）。
 *
 * 判据与宿主 `dsh-fs-local` 的 `contains()` 一致：空串算「就是自己」，
 * 其余只要不是 `..`、不以 `../`（Windows `..\`）开头、也不是绝对路径就算在内。
 * 不用 `rel.startsWith('..')` 一刀切：那会把 cwd 里名叫 `..notes.md` 的普通文件
 * 也判到外面去。
 */
function insideCwd(cwd, absPath) {
  const rel = relative(cwd, absPath)
  if (rel.length === 0) return false
  if (rel === '..') return false
  if (rel.startsWith(`..${sep}`)) return false
  return !isAbsolute(rel)
}

function hasProtectedSegment(relPath, protectedSegments) {
  const parts = relPath.split(/[/\\]+/)
  for (const part of parts) if (protectedSegments.has(part)) return true
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
async function scanTmpDir(cwd, tmpDirName, depthLimit, protectedSegments) {
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
      if (hasProtectedSegment(rel, protectedSegments)) continue
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
async function planBackups(cwd, seeds, keep, protectedSegments) {
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
        if (hasProtectedSegment(rel, protectedSegments)) continue
        try {
          const info = await stat(abs)
          if (!info.isFile()) continue
          members.push({ abs, rel, name: entry.name, mtimeMs: info.mtimeMs, size: info.size })
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
async function pruneBackups(cwd, plans, retention, protectedSegments) {
  const deleted = []
  for (const plan of plans) {
    // 原件不在，整族跳过：那几份备份可能是唯一副本，一条都不删。
    if (retention.requireOriginalPresent && !plan.originalPresent) continue
    for (const member of plan.excess) {
      if (deleted.length >= retention.maxPrunePerTurn) return deleted
      if (!insideCwd(cwd, member.abs)) continue
      if (hasProtectedSegment(member.rel, protectedSegments)) continue
      try {
        const info = await lstat(member.abs)
        if (!info.isFile() || info.isSymbolicLink()) continue
        await unlink(member.abs)
        // 大小取删除前的 lstat：删完再问就没有了。面板的「释放空间」全靠这一个数字。
        deleted.push({ rel: member.rel, size: Number(info.size) || 0 })
      } catch {}
    }
  }
  return deleted
}

/**
 * 给一批相对路径量体积，喂给面板的「释放空间」。
 *
 * 为什么不在 scanTmpDir 里顺手 stat：那条路径是 turn-stopping 的串行 await，
 * 每多一次系统调用就多一分延迟，而**绝大多数用户不开面板**（stats 默认 true 但
 * 只是记账，读面板的人才看数字）。所以体积按需量：只在 stats 打开时量，
 * 且只量最终清单里的条目（有上界），量不到就记 0 —— 数字少一点，闸门不受影响。
 */
async function measureSizes(cwd, rels, limit) {
  const out = Object.create(null)
  let n = 0
  for (const rel of rels) {
    if (n >= limit) break
    n += 1
    try {
      const info = await stat(join(cwd, rel))
      if (info.isFile()) out[rel] = Number(info.size) || 0
    } catch {}
  }
  return out
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
  const protectedSet = new Set(cfg.protectedSegments)
  const locale = resolveMessageLocale(cfg.messageLocale)
  const tmpPrefix = `${cfg.tmpDirName}/`
  // 落一行「我确实被加载了」。宿主升级把插件静默打成加载失败时（例如 0.2.2 那次
  // `ctx.inject(...).catch`），现场第一件事就是确认 apply 到底跑没跑。
  void record('', `apply steerMode=${cfg.steerMode} stats=${cfg.stats}`)

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

  /**
   * session → { turn, paths:Map<abs,bytes>, reported:Map<abs,bytes> }
   *
   * paths 记「本轮碰过的路径 → 最近一次已知体积」。用 Map 而不是 Set，是因为
   * v3 起要回答「这台电脑一共省了多少空间」—— 文件被 rm -f 走子进程删掉时不会
   * 触发 fs/delete-intent，等到 turn-stopping 再去 stat 已经拿不到体积了。
   * 体积只能在「写入那一刻」和「删除那一刻」记，两个时刻都在 recordIntent 里。
   *
   * reported 是模型自己通过 report_temp_cleanup 报上来的（它删之前量过，比插件猜得准）。
   */
  const state = new Map()
  /** `${sessionId}\u0000${turn}` → true */
  const tripped = new Set()
  /**
   * report_temp_cleanup 是否真的注册成功。注入是异步的（ctx.inject 的 callback 要等
   * tools 服务就绪），所以不能在这里判断，只能由注册回调置位、闸门发文案时读。
   * 没注册成功就绝不提这个工具 —— 让模型去调一个不存在的工具，比不给提示更糟。
   */
  let reportToolReady = false

  const stateFor = (session) => {
    let s = state.get(session)
    if (s === void 0) {
      s = {
        turn: void 0,
        paths: new Map(),
        // v4：本轮碰过、但落在 cwd 之外的文件（%TEMP%、~/.cache 之类）。
        // 这些只用于「已释放空间」记账，永远不进 steer 清单 —— 工作区之外的东西
        // 不该由插件指挥模型去删，但删掉了多少空间照样该算。
        foreign: new Map(),
        // v4：tool/call 那一刻同步拍下的 cwd 内文件体积。只用于记账（preCleaned），
        // **不进 steer 清单** —— 这里没有 mtime 过滤，`read` 顺手看一眼老临时件
        // 也会被拍进来，拿它指挥模型删文件就误伤了。
        touched: new Map(),
        reported: new Map(),
        // v4：与工具无关的采集。callId → 这次调用实参里捞出来的路径候选。
        pendingCalls: new Map(),
        // 本轮开始时刻（ms）。用来判断「文件是不是本轮被写过的」——
        // 读文件不改 mtime，写文件一定改。这是不认工具名的关键判据。
        startedAt: 0,
        // 本轮的 realpath(cwd)。每个 tool/result 都要拼绝对路径，逐次 realpath 太浪费。
        cwdReal: void 0
      }
      state.set(session, s)
    }
    return s
  }

  const keyOf = (session, turn) => `${session.id}\u0000${turn}`

  /** 把候选解析成绝对路径。cwd 之外的候选按 `base` 规则照解，不做 cwd 限制。 */
  const resolveCandidates = (cwd, found) => {
    const out = []
    for (const entry of found) {
      const candidate = typeof entry === 'string' ? entry : entry.path
      if (typeof candidate !== 'string' || candidate.length === 0) continue
      let base = cwd
      if (typeof entry === 'object' && entry !== null && typeof entry.base === 'string') {
        try {
          base = isAbsolute(entry.base) ? entry.base : resolvePath(cwd, entry.base)
        } catch {
          base = cwd
        }
      }
      try {
        out.push(isAbsolute(candidate) ? candidate : resolvePath(base, candidate))
      } catch {}
    }
    return out
  }

  /**
   * 在 tool/call 那一刻**同步**拍下候选文件的体积。
   *
   * 为什么必须同步：宿主派发 session/event 时不 await 监听器（`invokeContainedSessionObservers`
   * 只做 `Promise.resolve(returned).catch()`），工具本体紧接着就执行。`rm -f x` 从发起到
   * 删完只有几毫秒，任何 await 都会让快照落在删除之后 —— 那正是 0.6.x 一直记 0 字节、
   * 以及 test/tool-agnostic.mjs 场景 3/5 时好时坏的原因。
   *
   * 这里**不套 mtime 过滤**：此刻要量的是「马上就要消失的东西有多大」，不是「是不是本轮
   * 写的」。真正的「本轮写过」判定仍由 collectTouched 在 result 时做，它写的是 s.paths
   * （会进 steer 清单）；这里写的是 s.touched（只用于记账）。
   */
  const snapshotTouched = (ctx, session, s, found) => {
    // s.cwdReal 此刻通常还没算（collectTouched 才异步 realpath）。用原始 cwd 就够 ——
    // insideCwd 只做 path.relative 前缀判断，不要求两边都是 realpath。
    const cwd = s.cwdReal ?? eligible(ctx, session)
    if (cwd === void 0) return
    for (const abs of resolveCandidates(cwd, found)) {
      let info
      try {
        info = statSync(abs, { throwIfNoEntry: false })
      } catch {
        continue
      }
      if (info === void 0 || !info.isFile() || info.isSymbolicLink()) continue
      const size = Number(info.size) || 0
      if (insideCwd(cwd, abs)) s.touched.set(abs, size)
      else s.foreign.set(abs, size)
    }
  }

  /**
   * 把一次工具调用里捞到的路径候选落成「本轮碰过的文件」。
   *
   * 分两本账：
   *   - `s.paths`：cwd 内。要满足「现在是个普通文件」且「mtime >= 本轮开始时刻」——
   *     读文件不改 mtime，写文件一定改。这条是「不认工具名」方案能成立的全部依据，
   *     它把 `read` / `grep` / `glob` 顺手扫到的老文件全挡在外面。
   *   - `s.foreign`：cwd 之外（`%TEMP%`、`~/.cache`、别的盘）。**不套 mtime 过滤**，
   *     因为这些永远不进 steer 清单，只用于「已释放空间」记账；用户清理旧临时件
   *     是真实释放掉的磁盘空间，不该因为文件是上周建的就漏掉。
   *
   * `phase` 决定容差：
   *   - `'result'`：工具执行完了，能 stat 到的是本轮真正留下的文件，严格按 mtime 判。
   *
   * 为什么这里不再负责「已经删掉的文件」：`rm` 的执行顺序是 tool/call → 删文件 →
   * tool/result，到 result 再 stat 早就没得量了。实测就是这么丢掉整条记录的
   * （见 test/tool-agnostic.mjs 场景 3/5 时好时坏）。所以「删前体积」由同步的
   * `snapshotTouched()` 在 tool/call 那一刻拍下来，这里只认还在的文件。
   *
   * **必须同步跑完**：这条链曾经是 `s.chain = s.chain.then(() => collectTouched(...))`，
   * 结果监听器只是把工作排进微任务队列就返回了，工具本体（`rm -f x`）紧跟着执行 ——
   * 等微任务真正跑到时文件已经没了，`lstat` 抛 ENOENT，整条记录永久丢失。
   * 实测 `npm test` 连跑五次会交替出现 17/17 与 15/17，就是这个竞态。
   * 现在全程 `statSync`，没有任何 await 点，删得再快也抢不过同一个 tick 里的同步调用。
   */
  const collectTouched = (ctx, session, s, found) => {
    const rawCwd = eligible(ctx, session)
    if (rawCwd === void 0) return
    if (s.cwdReal === void 0) s.cwdReal = canonicalCwdSync(rawCwd)
    const cwd = s.cwdReal
    const startedAt = s.startedAt
    for (const abs of resolveCandidates(cwd, found)) {
      let info
      try {
        info = statSync(abs, { throwIfNoEntry: false })
      } catch {
        continue
      }
      if (info === void 0 || !info.isFile() || info.isSymbolicLink()) continue
      if (!insideCwd(cwd, abs)) {
        // cwd 之外的：只记账，不进 steer 清单。插件不该指挥模型去删工作区之外的文件，
        // 所以两条路彻底分开。
        s.foreign.set(abs, Number(info.size) || 0)
        continue
      }
      // 本轮之前就存在、本轮也没被改过的文件，不是本轮留下的。
      // 容差 1 秒：文件系统的 mtime 精度与时钟回拨都会造成假阴性，
      // 宁可多记一个（后面 stat 还在就不进 preCleaned），也不要漏掉刚写的。
      if (Number(info.mtimeMs) + 1000 < startedAt) continue
      s.paths.set(abs, Number(info.size) || 0)
    }
  }

  ctx.on('session/event', (session, event) => {
    if (event === null || event === void 0) return
    const data = event.data ?? {}
    if (event.type === 'turn/start') {
      const s = stateFor(session)
      s.turn = data.turn
      s.paths = new Map()
      s.foreign = new Map()
      s.touched = new Map()
      s.reported = new Map()
      s.pendingCalls = new Map()
      s.startedAt = Date.now()
      s.cwdReal = void 0
      return
    }
    // ── v4：与具体工具无关的采集 ───────────────────────────────────────────
    //
    // 为什么需要这一层：fs/*-intent 只有 dsh-tool-fs 与 dsh-tool-str-replace-editor 会发，
    // dsh-ops 一条都不发（它的 ops_write_file / ops_bash 直接走自己的执行层），第三方插件
    // 的工具更不会有。而**每一个**工具调用都会以 tool/call + tool/result 进 session/event。
    // 所以在 tool/call 时从实参里捞出路径候选，在 tool/result 时用 mtime 判断这些路径
    // 是不是本轮被动过 —— 不认工具名、不认参数键名，谁写都算。
    //
    // 判据只用 mtime：读文件不改 mtime，写文件一定改。这样「只读过」的路径不会被
    // 误记成本轮碰过，闸门也就不会叫模型去删一个它只是看了一眼的文件。
    if (event.type === 'tool/call') {
      const callId = typeof data.callId === 'string' ? data.callId : void 0
      if (callId === void 0) return
      let args = data.arguments
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          // 实参不是合法 JSON（模型截断、流式中断）。命令串里的路径捞不到了，
          // 但这一层只是补充，漏一次不影响正确性。
          return
        }
      }
      if (args === null || typeof args !== 'object') return
      const found = []
      extractPaths(args, found, 0)
      if (found.length === 0) return
      const s = stateFor(session)
      // 同步拍体积快照 —— 必须是同步的。
      //
      // 这个监听器是同步返回的（宿主的 invokeContainedSessionObservers 只
      // `Promise.resolve(returned).catch()`，不 await），而工具本体在它返回后立刻执行。
      // 一旦这里改成 await lstat，`rm -f x` 就可能先跑完，文件没了，体积永远量不到。
      // 实测就是这样丢掉整条记录的（test/tool-agnostic.mjs 场景 3/5 时好时坏）。
      snapshotTouched(ctx, session, s, found)
      s.pendingCalls.set(callId, found)
      // 兜底上限：tool/result 因中断没来时这些候选会一直留着。超了就丢最旧的。
      while (s.pendingCalls.size > MAX_PENDING_CALLS) {
        const oldest = s.pendingCalls.keys().next()
        if (oldest.done === true) break
        s.pendingCalls.delete(oldest.value)
      }
      return
    }
    if (event.type === 'tool/result') {
      const message = data.message
      const callId =
        (message !== null && message !== void 0 && typeof message.toolCallId === 'string'
          ? message.toolCallId
          : void 0) ??
        (message !== null && message !== void 0 && typeof message.source?.callId === 'string'
          ? message.source.callId
          : void 0) ??
        (typeof data.callId === 'string' ? data.callId : void 0)
      if (callId === void 0) return
      const s = stateFor(session)
      const found = s.pendingCalls.get(callId)
      if (found === void 0) return
      s.pendingCalls.delete(callId)
      // 同步跑完，不进任何异步队列 —— 理由见 collectTouched 的注释。
      // 同一个文件被多次调用碰到时「后写覆盖先写」，同步顺序天然就是调用顺序。
      collectTouched(ctx, session, s, found)
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
  //
  // 三个 intent 事件都要挂：宿主把「新建/覆盖」走 fs/write-intent，「原地改」走
  // fs/edit-intent，「删除」走 fs/delete-intent（见 dsh-tool-fs、dsh-tool-str-replace-editor）。
  // 只挂 write 的话，模型用 edit/str_replace 造出来的临时件在通道 2 里完全看不见，
  // 只能靠 tmp 目录扫描和 *.bak-* 兜住 —— 那正是审计里那条「改了却没人管」的缺口。
  //
  // 顺手记体积（v3）：write/edit 在 next() 之后量（那时新内容已落盘），delete 必须
  // 在 next() 之前量（之后文件就没了）。这是「已释放空间」唯一能拿到体积的时机之一：
  // 模型常用 `rm -f` 走子进程删临时件，那条路不触发 fs/delete-intent，等 turn-stopping
  // 再去 stat 早就没得量了。
  const measureOne = async (abs) => {
    try {
      const info = await lstat(abs)
      if (!info.isFile() || info.isSymbolicLink()) return void 0
      return Number(info.size) || 0
    } catch {
      return void 0
    }
  }

  const makeRecorder = (sizeBefore) => async (target, actor, next) => {
    const session = actor === null || actor === void 0 ? void 0 : actor.agent?.session
    const abs = targetPath(target)
    const trackable = session !== void 0 && session !== null && abs !== void 0 && isAbsolute(abs)
    // 只有 delete 能在 next() 之前量到体积（之后文件就没了）。write/edit 的 next 是空操作，
    // 真正的写盘发生在 waterfall 返回之后，此刻文件还不存在 —— 体积留空，交给 fs/observed。
    const early = trackable && sizeBefore ? await measureOne(abs) : void 0
    const intent = await next()
    try {
      if (trackable) {
        // 用 stateFor 而不是 state.get：插件可能在本 turn 中途才加载，错过 turn/start，
        // 此时也要开始记账（turn 字段留空，turn-stopping 按「本 turn」处理）。
        const s = stateFor(session)
        if (early !== void 0) s.paths.set(abs, early)
        else if (!s.paths.has(abs)) s.paths.set(abs, void 0)
      }
    } catch {}
    return intent
  }
  ctx.on('fs/write-intent', makeRecorder(false), { prepend: true })
  ctx.on('fs/edit-intent', makeRecorder(false), { prepend: true })
  // 删除要在动手前量体积；记进来的路径在通道 2 的 stat() 那步会自然失败 → 跳过，不会误报。
  ctx.on('fs/delete-intent', makeRecorder(true), { prepend: true })

  // 体积的唯一可靠时机。
  //
  // fs/*-intent 的 next 在宿主里是空操作（dsh-tool-fs 的 write 是
  // `ctx.waterfall('fs/write-intent', target, exec, () => void 0)`，真正的 writeText 在
  // waterfall 返回之后），所以 intent 回调里量体积必然量到「文件还不存在」→ 0。
  // 宿主在写入成功后立刻 emit fs/observed（kind:'present'），此刻文件已落盘，
  // 补一次 lstat 才拿得到真实字节数。edit 与 str_replace_editor 走同一个事件。
  //
  // payload 里的 version 只是版本串（missing:/hash 之类），不含体积，别指望它。
  ctx.on('fs/observed', async (target, payload, exec) => {
    try {
      if (payload === null || payload === void 0 || payload.kind !== 'present') return
      const session = exec === null || exec === void 0 ? void 0 : exec.agent?.session
      if (session === null || session === void 0) return
      const abs = targetPath(target)
      if (abs === void 0 || !isAbsolute(abs)) return
      // 只给「本轮已经有 intent 记过的路径」补体积。
      //
      // fs/observed 在读文件时也会发（str_replace_editor 的 view 命令、tool-fs 的 read），
      // 若无条件写入，读一个早就存在的 probe-*.mjs 就会被当成本轮写过的临时件，
      // 下一轮闸门会叫模型去删一个它只读过的东西。intent 才是「动过手」的证据。
      const s = stateFor(session)
      if (!s.paths.has(abs)) return
      const size = await measureOne(abs)
      if (size === void 0) return
      s.paths.set(abs, size)
    } catch {}
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    try {
      const session = agent?.session
      if (session === null || session === void 0) return
      const rawCwd = eligible(ctx, session)
      if (rawCwd === void 0) return
      // 归一后再用：写入侧路径来自 fs 服务（realpath 过），cwd 是会话创建时的字符串，
      // 两者不一致时 relative() 会算出 ../..，本轮的临时件会全部静默漏报。
      const cwd = await canonicalCwd(rawCwd)

      const key = keyOf(session, turn)
      if (tripped.has(key)) return

      // v4 的采集是同步的（collectTouched / snapshotTouched 全用 statSync），
      // 到这里 paths / foreign / touched 已经全部结算完，不需要再等任何队列。
      // 这里曾经有一句 `await pending.chain`，随着异步链一起去掉了。

      // turn/end 会清 state，所以此刻还存在的 state 一定属于本 turn；s.turn === undefined
      // 只发生在插件中途热加载（没赶上本 turn 的 turn/start），此时同样按本 turn 处理。
      const s = state.get(session)
      const sameTurn = s !== void 0 && (s.turn === void 0 || s.turn === turn)
      const recorded = sameTurn ? s.paths : new Map()
      const reported = sameTurn ? s.reported : new Map()
      const foreign = sameTurn ? s.foreign : new Map()
      const touched = sameTurn ? s.touched : new Map()

      const candidates = new Set()
      const tmpScanned = await scanTmpDir(cwd, cfg.tmpDirName, cfg.scanDepth, protectedSet)
      // 通道 1：约定目录
      for (const rel of tmpScanned) candidates.add(rel)

      // 通道 2：本 turn 记录的路径。分两类 —— 还在的进 candidates 等模型动手，
      // 已经不在了的进 preCleaned。
      //
      // v3 的 preCleaned 是「已释放空间」的主来源：实测 110 个会话、49334 次工具调用，
      // 模型几乎总在本 turn 结束前就自己把临时件删干净了（典型：turn 10 写了 7 个
      // check_*.ps1，turn/end 前 55 秒一条 rm -f 全删）。等闸门 stat 时文件早没了，
      // 于是 v2 的「已释放空间」永远停在 0。文件消失本身就是要记的事实，与「谁删的」无关。
      const preCleaned = []
      const preSeen = new Set()
      for (const [abs, knownSize] of recorded) {
        if (!insideCwd(cwd, abs)) continue
        const rel = toPosix(relative(cwd, abs))
        if (hasProtectedSegment(rel, protectedSet)) continue
        const isInTmpDir = rel.startsWith(tmpPrefix)
        if (!isInTmpDir && !matchesAny(patternRes, basename(rel))) continue
        let info
        try {
          info = await stat(abs)
        } catch {
          info = void 0
        }
        if (info === void 0) {
          // 不在了 —— 本轮写过又消失了。体积只能用写入/删除那一刻记下的，
          // 现在 stat 已经没得量。
          if (!preSeen.has(rel)) {
            preSeen.add(rel)
            preCleaned.push({ rel, size: knownSize })
          }
          continue
        }
        if (!info.isFile()) continue
        candidates.add(rel)
      }

      // v4：tool/call 那一刻拍过体积、到结束时已经不在的 cwd 内文件。
      //
      // 这条专治「模型在同一次工具调用里写了又删」以及「用 bash 删掉自己刚写的东西」：
      // 到 tool/result 时文件已经没了，collectTouched 的 lstat 拿不到，s.paths 里也就
      // 没有它；只有 tool/call 那一刻的同步快照还留着体积。
      //
      // 只进 preCleaned，**绝不进 candidates** —— 这里没有 mtime 过滤，`read` 顺手看一眼
      // 老临时件也会被拍进来。拿它去指挥模型删文件，就会叫模型去删一个它只是看过的文件。
      for (const [abs, knownSize] of touched) {
        if (!insideCwd(cwd, abs)) continue
        const rel = toPosix(relative(cwd, abs))
        if (hasProtectedSegment(rel, protectedSet)) continue
        if (preSeen.has(rel) || preSeen.has(abs)) continue
        let still = true
        try {
          await stat(abs)
        } catch {
          still = false
        }
        if (still) continue
        preSeen.add(rel)
        preSeen.add(abs)
        preCleaned.push({ rel, size: knownSize })
      }

      // v4：cwd 之外被碰过、到结束时已经不在的文件。只进 preCleaned（记账），
      // 绝不进 candidates —— 工作区之外不该由插件指挥模型去删。
      // 这条正是为「用户自己的清理脚本清在 %TEMP% 里」准备的：那些字节是真实
      // 释放掉的，但文件名可能既不符合模式、也不在 cwd 内，两条老通道都看不见。
      for (const [abs, knownSize] of foreign) {
        let still = true
        try {
          await stat(abs)
        } catch {
          still = false
        }
        if (still) continue
        if (preSeen.has(abs)) continue
        preSeen.add(abs)
        preCleaned.push({ rel: abs, size: knownSize })
      }

      // 模型主动上报的（report_temp_cleanup）。它删之前自己量过，比插件事后猜准。
      // 只采信「确实已经不在了」的：还在的文件若命中模式，通道 2 已经把它算作残留，
      // 再记一次就等于把同一个文件既算「待清」又算「已清」。
      for (const [abs, size] of reported) {
        const rel = insideCwd(cwd, abs) ? toPosix(relative(cwd, abs)) : abs
        if (hasProtectedSegment(rel, protectedSet)) continue
        if (preSeen.has(rel)) continue
        let gone = false
        try {
          await stat(abs)
          gone = false
        } catch {
          gone = true
        }
        if (!gone) continue
        preSeen.add(rel)
        preCleaned.push({ rel, size })
      }

      // 通道 3：备份保留。seeds = 本轮写过的路径 ∪ 约定目录里的文件。
      let excessBackups = []
      let pruned = []
      if (retention.enabled) {
        const seeds = new Set(recorded.keys())
        for (const rel of tmpScanned) seeds.add(join(cwd, rel))
        const allPlans = await planBackups(cwd, seeds, retention.keep, protectedSet)
        // 原件不在的家族整族不管：那几份备份可能是唯一副本，「留最近 N 份」
        // 这个规则本身就失去了参照物。宁可留垃圾，也不删掉唯一的那份。
        const plans = retention.requireOriginalPresent
          ? allPlans.filter((p) => p.originalPresent)
          : allPlans
        excessBackups = plans.flatMap((p) => p.excess.map((m) => ({ rel: m.rel, stem: p.stem })))
        if (retention.mode === 'prune' && excessBackups.length > 0) {
          pruned = await pruneBackups(cwd, plans, retention, protectedSet)
          const gone = new Set(pruned.map((p) => p.rel))
          excessBackups = excessBackups.filter((b) => !gone.has(b.rel))
          // 被 prune 删掉的备份，如果同时也命中了通道 2（模型自己写的 .bak-* 会被
          // 模式匹配到），必须从清单里剔除 —— 否则 steer 文案会列出刚删掉的文件。
          for (const rel of gone) candidates.delete(rel)
          if (pruned.length > 0) {
            const line = `prune session=${session.id} turn=${turn} cwd=${cwd} deleted=${pruned.length} ` +
              `bytes=${pruned.reduce((a, p) => a + p.size, 0)} keep=${retention.keep} ` +
              `paths=[${pruned.slice(0, cfg.maxLogPaths).map((p) => p.rel).join(', ')}]`
            try {
              ctx.logger?.info?.(`dsh-turn-cleanup: ${line}`)
            } catch {}
            await record(cwd, line)
          }
        }
      }

      // 没有需要提醒模型的东西，也要留账：本轮确实清掉过东西（模型自己删的，或 prune
      // 模式插件亲手删的），只是不必再打扰它。不留账的话「已释放空间」又会掉回 0 ——
      // 这正是 v2 的病根：清了 49334 次工具调用里的大部分，账本却只有一条。
      const askNothing = candidates.size === 0 && excessBackups.length === 0
      if (askNothing) {
        if (stats !== null && (preCleaned.length > 0 || pruned.length > 0)) {
          const preBytes = preCleaned.reduce((a, p) => a + p.size, 0)
          const line = `auto session=${session.id} turn=${turn} cwd=${cwd} ` +
            `preCleaned=${preCleaned.length} bytes=${preBytes} pruned=${pruned.length}`
          try {
            ctx.logger?.info?.(`dsh-turn-cleanup: ${line}`)
          } catch {}
          await record(cwd, line)
          void stats
            .recordGate({
              sid: session.id,
              turn,
              kind: 'auto',
              verifyAtTurn: turn,
              cwd,
              temps: [],
              backups: [],
              keep: retention.keep,
              mode: retention.mode,
              steerMode: cfg.steerMode,
              pruned,
              sizes: {},
              preCleaned
            })
            .catch(() => {})
        }
        return
      }

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
      // 行首用实际交付方式，日志里能一眼分出「另开一轮」与「同轮多跑一步」。
      const line = `${cfg.steerMode} session=${session.id} turn=${turn} cwd=${cwd} ${logParts.join(' ')}`
      try {
        ctx.logger?.info?.(`dsh-turn-cleanup: ${line}`)
      } catch {}
      await record(cwd, line)

      // 记一笔给面板：报了什么、prune 模式自己删了什么。verify 留空，等复核时机到了再算。
      // followup 模式清单要下一轮才被执行，所以复核点也跟着挪一轮。
      // sizes 只在这里量：清单已定（有上界），且只有 stats 打开时才需要——面板的
      // 「释放空间」全靠它，闸门本身一个字节都不依赖。
      if (stats !== null) {
        const sizes = await measureSizes(cwd, [...list, ...backupList], MAX_MEASURE_FILES)
        void stats
          .recordGate({
            sid: session.id,
            turn,
            verifyAtTurn: cfg.steerMode === 'followup' ? turn + 1 : turn,
            cwd,
            temps: list,
            backups: backupList,
            keep: retention.keep,
            mode: retention.mode,
            steerMode: cfg.steerMode,
            pruned,
            sizes,
            preCleaned
          })
          .catch(() => {})
      }

      const sections = []
      const text = messagesFor(locale)
      // 只有工具真的在架子上时才提它。提示调一个不存在的工具，比不给提示更糟。
      const footer = reportToolReady ? `${text.tempFooter}\n${text.reportHint}` : text.tempFooter
      if (list.length > 0) {
        const lines = shownTemps.map((p) => `- ${p}`)
        if (moreTemps > 0) lines.push(text.more(moreTemps))
        sections.push([text.tempTitle, ...lines, footer].join('\n'))
      }
      if (backupList.length > 0) {
        const lines = shownBackups.map((p) => `- ${p}`)
        if (moreBackups > 0) lines.push(text.more(moreBackups))
        const bFooter = reportToolReady
          ? `${text.backupFooter(retention.keep)}\n${text.reportHint}`
          : text.backupFooter(retention.keep)
        sections.push([text.backupTitle(retention.keep), ...lines, bFooter].join('\n'))
      }

      // 交付方式决定「这一轮能不能收尾」：
      //   followup → 排进 next-turn：本轮正常结束，交付汇报继续占着答案位，
      //              紧接着自动开一轮清场（chat UI 按 turn 折叠，跨轮不会互相顶替）。
      //   steer    → 同轮多跑一步：闸门更硬，但那一步成为最后一步，会把汇报折进「过程」。
      //
      // source.form = 'notice' 与宿主自己的 modelSwitchNotice() 对齐（dsh-agent/lib/index.js）：
      // 这类消息不是用户说的话，是宿主替系统插的提示。不带 form 时 chat UI 会退回
      // 「收到执行请求」的通用标题，读起来像用户在催活。
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: sections.join('\n\n') }],
        source: {
          kind: 'dsh-turn-cleanup',
          form: 'notice',
          summary: summaryFor(locale, list.length, backupList.length)
        }
      }
      try {
        if (cfg.steerMode === 'steer') agent.steer(message)
        else if (typeof agent.followup === 'function') agent.followup(message)
        else agent.steer(message)
      } catch (error) {
        try {
          ctx.logger?.warn?.(`dsh-turn-cleanup: ${cfg.steerMode} failed: ${error?.message ?? error}`)
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
   * 0.2.1 及更早的 clientModules 用 pkgMeta 缓存每个包「有没有 dsh.client」的结论，
   * 命中即返回（含缓存的 null），而这份缓存只在进程启动时清一次。于是：先装插件、
   * 后补 dsh.client 声明的情况，会被永久记成「没有 client 半」，HMR 重跑 apply 也
   * 救不回来（它只对新 fiber 重扫）。
   *
   * 0.2.2 删掉了 pkgMeta（resolveMeta 每次 flush 都重新读 package.json），但「新装包
   * 要有人触发一次 flush」这条没变。所以这里的通用写法是：清掉本包那条 null 缓存
   * （老版本需要，新版本自然是空集合）→ dirty.add(本包) → flush 一次。任何一步
   * 拿不到内部字段就安静放弃，退化成「重启 DSH 才出现面板」——那本来也是正常安装路径。
   */
  const recoverClientEntry = (cm) => {
    try {
      const has = () => (cm.graph?.()?.entries ?? []).some((e) => e.id === name)
      if (has()) {
        const row = (cm.graph?.()?.entries ?? []).find((e) => e.id === name)
        record('', `client entry present url=${String(row?.url)} rev=${String(row?.rev)}`)
        return
      }
      // 0.2.1 及更早：结论缓存在 pkgMeta（key 形如 `<baseUrl>\0<loaderName>`），
      // 命中就连 `null` 一起返回，必须先把本包那条清掉。0.2.2 删掉了这份缓存
      // （resolveMeta 每次 flush 都重新读 package.json），清缓存段自然变成 no-op，
      // 只剩 dirty + flush 两条路——所以这里不把 pkgMeta 当作前置条件。
      if (cm.pkgMeta instanceof Map) {
        for (const key of [...cm.pkgMeta.keys()]) {
          if (key.includes(name) && cm.pkgMeta.get(key) === null) cm.pkgMeta.delete(key)
        }
      }
      if (typeof cm.dirty?.add !== 'function' || typeof cm.flush !== 'function') {
        record('', `client entry check: clientModules shape unknown keys=${Object.keys(cm).join(',')}`)
        return
      }
      cm.dirty.add(name)
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
      if (url === void 0) {
        record('', `client entry still absent after flush; graph ids=${(cm.graph?.()?.entries ?? []).map((e) => e.id).join('|')}`)
        return
      }
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
  // 为什么不是 apply 里同步 `ctx.get('clientModules')`：
  // cordis 4.1.0 的 `ctx.get(name)` 就是 `reflect.get(name, strict = true)`
  // （cordis/lib/index.js:1347-1356），strict 时**只返回提供该服务的 fiber 已经 ACTIVE
  // （state === 2）的实现**——value 早就 provide 好了也照样返回 undefined。冷启动时本插件
  // 随 profile 一起装，apply 跑在 modules 那个 fiber 走到 state 2 之前，于是拿到 undefined。
  // 日志里 40+ 行 `clientModules service absent` 全是这一条，服务其实一直都在。
  // 偶发那几次成功（11-16、11-18 的 `client entry present`）是 HMR 重跑 apply，
  // 那时 modules 早就 ACTIVE 了。
  // `ctx.inject(['clientModules'], …)` 才是「等它 ACTIVE 再跑」：它建一个子 fiber，
  // 依赖不满足只让这个子 fiber 不加载，闸门本体不受影响（tools / webServer 同款写法）。
  if (typeof ctx.inject === 'function') {
    const onClientInjectError = (error) => {
      try {
        ctx.logger?.warn?.(`dsh-turn-cleanup: client entry recovery skipped: ${error?.message ?? error}`)
      } catch {}
    }
    try {
      // cordis 4.1.0 的 ctx.inject() 是 then-only thenable，没有 catch（同 stats 路由）。
      const fiber = ctx.inject(['clientModules'], (sub) => {
        recoverClientEntry(sub.clientModules)
      })
      if (typeof fiber?.then === 'function') fiber.then(undefined, onClientInjectError)
    } catch (error) {
      onClientInjectError(error)
    }
  }

  // ── 模型主动上报工具 ────────────────────────────────────────────────────
  //
  // 为什么需要它：插件只能在 turn-stopping 与三个 fs intent 上观察。但模型删临时件
  // 最常用的手段是 `rm -f` / `Remove-Item`，走子进程，不触发任何 intent；等到
  // turn-stopping 再去 stat，文件早没了 —— 体积也就永久丢了。模型自己删的时候
  // 明明知道删了什么、多大，让它顺手说一句，是唯一不靠猜的补法。
  //
  // 不硬 inject 'tools'：那会让插件在缺该服务的 profile 里整个不加载，闸门跟着
  // 一起消失。改成软探测 + 可选注入，拿不到就退化成「没有上报工具，靠 stat 猜」。
  //
  // 但**不要**在这里用 `ctx.get('tools') !== void 0` 预判：reflect.get 的 strict 语义
  // 只认已经 ACTIVE 的 fiber（cordis/lib/index.js:1347-1356），冷启动时恒返回 undefined，
  // 整块被跳过 → 上报工具静默不注册。日志印证：46 次 `apply steerMode=…` 只配到 2 次
  // `report session=…`，其余全是冷启动白白丢掉这一路。注册得成与否交给下面的
  // `ctx.inject(['tools'], registerTool)` 自己判断——它才是「等 tools 就绪再跑」。
  if (typeof ctx.inject === 'function') {
    const reportDefinition = {
      name: 'report_temp_cleanup',
      description:
        'Report the temporary files you just deleted, with their sizes, so the cleanup panel ' +
        'can total up the disk space freed. Call it once after removing scratch files ' +
        '(.agent-tmp/, probe-*, tmp-*, scratch-*, check-*, diag_*, bench-*, *.bak-*). ' +
        'Only report files you actually removed; sizes are optional when you do not know them.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: {
            type: 'array',
            description: 'One entry per file you removed.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: {
                  type: 'string',
                  description: 'Absolute path, or a path relative to the workspace root.'
                },
                bytes: {
                  type: 'integer',
                  description: 'Size in bytes before deletion. Omit when unknown.'
                }
              },
              required: ['path']
            }
          }
        },
        required: ['files']
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            accepted: { type: 'integer' },
            ignored: { type: 'integer' },
            bytes: { type: 'integer' }
          }
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `recorded ${value.accepted} file(s), ${value.bytes} byte(s); ignored ${value.ignored}`
          }
        ]
      },
      async execute(args, exec) {
        const agent = exec === null || exec === void 0 ? void 0 : exec.agent
        const session = agent === null || agent === void 0 ? void 0 : agent.session
        const entries = Array.isArray(args?.files) ? args.files : []
        if (session === null || session === void 0) {
          // 没有会话就没有账本可记（后台/子代理调用）：当成功，但什么都不做。
          return { accepted: 0, ignored: entries.length, bytes: 0 }
        }
        const cwd = cwdOf(ctx, session) ?? process.cwd()
        const s = stateFor(session)
        let accepted = 0
        let ignored = 0
        let bytes = 0
        for (const entry of entries) {
          const raw = typeof entry?.path === 'string' ? entry.path.trim() : ''
          if (raw.length === 0) {
            ignored += 1
            continue
          }
          const abs = isAbsolute(raw) ? raw : join(cwd, raw)
          const size = Number.isFinite(entry?.bytes) && entry.bytes > 0 ? Math.floor(entry.bytes) : 0
          s.reported.set(abs, size)
          accepted += 1
          bytes += size
        }
        if (accepted > 0) {
          void record(cwd, `report session=${session.id} turn=${s.turn ?? '?'} files=${accepted} bytes=${bytes}`)
        }
        return { accepted, ignored, bytes }
      }
    }

    const registerTool = (sub) => {
      sub.effect(() => {
        let dispose = null
        try {
          dispose = sub.tools.register(reportDefinition)
          reportToolReady = true
        } catch (error) {
          // 同名已注册（HMR 重复 apply）、schema 不合规、被别的插件占位 —— 都不是
          // 致命错误：闸门本身还能跑，只是少了主动上报这一路。
          try {
            ctx.logger?.warn?.(`dsh-turn-cleanup: report tool unavailable: ${error?.message ?? error}`)
          } catch {}
          return () => {}
        }
        return () => {
          try {
            dispose?.()
          } catch {}
        }
      }, 'dsh-turn-cleanup: report tool')
    }
    const onToolInjectError = (error) => {
      try {
        ctx.logger?.warn?.(`dsh-turn-cleanup: report tool unavailable: ${error?.message ?? error}`)
      } catch {}
    }
    // 与 stats 路由同款：cordis 4.1.0 的 ctx.inject() 是 then-only thenable，没有 catch。
    try {
      const fiber = ctx.inject(['tools'], registerTool)
      if (typeof fiber?.then === 'function') fiber.then(undefined, onToolInjectError)
    } catch (error) {
      onToolInjectError(error)
    }
  }

  if (stats !== null && typeof ctx.inject === 'function') {
    const onInjectError = (error) => {
      try {
        ctx.logger?.warn?.(`dsh-turn-cleanup: stats route unavailable: ${error?.message ?? error}`)
      } catch {}
    }
    // cordis 4.1.0 的 ctx.inject() 返回 `Object.create(fiber)` 再挂一个 then 的 thenable：
    // 有 then，没有 catch / finally。直接 `.catch()` 会抛
    // `ctx.inject(...).catch is not a function`（0.2.2 实测）。所以按 then 处理，
    // 并且把同步抛出的情况也兜住。
    try {
      const fiber = ctx.inject(['webServer'], (sub) => {
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
      if (typeof fiber?.then === 'function') fiber.then(undefined, onInjectError)
    } catch (error) {
      onInjectError(error)
    }
  }
}

export default { name, inject, apply }
