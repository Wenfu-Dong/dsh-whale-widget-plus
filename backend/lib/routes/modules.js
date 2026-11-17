/**
 * 能力槽 / 功能模块接口（组件化迁移 #11）。
 *
 * 从 backend/lib/index.js 的 apply(ctx) 闭包里原样搬出：
 *   · /capabilities   能力契约测试、切换、统计
 *   · /modules        设置栏位模块启停（停用 qq 会停桥、停用 douyin 会停观看）
 *
 * 路由分发与全局鉴权/只读降级仍在 index.js。
 */
export function createModuleRoutes(deps) {
  const {
    capabilityRegistry, moduleList, readUnified, saveUnified,
    readJsonBody, json, douyinStop, stopBridge, pluginLog,
  } = deps || {};

  const required = {
    capabilityRegistry, moduleList, readUnified, saveUnified,
    readJsonBody, json, douyinStop, stopBridge, pluginLog,
  };
  for (const [name, value] of Object.entries(required)) {
    if (value === undefined || value === null) throw new TypeError(`module-routes 缺少依赖：${name}`);
  }

  // ── 能力槽接口（设置 → 模块中心）────────────────────────────────────────
  // GET  = 当前能力清单 / 健康状况 / 最近事件；POST = 切换、只做契约测试、清空统计。
  // 切换会立刻写回合体层配置（capabilities.slots），所以「安装后自动配置好」不依赖前端保存按钮。
  async function handleCapabilities(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'GET') {
      json(res, 200, capabilityRegistry.snapshot());
      return;
    }
    if (method !== 'POST') {
      json(res, 405, { ok: false, code: 'CAPABILITY_METHOD', error: '只支持 GET / POST' });
      return;
    }
    const body = await readJsonBody(req);
    const action = String(body.action ?? 'switch');
    if (action === 'switch') {
      const capability = String(body.capability ?? '').trim();
      const provider = String(body.provider ?? '').trim();
      const result = await capabilityRegistry.switchTo(capability, provider, { test: body.test !== false });
      json(res, result.ok ? 200 : 400, { ...capabilityRegistry.snapshot(), switch: result });
      return;
    }
    if (action === 'test') {
      const capability = String(body.capability ?? '').trim();
      const provider = String(body.provider ?? '').trim();
      const result = await capabilityRegistry.runContract(capability, provider);
      json(res, 200, { ...capabilityRegistry.snapshot(), contract: result });
      return;
    }
    if (action === 'reset-stats') {
      json(res, 200, capabilityRegistry.resetStats());
      return;
    }
    json(res, 400, { ok: false, code: 'CAPABILITY_ACTION', error: `未知操作：${action}` });
  }

  // ── 功能模块接口（设置 → 模块中心）──────────────────────────────────────
  // 每个设置栏位是一个模块：停用后导航立刻隐藏、对应接口前缀返回 410。
  // 状态存在 unified.modules，切换立即保存，不依赖设置页的总保存按钮。
  async function handleModules(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'GET') {
      json(res, 200, { ok: true, modules: moduleList(readUnified().config) });
      return;
    }
    if (method !== 'POST') {
      json(res, 405, { ok: false, code: 'MODULE_METHOD', error: '只支持 GET / POST' });
      return;
    }
    const body = await readJsonBody(req);
    const id = String(body.id ?? '').trim();
    const enabled = body.enabled === true;
    if (!moduleList({}).some((item) => item.id === id)) {
      json(res, 400, { ok: false, code: 'MODULE_UNKNOWN', error: `未知模块：${id}` });
      return;
    }
    saveUnified({ modules: { [id]: enabled } });
    if (!enabled && id === 'douyin') {
      // 抖音模块一停就连观看一起收掉，避免「页面关了浏览器还在跑」。
      try { await douyinStop(); } catch {}
    }
    if (!enabled && id === 'qq') {
      // 模块停用只停当前桥（防止两个大脑同时回 QQ），**不改 platforms.start**：
      // 启动偏好由设置页的「随插件自动启动 QQ」控制，重新启用模块即自动恢复。
      try { await stopBridge(); } catch (error) { pluginLog('[module] 停 QQ 桥失败：', error?.message ?? error); }
    }
    pluginLog(`[module] ${id} → ${enabled ? '启用' : '停用'}`);
    json(res, 200, { ok: true, modules: moduleList(readUnified().config) });
  }

  return { handleCapabilities, handleModules };
}
