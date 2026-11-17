/**
 * 平台 / 模型 / 更新 / 额度路由（组件化迁移 #11）。
 *
 * 从 backend/lib/index.js 的 apply(ctx) 闭包里原样搬出：
 *   · /platforms        平台适配器状态
 *   · /platform-hub     外部插件发现 + AstrBot 状态
 *   · /models           全局模型（DSH 默认 + QQ 桥接同步）
 *   · /updates          组件更新检查 / 应用 / 回滚 / GitHub token
 *   · /token-budget     每日额度与用量
 *
 * 路由分发与全局鉴权/只读降级仍在 index.js。
 */
export function createPlatformRoutes(deps) {
  const {
    platforms, platformHub, astrbotSupervisor,
    getLlmService, getDefaultModelService,
    readUnified, saveUnified, readQqConfig, saveQqConfig,
    readJsonBody, json, pluginLog, updates, tokenBudget, backupFile,
  } = deps || {};

  const required = {
    platforms, platformHub, astrbotSupervisor,
    getLlmService, getDefaultModelService,
    readUnified, saveUnified, readQqConfig, saveQqConfig,
    readJsonBody, json, pluginLog, updates, tokenBudget, backupFile,
  };
  for (const [name, value] of Object.entries(required)) {
    if (value === undefined || value === null) throw new TypeError(`platform-routes 缺少依赖：${name}`);
  }

  // ── 平台 ────────────────────────────────────────────────────────────────
  async function handlePlatforms(req, res) {
    json(res, 200, { ok: true, platforms: await platforms.statusAll(), capabilities: ['identity', 'memory.read', 'memory.write', 'prompt.block', 'actions'] });
  }

  // 外部平台插件：两层发现 + 同源环回探测运行态（Host 来自请求头，只探本机）。
  async function handlePlatformHub(req, res) {
    json(res, 200, { ok: true, ...(await platformHub.snapshot(req.headers.host)), astrbot: await astrbotSupervisor.status() });
  }

  // ── 全局模型（对话页）：一份选择，插件后台任务与新建会话共用 ───────────
  async function modelCatalog() {
    const llmService = getLlmService();
    const defaultModelService = getDefaultModelService();
    const saved = readUnified().config.model ?? { provider: '', model: '' };
    let providers = [];
    let models = [];
    let error = '';
    if (!llmService || typeof llmService.listProviders !== 'function') {
      error = 'DSH 模型服务未就绪';
    } else {
      try { providers = llmService.listProviders().map((item) => ({ id: String(item.id ?? ''), name: String(item.name || item.displayName || item.id || '') })); }
      catch (err) { error = `读取提供商失败：${String(err?.message ?? err).slice(0, 160)}`; }
      for (const provider of providers) {
        try {
          const list = typeof llmService.listModels === 'function' ? await Promise.race([
            llmService.listModels(provider.id),
            new Promise((_, reject) => setTimeout(() => reject(new Error('目录查询超时')), 5000)),
          ]) : [];
          for (const entry of Array.isArray(list) ? list : []) {
            if (!entry?.id) continue;
            models.push({ provider: provider.id, id: String(entry.id), name: String(entry.name || entry.id) });
          }
        } catch (err) { error = error || `${provider.id}: ${String(err?.message ?? err).slice(0, 120)}`; }
      }
    }
    let dshDefault = {};
    try { dshDefault = defaultModelService?.currentSelection?.() ?? {}; } catch {}
    return { ok: true, providers, models, saved, dshDefault, error };
  }

  async function handleModels(req, res) {
    if (req.method === 'GET') { json(res, 200, await modelCatalog()); return; }
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 GET / POST' }); return; }
    let body = {};
    try { body = await readJsonBody(req); } catch { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
    const provider = String(body.provider ?? '').trim().slice(0, 200);
    const model = String(body.model ?? '').trim().slice(0, 300);
    if (Boolean(provider) !== Boolean(model)) { json(res, 400, { ok: false, error: '提供商和模型要同时选，或同时清空（跟随默认）' }); return; }
    saveUnified({ model: { provider, model } });
    // QQ 桥接读的是 qq 配置里的 dsh.provider/model（不是 unified.model）。
    // 以前只写 unified，用户在「模型」页切换后 QQ 仍用旧模型、两处说明互相矛盾。
    // 这里同步写一份（仅在明确选择时；清空不改动 QQ 现有配置，避免把能用的配置写坏）。
    if (provider && model) {
      try { saveQqConfig({ dsh: { provider, model } }); } catch (err) { pluginLog(`[模型] 同步到 QQ 配置失败：${String(err?.message ?? err).slice(0, 160)}`); }
    }
    let defaultSaved = false;
    const defaultModelService = getDefaultModelService();
    if (provider && model && typeof defaultModelService?.saveSelection === 'function') {
      try { await defaultModelService.saveSelection({ provider, model }); defaultSaved = true; } catch (err) { pluginLog(`[模型] 写入 DSH 默认失败：${String(err?.message ?? err).slice(0, 160)}`); }
    }
    pluginLog(`[模型] 全局模型 → ${provider ? `${provider}/${model}` : '跟随 DSH 默认'}`);
    json(res, 200, { ...(await modelCatalog()), ok: true, defaultSaved });
  }

  // ── 组件更新 ────────────────────────────────────────────────────────────
  // GET  : 最近一次检查结果 + 待更新项 + 是否该弹窗
  // POST : { action:'check' | 'apply' | 'dismiss' | 'reset', ids?: string[] }
  async function handleUpdates(req, res) {
    if (req.method === 'GET') { json(res, 200, updates.status()); return; }
    let body = {};
    try { body = await readJsonBody(req); } catch { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
    const action = String(body.action ?? '');
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    if (action === 'check') { json(res, 200, await updates.check({ fetch: true })); return; }
    if (action === 'apply') { json(res, 200, await updates.apply(ids)); return; }
    if (action === 'set-token' || action === 'clear-token') {
      try {
        const current = readUnified().config ?? {};
        const next = { ...current, updates: { ...(current.updates ?? {}) } };
        if (action === 'clear-token') delete next.updates.githubToken;
        else next.updates.githubToken = String(body.token ?? '').trim();
        saveUnified(next);
        json(res, 200, { ok: true, configured: action === 'set-token' && Boolean(next.updates.githubToken) });
      } catch (error) {
        json(res, 500, {
          ok: false, code: 'token.save-failed',
          error: `保存 token 失败：${String(error?.message ?? error).slice(0, 160)}`,
          hint: '检查 config.json 是否可写；也可以稍后重试',
        });
      }
      return;
    }
    if (action === 'rollback') {
      const target = String(body.id ?? ids[0] ?? '').trim();
      json(res, 200, await updates.rollback(target));
      return;
    }
    if (action === 'dismiss') { json(res, 200, updates.dismiss(ids)); return; }
    if (action === 'reset') { json(res, 200, updates.resetDismissed()); return; }
    json(res, 400, { ok: false, error: '未知 action' });
  }

  // ── 每日 token 额度 ─────────────────────────────────────────────────────
  // GET  : 额度 + 今日三类用量 + 比例 + 当天唯一的 80% 提醒（取走即落盘）
  // POST : { limits } 整体保存 / { add:{scope,unit,amount} } 快捷加额度 / { reset:true } 清空
  async function handleTokenBudget(req, res, url) {
    if (req.method === 'GET') {
      const takeAlertFlag = url?.searchParams?.get('alert') !== '0';
      json(res, 200, await tokenBudget.status({ takeAlertFlag }));
      return;
    }
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 GET / POST' }); return; }
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      return;
    }
    try {
      if (body?.reset === true) {
        backupFile(tokenBudget.budgetFile, 'token-budget-before-reset');
        tokenBudget.resetLimits();
      } else if (body?.add && typeof body.add === 'object') {
        backupFile(tokenBudget.budgetFile, 'token-budget-before-add');
        tokenBudget.addLimit(body.add.scope, body.add.unit, body.add.amount);
      } else if (body?.limits !== undefined) {
        backupFile(tokenBudget.budgetFile, 'token-budget-before-save');
        tokenBudget.saveLimits(body.limits);
      } else {
        throw new Error('缺少 limits，或 add / reset');
      }
      json(res, 200, await tokenBudget.status({ takeAlertFlag: false }));
    } catch (error) {
      json(res, 400, { ok: false, error: `保存额度失败：${String(error?.message ?? error)}` });
    }
  }

  return { handlePlatforms, handlePlatformHub, handleModels, handleUpdates, handleTokenBudget };
}
