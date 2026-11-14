/**
 * 闸门文案（zh / en）。
 *
 * 为什么文案要单独成文件并可配：这段文字是**直接注入模型回合**的指令，不是 UI 装饰。
 * v0.3.x 之前把它硬编码成中文，非中文用户装上插件后，每一轮都会在对话里多出一条
 * 中文命令 —— 这属于把作者本机的语言环境当成了普遍默认。
 *
 * 为什么不用宿主语言服务：`dsh-client-locale` 只在 settings 里存一个 `preference`
 * 字段给前端选语言，宿主侧没有任何「当前语言」API 可以在 turn-stopping 里廉价读到
 * （读它要么依赖一个可能不存在的服务，要么得等 settings 初始化）。所以这里用一条
 * 显式的回退链：配置 → 环境变量 → Intl → 'en'，全程无依赖、无 I/O。
 */

/** 目前提供的语言。未列出的语言一律退到 en（与宿主 client-locale 的兜底一致）。 */
const LOCALES = ['zh', 'en']

/**
 * 把 `zh-CN` / `zh_CN.UTF-8` / `en_US:zh` 之类的标签归一到支持的语言码。
 * 只取第一段主语言；认不出就返回 undefined，交给下一个回退项。
 */
function pick(tag) {
  if (typeof tag !== 'string') return undefined
  const head = tag.trim().split(/[-_.:]/)[0].toLowerCase()
  if (head.length === 0) return undefined
  return LOCALES.includes(head) ? head : undefined
}

/**
 * 解析 `messageLocale`：
 *   1. 配置里显式写了 `zh` / `en` → 用它（其它值一律当 `auto`）
 *   2. 常见 locale 环境变量（显式设定比任何猜测都更可信）
 *   3. `Intl.DateTimeFormat().resolvedOptions().locale`（读操作系统的区域设置）
 *   4. `'en'`
 */
export function resolveMessageLocale(raw) {
  if (raw === 'zh' || raw === 'en') return raw

  for (const key of ['DSH_LOCALE', 'LC_ALL', 'LC_MESSAGES', 'LANGUAGE', 'LANG']) {
    const hit = pick(process.env[key])
    if (hit !== undefined) return hit
  }

  try {
    const hit = pick(Intl.DateTimeFormat().resolvedOptions().locale)
    if (hit !== undefined) return hit
  } catch {}

  return 'en'
}

const DICT = {
  zh: {
    tempTitle: '收尾前清场：这些是本轮你留下的临时文件——',
    tempFooter: '删掉它们；要留的逐条说明理由并挪到明确位置。交付物、用户文件、受保护目录不要动。',
    more: (n) => `- …还有 ${n} 个`,
    backupTitle: (keep) => `备份超量：同一原件的 .bak 只保留最近 ${keep} 份，这些是多余的——`,
    backupFooter: (keep) =>
      `删掉它们；要留的先挪到明确位置并说明理由。不要动原件本身，也不要动最近 ${keep} 份。`,
    summaryTemps: (n) => `清理 ${n} 个临时文件`,
    summaryBackups: (n) => `${n} 份超量备份`,
    summaryBoth: (a, b) => `清理 ${a} 个临时文件、${b} 份超量备份`,
    // 只在 report_temp_cleanup 工具真的注册成功时才追加。删完调一次，面板才统计得到
    // 省下的空间 —— 否则那些用 bash rm 删掉的临时件，插件事后 stat 不到体积。
    reportHint:
      '删完顺手调一次 report_temp_cleanup，把删掉的路径和字节数报上来（不确定就省略字节）；' +
      '面板的「已释放空间」靠它记账。'
  },
  en: {
    tempTitle: 'Clean up before you finish: these temporary files were produced in this turn —',
    tempFooter:
      'Delete them. If one must stay, say why for each and move it somewhere deliberate. ' +
      'Do not touch deliverables, user files, or protected directories.',
    more: (n) => `- …and ${n} more`,
    backupTitle: (keep) => `Too many backups: keep only the newest ${keep} .bak files per original —`,
    backupFooter: (keep) =>
      `Delete them. If one must stay, move it somewhere deliberate and say why. ` +
      `Do not touch the original, and do not touch the newest ${keep}.`,
    summaryTemps: (n) => `${n} temp file(s) to clean`,
    summaryBackups: (n) => `${n} excess backup(s)`,
    summaryBoth: (a, b) => `${a} temp file(s) and ${b} excess backup(s) to clean`,
    // Only appended when report_temp_cleanup actually registered. Reporting once after
    // deleting is what lets the panel total the freed space — files removed through a
    // shell `rm` never expose their size to the gate afterwards.
    reportHint:
      'After deleting, call report_temp_cleanup once with the paths and byte sizes ' +
      '(omit sizes you do not know); the panel totals freed space from it.'
  }
}

export function messagesFor(locale) {
  return DICT[locale] ?? DICT.en
}

/**
 * 组装 message 的 `source.summary`（宿主 UI 用它做一行摘要，超长会被截断）。
 * 保持简短：宿主 `boundContextSummary` 的上限是 120 字符。
 */
export function summaryFor(locale, temps, backups) {
  const t = messagesFor(locale)
  if (temps > 0 && backups > 0) return t.summaryBoth(temps, backups)
  if (temps > 0) return t.summaryTemps(temps)
  return t.summaryBackups(backups)
}
