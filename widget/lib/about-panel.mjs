/**
 * 「关于 / 自检」面板数据组装（组件化迁移 #11）。
 *
 * 从 widget/lib/index.js 里原样搬出：字段白名单、路径脱敏、客户端判定都在这里，
 * 宿主侧只保留路由注册。所有输入（候选路径表、账本读取、Codex 状态）显式注入。
 */
import fs from 'node:fs'
import path from 'node:path'

export function createAboutPanel(deps) {
  const {
    BUILD_VERSION, BUILD_CHANNEL, VERSION_LABEL, PACKAGE_ROOT, DSH_HOME, hostFile,
    WIDGET_FILE_CANDIDATES, USAGE_FILE_CANDIDATES, API_FILE_CANDIDATES,
    BUBBLE_FILE_CANDIDATES, SIZE_FILE_CANDIDATES, TURN_FILE_CANDIDATES,
    firstExisting, fileFacts, maskPath,
    readUsageLedger, todayKey, daySummary, accountingDays,
    codexStatsOn, codexDisabledReason, getCodexSnap, getCodexSnapAt,
    getBubbleConfigIgnored, getBalanceLast,
  } = deps || {}

  const required = {
    BUILD_VERSION, BUILD_CHANNEL, VERSION_LABEL, PACKAGE_ROOT, DSH_HOME, hostFile,
    WIDGET_FILE_CANDIDATES, USAGE_FILE_CANDIDATES, API_FILE_CANDIDATES,
    BUBBLE_FILE_CANDIDATES, SIZE_FILE_CANDIDATES, TURN_FILE_CANDIDATES,
    firstExisting, fileFacts, maskPath,
    readUsageLedger, todayKey, daySummary, accountingDays,
    codexStatsOn, codexDisabledReason, getCodexSnap, getCodexSnapAt,
    getBubbleConfigIgnored, getBalanceLast,
  }
  for (const [name, value] of Object.entries(required)) {
    if (value === undefined || value === null) throw new TypeError(`about-panel 缺少依赖：${name}`)
  }

  // v796：DSH 版本**真的去读**，而不是只看环境变量（用户反馈"DSH 版本读取不到 (?)"）。
  //   顺序：① 环境变量（部分启动方式会带）② 从 argv/execPath 往上找 `@deepseek-ai/dsh` 的 package.json
  //   （npx 启动时 argv 就在 `_npx/<hash>/node_modules/@deepseek-ai/dsh/...` 里）③ 读不到就老实回 'unknown'。
  //   全程 try/catch + 缓存（每个目录最多往上 8 层），绝不抛错。
  let dshVersionCache = null
  function dshVersionOf() {
    if (dshVersionCache !== null) return dshVersionCache
    let v = ''
    try { v = String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || '') } catch (err) {}
    if (!v) {
      try {
        const roots = [process.argv[1], process.argv[0], process.execPath]
        for (const r of roots) {
          if (!r) continue
          let dir = path.dirname(String(r))
          for (let up = 0; up < 8; up++) {
            try {
              const pj = path.join(dir, 'package.json')
              if (fs.existsSync(pj)) {
                const j = JSON.parse(fs.readFileSync(pj, 'utf8'))
                const nm = String((j && j.name) || '')
                if (nm === '@deepseek-ai/dsh' || nm === 'dsh' || nm === 'dsh-cli') {
                  v = String((j && j.version) || '')
                  if (v) break
                }
              }
            } catch (err) {}
            const parent = path.dirname(dir)
            if (parent === dir) break
            dir = parent
          }
          if (v) break
        }
      } catch (err) {}
    }
    dshVersionCache = v || 'unknown'
    return dshVersionCache
  }

  // v795（用户反馈）：客户端类型**看请求头的 UA**。前端用 `navigator.windowControlsOverlay` 判会误判 ——
  //   Chrome 桌面浏览器也有这个 API，于是 `npx @deepseek-ai/dsh web` 起来也被认成"官方桌面客户端"。
  //   官方桌面客户端是 Electron ⇒ UA 里必有 `Electron/`。判定只回 kind（不回完整 UA，避免带出多余指纹）。
  function clientKindOf(req) {
    try {
      const ua = String((req && req.headers && (req.headers['user-agent'] || req.headers['User-Agent'])) || '')
      const electron = /electron/i.test(ua)
      return { kind: electron ? 'desktop' : 'web', via: electron ? 'ua-electron' : 'ua-browser' }
    } catch (err) { return { kind: 'unknown', via: 'error' } }
  }

  // ===== v793（用户要求）：点版号 → 「关于 / 自检」面板 =====
  // 数据来源全部是宿主已有状态；路径一律脱敏；**点开才请求，不轮询**。
  function aboutPayload(req) {
    const client = clientKindOf(req)
    const widgetFile = (() => {
      for (const p of WIDGET_FILE_CANDIDATES) { try { if (fs.existsSync(p)) return p } catch (err) {} }
      return ''
    })()
    const ignored = getBubbleConfigIgnored()
    const balanceLast = getBalanceLast()
    const codexSnap = getCodexSnap()
    const codexSnapAt = getCodexSnapAt()
    const dataFiles = [
      ['账本（记账）', USAGE_FILE_CANDIDATES],
      ['模型注册表', API_FILE_CANDIDATES],
      ['泡泡配置', BUBBLE_FILE_CANDIDATES, ignored ? ('被忽略：' + ignored.reason) : ''],
      ['外观/设置', SIZE_FILE_CANDIDATES],
      ['轮次序号', TURN_FILE_CANDIDATES],
      ['Codex 缓存', [path.join(DSH_HOME, '.dshw-codex.json')]],
    ].map(([label, list, note]) => {
      const p = firstExisting(list)
      const f = p ? fileFacts(p) : null
      return {
        label: label,
        found: !!p,
        path: p ? maskPath(p) : '',
        candidates: (list || []).length,
        bytes: f ? f.bytes : null,
        mtime: f ? f.mtime : null,
        note: note || '',
      }
    })
    // 记账概览（只给统计，不给明细）
    let ledger = null
    try {
      const led = readUsageLedger()
      const today = todayKey()
      const sum = daySummary(led, today)
      let days = 0
      try { days = accountingDays(led).length } catch (err) { days = Object.keys(led.history || {}).length }
      ledger = {
        days: days,
        todayPartial: !!(sum && sum.partialDay),
        todaySource: (sum && sum.source) || '',
        lastObservedAt: (sum && sum.lastObservedAt) || null,
        needsReview: !!(sum && sum.needsReview),
      }
    } catch (err) { ledger = { error: String((err && err.message) || err).slice(0, 120) } }
    // Codex（v792 起：没配就完全禁用）
    let codex = { enabled: false, reason: '' }
    try {
      codex = {
        enabled: codexStatsOn(),
        reason: codexStatsOn() ? '' : codexDisabledReason(),
        snapAt: codexSnapAt || null,
        ok: !!(codexSnap && codexSnap.ok),
        files: (codexSnap && codexSnap.sessions) != null ? codexSnap.sessions : null,
        skipped: (codexSnap && codexSnap.skipped) != null ? codexSnap.skipped : null,
        deferred: (codexSnap && codexSnap.deferred) != null ? codexSnap.deferred : null,
      }
    } catch (err) {}
    return {
      ok: true,
      plugin: {
        name: 'dsh-dfy',
        version: BUILD_VERSION,
        channel: BUILD_CHANNEL,
        label: VERSION_LABEL,
        // 「版本自洽」的对照值：**实时**读一次 package.json。
        // BUILD_VERSION 是进程启动时读的；改了 package.json 却没重启 ⇒ 两者不同，
        // 自检会显示"不一致（重启后生效）"，这正是用户最容易踩的坑。
        packageVersion: (() => {
          try { return String(JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, '..', 'package.json'), 'utf8')).version || '') } catch (err) { return '' }
        })(),
      },
      build: {
        // v796：`found` 必须给（v795 前端简化后靠它判断"未找到"，缺了就会把宿主/前端文件误显示成"未找到"）
        host: { found: !!hostFile, path: maskPath(hostFile), bytes: fileFacts(hostFile) ? fileFacts(hostFile).bytes : null, mtime: fileFacts(hostFile) ? fileFacts(hostFile).mtime : null },
        widget: { found: !!widgetFile, path: maskPath(widgetFile), bytes: fileFacts(widgetFile) ? fileFacts(widgetFile).bytes : null, mtime: fileFacts(widgetFile) ? fileFacts(widgetFile).mtime : null },
        // v819（自检发现）：这里原来写的是 `indexOf('<开发机目录名>')` —— 检测"开发版路径"的代码自己带了
        //   那个字面量 ⇒ 发布包被 `tools/ci-audit.mjs` 判为"含开发机路径"（自己成了自己要检测的东西）。
        //   改成**结构性判定**：宿主源码里有没有写死的绝对盘符路径（'D:/…' / "C:\\…"）。
        //   开发版有 15+ 处（assets 兜底路径），strip 后的发布副本 0 处 ⇒ 判定更准，也不再出现那个字面量。
        hostHasDevPaths: (() => {
          try {
            const src = fs.readFileSync(hostFile, 'utf8')
            return /["'][A-Za-z]:[\\/]/.test(src)
          } catch (err) { return null }
        })(),
      },
      runtime: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        dsh: dshVersionOf(),
        uptimeSec: Math.round(process.uptime()),
        dataHome: maskPath(DSH_HOME),
        // profile 名（`profiles/web`、`profiles/desktop`…）：用来一眼看出"这份是哪个 profile 起来"的
        profile: (() => { try { const m = /profiles[\\/]([^\\/]+)/.exec(hostFile); return m ? m[1] : '' } catch (err) { return '' } })(),
      },
      client: client,
      data: dataFiles,
      ledger: ledger,
      balance: balanceLast,
      codex: codex,
    }
  }

  return { aboutPayload, dshVersionOf, clientKindOf }
}
