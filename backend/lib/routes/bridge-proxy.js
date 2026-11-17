/**
 * 桥接代理路由（组件化迁移 #11）。
 *
 * 群策略与限频禁言都是「插件后端 → QQ 桥接」的薄代理：搬出后只注入
 * callBridge / readJsonBody / json，业务仍全部在桥接侧。
 */
export function createBridgeProxyRoutes(deps) {
  const { callBridge, readJsonBody, json } = deps || {};

  const required = { callBridge, readJsonBody, json };
  for (const [name, value] of Object.entries(required)) {
    if (value === undefined || value === null) throw new TypeError(`bridge-proxy-routes 缺少依赖：${name}`);
  }

  async function handleGroupPolicy(req, res) {
    try {
      if (req.method === 'GET') {
        const r = await callBridge('/api/socialV2/group-policy');
        if (!r.ok) {
          json(res, 502, { ok: false, code: 'GROUP_POLICY_BRIDGE', error: r.error || '桥接不可用', hint: '先启动 QQ 桥接，再刷新设置页' });
          return;
        }
        json(res, 200, r.data);
        return;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const r = await callBridge('/api/socialV2/group-policy', { method: 'POST', body });
        if (!r.ok) {
          json(res, 502, { ok: false, code: 'GROUP_POLICY_SAVE', error: r.error || '保存失败', hint: '检查桥接是否运行，再重试' });
          return;
        }
        json(res, 200, r.data);
        return;
      }
      json(res, 405, { ok: false, code: 'GROUP_POLICY_METHOD', error: '只支持 GET/POST' });
    } catch (error) {
      json(res, 400, { ok: false, code: 'GROUP_POLICY_FAILED', error: String(error?.message ?? error), hint: '检查桥接与配置' });
    }
  }

  async function handleLimitMute(req, res) {
    if (req.method !== 'POST') { json(res, 405, { ok: false, code: 'LIMIT_MUTE_METHOD', error: '只支持 POST' }); return; }
    try {
      const body = await readJsonBody(req);
      const r = await callBridge('/api/socialV2/limit-mute', { method: 'POST', body });
      if (!r.ok) { json(res, 502, { ok: false, code: 'LIMIT_MUTE_BRIDGE', error: r.error || '桥接不可用', hint: '先启动/重启 QQ 桥接' }); return; }
      json(res, 200, r.data);
    } catch (error) {
      json(res, 400, { ok: false, code: 'LIMIT_MUTE_FAILED', error: String(error?.message ?? error), hint: '刷新错误报告后重试' });
    }
  }

  return { handleGroupPolicy, handleLimitMute };
}
