/**
 * 日志与主人审计路由（组件化迁移 #11c）。
 *
 * 从 backend/lib/index.js 的 apply(ctx) 闭包里原样搬出，依赖改为显式注入：
 *   · /logs              插件日志 + 桥接日志尾部（返回前按已知秘密值脱敏）
 *   · /owner-audit       主人特权操作审计（只读转发给桥接）
 *   · /owner-audit/open  打开本机 state 目录（仅 Windows）
 *
 * 查询参数上限、状态码、日志文案与输出格式均保持原样；
 * 路由分发与全局鉴权/只读降级仍在 index.js。
 */
import path from 'node:path';
import { spawn } from 'node:child_process';

export function createAuditLogRoutes(deps) {
  const {
    json, readTextTail, bridgeLogTail, redactLogText, PLUGIN_LOG, QQ_STATE_DIR,
    readJsonBody, callBridge, DATA_ROOT,
  } = deps || {};

  const required = {
    json, readTextTail, bridgeLogTail, redactLogText, PLUGIN_LOG, QQ_STATE_DIR,
    readJsonBody, callBridge, DATA_ROOT,
  };
  for (const [name, value] of Object.entries(required)) {
    if (value === undefined || value === null) throw new TypeError(`audit-logs-routes 缺少依赖：${name}`);
  }

  function handleLogs(res, url) {
    const lines = Math.max(10, Math.min(500, Number(url.searchParams.get('lines')) || 120));
    const plugin = redactLogText(readTextTail(PLUGIN_LOG).split('\n').slice(-lines).join('\n'));
    const bridge = redactLogText(bridgeLogTail(lines));
    json(res, 200, { ok: true, plugin, bridge, paths: { pluginLog: PLUGIN_LOG, bridgeLog: path.join(QQ_STATE_DIR(), 'bridge.log') } });
  }

  // 主人特权操作审计：只读桥接写好的 state/owner-audit.jsonl；agent 永远拿不到。
  async function handleOwnerAudit(req, res, url) {
    if (req.method === 'GET') {
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
      const result = await callBridge(`/api/owner-audit?limit=${limit}`, { timeoutMs: 8000 });
      json(res, result.status || 200, result.data ?? { ok: false, error: result.error || '桥接不可用' });
      return;
    }
    if (req.method === 'POST') {
      let body = {};
      try { body = await readJsonBody(req); } catch { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
      // 只支持「打开所在文件夹」；路径固定，不接受任何用户输入。
      if (body.action !== 'open') { json(res, 400, { ok: false, error: '未知 action' }); return; }
      if (process.platform !== 'win32') { json(res, 200, { ok: false, error: '只有 Windows 支持打开文件夹' }); return; }
      const dir = path.join(DATA_ROOT, 'state');
      try {
        spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
        json(res, 200, { ok: true, path: dir });
      } catch (error) {
        json(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    json(res, 405, { ok: false, error: 'method not allowed' });
  }

  return { handleLogs, handleOwnerAudit };
}
