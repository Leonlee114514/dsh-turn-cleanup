window.__ModuleLoader__.load({
  id: 'dsh-turn-cleanup',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'turn-cleanup'
    const STATS_URL = '/turn-cleanup/stats'

    const DICT = {
      zh: {
        nav: '收尾清场',
        title: '收尾清场',
        subtitle: '每轮 turn 结束时拦住没清理的临时文件与超量备份。插件只拦不删——判定和执行都由模型完成。',
        scopeAll: '全局',
        scopePick: '按会话',
        scopeSession: '会话',
        cardGates: '拦截次数',
        cardGatesHint: 'turn 结束被拦下的次数',
        cardReported: '报告文件数',
        cardReportedHint: '被列进清单的临时件 + 超量备份',
        cardCleaned: '已清文件数',
        cardCleanedHint: '下一轮复核时确认已不存在的',
        cardCompliance: '依从率',
        cardComplianceHint: '已清 / (已清 + 仍在)',
        cardPruned: '插件代删',
        cardPrunedHint: 'prune 模式下插件亲手删掉的备份',
        cardFreed: '已释放空间',
        cardFreedHint: '复核确认已消失的临时件与备份总大小',
        colFreed: '释放',
        badgeFreed: '释放',
        noData: '还没有拦截记录。等一轮 turn 结束时留下临时文件，这里就会有数字。',
        noCompliance: '暂无复核数据',
        recent: '最近拦截',
        colAt: '时间',
        colTurn: '轮次',
        colTemps: '临时件',
        colBackups: '备份',
        colResult: '复核',
        resultCleaned: '已清',
        resultRemaining: '仍在',
        resultPending: '待复核',
        bySession: '按会话',
        colSession: '会话',
        colGates: '拦截',
        colReported: '报告',
        colCleanedS: '已清',
        colRemaining: '仍在',
        refresh: '刷新',
        loading: '读取中…',
        failed: '读取统计失败',
        badgeTemps: '临时件',
        badgeBackups: '备份',
        badgeCleaned: '已清',
        badgeRemaining: '仍在',
        badgePruned: '代删',
        badgePending: '待复核',
        unit: '个'
      },
      en: {
        nav: 'Turn cleanup',
        title: 'Turn cleanup',
        subtitle:
          'Blocks the end of a turn while temp files and excess backups from that turn are still there. The plugin only blocks — deciding and deleting stay with the model.',
        scopeAll: 'All',
        scopePick: 'Per session',
        scopeSession: 'Session',
        cardGates: 'Gates tripped',
        cardGatesHint: 'turns whose end was blocked',
        cardReported: 'Files reported',
        cardReportedHint: 'temp files + excess backups listed to the model',
        cardCleaned: 'Files cleaned',
        cardCleanedHint: 'confirmed gone on the next-turn check',
        cardCompliance: 'Compliance',
        cardComplianceHint: 'cleaned / (cleaned + still there)',
        cardPruned: 'Pruned by plugin',
        cardPrunedHint: 'backups the plugin deleted itself in prune mode',
        cardFreed: 'Space freed',
        cardFreedHint: 'size of temp files and backups confirmed gone on the check',
        colFreed: 'Freed',
        badgeFreed: 'freed',
        noData: 'No gates tripped yet. Leave a temp file behind at the end of a turn and numbers show up here.',
        noCompliance: 'nothing verified yet',
        recent: 'Recent gates',
        colAt: 'Time',
        colTurn: 'Turn',
        colTemps: 'Temps',
        colBackups: 'Backups',
        colResult: 'Check',
        resultCleaned: 'cleaned',
        resultRemaining: 'remaining',
        resultPending: 'pending',
        bySession: 'By session',
        colSession: 'Session',
        colGates: 'Gates',
        colReported: 'Reported',
        colCleanedS: 'Cleaned',
        colRemaining: 'Remaining',
        refresh: 'Refresh',
        loading: 'Loading…',
        failed: 'Failed to read stats',
        badgeTemps: 'temps',
        badgeBackups: 'backups',
        badgeCleaned: 'cleaned',
        badgeRemaining: 'remaining',
        badgePruned: 'pruned',
        badgePending: 'pending',
        unit: ''
      }
    }

    // 只用 rgba(127,127,127,·) 灰阶 + 一个强调色，亮/暗主题都自动成立，
    // 不读 host 的 CSS 变量也不覆盖别人的样式。
    const MUTED = 'rgba(127,127,127,0.75)'
    const LINE = '1px solid rgba(127,127,127,0.22)'
    const CARD = {
      border: LINE,
      borderRadius: 10,
      padding: '14px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      minWidth: 0
    }
    const LABEL = { fontSize: 12, color: MUTED, margin: 0 }
    const BIG = { fontSize: 26, fontWeight: 600, lineHeight: '32px', margin: 0, fontVariantNumeric: 'tabular-nums' }
    const HINT = { fontSize: 11, color: MUTED, margin: 0, lineHeight: '16px' }
    const BTN = {
      cursor: 'pointer',
      borderRadius: 8,
      border: '1px solid rgba(127,127,127,0.4)',
      background: 'transparent',
      color: 'inherit',
      fontFamily: 'inherit',
      fontSize: 13,
      lineHeight: '20px',
      padding: '5px 12px',
      whiteSpace: 'nowrap'
    }
    const BTN_ON = { ...BTN, border: '1px solid rgba(127,127,127,0.7)', background: 'rgba(127,127,127,0.12)', fontWeight: 600 }
    const TH = { textAlign: 'left', fontSize: 11, color: MUTED, fontWeight: 500, padding: '6px 8px', borderBottom: LINE }
    const TD = { fontSize: 12, padding: '6px 8px', borderBottom: '1px solid rgba(127,127,127,0.1)', fontVariantNumeric: 'tabular-nums' }

    function fmt(n) {
      return typeof n === 'number' && Number.isFinite(n) ? String(n) : '0'
    }

    const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

    /**
     * 字节数 → 人读的大小。
     *
     * 保留 3 位有效数字：`512 B` / `4.25 KB` / `73.4 KB` / `1.21 MB`。
     * 逐级进位，最大到 TB（再大也不会有人在这种清单上看到）。0 与非法值一律
     * 显示 `0 B`——面板宁可说「没释放」也不要显示 `NaN` 或空白。
     */
    function fmtBytes(n) {
      if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '0 B'
      let value = n
      let unit = 0
      while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
        value /= 1024
        unit += 1
      }
      const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2
      return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`
    }

    function pct(x) {
      if (typeof x !== 'number' || !Number.isFinite(x)) return null
      return `${Math.round(x * 100)}%`
    }

    function shortTime(iso) {
      if (typeof iso !== 'string' || iso.length < 16) return iso ?? ''
      return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`
    }

    function shortId(sid) {
      if (typeof sid !== 'string') return ''
      const body = sid.startsWith('session-') ? sid.slice(8) : sid
      return body.length > 8 ? body.slice(0, 8) : body
    }

    async function readStats(query) {
      const res = await fetch(`${STATS_URL}${query ?? ''}`, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    }

    function Card(props) {
      return h(
        'div',
        { style: CARD },
        h('p', { style: LABEL }, props.label),
        h('p', { style: BIG }, props.value),
        props.hint ? h('p', { style: HINT }, props.hint) : null
      )
    }

    function StatGrid(props) {
      const s = props.stats
      const compliance = pct(s.compliance)
      return h(
        'div',
        { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(180px,100%),1fr))', gap: 12 } },
        h(Card, { label: props.t('cardFreed'), value: fmtBytes(s.cleanedBytes), hint: props.t('cardFreedHint') }),
        h(Card, { label: props.t('cardGates'), value: fmt(s.gates), hint: props.t('cardGatesHint') }),
        h(Card, { label: props.t('cardReported'), value: fmt(s.reported), hint: props.t('cardReportedHint') }),
        h(Card, {
          label: props.t('cardCleaned'),
          value: fmt(s.cleaned),
          hint: s.pruned > 0 ? `${props.t('cardPrunedHint')}: ${s.pruned}` : props.t('cardCleanedHint')
        }),
        h(Card, {
          label: props.t('cardCompliance'),
          value: compliance === null ? '—' : compliance,
          hint: compliance === null ? props.t('noCompliance') : props.t('cardComplianceHint')
        })
      )
    }

    function RecentTable(props) {
      const rows = props.stats.recent ?? []
      if (rows.length === 0) return null
      const t = props.t
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('p', { style: { ...LABEL, fontSize: 13, fontWeight: 600, color: 'inherit' } }, t('recent')),
        h(
          'table',
          { style: { width: '100%', borderCollapse: 'collapse' } },
          h('thead', null, h('tr', null,
            h('th', { style: TH }, t('colAt')),
            h('th', { style: TH }, t('colTurn')),
            h('th', { style: TH }, t('colSession')),
            h('th', { style: TH }, t('colTemps')),
            h('th', { style: TH }, t('colBackups')),
            h('th', { style: TH }, t('colResult'))
          )),
          h('tbody', null, rows.map((r, i) =>
            h('tr', { key: `${r.at}-${i}` },
              h('td', { style: TD }, shortTime(r.at)),
              h('td', { style: TD }, fmt(r.turn)),
              h('td', { style: TD, title: r.sid }, shortId(r.sid)),
              h('td', { style: TD }, fmt(r.temps)),
              h('td', { style: TD }, fmt(r.backups)),
              h('td', { style: TD, color: MUTED },
                r.verify === null
                  ? t('resultPending')
                  : `${t('resultCleaned')} ${r.verify.cleaned} / ${t('resultRemaining')} ${r.verify.remaining}` +
                    (r.verify.cleanedBytes > 0 ? ` · ${fmtBytes(r.verify.cleanedBytes)}` : ''))
            )
          ))
        )
      )
    }

    function SessionTable(props) {
      const rows = props.stats.bySession ?? []
      if (rows.length <= 1) return null
      const t = props.t
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('p', { style: { ...LABEL, fontSize: 13, fontWeight: 600, color: 'inherit' } }, t('bySession')),
        h(
          'table',
          { style: { width: '100%', borderCollapse: 'collapse' } },
          h('thead', null, h('tr', null,
            h('th', { style: TH }, t('colSession')),
            h('th', { style: TH }, t('colGates')),
            h('th', { style: TH }, t('colReported')),
            h('th', { style: TH }, t('colCleanedS')),
            h('th', { style: TH }, t('colRemaining')),
            h('th', { style: TH }, t('colFreed'))
          )),
          h('tbody', null, rows.map((r) =>
            h('tr', { key: r.sid },
              h('td', { style: TD, title: r.sid }, shortId(r.sid)),
              h('td', { style: TD }, fmt(r.gates)),
              h('td', { style: TD }, fmt(r.reported)),
              h('td', { style: TD }, fmt(r.cleaned)),
              h('td', { style: TD }, fmt(r.remaining)),
              h('td', { style: TD }, fmtBytes(r.cleanedBytes))
            )
          ))
        )
      )
    }

    /** 设置页整页面板。 */
    function CleanupPanel(props) {
      const t = props.t
      const [scope, setScope] = React.useState('all')
      const [picked, setPicked] = React.useState('')
      const [state, setState] = React.useState({ status: 'loading', stats: null, error: '' })
      const [tick, setTick] = React.useState(0)

      React.useEffect(() => {
        let alive = true
        const query =
          scope === 'session' && picked.length > 0
            ? `?scope=session&sid=${encodeURIComponent(picked)}`
            : ''
        setState((prev) => ({ ...prev, status: 'loading' }))
        readStats(query)
          .then((stats) => {
            if (alive) setState({ status: 'ready', stats, error: '' })
          })
          .catch((error) => {
            if (alive) setState({ status: 'error', stats: null, error: String(error?.message ?? error) })
          })
        return () => {
          alive = false
        }
      }, [scope, picked, tick])

      const stats = state.stats
      const sessions = (stats?.bySession ?? []).map((r) => r.sid)

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 2px' } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h('h3', { style: { margin: 0, fontSize: 16, fontWeight: 600 } }, t('title')),
          h('p', { style: { ...HINT, fontSize: 12, lineHeight: '18px' } }, t('subtitle'))
        ),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            style: scope === 'all' ? BTN_ON : BTN,
            onClick: () => setScope('all')
          }, t('scopeAll')),
          h('button', {
            type: 'button',
            style: scope === 'session' ? BTN_ON : BTN,
            onClick: () => {
              setScope('session')
              if (picked.length === 0 && sessions.length > 0) setPicked(sessions[0])
            }
          }, t('scopePick')),
          scope === 'session' && sessions.length > 0
            ? h('select', {
                value: picked,
                onChange: (e) => setPicked(e.target.value),
                style: { ...BTN, padding: '5px 8px', fontFamily: 'inherit' }
              }, sessions.map((sid) => h('option', { key: sid, value: sid }, shortId(sid))))
            : null,
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', style: BTN, onClick: () => setTick((n) => n + 1) }, t('refresh'))
        ),
        state.status === 'error'
          ? h('p', { style: { ...HINT, color: '#d9534f' } }, `${t('failed')}: ${state.error}`)
          : null,
        stats !== null && stats.gates === 0
          ? h('p', { style: { ...HINT, fontSize: 12 } }, t('noData'))
          : null,
        stats !== null
          ? h(StatGrid, { stats, t })
          : state.status === 'loading'
            ? h('p', { style: HINT }, t('loading'))
            : null,
        stats !== null ? h(RecentTable, { stats, t }) : null,
        stats !== null ? h(SessionTable, { stats, t }) : null
      )
    }

    /** 每个 turn 末尾的一行徽章：这一轮拦了什么、清没清。 */
    function TurnBadge(props) {
      const t = props.t
      const turnNo = typeof props.turn === 'number' ? props.turn : props.turn?.turn
      const sid = typeof props.sessionId === 'string' ? props.sessionId : ''
      const [record, setRecord] = React.useState(null)

      React.useEffect(() => {
        if (!Number.isFinite(turnNo) || sid.length === 0) return undefined
        let alive = true
        readStats(`?sid=${encodeURIComponent(sid)}&turn=${encodeURIComponent(String(turnNo))}`)
          .then((r) => {
            if (alive) setRecord(r !== null && typeof r === 'object' ? r : null)
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [sid, turnNo])

      if (record === null) return null
      const parts = []
      if (record.temps > 0) parts.push(`${record.temps} ${t('badgeTemps')}`)
      if (record.backups > 0) parts.push(`${record.backups} ${t('badgeBackups')}`)
      if (record.pruned > 0) parts.push(`${t('badgePruned')} ${record.pruned}`)
      if (record.verified) {
        if (record.cleaned > 0) parts.push(`${t('badgeCleaned')} ${record.cleaned}`)
        if (record.remaining > 0) parts.push(`${t('badgeRemaining')} ${record.remaining}`)
        if (record.cleanedBytes > 0) parts.push(`${t('badgeFreed')} ${fmtBytes(record.cleanedBytes)}`)
      } else {
        parts.push(t('badgePending'))
      }
      if (parts.length === 0) return null

      return h(
        'div',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            lineHeight: '16px',
            color: MUTED,
            border: LINE,
            borderRadius: 999,
            padding: '2px 10px',
            whiteSpace: 'nowrap'
          },
          title: `${t('title')} · turn ${turnNo}`
        },
        h('span', null, parts.join(' · '))
      )
    }

    return {
      inject: ['slots', 'locale'],
      // 给 contract 测试用的纯函数。宿主只读 inject / apply，多一个键没有副作用；
      // 放在这里是因为 bundle 没有别的出口，而字节格式化最容易写出 0/NaN 边界错误。
      fmtBytes,
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, DICT))

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'turn-cleanup', order: 32, label: () => t('nav'), locale: NS },
            CleanupPanel
          )
        )

        ctx.slots.inject('conversation.chat.turnTail', () =>
          ctx.slots.register(
            {
              name: 'conversation.chat.turnTail',
              id: 'turn-cleanup-turn',
              order: 12,
              locale: NS
              // 不要再 inject 一个 `t`：renderer 的 standardKit 已经按 entry.locale
              // 提供了 locale 绑定的 `t`（localeSeat(face, entry.locale)），而
              // assertNoPropOverlap 会把重名 prop 当成装配错误抛出来。
            },
            TurnBadge
          )
        )
      }
    }
  }
})
