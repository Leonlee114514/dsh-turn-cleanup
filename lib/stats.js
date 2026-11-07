import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { join, dirname, isAbsolute } from 'node:path'
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
 * 不在了 = 已清。依从率 = 已清 / (已清 + 未清)。
 *
 * 「之后」是哪一刻，取决于交付方式（见 index.js 的 steerMode）：
 *   steer    —— 同轮多跑一步，那个 turn/end 就是动手之后，verifyAtTurn = turn。
 *   followup —— 清单排进 next-turn，本轮照常结束、下一轮才动手，
 *               所以 verifyAtTurn = turn + 1；在 turn/end 时按 turn 复核会读到
 *               「全都还在」的假数字，依从率会被压成 0。
 */

const VERSION = 1
const MAX_EVENTS = 1000

/** 账本文件：与文本日志同目录，没有配置 logFile 时退回 $DSH_HOME/logs。 */
export function defaultStatsFile(logFile) {
  if (typeof logFile === 'string' && logFile.length > 0) {
    return join(dirname(logFile), 'turn-cleanup-stats.json')
  }
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'logs', 'turn-cleanup-stats.json')
}

async function present(abs) {
  try {
    const info = await stat(abs)
    return info.isFile() || info.isDirectory()
  } catch {
    return false
  }
}

function emptyVerify() {
  return {
    at: '',
    cleanedTemps: [],
    remainingTemps: [],
    cleanedBackups: [],
    remainingBackups: [],
    cleaned: 0,
    remaining: 0
  }
}

export class StatsStore {
  constructor(file, logger) {
    this.file = file
    this.logger = logger
    this.events = []
    this.loaded = false
    this.chain = Promise.resolve()
  }

  /** 只读一次；文件不存在、损坏、版本不认识都当空账本，绝不影响闸门。 */
  async load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const text = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.events)) {
        this.events = parsed.events.filter((e) => e !== null && typeof e === 'object')
        if (this.events.length > MAX_EVENTS) {
          this.events = this.events.slice(this.events.length - MAX_EVENTS)
        }
      }
    } catch {}
  }

  /** 整份重写，串行化；失败静默（统计不该拖累闸门）。 */
  save() {
    this.chain = this.chain
      .then(async () => {
        try {
          await mkdir(dirname(this.file), { recursive: true })
          await writeFile(
            this.file,
            JSON.stringify({ version: VERSION, events: this.events }),
            'utf8'
          )
        } catch {}
      })
      .catch(() => {})
    return this.chain
  }

  /**
   * 记一次拦截。pruned 只有 prune 模式才有（插件自己删掉的那些）。
   * @param input.verifyAtTurn - 哪一轮的 turn/end 才算「模型已经动过手」。缺省 = 本轮
   *   （steer 模式）；followup 模式由调用方传 turn + 1。
   * @returns 落账后的事件对象（引用，调用方可继续用）。
   */
  async recordGate(input) {
    await this.load()
    const turn = Number(input.turn)
    const verifyAtTurn = Number.isFinite(input.verifyAtTurn) ? Number(input.verifyAtTurn) : turn
    const event = {
      at: new Date().toISOString(),
      sid: String(input.sid),
      turn,
      verifyAtTurn,
      cwd: String(input.cwd),
      temps: Array.isArray(input.temps) ? input.temps.slice() : [],
      backups: Array.isArray(input.backups) ? input.backups.slice() : [],
      keep: Number(input.keep) || 0,
      mode: input.mode === 'prune' ? 'prune' : 'steer',
      steerMode: input.steerMode === 'steer' ? 'steer' : 'followup',
      pruned: Array.isArray(input.pruned) ? input.pruned.slice() : [],
      verify: null
    }
    this.events.push(event)
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS)
    }
    await this.save()
    return event
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
    const targets = this.events.filter(
      (e) => e.sid === String(sid) && (Number.isFinite(e.verifyAtTurn) ? e.verifyAtTurn : e.turn) === at && e.verify === null
    )
    if (targets.length === 0) return

    let changed = false
    for (const event of targets) {
      const v = emptyVerify()
      v.at = new Date().toISOString()
      for (const rel of event.temps) {
        ;(await present(join(event.cwd, rel))) ? v.remainingTemps.push(rel) : v.cleanedTemps.push(rel)
      }
      for (const rel of event.backups) {
        ;(await present(join(event.cwd, rel)))
          ? v.remainingBackups.push(rel)
          : v.cleanedBackups.push(rel)
      }
      // prune 模式删掉的备份，插件亲手删的，一律计入「已清」。
      const prunedCount = Array.isArray(event.pruned) ? event.pruned.length : 0
      v.cleaned = v.cleanedTemps.length + v.cleanedBackups.length + prunedCount
      v.remaining = v.remainingTemps.length + v.remainingBackups.length
      event.verify = v
      changed = true
    }
    if (changed) await this.save()
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
    let verifiedEvents = 0
    const sessions = new Set()
    const bySession = new Map()

    for (const e of all) {
      sessions.add(e.sid)
      reportedTemps += e.temps.length
      reportedBackups += e.backups.length
      pruned += Array.isArray(e.pruned) ? e.pruned.length : 0
      if (e.verify !== null && typeof e.verify === 'object') {
        verifiedEvents += 1
        cleaned += Number(e.verify.cleaned) || 0
        remaining += Number(e.verify.remaining) || 0
      }
      let row = bySession.get(e.sid)
      if (row === undefined) {
        row = { sid: e.sid, gates: 0, reported: 0, cleaned: 0, remaining: 0, lastAt: '' }
        bySession.set(e.sid, row)
      }
      row.gates += 1
      row.reported += e.temps.length + e.backups.length
      if (e.verify !== null && typeof e.verify === 'object') {
        row.cleaned += Number(e.verify.cleaned) || 0
        row.remaining += Number(e.verify.remaining) || 0
      }
      if (e.at > row.lastAt) row.lastAt = e.at
    }

    const judged = cleaned + remaining
    const recent = all
      .slice(-20)
      .reverse()
      .map((e) => ({
        at: e.at,
        sid: e.sid,
        turn: e.turn,
        verifyAtTurn: Number.isFinite(e.verifyAtTurn) ? e.verifyAtTurn : e.turn,
        steerMode: e.steerMode === 'steer' ? 'steer' : 'followup',
        temps: e.temps.length,
        backups: e.backups.length,
        pruned: Array.isArray(e.pruned) ? e.pruned.length : 0,
        verify:
          e.verify === null || typeof e.verify !== 'object'
            ? null
            : { cleaned: e.verify.cleaned, remaining: e.verify.remaining }
      }))

    return {
      scope,
      sid: scope === 'session' ? String(sid) : '',
      gates: all.length,
      reportedTemps,
      reportedBackups,
      reported: reportedTemps + reportedBackups,
      pruned,
      verifiedEvents,
      unverifiedEvents: all.length - verifiedEvents,
      cleaned,
      remaining,
      compliance: judged > 0 ? cleaned / judged : null,
      sessions: sessions.size,
      bySession: [...bySession.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1)),
      recent
    }
  }

  /** 单个 turn 的记录，给 turnTail 徽章用。 */
  async turnRecord(sid, turn) {
    await this.load()
    const hit = this.events.filter((e) => e.sid === String(sid) && e.turn === Number(turn))
    if (hit.length === 0) return null
    let temps = 0
    let backups = 0
    let pruned = 0
    let cleaned = 0
    let remaining = 0
    let verified = false
    let verifyAtTurn = Number(turn)
    let steerMode = 'followup'
    for (const e of hit) {
      temps += e.temps.length
      backups += e.backups.length
      pruned += Array.isArray(e.pruned) ? e.pruned.length : 0
      verifyAtTurn = Number.isFinite(e.verifyAtTurn) ? e.verifyAtTurn : e.turn
      steerMode = e.steerMode === 'steer' ? 'steer' : 'followup'
      if (e.verify !== null && typeof e.verify === 'object') {
        verified = true
        cleaned += Number(e.verify.cleaned) || 0
        remaining += Number(e.verify.remaining) || 0
      }
    }
    return { sid: String(sid), turn: Number(turn), verifyAtTurn, steerMode, temps, backups, pruned, cleaned, remaining, verified }
  }
}
