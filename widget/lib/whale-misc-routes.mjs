/**
 * 杂项路由（组件化迁移收尾）。
 *
 * 从 widget/lib/index.js 原样搬出以下 handler：
 *   · /dsh-whale/qq-sync.json —— 长轮询 SurfCore 的 QQ 消息事件 + 历史 + 代回复
 *   · /dsh-whale/size.json    —— 外观/音效/用量模式配置读写
 *
 * size 的读写与默认值仍由 index.js 注入（readSizeConfig / writeSizeConfig / exprPackId /
 * exprDefaults 也被记账与表情逻辑复用）；余额缓存与 Codex 快照的失效同样是宿主状态，
 * 通过 resetBalanceCache / codexInvalidate 触发。路径、状态码与错误文案保持原样。
 */

const DEP_ID = 'whale-misc-routes'

function requireDeps(deps) {
  for (const [name, value] of Object.entries(deps)) {
    if (value === undefined || value === null) throw new TypeError(`${DEP_ID} 缺少依赖：${name}`)
  }
}

export function createWhaleMiscRoutes(deps) {
  const {
    JSON_HEADERS,
    readBody,
    readBodyMax,
    surfcoreRequest,
    readSizeConfig,
    writeSizeConfig,
    normalizeUsageMode,
    exprPackId,
    exprDefaults,
    resetBalanceCache,
    codexInvalidate,
    BUILD_VERSION,
    VERSION_LABEL,
  } = deps || {}
  requireDeps({
    JSON_HEADERS,
    readBody,
    readBodyMax,
    surfcoreRequest,
    readSizeConfig,
    writeSizeConfig,
    normalizeUsageMode,
    exprPackId,
    exprDefaults,
    resetBalanceCache,
    codexInvalidate,
    BUILD_VERSION,
    VERSION_LABEL,
  })

  // QQ 对话同步：长轮询 SurfCore 的 QQ 消息事件 + 读取历史 + 代主人回复。
  // 浏览器端只碰这个同源路由，令牌/baseUrl 都留在宿主侧。
  const qqSyncHandler = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (req.method === 'POST') {
        // v882（审查发现）：这里原来用 readBody（8KB 上限）却按 64KB 做前置检查 ——
        //   8~64KB 的请求体会先通过检查、再被 readBody 直接 destroy 连接，客户端看到的是 ECONNRESET
        //   而不是下面这条 413。改成同一个上限，两处保持一致。
        const declared = Number(req.headers['content-length'] || 0)
        if (declared > 64 * 1024) {
          res.writeHead(413, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: '请求体过大（上限 64KB）' }))
          return
        }
        const body = JSON.parse((await readBodyMax(req, 64 * 1024)) || '{}')
        // 严格校验：只接受字符串，且最多 150 字（和卡片输入框上限一致），不再静默截断/强转
        if (typeof body.text !== 'string') {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: '消息格式不正确' }))
          return
        }
        const text = body.text.trim()
        if (!text) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: '消息不能为空' }))
          return
        }
        if (text.length > 150) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: `消息太长（最多 150 字，当前 ${text.length} 字）` }))
          return
        }
        const data = await surfcoreRequest('/qq/send', { method: 'POST', body: { text }, timeout: 15000 })
        res.writeHead(data && data.ok ? 200 : 502, JSON_HEADERS)
        res.end(JSON.stringify(data && data.ok ? { ok: true, message: data.message } : { ok: false, error: (data && data.error) || 'dsh-Dfy/桥接不可达' }))
        return
      }
      if (url.searchParams.get('history')) {
        const limit = Math.max(1, Math.min(120, Number(url.searchParams.get('limit')) || 40))
        const data = await surfcoreRequest(`/qq/history?limit=${limit}`, { timeout: 10000 })
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(data && data.ok ? {
          ok: true,
          cursor: data.cursor,
          owner: data.owner || null,
          ownerKey: data.ownerKey || '',
          messages: data.messages || [],
        } : { ok: false, error: (data && data.error) || 'dsh-Dfy 不可达', messages: [] }))
        return
      }
      const since = url.searchParams.get('since')
      const wait = Math.max(0, Math.min(25000, Number(url.searchParams.get('wait')) || 0))
      const q = new URLSearchParams({ wait: String(wait), client: 'whale-widget' })
      if (since !== null && since !== '' && since !== 'null') q.set('since', since)
      // v882（审查发现，稳定性）：长轮询（前端固定 wait=20000）期间若页面刷新/关闭，
      //   浏览器会断开这条 GET，但旧实现仍会把上游请求跑满 wait+8s（最坏 28 秒）才释放。
      //   现在把"客户端断开"接到上游 fetch 的 AbortController 上，让连接与定时器立刻回收。
      const ac = new AbortController()
      let clientGone = false
      const onClientClose = () => {
        if (!res.writableEnded) { clientGone = true; try { ac.abort() } catch (err) {} }
      }
      try { req.on('close', onClientClose) } catch (err) {}
      let data = null
      try {
        data = await surfcoreRequest(`/events?${q.toString()}`, { timeout: wait + 8000, signal: ac.signal })
      } finally {
        try { req.off('close', onClientClose) } catch (err) {}
      }
      // 客户端已经走了：不再往一个已断开的响应上写（旧实现在这里会触发 write-after-end 类噪音）
      if (clientGone || res.destroyed || res.writableEnded) return
      if (!data || !data.ok) {
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: (data && data.error) || 'dsh-Dfy 不可达', events: [] }))
        return
      }
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({
        ok: true,
        bootId: data.bootId || '',
        cursor: Number(data.cursor) || 0,
        // qq-message：QQ 私聊收发；proactive：SurfCore 主动搭话；reply：对话/测试回复。
        // 三类都透传给挂件，由前端决定进气泡还是进消息卡。
        events: (Array.isArray(data.events) ? data.events : []).filter((e) => e && (e.type === 'qq-message' || e.type === 'proactive' || e.type === 'reply')),
      }))
    } catch (err) {
      try {
        // v882：读体超限（BODY_TOO_LARGE）带 status=413 —— 照抄它，别一律报 500
        res.writeHead(Number(err && err.status) || 500, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
      } catch (e) {}
    }
  }

  const sizeHandler = async (req, res) => {
    if (req.method === 'PUT' || req.method === 'POST') {
      try {
        const body = await readBody(req)
        const parsed = JSON.parse(body)
        const scale = typeof parsed.scale === 'number' ? parsed.scale : null
        if (scale === null) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'missing scale' }))
          return
        }
        // issue #97：缺字段一律「沿用现有值」，绝不落默认 —— 否则任何不全的 PUT
        // （旧客户端 / 手写 curl / 加载竞态）都会把用户的设置洗成默认值。
        // 特别注意 scrollGapPx：读取默认是 17，而写入缺省曾是 0，会静默把避让宽度改掉。
        const old = readSizeConfig() || {}
        const pickB = (v, cur, dflt) => (typeof v === 'boolean' ? v : (typeof cur === 'boolean' ? cur : dflt))
        const pickN = (v, cur, dflt) => (typeof v === 'number' ? v : (typeof cur === 'number' ? cur : dflt))
        const pickS = (v, cur, dflt) => (typeof v === 'string' && v ? v : (typeof cur === 'string' && cur ? cur : dflt))
        // 用量模式变化时让余额缓存失效，下次请求立即按新模式计算
        if (typeof parsed.usageMode === 'string') {
          if (normalizeUsageMode(old.usageMode) !== normalizeUsageMode(parsed.usageMode)) {
            resetBalanceCache()
          }
        }
        const result = writeSizeConfig(
          scale,
          pickB(parsed.sound, old.sound, true),
          pickN(parsed.vol, old.vol, 0.9),
          pickS(parsed.soundSet, old.soundSet, 'duck'),
          typeof parsed.usageMode === 'string' ? parsed.usageMode : old.usageMode,
          typeof parsed.peakMode === 'string' ? parsed.peakMode : old.peakMode,
          pickB(parsed.bubbleOn, old.bubbleOn, true),
          pickB(parsed.pressOn, old.pressOn, true),
          pickB(parsed.turnCostOn, old.turnCostOn, true),
          pickN(parsed.turnCostCloseMs, old.turnCostCloseMs, 5000),
          pickB(parsed.scrollGapOn, old.scrollGapOn, false),
          pickN(parsed.scrollGapPx, old.scrollGapPx, 17),
          pickB(parsed.menuBtnHide, old.menuBtnHide, false),
          pickB(parsed.codexStatsOn, old.codexStatsOn, true),
          // 表情配置：exprPack 允许显式传空串来「清除选择」（不同于 pickS —— 它会把空串当成
          // "本次没给"而沿用旧值，导致选不回自动）；缺字段时仍沿用旧值，防洗成默认。
          // 值的合法性判定与另外两处共用 exprPackId（非法 id 一律归一成 '' = 自动）。
          typeof parsed.exprPack === 'string' ? exprPackId(parsed.exprPack) : (typeof old.exprPack === 'string' ? old.exprPack : ''),
          pickB(parsed.exprOn, old.exprOn, true),
          pickB(parsed.blinkOn, old.blinkOn, true),
          // 厂商额度（选装）：默认关；vendorQuotaModel 允许显式传空串来清除选择（同 exprPack 的处理）
          pickB(parsed.vendorQuotaOn, old.vendorQuotaOn, false),
          typeof parsed.vendorQuotaModel === 'string' ? parsed.vendorQuotaModel : (typeof old.vendorQuotaModel === 'string' ? old.vendorQuotaModel : ''),
          pickB(parsed.volcQuotaOn, old.volcQuotaOn, false)
        )
        res.writeHead(result.ok ? 200 : 500, JSON_HEADERS)
        // 配置刚变（可能刚关掉/打开 Codex 统计）→ 丢掉旧快照，让下一次请求立刻反映新设置
        if (result.ok) { try { codexInvalidate() } catch (err) {} }
        res.end(JSON.stringify(result))
      } catch (err) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
      }
      return
    }
    res.writeHead(200, JSON_HEADERS)
    // v794：GET 也带上版本（客户端启动就会读这份配置 ⇒ 菜单底部那行版本小字**不必等余额请求**，
    //   余额首次请求失败时也不会一直空着 —— 这是用户报的"刚启动时版号消失"）
    // 注：配置文件还不存在时 readSizeConfig() 返回 null，此时必须补上表情层三键的默认值 ——
    //   因为这三键的语义是**宿主默认开**，而前端只有读到 boolean 才会赋值（读不到就保持初始的"关"），
    //   不补的话全新安装下表情层会静默不生效。
    res.end(JSON.stringify(Object.assign({}, readSizeConfig() || exprDefaults(), {
      version: BUILD_VERSION,
      versionLabel: VERSION_LABEL,
    })))
  }

  return { qqSyncHandler, sizeHandler }
}
