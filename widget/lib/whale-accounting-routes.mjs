/**
 * 记账 / 用量 / 运行状态路由（组件化迁移收尾）。
 *
 * 从 widget/lib/index.js 原样搬出以下 handler：
 *   · /dsh-whale/platform-usage.json    · /dsh-whale/platform-token.json
 *   · /dsh-whale/balance.json           · /dsh-whale/last-turn.json
 *   · /dsh-whale/last-step.json         · /dsh-whale/wait.json
 *   · /dsh-whale/about.json             · /dsh-whale/update-check.json
 *   · /dsh-whale/usage-records.json     · /dsh-whale/balance-adjustments.json
 *
 * 契约：**状态仍留在 index.js**（platformUsage 缓存/来源/错误码、balanceLast、lastTurn/lastStep、
 * waitState、about 面板实例），这里只通过 getter/setter 读写，不复制第二份。
 * aboutPayload 的组装仍在 about-panel.mjs，由 index.js 注入。
 * 路径、状态码、响应头、错误文案与缓存 TTL 保持原样。
 */

const DEP_ID = 'whale-accounting-routes'

function requireDeps(deps) {
  for (const [name, value] of Object.entries(deps)) {
    if (value === undefined || value === null) throw new TypeError(`${DEP_ID} 缺少依赖：${name}`)
  }
}

export function createWhaleAccountingRoutes(deps) {
  const {
    JSON_HEADERS,
    readBody,
    readBodyMax,
    fetchPlatformUsage,
    getPlatformUsageSource,
    getPlatformUsageCode,
    setPlatformToken,
    getBalance,
    setBalanceLast,
    BUILD_VERSION,
    BUILD_CHANNEL,
    VERSION_LABEL,
    getLastTurn,
    getLastTurnSeq,
    getLastStep,
    getWaitState,
    getAboutPayload,
    usageRecordsPayload,
    API_BUILTIN_ID,
    canAdjustBuiltinBalance,
    apiModelById,
    todayKey,
    readUsageLedger,
    writeUsageLedger,
    reconcileBalance,
    accountingDays,
    balanceSummary,
    resetBalanceCache,
    httpsGetJson,
    npmCliVersion,
  } = deps || {}
  requireDeps({
    JSON_HEADERS,
    readBody,
    readBodyMax,
    fetchPlatformUsage,
    getPlatformUsageSource,
    getPlatformUsageCode,
    setPlatformToken,
    getBalance,
    setBalanceLast,
    BUILD_VERSION,
    BUILD_CHANNEL,
    VERSION_LABEL,
    getLastTurn,
    getLastTurnSeq,
    getLastStep,
    getWaitState,
    getAboutPayload,
    usageRecordsPayload,
    API_BUILTIN_ID,
    canAdjustBuiltinBalance,
    apiModelById,
    todayKey,
    readUsageLedger,
    writeUsageLedger,
    reconcileBalance,
    accountingDays,
    balanceSummary,
    resetBalanceCache,
    httpsGetJson,
    npmCliVersion,
  })
  // 检查更新的源列表（镜像优先；最后一条走 npm CLI，适配受限网络）。
  const UPDATE_SOURCES = [
    { name: 'npmmirror', url: 'https://registry.npmmirror.com/dsh-whale-widget/latest' },
    { name: 'jsdelivr', url: 'https://cdn.jsdelivr.net/npm/dsh-whale-widget@latest/package.json' },
    { name: 'unpkg', url: 'https://unpkg.com/dsh-whale-widget@latest/package.json' },
    { name: 'npmjs', url: 'https://registry.npmjs.org/dsh-whale-widget/latest' },
    { name: 'npm-cli', cli: true },
  ]

  const platformUsageHandler = async (req, res) => {
    try {
      const refresh = new URL(req.url || '/', 'http://localhost').searchParams.get('refresh') === '1'
      const data = await fetchPlatformUsage(refresh)
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify(data ? Object.assign({ ok: true, source: getPlatformUsageSource() }, data) : { ok: false, code: getPlatformUsageCode() || 'NO_TOKEN' }))
    } catch (err) {
      res.writeHead(500, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, code: 'ERROR' }))
    }
  }

  const platformTokenHandler = async (req, res) => {
    try {
      if (req.method === 'PUT' || req.method === 'POST') {
        const raw = await readBody(req)
        let body = null
        try { body = JSON.parse(raw || '{}') } catch (err) { body = null }
        const token = String((body && body.token) || '').trim()
        if (!token) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, code: 'EMPTY' }))
          return
        }
        await setPlatformToken(token)
        const data = await fetchPlatformUsage(true)
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(data ? Object.assign({ ok: true, source: getPlatformUsageSource() }, data) : { ok: false, code: getPlatformUsageCode() || 'AUTH_FAILED' }))
        return
      }
      res.writeHead(405, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, code: 'METHOD' }))
    } catch (err) {
      // v882：读体超限（BODY_TOO_LARGE）带 status=413 —— 照抄它，别一律报 500
      res.writeHead(Number(err && err.status) || 500, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, code: 'ERROR', error: String((err && err.message) || err).slice(0, 160) }))
    }
  }

  const balanceHandler = async (req, res) => {
    // v882（审查发现）：这里原来没有 `t0`，而下面两处 `Date.now() - t0` 都写在 try/catch 里
    //   ⇒ ReferenceError 被静默吞掉，`balanceLast` **永远是 null**，「关于/自检」面板的
    //   「余额取数」一行因此永远显示"本次会话尚未取过"。t0 必须在取数前就位。
    const t0 = Date.now()
    // 后台刷新平台用量（不阻塞本次响应；有缓存时响应里直接用缓存值）
    try { fetchPlatformUsage(false).catch(function () {}) } catch (err) {}
    try {
      const refresh = new URL(req.url || '/', 'http://localhost').searchParams.get('refresh') === '1'
      const payload = await getBalance(refresh)
      // v793：给「关于/自检」面板留一条最近的取数结果（只记状态与耗时，不记任何凭据）
      try {
        setBalanceLast({
          at: Date.now(),
          ms: Date.now() - t0,
          ok: !!payload.ok,
          code: String(payload.code || ''),
          error: payload.ok ? '' : String(payload.error || '').slice(0, 160),
          hasBalance: payload.totalBalance !== null && payload.totalBalance !== undefined,
          currency: String(payload.currency || ''),
        })
      } catch (err) {}
      res.writeHead(200, JSON_HEADERS)
      // v794：成功失败都带上版本 ⇒ 客户端不必依赖"余额成功"才拿到版号
      res.end(JSON.stringify(Object.assign({}, payload, { version: BUILD_VERSION, versionLabel: VERSION_LABEL })))
    } catch (err) {
      try {
        setBalanceLast({ at: Date.now(), ms: Date.now() - t0, ok: false, code: 'THROW', error: String((err && err.message) || err).slice(0, 160), hasBalance: false, currency: '' })
      } catch (e2) {}
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, code: 'ERROR', error: String((err && err.message) || err).slice(0, 200), version: BUILD_VERSION, versionLabel: VERSION_LABEL }))
    }
  }

  const lastTurnHandler = (req, res) => {
    // 返回最近一轮已完成的对话消耗；seq 递增供前端判断「新的一轮」
    // unpriced/unpricedTokens：本轮有第三方模型没配单价（金额不可算），前端显示 token 而不是钱
    const lastTurn = getLastTurn()
    const payload = lastTurn
      ? { ok: true, seq: getLastTurnSeq(), turn: lastTurn.turn, amount: lastTurn.amount, tokens: lastTurn.tokens, ts: lastTurn.ts, unpriced: lastTurn.unpriced === true, unpricedTokens: lastTurn.unpricedTokens || 0 }
      : { ok: true, seq: 0, turn: null, amount: null, tokens: null, ts: null }
    res.writeHead(200, JSON_HEADERS)
    res.end(JSON.stringify(payload))
  }

  const lastStepHandler = (req, res) => {
    // 逐步骤金额（每次模型调用完成就 +1）：前端在峰谷徽标上方滚动显示「-x.xx」
    const lastStep = getLastStep()
    const payload = lastStep
      ? { ok: true, seq: lastStep.seq, amount: lastStep.amount, tokens: lastStep.tokens, model: lastStep.model, ts: lastStep.ts }
      : { ok: true, seq: 0, amount: null, tokens: null, model: '', ts: null }
    res.writeHead(200, JSON_HEADERS)
    res.end(JSON.stringify(payload))
  }

  const waitHandler = (req, res) => {
    // v761（issue #161）：等待用户交互的挂起状态（提问 / 授权）。
    // 沿用"宿主出状态 + 前端每秒轮询"的既有模式，不引入新通道。
    const waitState = getWaitState()
    res.writeHead(200, JSON_HEADERS)
    res.end(JSON.stringify({
      ok: true,
      pending: waitState.pending,
      sessionName: waitState.sessionName || '',
    }))
  }

  const aboutHandler = (req, res) => {
    try {
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify(getAboutPayload()(req)))
    } catch (err) {
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 160) }))
    }
  }

  // 检查更新：**点了才联网**。这里必须用 https 而不是 fetch（见 index.js 原注释）；
  // 顺序镜像优先，所有失败源的原因一起报出来；跟随重定向最多 3 跳。
  let updateCheckCache = null
  const updateCheckHandler = async (req, res) => {
    // v882（审查发现）：这是一个"点一下才联网"的 GET 接口，内部会并行打 5 个外部源
    //   （含 `npm view` 子进程）。原来**任何方法**都会触发一次完整外呼 ⇒ 补方法与缓存前置校验。
    if (req.method !== 'GET' && req.method !== undefined) {
      res.writeHead(405, { ...JSON_HEADERS, Allow: 'GET' })
      res.end(JSON.stringify({ ok: false, error: '不支持的请求方法' }))
      return
    }
    const now = Date.now()
    try {
      if (updateCheckCache && now - updateCheckCache.at < 10 * 60 * 1000) {
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(updateCheckCache.payload))
        return
      }
    } catch (err) {}
    let payload = null
    // v802：四个源**并行**试（单个源实测很不稳），并行后最坏也就 5 秒（串行会是 20 秒），
    //   谁先成功用谁，全失败就把每个源的原因都列出来。
    const results = await Promise.all(UPDATE_SOURCES.map(async (src) => {
      // v803：失败得**很快**（<1.5s，多为 DNS/连接抖动）就再试一次；超时那种就不重试了（不然最坏翻倍）
      const attempt = async () => {
        const t0 = Date.now()
        if (src.cli) return { v: await npmCliVersion(8000), ms: Date.now() - t0 }
        const j = await httpsGetJson(src.url, 5000, 0)
        const latest = String((j && j.version) || '')
        if (!latest) throw new Error('返回里没有 version')
        return { v: latest, ms: Date.now() - t0 }
      }
      try {
        const a = await attempt()
        return { ok: true, name: src.name, latest: a.v }
      } catch (err1) {
        // 只在"失败得很快"（<1.5s，多为连接抖动）时重试一次；超时那种不重试，避免最坏耗时翻倍
        const fast = !(err1 && /超时/.test(String(err1.message || '')))
        if (!fast) return { ok: false, name: src.name, why: String((err1 && err1.message) || err1).slice(0, 40) }
        try {
          const a2 = await attempt()
          return { ok: true, name: src.name, latest: a2.v }
        } catch (err2) {
          return { ok: false, name: src.name, why: String((err2 && err2.message) || err2).slice(0, 40) }
        }
      }
    }))
    const hit = results.filter((r) => r.ok)[0]
    if (hit) {
      payload = {
        ok: true,
        current: BUILD_VERSION,
        channel: BUILD_CHANNEL,
        latest: hit.latest,
        hasUpdate: hit.latest !== BUILD_VERSION,
        source: hit.name,
      }
    } else {
      // 全失败 ⇒ 把**每一个源**的原因都列出来（只报最后一个会让人以为只有 npmjs 挂了）
      payload = {
        ok: false,
        current: BUILD_VERSION,
        error: results.map((r) => r.name + '：' + r.why).join('；'),
        tried: UPDATE_SOURCES.map((s) => s.name),
      }
    }
    try { updateCheckCache = { at: now, payload: payload } } catch (err) {}
    res.writeHead(200, JSON_HEADERS)
    res.end(JSON.stringify(payload))
  }

  const usageRecordsHandler = async (req, res) => {
    try {
      // Reports read the committed ledger. Replaying cached balance samples
      // here could roll back a correction or create a false midnight baseline.
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify(usageRecordsPayload()))
    } catch (err) {
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
    }
  }

  const balanceAdjustmentsHandler = async (req, res) => {
    try {
      // 先核对身份再碰余额或账本：必须是唯一且明确的 DeepSeek（内置）。
      // 新增厂商模板不会自动继承这个能力，也拒绝其它模型读写校正。
      const targetIds = new URL(req.url || '/', 'http://localhost').searchParams.getAll('modelId')
      const targetModelId = targetIds.length === 1 ? targetIds[0] : null
      if (targetModelId !== API_BUILTIN_ID || !canAdjustBuiltinBalance(apiModelById(targetModelId))) {
        const error = new Error('余额校正仅支持 DeepSeek（内置），请从该模型的设置菜单进入')
        error.status = 403
        throw error
      }
      if (req.method === 'PUT') {
        const input = JSON.parse(await readBodyMax(req, 8192))
        if (!input || typeof input !== 'object') throw new Error('校正内容无效')
        if (input.modelId !== targetModelId) {
          const error = new Error('校正请求的模型不匹配，仅支持 DeepSeek（内置）')
          error.status = 403
          throw error
        }
        if (input.day === todayKey()) {
          const fresh = await getBalance(true)
          if (!fresh.ok || fresh.stale) {
            res.writeHead(503, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: '暂时无法刷新余额，请稍后再保存校正' }))
            return
          }
        }
        const led = readUsageLedger()
        const summary = reconcileBalance(led, input)
        if (!writeUsageLedger(led)) throw new Error('校正保存失败，请检查 DSH 数据目录写入权限')
        resetBalanceCache()
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, summary }))
        return
      }
      if (req.method !== 'GET' && req.method !== undefined) {
        res.writeHead(405, { ...JSON_HEADERS, Allow: 'GET, PUT' })
        res.end(JSON.stringify({ ok: false, error: '不支持的请求方法' }))
        return
      }
      const fresh = await getBalance(true)
      const led = readUsageLedger()
      // v882（审查发现）：accountingDays() 是**所有记账本的日期并集**（换过 API key 时旧本的日期也在里面），
      //   而 balanceSummary() 只认当前本 ⇒ 旧本独有的日期会算成 null 一起下发，前端 `rows.forEach(row => row.day)`
      //   直接 TypeError，整个「余额校正」弹窗打不开。这里只下发**当前本真有观测行**的日子
      //   （校正本来就只能针对当前本的行：reconcileBalance 对缺失行会报「这一天没有余额观测记录」）。
      const days = accountingDays(led).sort().reverse()
        .map(day => balanceSummary(led, day))
        .filter(Boolean)
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({
        ok: true, days, today: todayKey(), fresh: !!fresh.ok && !fresh.stale,
        error: !fresh.ok || fresh.stale ? (fresh.error || '余额暂未刷新') : null,
      }))
    } catch (err) {
      res.writeHead(err.status || 400, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 240) }))
    }
  }

  return {
    platformUsageHandler,
    platformTokenHandler,
    balanceHandler,
    lastTurnHandler,
    lastStepHandler,
    waitHandler,
    aboutHandler,
    updateCheckHandler,
    usageRecordsHandler,
    balanceAdjustmentsHandler,
  }
}
