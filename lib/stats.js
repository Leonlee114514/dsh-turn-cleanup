import { readFile, writeFile, mkdir, stat, rename, unlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

/**
 * dsh-turn-cleanup 的统计账本。
 *
 * 为什么需要独立账本：`ctx.logger.info` 只进进程 stdout，人类可读但机器难聚合；
 * `record()` 写的文本日志可以 grep，但要算「依从率」得跨行关联，脆弱。
 * 这里用一份 JSON 快照（单个文件、整份重写）作为唯一机器事实源：
 * 事件数组最多保留 MAX_EVENTS 条，写入串行化，读失败就当空账本。
 *
 * 核心指标不是「拦了多少次」，而是「拦完之后模型真的清了吗」——插件只 steer 不删，
 * 所以每个拦截事件都要在**模型已经拿到清单并动过手之后**复核一次：路径还在 = 没清，
 * 不在了 = 已清。依从率 = 已清 / (已清 + 未清)。复核不了的（stat 报 EACCES/网络盘断连）
 * 既不算已清也不算未清，从分母里剔除 —— 「不知道」不是「已释放」。
 *
 * 「之后」是哪一刻，取决于交付方式（见 index.js 的 steerMode）：
 *   steer    —— 同轮多跑一步，那个 turn/end 就是动手之后，verifyAtTurn = turn。
 *   followup —— 清单排进 next-turn，本轮照常结束、下一轮才动手，
 *               所以 verifyAtTurn = turn + 1；在 turn/end 时按 turn 复核会读到
 *               「全都还在」的假数字，依从率会被压成 0。
 */

const VERSION = 4
const MAX_EVENTS = 1000
/**
 * 单条事件最多落盘多少条 preCleaned 明细。
 *
 * 为什么不存全量：一轮可能碰过 200 个文件（index.js 的 MAX_TOUCHED_PATHS），
 * 账本 1000 条事件满载时就是 1000 × 200 × 约 40 字节 ≈ 18 MB，而 save() 是
 * **同步 JSON.stringify 整份重写**，实测单次 330 ms（其中序列化 243 ms），
 * 这期间整个进程的事件循环停摆，所有会话的 turn 都卡住。
 * 截断到 100 条后最坏约 4 MB / 80 ms，超出的部分只留计数与体积。
 */
const MAX_PRECLEANED_STORED = 100

/**
 * v3 起事件多一个 `preCleaned`：本轮写过（或模型主动上报过）、但轮到插件检查时
 * 已经不在磁盘上的文件。
 *
 * 为什么需要它：实测 110 个会话、49334 次工具调用，模型几乎总是在 turn 结束
 * **之前**就把临时文件删干净了（典型案例：写完 7 个脚本，一条 rm -f 全删，
 * 55 秒后 turn 才结束）。插件的闸门只在 turn-stopping 时 stat 一次，那时文件
 * 早已不在，于是「已释放空间」永远是 0 —— 数字没错，口径错了。
 *
 * 体积从哪来：write/edit 的 intent 在写入**之前**触发，拿不到大小；所以大小靠
 * 三条路补：① delete-intent 删除前 lstat；② 模型用 report_temp_cleanup 工具
 * 主动报；③ 轮到检查时文件还在，直接 stat。三条都没有就记 0（宁可少报）。
 */
function normalizePreCleaned(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw) {
    if (typeof entry === 'string') {
      if (entry.length > 0) out.push({ rel: entry, size: 0 })
      continue
    }
    if (entry === null || typeof entry !== 'object') continue
    const rel = typeof entry.rel === 'string' ? entry.rel : ''
    if (rel.length === 0) continue
    const n = Number(entry.size)
    out.push({ rel, size: Number.isFinite(n) && n > 0 ? n : 0 })
  }
  return out
}

/** 一条 pruned 记录：v1 是裸字符串，v2 起是 `{rel, size}`。两种都要能读。 */
function prunedEntry(entry) {
  if (typeof entry === 'string') return { rel: entry, size: 0 }
  if (entry !== null && typeof entry === 'object' && typeof entry.rel === 'string') {
    const n = Number(entry.size)
    return { rel: entry.rel, size: Number.isFinite(n) && n > 0 ? n : 0 }
  }
  return null
}

function prunedSize(entry) {
  if (entry !== null && typeof entry === 'object' && Number.isFinite(entry.size)) return Number(entry.size)
  return 0
}

/** 账本文件：与文本日志同目录，没有配置 logFile 时退回 $DSH_HOME/logs。 */
export function defaultStatsFile(logFile) {
  if (typeof logFile === 'string' && logFile.length > 0) {
    return join(dirname(logFile), 'turn-cleanup-stats.json')
  }
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'logs', 'turn-cleanup-stats.json')
}

/**
 * 三态存在性判定。
 *
 * 曾经这里是 `catch { return false }`：cwd 被删、移动硬盘拔掉、网络盘断连时
 * stat 抛 EACCES/ENOTDIR/ELOOP，全部被当成「文件已删除」，于是 verify 把整批
 * 文件记成已清、cleanedBytes 虚增。找不到 ≠ 已释放。
 *   只在 ENOENT / ENOTDIR（真的不在了）时返回 'absent'，
 *   其余错误返回 'unknown' —— 既不进已清也不进未清，从合规率分母里剔除。
 */
async function probe(abs) {
  try {
    const info = await stat(abs)
    return info.isFile() || info.isDirectory() ? 'present' : 'absent'
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : ''
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'absent'
    return 'unknown'
  }
}

function emptyVerify() {
  return {
    at: '',
    cleanedTemps: [],
    remainingTemps: [],
    cleanedBackups: [],
    remainingBackups: [],
    // 复核不了的文件（stat 报 EACCES/ELOOP/网络盘断连）：既不算清也不算没清。
    unknownTemps: [],
    unknownBackups: [],
    cleaned: 0,
    remaining: 0,
    unknown: 0,
    cleanedBytes: 0,
    remainingBytes: 0,
    // v3：本轮写过、轮到检查时已不在的文件条数（体积已由 summary 直接计入）。
    preCleaned: 0
  }
}

/** 体积表归一：`{rel: bytes}` → 只留正数，其余当没有。 */
function normalizeSizes(raw) {
  const out = Object.create(null)
  if (raw === null || typeof raw !== 'object') return out
  for (const [rel, bytes] of Object.entries(raw)) {
    const n = Number(bytes)
    if (Number.isFinite(n) && n > 0) out[rel] = n
  }
  return out
}

function sizeOf(sizes, rel) {
  const n = sizes?.[rel]
  return Number.isFinite(n) ? Number(n) : 0
}

function relList(raw) {
  return Array.isArray(raw) ? raw.filter((rel) => typeof rel === 'string' && rel.length > 0) : []
}

function finiteOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 把磁盘上读到的一条记录重建成已知形状。
 *
 * 为什么必须做：load 以前只校验「是 object」，之后所有聚合都直接 `e.temps.length`。
 * 账本被外部工具改过、旧版本残留、写盘半截留下一条 {`sid`,`turn`} 时，
 * summary() 抛 TypeError → 路由 500 → 面板永久白屏，且因为 load 只做一次，
 * 坏记录常驻内存，重启前每次请求都重抛。
 */
function normalizeEvent(raw, index) {
  if (raw === null || typeof raw !== 'object') return null
  const turn = finiteOr(raw.turn, 0)
  const event = {
    at: typeof raw.at === 'string' ? raw.at : '',
    kind: raw.kind === 'auto' ? 'auto' : 'gate',
    sid: typeof raw.sid === 'string' ? raw.sid : String(raw.sid ?? ''),
    turn,
    verifyAtTurn: finiteOr(raw.verifyAtTurn, turn),
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    temps: relList(raw.temps),
    backups: relList(raw.backups),
    keep: finiteOr(raw.keep, 0),
    mode: raw.mode === 'prune' ? 'prune' : 'steer',
    steerMode: raw.steerMode === 'steer' ? 'steer' : 'followup',
    pruned: Array.isArray(raw.pruned)
      ? raw.pruned.map(prunedEntry).filter((entry) => entry !== null)
      : [],
    preCleaned: [],
    preCleanedOmitted: 0,
    preCleanedOmittedBytes: 0,
    sizes: normalizeSizes(raw.sizes),
    verify: null,
    // 仅供 verify 去重与调试，不参与任何统计口径。
    seq: index
  }
  const preAll = normalizePreCleaned(raw.preCleaned)
  event.preCleaned = preAll.slice(0, MAX_PRECLEANED_STORED)
  if (preAll.length > MAX_PRECLEANED_STORED) {
    const rest = preAll.slice(MAX_PRECLEANED_STORED)
    event.preCleanedOmitted = rest.length
    event.preCleanedOmittedBytes = rest.reduce((a, entry) => a + entry.size, 0)
  }
  if (raw.verify !== null && typeof raw.verify === 'object') {
    const v = emptyVerify()
    v.at = typeof raw.verify.at === 'string' ? raw.verify.at : ''
    v.cleanedTemps = relList(raw.verify.cleanedTemps)
    v.remainingTemps = relList(raw.verify.remainingTemps)
    v.cleanedBackups = relList(raw.verify.cleanedBackups)
    v.remainingBackups = relList(raw.verify.remainingBackups)
    v.unknownTemps = relList(raw.verify.unknownTemps)
    v.unknownBackups = relList(raw.verify.unknownBackups)
    v.cleaned = finiteOr(raw.verify.cleaned, 0)
    v.remaining = finiteOr(raw.verify.remaining, 0)
    v.unknown = finiteOr(raw.verify.unknown, 0)
    v.cleanedBytes = finiteOr(raw.verify.cleanedBytes, 0)
    v.remainingBytes = finiteOr(raw.verify.remainingBytes, 0)
    v.preCleaned = finiteOr(raw.verify.preCleaned, 0)
    event.verify = v
  }
  return event
}

/** preCleaned 的条数与体积，含被截断的部分。 */
function preCleanedTotals(event) {
  const list = Array.isArray(event.preCleaned) ? event.preCleaned : []
  let count = list.length + (Number(event.preCleanedOmitted) || 0)
  let bytes = list.reduce((a, entry) => a + (Number(entry?.size) || 0), 0) + (Number(event.preCleanedOmittedBytes) || 0)
  return { count, bytes }
}

export class StatsStore {
  constructor(file, logger) {
    this.file = file
    this.logger = logger
    this.events = []
    // 读盘的门是**这个 Promise 本身**，不是布尔标志。
    // 曾经 `this.loaded = true` 写在 await readFile 之前：第二个并发调用者立刻
    // 拿到空 events，而插件在 turn-stopping 与 turn/end 两处都是 `void` 起跑
    // stats 调用，于是进程生命周期内第一次拦截的复核必然静默跳过、recordGate
    // 与 load 竟态时新事件还会被 `this.events = parsed.events` 整块覆盖掉。
    this.loading = null
    this.chain = Promise.resolve()
    this.saveSeq = 0
  }

  warn(message) {
    try {
      this.logger?.warn?.(message)
    } catch {}
  }

  /** 只读一次；文件不存在、损坏、版本不认识都当空账本，绝不影响闸门。 */
  load() {
    if (this.loading === null) this.loading = this.readFromDisk()
    return this.loading
  }

  async readFromDisk() {
    let text
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : ''
      if (code !== 'ENOENT') {
        this.warn(`dsh-turn-cleanup: stats ledger unreadable (${code || error?.message}); starting empty`)
      }
      this.events = []
      return
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      // 写盘被打断留下半截 JSON 时，旧实现直接当空账本，下一次 save() 整份重写
      // 就把历史永久抹掉。这里先留一份 .corrupt-<时间戳> 副本再重开，事主能捞。
      await this.quarantine()
      this.warn(`dsh-turn-cleanup: stats ledger is not valid JSON (${error?.message}); kept a .corrupt copy and started empty`)
      this.events = []
      return
    }
    const raw = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.events) ? parsed.events : []
    const events = []
    for (const entry of raw) {
      const normalized = normalizeEvent(entry, events.length)
      if (normalized !== null) events.push(normalized)
    }
    this.events = events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events
  }

  /** 把损坏的账本改名留档；失败就算了，绝不能因此挡住闸门。 */
  async quarantine() {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      await rename(this.file, `${this.file}.corrupt-${stamp}`)
    } catch {}
  }

  /**
   * 整份重写，串行化，先写临时文件再 rename。
   *
   * 曾经直接 writeFile 目标文件：进程在写一半时被杀（关机、OOM、Ctrl-C）就留下
   * 截断的 JSON，下次 load 解析失败 → 当空账本 → 下一次 save 整份覆盖，
   * 实测 40 条历史一次性归零。rename 是原子的，最坏也只是保留上一版。
   * 失败不再静默：留一条 warn，否则「账本没写进去」永远不可见。
   */
  save() {
    const run = async () => {
      await mkdir(dirname(this.file), { recursive: true })
      this.saveSeq += 1
      const tmp = `${this.file}.tmp-${process.pid}-${this.saveSeq}`
      try {
        await writeFile(tmp, JSON.stringify({ version: VERSION, events: this.events }), 'utf8')
        await rename(tmp, this.file)
      } catch (error) {
        try {
          await unlink(tmp)
        } catch {}
        throw error
      }
    }
    this.chain = this.chain.then(run, run).catch((error) => {
      this.warn(`dsh-turn-cleanup: stats ledger write failed: ${error?.message ?? error}`)
    })
    return this.chain
  }

  /**
   * 记一次拦截。pruned 只有 prune 模式才有（插件自己删掉的那些）。
   * @param input.verifyAtTurn - 哪一轮的 turn/end 才算「模型已经动过手」。缺省 = 本轮
   *   （steer 模式）；followup 模式由调用方传 turn + 1。
   * @param input.sizes - `{rel: bytes}`，清单里各文件的体积。量不到就不放键，
   *   面板会把它当 0（宁可少报，不猜）。
   * @returns 落账后的事件对象（引用，调用方可继续用）。
   */
  async recordGate(input) {
    await this.load()
    const turn = finiteOr(input.turn, 0)
    const verifyAtTurn = Number.isFinite(input.verifyAtTurn) ? Number(input.verifyAtTurn) : turn
    const preAll = normalizePreCleaned(input.preCleaned)
    const preStored = preAll.slice(0, MAX_PRECLEANED_STORED)
    const preRest = preAll.slice(MAX_PRECLEANED_STORED)
    const event = {
      at: new Date().toISOString(),
      // gate = 拦到了残留并 steer 过模型；auto = 模型自己先清干净了，只记账不打扰。
      kind: input.kind === 'auto' ? 'auto' : 'gate',
      sid: String(input.sid),
      turn,
      verifyAtTurn,
      cwd: String(input.cwd),
      temps: relList(input.temps),
      backups: relList(input.backups),
      keep: Number(input.keep) || 0,
      mode: input.mode === 'prune' ? 'prune' : 'steer',
      steerMode: input.steerMode === 'steer' ? 'steer' : 'followup',
      // pruned 同时带体积：v1 只存路径，v2 起存 `{rel, size}`（读侧兼容裸字符串）。
      pruned: Array.isArray(input.pruned) ? input.pruned.map(prunedEntry).filter((e) => e !== null) : [],
      // v3：本轮写过、但轮到检查时已经不在的文件。模型自己清得越干净，这里越多。
      preCleaned: preStored,
      preCleanedOmitted: preRest.length,
      preCleanedOmittedBytes: preRest.reduce((a, entry) => a + entry.size, 0),
      sizes: normalizeSizes(input.sizes),
      verify: null,
      seq: this.events.length
    }
    this.events.push(event)
    this.trim()
    await this.save()
    return event
  }

  /**
   * 裁剪到 MAX_EVENTS。**优先丢已经复核过的事件**：
   * 老实现按插入序 splice，不看 verify，实测满载 1000 条时，头部一条
   * verifyAtTurn 还在未来的 followup 事件会被直接裁掉，下一轮 verify 找不到它，
   * 这条拦截永远停在「未复核」，依从率少一条且无从发现。
   */
  trim() {
    if (this.events.length <= MAX_EVENTS) return
    let overflow = this.events.length - MAX_EVENTS
    const kept = []
    for (const event of this.events) {
      if (overflow > 0 && event.verify !== null && event.verify !== undefined) {
        overflow -= 1
        continue
      }
      kept.push(event)
    }
    // 还没裁够（全是待复核的）才按最旧丢。
    this.events = overflow > 0 ? kept.slice(overflow) : kept
  }

  /**
   * 复核某个 (session, turn) 的拦截结果。只复核**这一轮才算动手**、且还没复核过的
   * 事件 —— 更早的 turn 早已结束，此刻补算会把「当时没删、后来手工删了」也算成依从，
   * 让数字虚高。
   *
   * verifyAtTurn 而不是 turn：followup 模式下清单要等下一轮才被执行，
   * 在本轮 turn/end 复核只会读到「全都还在」，依从率被压成 0。
   */
  async verify(sid, turn) {
    await this.load()
    const at = Number(turn)
    // 收集这一轮**全部**待复核事件，而不是只留最后一条。
    //
    // 为什么不能只留一条：sid + turn 不是唯一键。followup 模式下 gate 事件记在
    // turn N、verifyAtTurn = N+1；如果 N+1 这一轮模型自己就把残留清干净了，闸门
    // 走的是「没有清单」分支，会再写一条 kind='auto'、verifyAtTurn = N+1 的事件。
    // 两条的 when 相等，新事件又在尾部 —— 旧实现取最后一条，等于让 auto 事件抢走
    // 复核权，gate 事件永远 verify === null（面板「待复核」永远减不掉、依从率分母
    // 偏小、cleanedBytes 永远缺这一块）。
    //
    // 现在全量复核：auto 事件本来就没有 temps/backups，探针循环空转一次就得到
    // 「已复核的空结果」，成本可以忽略；换来的是 unverifiedEvents 归零、每一个
    // 事件的 verify 都在它该来的那一轮落地。
    const pending = []
    for (const event of this.events) {
      if (event.sid !== String(sid)) continue
      const when = Number.isFinite(event.verifyAtTurn) ? event.verifyAtTurn : event.turn
      if (when !== at) continue
      // `== null` 而不是 `=== null`：v2 账本里根本没有 verify 键，
      // undefined === null 为 false，那些事件永远进不了复核队列。
      if (event.verify !== null && event.verify !== undefined) continue
      pending.push(event)
    }
    if (pending.length === 0) return

    for (const target of pending) {
      const v = emptyVerify()
      v.at = new Date().toISOString()
      const sizes = normalizeSizes(target.sizes)
      for (const rel of relList(target.temps)) {
        const state = await probe(join(target.cwd, rel))
        if (state === 'present') {
          v.remainingTemps.push(rel)
          v.remainingBytes += sizeOf(sizes, rel)
        } else if (state === 'absent') {
          v.cleanedTemps.push(rel)
          v.cleanedBytes += sizeOf(sizes, rel)
        } else {
          v.unknownTemps.push(rel)
        }
      }
      for (const rel of relList(target.backups)) {
        const state = await probe(join(target.cwd, rel))
        if (state === 'present') {
          v.remainingBackups.push(rel)
          v.remainingBytes += sizeOf(sizes, rel)
        } else if (state === 'absent') {
          v.cleanedBackups.push(rel)
          v.cleanedBytes += sizeOf(sizes, rel)
        } else {
          v.unknownBackups.push(rel)
        }
      }
      // prune 模式删掉的备份，插件亲手删的，一律计入「已清」——体积用删除前量到的那个数。
      const prunedList = Array.isArray(target.pruned) ? target.pruned : []
      for (const entry of prunedList) v.cleanedBytes += prunedSize(entry)
      // v3：preCleaned 的体积不在这里加。它在 recordGate 那一刻就已经是既成事实
      // （文件确实没了），不该依赖 verify 是否跑过 —— 由 summary() 直接计入。
      // 这里只留条数，方便核对。
      v.preCleaned = preCleanedTotals(target).count
      v.cleaned = v.cleanedTemps.length + v.cleanedBackups.length + prunedList.length
      v.remaining = v.remainingTemps.length + v.remainingBackups.length
      v.unknown = v.unknownTemps.length + v.unknownBackups.length
      target.verify = v
    }
    await this.save()
  }

  /**
   * 汇总。scope: 'all' | 'session'。
   * @param {string} scope
   * @param {string} [sid] scope==='session' 时必填
   */
  async summary(scope, sid) {
    await this.load()
    const all = scope === 'session' ? this.events.filter((e) => e.sid === String(sid)) : this.events

    let reportedTemps = 0
    let reportedBackups = 0
    let pruned = 0
    let cleaned = 0
    let remaining = 0
    let unknown = 0
    let verifiedEvents = 0
    let reportedBytes = 0
    let cleanedBytes = 0
    let remainingBytes = 0
    let preCleaned = 0
    let preCleanedBytes = 0
    let gateEvents = 0
    let autoRounds = 0
    const sessions = new Set()
    const bySession = new Map()

    // bySession 恒基于**未过滤**的全量事件构建：它既是分会话对比表的数据源，
    // 也是面板「按会话」下拉框的唯一数据源。以前用过滤后的 all 累加，
    // 结果 ?scope=session 时只剩一行 —— select 永远只有一个选项、对比表恒隐藏。
    const rowFor = (e) => {
      let row = bySession.get(e.sid)
      if (row === undefined) {
        row = {
          sid: e.sid,
          gates: 0,
          reported: 0,
          cleaned: 0,
          remaining: 0,
          lastAt: '',
          reportedBytes: 0,
          cleanedBytes: 0,
          preCleanedBytes: 0
        }
        bySession.set(e.sid, row)
      }
      return row
    }
    for (const e of this.events) {
      rowFor(e)
      sessions.add(e.sid)
    }

    for (const e of all) {
      const temps = relList(e.temps)
      const backups = relList(e.backups)
      if (e.kind === 'auto') autoRounds += 1
      else gateEvents += 1
      reportedTemps += temps.length
      reportedBackups += backups.length
      pruned += Array.isArray(e.pruned) ? e.pruned.length : 0
      const sizes = normalizeSizes(e.sizes)
      const eventReportedBytes =
        temps.reduce((a, rel) => a + sizeOf(sizes, rel), 0) + backups.reduce((a, rel) => a + sizeOf(sizes, rel), 0)
      reportedBytes += eventReportedBytes
      // v3：本轮写过、轮到检查时已经不在的文件 —— 不依赖 verify 是否跑过，
      // 因为文件在 recordGate 那一刻就已经没了，是既成事实。
      const pre = preCleanedTotals(e)
      preCleaned += pre.count
      preCleanedBytes += pre.bytes
      if (e.verify !== null && typeof e.verify === 'object') {
        verifiedEvents += 1
        cleaned += Number(e.verify.cleaned) || 0
        remaining += Number(e.verify.remaining) || 0
        unknown += Number(e.verify.unknown) || 0
        cleanedBytes += Number(e.verify.cleanedBytes) || 0
        remainingBytes += Number(e.verify.remainingBytes) || 0
      }
      const row = rowFor(e)
      // 只有真正拦下东西的轮才算「拦截」。kind='auto' 是「这一轮本来就没有清单」，
      // 把它算进拦截次数会让指标永远大于真实值，且面板「还没有拦截记录」的提示
      // 会因为 gates>0 而再也不出现。
      if (e.kind !== 'auto') row.gates += 1
      row.reported += temps.length + backups.length
      row.reportedBytes += eventReportedBytes
      row.preCleanedBytes += pre.bytes
      if (e.verify !== null && typeof e.verify === 'object') {
        row.cleaned += Number(e.verify.cleaned) || 0
        row.remaining += Number(e.verify.remaining) || 0
        row.cleanedBytes += Number(e.verify.cleanedBytes) || 0
      }
      if (e.at > row.lastAt) row.lastAt = e.at
    }

    const judged = cleaned + remaining
    // 「最近记录」应该是最近 20 **轮**，不是最近 20 条事件：auto 与 gate 会同时出现，
    // 单轮最多两条，按条截断实际只覆盖约 10 轮。按 (sid, turn) 归并后再取尾部。
    //
    // 同一轮里必须**优先留 gate**：followup 下 gate(N) 与 auto(N+1) 会落在同一个
    // turn 上（gate 的 verifyAtTurn = N+1）。旧实现倒序扫描、先到先得，后写入的
    // auto 把 gate 行顶掉，于是「最近记录」里一条真正拦过东西的行都看不到。
    const byTurn = new Map()
    for (let i = 0; i < all.length; i += 1) {
      const e = all[i]
      const key = `${e.sid}\u0000${e.turn}`
      const prev = byTurn.get(key)
      if (prev === undefined) {
        byTurn.set(key, { event: e, index: i })
        continue
      }
      // 只替换成 gate，不让 auto 覆盖 gate；同 kind 时保留更晚的那条（信息更新）。
      if (prev.event.kind === 'auto' && e.kind !== 'auto') prev.event = e
      prev.index = i
    }
    const rounds = [...byTurn.values()]
      .sort((a, b) => a.index - b.index)
      .slice(-20)
      .map((entry) => entry.event)
      .reverse()
    const recent = rounds.map((e) => {
      const pre = preCleanedTotals(e)
      return {
        at: e.at,
        sid: e.sid,
        kind: e.kind === 'auto' ? 'auto' : 'gate',
        turn: e.turn,
        verifyAtTurn: Number.isFinite(e.verifyAtTurn) ? e.verifyAtTurn : e.turn,
        steerMode: e.steerMode === 'steer' ? 'steer' : 'followup',
        temps: relList(e.temps).length,
        backups: relList(e.backups).length,
        pruned: Array.isArray(e.pruned) ? e.pruned.length : 0,
        preCleaned: pre.count,
        preCleanedBytes: pre.bytes,
        // 与 bySession 行、单轮记录保持同一口径：面板的 freedBytes(row) 读的是
        // row.cleanedBytes，缺了这个字段时 typeof 检查会把它当 0。
        cleanedBytes: Number(e.verify?.cleanedBytes) || 0,
        verify:
          e.verify === null || typeof e.verify !== 'object'
            ? null
            : {
                cleaned: Number(e.verify.cleaned) || 0,
                remaining: Number(e.verify.remaining) || 0,
                unknown: Number(e.verify.unknown) || 0,
                cleanedBytes: Number(e.verify.cleanedBytes) || 0,
                remainingBytes: Number(e.verify.remainingBytes) || 0
              }
      }
    })

    return {
      scope,
      sid: scope === 'session' ? String(sid) : '',
      // gates 只数**真正拦下东西**的轮。kind='auto' 是「这一轮本来就没有清单」，
      // 它不是拦截（旧实现用 all.length，指标恒大于真实值，面板的「还没有拦截
      // 记录」提示也因此永不出现）。auto 单独给一个计数，便于核对总量。
      gates: gateEvents,
      autoRounds,
      events: all.length,
      reportedTemps,
      reportedBackups,
      reported: reportedTemps + reportedBackups,
      pruned,
      verifiedEvents,
      unverifiedEvents: all.length - verifiedEvents,
      cleaned,
      remaining,
      unknown,
      // 体积（字节）。reportedBytes 是「报出去的清单有多大」，cleanedBytes 是
      // 「复核时确认已经不在了的那部分」——后者才是真正释放掉的磁盘空间。
      reportedBytes,
      cleanedBytes,
      remainingBytes,
      // v3：本轮写过、轮到检查时已不在的文件。它们没进清单（闸门没看见），
      // 但磁盘上确实少了这么多。面板的「已释放空间」= cleanedBytes + preCleanedBytes。
      preCleaned,
      preCleanedBytes,
      compliance: judged > 0 ? cleaned / judged : null,
      sessionCount: sessions.size,
      // 兼容旧字段名：它是**计数**不是数组，曾在契约里和 bySession 并列极易误用。
      sessions: sessions.size,
      bySession: [...bySession.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1)),
      recent
    }
  }

  /** 单个 turn 的记录，给 turnTail 徽章用。 */
  async turnRecord(sid, turn) {
    await this.load()
    const at = Number(turn)
    // 匹配 turn **或** verifyAtTurn：followup 模式下事件记在 turn N、复核在 N+1，
    // 徽章在第 N+1 轮挂载时查的是 N+1，只比对 e.turn 会永远返回 null（徽章整轮不渲染）。
    const hit = this.events.filter(
      (e) => e.sid === String(sid) && (e.turn === at || (Number.isFinite(e.verifyAtTurn) && e.verifyAtTurn === at))
    )
    if (hit.length === 0) return null
    // 拆成「本轮自己的事件」与「上一轮留下、本轮才复核的事件」。
    // 不拆的后果：followup 模式下 turn N 拦了 2 个临时件，turn N+1 干干净净什么
    // 都没写，徽章却挂着 temps:2 —— 用户会以为这一轮被拦了（默认 followup 下
    // 每条拦截后必现）。清单数字只认本轮自己的事件；复核结果两边都收，这样
    // turn N+1 的徽章能报「上一轮那批清了没」，但不冒充本轮拦下的东西。
    const own = hit.filter((e) => e.turn === at)
    const carried = hit.filter((e) => e.turn !== at)
    const ownGate = own.some((e) => e.kind !== 'auto')
    let temps = 0
    let backups = 0
    let pruned = 0
    let cleaned = 0
    let remaining = 0
    let unknown = 0
    let verified = false
    let verifyAtTurn = at
    let steerMode = 'followup'
    let cleanedBytes = 0
    let remainingBytes = 0
    let preCleaned = 0
    let preCleanedBytes = 0
    // kind 只由本轮自己的事件决定：上一轮的 auto 不该把本轮的 gate 改写成 auto
    // （旧实现 `if (e.kind === 'auto') kind = 'auto'` 在遍历里无条件覆盖）。
    let kind = ownGate ? 'gate' : own.length > 0 ? 'auto' : 'gate'
    for (const e of own) {
      temps += relList(e.temps).length
      backups += relList(e.backups).length
      pruned += Array.isArray(e.pruned) ? e.pruned.length : 0
      steerMode = e.steerMode === 'steer' ? 'steer' : 'followup'
      const pre = preCleanedTotals(e)
      preCleaned += pre.count
      preCleanedBytes += pre.bytes
    }
    for (const e of hit) {
      verifyAtTurn = Number.isFinite(e.verifyAtTurn) ? e.verifyAtTurn : e.turn
      if (e.verify !== null && typeof e.verify === 'object') {
        verified = true
        cleaned += Number(e.verify.cleaned) || 0
        remaining += Number(e.verify.remaining) || 0
        unknown += Number(e.verify.unknown) || 0
        cleanedBytes += Number(e.verify.cleanedBytes) || 0
        remainingBytes += Number(e.verify.remainingBytes) || 0
      }
    }
    return {
      sid: String(sid),
      turn: Number(turn),
      kind,
      // own=false 表示本轮没有任何自己的事件，画面上的数字全部来自上一轮的复核
      // 结果；客户端据此决定是否整轮不渲染（什么都没发生就别占一行）。
      own: ownGate,
      carried: carried.length > 0,
      verifyAtTurn,
      steerMode,
      temps,
      backups,
      pruned,
      cleaned,
      remaining,
      unknown,
      cleanedBytes,
      remainingBytes,
      preCleaned,
      preCleanedBytes,
      verified
    }
  }
}
