/**
 * 自我学习路由（组件化迁移 #11）。
 *
 * 从 backend/lib/index.js 的 apply(ctx) 闭包里原样搬出：贴吧 / B站 / 抖音
 * → 经历 + 近况（读状态 / 立即学 / 回滚 / 改配置）。
 */
export function createLearningRoutes(deps) {
  const {
    API_PREFIX, learningLoop, rollbackAutoPersona, saveUnified, readJsonBody, json,
  } = deps || {};

  const required = { API_PREFIX, learningLoop, rollbackAutoPersona, saveUnified, readJsonBody, json };
  for (const [name, value] of Object.entries(required)) {
    if (value === undefined || value === null) throw new TypeError(`learning-routes 缺少依赖：${name}`);
  }

  async function handleLearning(req, res, url) {
    const parsed = url && typeof url.pathname === 'string' ? url : new URL(req.url || '/', 'http://127.0.0.1');
    const suffix = parsed.pathname.slice(`${API_PREFIX}/learning`.length) || '/status';
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'GET' && (suffix === '' || suffix === '/status')) {
      json(res, 200, learningLoop.status());
      return;
    }
    if (method === 'POST' && suffix === '/run') {
      let body = {};
      try { body = await readJsonBody(req); } catch { body = {}; }
      json(res, 200, await learningLoop.run({ force: body.force !== false }));
      return;
    }
    if (method === 'POST' && suffix === '/rollback') {
      json(res, 200, rollbackAutoPersona());
      return;
    }
    if (method === 'POST' && suffix === '/config') {
      let body = {};
      try { body = await readJsonBody(req); } catch { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
      const patch = {};
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      if (typeof body.diary === 'boolean') patch.diary = body.diary;
      if (Number.isFinite(Number(body.intervalHours))) patch.intervalHours = Math.max(1, Math.min(48, Math.round(Number(body.intervalHours))));
      if (Number.isFinite(Number(body.minItems))) patch.minItems = Math.max(1, Math.min(40, Math.round(Number(body.minItems))));
      if (Object.keys(patch).length) {
        saveUnified({ learning: patch });
        // 间隔/开关变了：重建定时器，免得要等下次重启才生效。
        try { learningLoop.stop(); learningLoop.start(); } catch {}
      }
      json(res, 200, learningLoop.status());
      return;
    }
    json(res, 404, { ok: false, error: `未知学习接口：${suffix}` });
  }

  return { handleLearning };
}
