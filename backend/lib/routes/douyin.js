/**
 * 抖音路由（组件化迁移 #11）。
 *
 * 从 backend/lib/index.js 的 apply(ctx) 闭包里原样搬出：动作清单、分发顺序、
 * 错误码口径全部保持不变，只把闭包依赖（douyin / douyin-im 的导出）改为显式注入。
 */
export function createDouyinRoutes(deps) {
  const {
    readJsonBody, json, pluginLog, douyinSyncPolicy, readDouyinHistory,
    douyinStatus, douyinOpen, douyinCurrent, douyinNext, douyinSearch, douyinStart, douyinStop,
    douyinSummary, douyinComments, douyinNotices, douyinDebrief,
    douyinChatStatus, douyinChatContacts, douyinChatConfigure, douyinChatStart, douyinChatStop,
    douyinChatRead, douyinChatMinimize, douyinChatModels, douyinChatSetModel, douyinChatSetup,
    douyinChatEnable, douyinChatRecover,
    douyinImStatus, douyinImLoginQr, douyinImLoginSms, douyinImSubmitSms, douyinImLogout,
    douyinImContacts, douyinImSaveConfig, douyinImStart, douyinImStop, douyinImSelftest,
  } = deps || {};

  const required = {
    readJsonBody, json, pluginLog, douyinSyncPolicy, readDouyinHistory,
    douyinStatus, douyinOpen, douyinCurrent, douyinNext, douyinSearch, douyinStart, douyinStop,
    douyinSummary, douyinComments, douyinNotices, douyinDebrief,
    douyinChatStatus, douyinChatContacts, douyinChatConfigure, douyinChatStart, douyinChatStop,
    douyinChatRead, douyinChatMinimize, douyinChatModels, douyinChatSetModel, douyinChatSetup,
    douyinChatEnable, douyinChatRecover,
    douyinImStatus, douyinImLoginQr, douyinImLoginSms, douyinImSubmitSms, douyinImLogout,
    douyinImContacts, douyinImSaveConfig, douyinImStart, douyinImStop, douyinImSelftest,
  };
  for (const [name, value] of Object.entries(required)) {
    if (value === undefined || value === null) throw new TypeError(`douyin-routes 缺少依赖：${name}`);
  }

  // ── 抖音（第 4 个平台：网页版 + 本机 Edge，登录在专用窗口里人工完成）──────
  // GET  /douyin            → 状态（开关 / 时段 / 今日额度 / 窗口 / 上次总结）
  // GET  /douyin/history    → 看过的视频（本地记录）
  // POST /douyin  {action}  → open / current / next / search / start / stop / apply / summary
  async function handleDouyin(req, res, url) {
    const pathname = url.pathname;
    if (req.method === 'GET' && pathname.endsWith('/history')) {
      try { json(res, 200, readDouyinHistory({ limit: Number(url.searchParams.get('limit')) || 300 })); }
      catch (error) { json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      return;
    }
    if (req.method === 'GET') { json(res, 200, await douyinStatus()); return; }
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 GET / POST' }); return; }
    let body = {};
    try { body = await readJsonBody(req); } catch { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
    const action = String(body.action ?? '');
    if (!['open', 'current', 'next', 'search', 'start', 'stop', 'apply', 'status', 'summary', 'comments', 'notices', 'debrief',
      'chat-status', 'chat-contacts', 'chat-configure', 'chat-start', 'chat-stop', 'chat-read', 'chat-minimize', 'chat-models', 'chat-set-model', 'chat-setup', 'chat-recover', 'chat-enable',
      'im-status', 'im-login-qr', 'im-login-sms', 'im-sms-code', 'im-logout', 'im-contacts', 'im-config', 'im-start', 'im-stop', 'im-selftest'].includes(action)) {
      json(res, 400, { ok: false, error: `未知抖音动作：${action || '（空）'}` });
      return;
    }
    try {
      let result;
      if (action === 'open') result = await douyinOpen();
      else if (action === 'current') result = await douyinCurrent();
      else if (action === 'next') result = await douyinNext();
      else if (action === 'search') result = await douyinSearch(body.query);
      else if (action === 'start') result = await douyinStart({ reason: String(body.reason || '手动'), maxVideos: body.maxVideos, minutes: body.minutes });
      else if (action === 'stop') result = await douyinStop();
      else if (action === 'summary') result = douyinSummary(body.note);
      else if (action === 'comments') result = await douyinComments({ awemeId: body.awemeId, url: body.url, max: body.max, images: body.images !== false });
      else if (action === 'notices') result = await douyinNotices({ count: body.count });
      else if (action === 'debrief') result = await douyinDebrief({ awemeId: body.awemeId, url: body.url, danmakuLimit: body.danmakuLimit, commentMax: body.commentMax });
      else if (action === 'chat-status') result = await douyinChatStatus();
      else if (action === 'chat-contacts') result = await douyinChatContacts();
      else if (action === 'chat-configure') result = await douyinChatConfigure({ recipientIds: body.recipientIds, mentionNames: body.mentionNames, allowConversationOnly: body.allowConversationOnly });
      else if (action === 'chat-start') result = await douyinChatStart();
      else if (action === 'chat-stop') result = await douyinChatStop();
      else if (action === 'chat-read') result = await douyinChatRead(body.recipientId);
      else if (action === 'chat-minimize') result = await douyinChatMinimize();
      else if (action === 'chat-models') result = await douyinChatModels();
      else if (action === 'chat-set-model') result = await douyinChatSetModel({ provider: body.provider, model: body.model });
      else if (action === 'chat-setup') result = await douyinChatSetup({ recipientIds: body.recipientIds, mentionNames: body.mentionNames });
      else if (action === 'chat-enable') result = await douyinChatEnable();
      else if (action === 'chat-recover') result = await douyinChatRecover();
      else if (action === 'im-status') result = douyinImStatus();
      else if (action === 'im-login-qr') result = await douyinImLoginQr();
      else if (action === 'im-login-sms') result = await douyinImLoginSms(body.mobile);
      else if (action === 'im-sms-code') result = await douyinImSubmitSms(body.code);
      else if (action === 'im-logout') result = await douyinImLogout();
      else if (action === 'im-contacts') result = await douyinImContacts();
      else if (action === 'im-config') result = douyinImSaveConfig(body);
      else if (action === 'im-start') result = await douyinImStart();
      else if (action === 'im-stop') result = await douyinImStop();
      else if (action === 'im-selftest') result = await douyinImSelftest();
      else { if (action === 'apply') douyinSyncPolicy(); result = await douyinStatus(); }
      if (result?.ok === false) { json(res, 400, result); return; }
      json(res, 200, { ...result, ok: true });
    } catch (error) {
      pluginLog(`[抖音] ${action} 失败：${String(error?.message ?? error).slice(0, 200)}`);
      json(res, 400, { ok: false, code: String(error?.code ?? ''), error: String(error?.message ?? error) });
    }
  }

  return { handleDouyin };
}
