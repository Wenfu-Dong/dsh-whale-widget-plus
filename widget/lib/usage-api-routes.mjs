/**
 * 用量设置 / API 模型路由（组件化迁移 #11）。
 *
 * 从 widget/lib/index.js 里原样搬出两个 handler：
 *   · /dsh-whale/usage-settings.json
 *   · /dsh-whale/api-models.json
 * 只注入依赖，响应头、上限、动作顺序与错误码保持原样。
 */

function requireDeps(id, deps) {
  for (const [name, value] of Object.entries(deps)) {
    if (value === undefined || value === null) throw new TypeError(`${id} 缺少依赖：${name}`)
  }
}

// 用量设置：GET 读、PUT/POST 局部写。
export function createUsageSettingsRoute(deps) {
  const { readBodyMax, writeUsageSettings, readUsageSettings, JSON_HEADERS } = deps || {}
  requireDeps('usage-settings-route', { readBodyMax, writeUsageSettings, readUsageSettings, JSON_HEADERS })

  return async (req, res) => {
    try {
      if (req.method === 'PUT' || req.method === 'POST') {
        // v882：4 类提示的自定义泡泡内容（多模块文案）合起来可能超过 8KB，抬到 64KB（仍有界）
        const body = await readBodyMax(req, 64 * 1024)
        const parsed = JSON.parse(body || '{}')
        if (!parsed || typeof parsed !== 'object') throw new Error('bad body')
        const result = writeUsageSettings(parsed)
        res.writeHead(result.ok ? 200 : 400, JSON_HEADERS)
        res.end(JSON.stringify(result))
        return
      }
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({ ok: true, settings: readUsageSettings() }))
    } catch (err) {
      res.writeHead(400, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
    }
  }
}

// 自定义 API 模型：GET 列表（含实时余额/今日已用/各模型提醒预算）
// POST {action: save|delete|set-key|delete-key|model-settings|probe}
export function createApiModelsRoute(deps) {
  const {
    readBodyMax, apiDeleteModel, apiModelsPayload, apiModelById, apiProbeModel,
    getCtx, writeUsageSettings, apiSaveModel, JSON_HEADERS,
  } = deps || {}
  requireDeps('api-models-route', {
    readBodyMax, apiDeleteModel, apiModelsPayload, apiModelById, apiProbeModel,
    getCtx, writeUsageSettings, apiSaveModel, JSON_HEADERS,
  })

  return async (req, res) => {
    try {
      if (req.method === 'PUT' || req.method === 'POST') {
        // v882：8KB 对"余额接口 body(4000) + auth(1000) + 若干 url"这种完整模型条目偏小，
        //   合法保存会被判成请求体过大。抬到 64KB（仍有界），与 qq-sync 的上限一致。
        const body = await readBodyMax(req, 64 * 1024)
        const parsed = JSON.parse(body || '{}')
        const action = String((parsed && parsed.action) || 'save')
        if (action === 'delete') {
          const r = apiDeleteModel(parsed.id)
          const list = await apiModelsPayload()
          res.writeHead(r.ok ? 200 : 400, JSON_HEADERS)
          res.end(JSON.stringify({ ...r, models: list.models }))
          return
        }
        if (action === 'probe') {
          // 只做只读连通性测试（如方舟 /api/v3/models），不消耗 token
          const m0 = apiModelById(parsed.id)
          const pr = await apiProbeModel(m0)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(pr))
          return
        }
        if (action === 'set-key' || action === 'delete-key') {
          const ref = String(parsed.keyRef || '').trim()
          if (!ref) throw new Error('bad keyRef')
          // v882（审查发现，安全一致性）：apiSaveModel 早就有凭据名白名单，这里却接受任意字符串 ⇒
          //   可借 set-key/delete-key 往**任意凭据名**上写/删（例如别的插件在用的 ref）。
          //   与 apiSaveModel 用同一条规则：字母/数字/下划线，≤64。
          if (!/^[A-Za-z0-9_]{1,64}$/.test(ref)) throw new Error('凭据名只能包含字母、数字与下划线（≤64 字符）')
          const svc = getCtx().credentials
          if (action === 'set-key') {
            await svc.set(ref, String(parsed.keyValue || ''))
          } else if (typeof svc.unset === 'function') {
            // 普通密钥存在凭据文档的 refs 段：必须用 unset 才能真正删除
            // （deleteRecord 只处理 records 段的结构化记录，对 refs 会静默返回）
            await svc.unset(ref)
          } else {
            await svc.deleteRecord(ref)
          }
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true }))
          return
        }
        if (action === 'model-settings') {
          const r = writeUsageSettings({ modelSettings: { id: String(parsed.id || ''), alert: parsed.alert, budget: parsed.budget, quota: parsed.quota } })
          res.writeHead(r.ok ? 200 : 400, JSON_HEADERS)
          res.end(JSON.stringify(r))
          return
        }
        // 注意：keyValue 在提交体上（不在 model 里），必须合并进去，
        // 否则前端面板里填的 API key 会被丢弃（密钥永远存不进去）
        const r = await apiSaveModel({ ...(parsed.model || parsed), keyValue: parsed.keyValue })
        const list2 = await apiModelsPayload()
        res.writeHead(r.ok ? 200 : 400, JSON_HEADERS)
        res.end(JSON.stringify({ ...r, models: list2.models }))
        return
      }
      const payload = await apiModelsPayload()
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify(payload))
    } catch (err) {
      res.writeHead(400, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
    }
  }
}
