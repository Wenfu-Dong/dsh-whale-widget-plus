/**
 * 设置页外围接口（组件化迁移 #11）。
 *
 * 从 backend/lib/index.js 的 apply(ctx) 闭包里原样搬出：
 *   · /browse                    原生选择目录/文件（仅 Windows）
 *   · /voice/preview             音色试听（转发桥接 Edge TTS）
 *   · /voice/doubao-web/*        豆包网页音源（转发桥接）
 *   · /deepseek-status           DeepSeek key 体检（余额接口，缓存 10 分钟）
 *
 * 路由分发与全局鉴权/只读降级仍在 index.js。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export function createConsoleExtrasRoutes(deps) {
  const {
    json, readJsonBody, readQqConfig, readAsrSettings, httpRequest,
    consoleBase, consoleToken,
  } = deps || {};

  const required = {
    json, readJsonBody, readQqConfig, readAsrSettings, httpRequest,
    consoleBase, consoleToken,
  };
  for (const [name, value] of Object.entries(required)) {
    if (value === undefined || value === null) throw new TypeError(`console-extras-routes 缺少依赖：${name}`);
  }

  // 原生「浏览目录 / 选择文件」——浏览器拿不到绝对路径，只能由宿主进程弹 Windows 对话框。
  // 仅 Windows 且 DSH 跑在本机时有意义；其它情况返回可读错误，前端提示手动填。
  //
  // 路径不能走 PowerShell stdout：Windows PowerShell 5.1 重定向时用 OEM/GBK 编码，
  // Node 按 UTF-8 解码，中文目录会变成 `�`，后端 fsp.stat 直接 ENOENT（2026-10-29 反馈）。
  // 改成：PowerShell 把选中路径写进临时 UTF-8 文件，Node 读文件后删除；彻底绕开控制台编码。
  async function handleBrowse(req, res, url) {
    const mode = url.searchParams.get('mode') === 'file' ? 'file' : 'dir';
    const title = url.searchParams.get('title') || (mode === 'file' ? '选择文件' : '选择目录');
    // 文件过滤只认枚举（目前只有 snowluma）：不接受任意 filter 串，避免用户被诱导选错类型。
    const filterKey = String(url.searchParams.get('filter') || '').trim().toLowerCase();
    const fileFilter = filterKey === 'snowluma'
      ? 'SnowLuma 启动文件 (SnowLuma.exe;launcher.bat)|SnowLuma.exe;launcher.bat|所有文件 (*.*)|*.*'
      : '可执行文件 (*.exe)|*.exe|所有文件 (*.*)|*.*';
    if (process.platform !== 'win32') {
      json(res, 200, { ok: false, error: '只有 Windows 支持原生选择框，请手动填路径' });
      return;
    }
    const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const outFile = path.join(os.tmpdir(), `surfcore-browse-${process.pid}-${randomUUID()}.txt`);
    const writeOut = (expr) => `[System.IO.File]::WriteAllText(${psQuote(outFile)}, ${expr}, (New-Object System.Text.UTF8Encoding -ArgumentList $false))`;
    const ps = mode === 'file'
      ? `Add-Type -AssemblyName System.Windows.Forms;
$d = New-Object System.Windows.Forms.OpenFileDialog;
$d.Title = ${psQuote(title)};
$d.Filter = ${psQuote(fileFilter)};
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { ${writeOut('$d.FileName')} }`
      : `Add-Type -AssemblyName System.Windows.Forms;
$d = New-Object System.Windows.Forms.FolderBrowserDialog;
$d.Description = ${psQuote(title)};
$d.ShowNewFolderButton = $true;
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { ${writeOut('$d.SelectedPath')} }`;
    const child = execFile('powershell.exe', ['-STA', '-NoProfile', '-Command', ps], { windowsHide: true, timeout: 180_000 }, (error) => {
      let picked = '';
      try { picked = String(fs.readFileSync(outFile, 'utf8')).replace(/^\uFEFF/, '').trim(); } catch {}
      try { fs.unlinkSync(outFile); } catch {}
      if (error && !picked) json(res, 200, { ok: false, error: `选择框打不开：${String(error.message || error).slice(0, 160)}` });
      else if (!picked) json(res, 200, { ok: false, cancelled: true, error: '已取消' });
      else json(res, 200, { ok: true, path: picked });
    });
    child.on('error', () => {
      try { fs.unlinkSync(outFile); } catch {}
      json(res, 200, { ok: false, error: '无法启动 PowerShell（可能不在本机桌面）' });
    });
  }

  // 语音试听：设置页「语音」的音色试听走桥接的 Edge TTS，音频字节必须原样转发。
  // 语音包管理接口（/voice/packs、/voice/tts-*）已随语音包子系统下线（2026-11 精简）。
  async function handleVoicePreview(req, res, url) {
    if (String(req.method || 'GET').toUpperCase() !== 'GET') {
      json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: '只支持 GET' });
      return;
    }
    const target = `${consoleBase()}/api/voice/preview${url.search || ''}`;
    try {
      const r = await fetch(target, { headers: { 'x-console-token': consoleToken() }, signal: AbortSignal.timeout(60_000) });
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, {
        'content-type': r.headers.get('content-type') || 'audio/mpeg',
        ...(r.headers.get('content-disposition') ? { 'content-disposition': r.headers.get('content-disposition') } : {}),
      });
      res.end(buf);
    } catch (error) {
      json(res, 502, { ok: false, code: 'VOICE_PREVIEW_UNREACHABLE', error: `语音服务不可达（桥接是否在运行？）：${error?.message ?? error}` });
    }
  }

  // 豆包网页音源（doubao-web）：登录态存在桥接那侧的浏览器 profile 里，面板只是个查看/触发入口，
  // 所以必须在这里代理到桥接 /api/voice/doubao-web/*。
  // 漏了这层代理时，设置页拿到的是本文件的 404，页面只会显示「读不到状态接口（后端没重启）」，
  // 看着像后端没升级，其实是路由没接（2026-11 用户反馈）。
  // status/voices 要先开浏览器，给 2 分钟；login 要真实弹 Edge 等扫码（桥接侧最长 4 分钟），按 4.5 分钟放。
  async function handleVoiceDoubaoWeb(req, res, url) {
    const kind = String(url.pathname.split('/').pop() || '');
    const spec = {
      status: { method: 'GET', timeout: 120_000 },
      login: { method: 'POST', timeout: 270_000 },
      voices: { method: 'GET', timeout: 120_000 },
      voice: { method: 'POST', timeout: 90_000 },
    }[kind];
    if (!spec) {
      json(res, 404, { ok: false, code: 'UNKNOWN_DOUBAO_WEB_API', error: `未知的豆包网页音源接口：${kind}` });
      return;
    }
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== spec.method) {
      json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: `只支持 ${spec.method}` });
      return;
    }
    const target = `${consoleBase()}/api/voice/doubao-web/${kind}`;
    let body = null;
    if (spec.method === 'POST') {
      // voice 要带参数 { name }；login 不需要参数，也要带个合法 JSON 体。
      body = kind === 'voice'
        ? JSON.stringify(await readJsonBody(req).catch(() => ({})))
        : '{}';
    }
    try {
      const r = await fetch(target, {
        method: spec.method,
        headers: { 'x-console-token': consoleToken(), ...(spec.method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(spec.timeout),
      });
      let data = {};
      try { data = await r.json(); } catch { data = {}; }
      if (!data || typeof data !== 'object') data = {};
      if (!r.ok && !data.error) data.error = `桥接返回 HTTP ${r.status}`;
      json(res, r.ok ? 200 : 502, data);
    } catch (error) {
      json(res, 502, {
        ok: false,
        code: 'VOICE_DOUBAO_WEB_UNREACHABLE',
        error: `豆包网页音源不可达（桥接是否在运行？）：${String(error?.message ?? error).slice(0, 200)}`,
      });
    }
  }

  // DeepSeek key 状态体检：语音（TTS/ASR）和联网搜索共用这把 key，失效时全部静默
  // 降级（搜索回 Bing、语音回占位文案），以前没有任何页面能看到（2026-11-14 体检）。
  // 用官方余额接口验证（免费、顺带拿余额），结果缓存 10 分钟。
  let deepseekStatusCache = null; // { at, payload }
  async function handleDeepseekStatus(req, res) {
    if (String(req.method || 'GET').toUpperCase() !== 'GET') {
      json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: '只支持 GET' });
      return;
    }
    if (deepseekStatusCache && Date.now() - deepseekStatusCache.at < 10 * 60_000) {
      json(res, 200, { ok: true, cached: true, ...deepseekStatusCache.payload });
      return;
    }
    const cfg = readQqConfig().config ?? {};
    const settings = readAsrSettings(cfg);
    const tail = String(settings.apiKey ?? '').slice(-4);
    const payload = {
      keySource: settings.keySource,
      hasKey: Boolean(settings.apiKey),
      keyTail: tail,
      asrEnabled: settings.enabled === true,
      balance: null,
      ok: false,
      hint: '',
      checkedAt: new Date().toISOString(),
    };
    if (!settings.apiKey) {
      payload.hint = '读不到 DeepSeek key：检查联网搜索的 Key 配置（webSearch.apiKey / DEEPSEEK_API_KEY / DSH 凭据）';
    } else {
      try {
        // node:https 直连：DSH 宿主进程里 fetch 出站实测失败（fetch failed），与
        // TTS/ASR/联网搜索走同一通道；底层错误码已透出（如 ECONNRESET）
        const r = await httpRequest({
          url: 'https://api.deepseek.com/user/balance',
          headers: { authorization: `Bearer ${settings.apiKey}`, accept: 'application/json' },
          timeoutMs: 15_000,
          maxBytes: 1 * 1024 * 1024,
        });
        let data = null;
        try { data = JSON.parse(r.body.toString('utf8')); } catch { /* 非 JSON 按无数据处理 */ }
        if (r.status === 401) {
          payload.hint = 'key 已失效（DeepSeek 返回 401）：去 platform.deepseek.com/api_keys 重新生成，并更新到 DSH 凭据';
        } else if (r.status >= 200 && r.status < 300 && data?.is_available !== undefined) {
          const info = Array.isArray(data.balance_infos) ? data.balance_infos[0] : null;
          payload.balance = info ? { currency: info.currency, total: info.total_balance } : null;
          payload.ok = data.is_available === true;
          payload.hint = payload.ok ? '' : '账号当前不可用（可能余额为负被暂停）：去开放平台确认';
        } else {
          payload.hint = `余额接口返回 HTTP ${r.status}，稍后再试`;
        }
      } catch (error) {
        const message = String(error?.message ?? error);
        // 2026-11-14 实测：本机走代理软件的 fake-ip 隧道，到 DeepSeek 的连接会间歇性被
        // 重置——用户侧的第一修法是换代理节点或把 DeepSeek 设为直连规则
        const proxyHint = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|超时/.test(message)
          ? '（大概率是代理节点到 DeepSeek 不稳：换个节点，或把 api.deepseek.com 设为直连规则后刷新）'
          : '';
        payload.hint = `连不上 DeepSeek：${message.slice(0, 120)}${proxyHint}`;
      }
    }
    deepseekStatusCache = { at: Date.now(), payload };
    json(res, 200, { ok: true, cached: false, ...payload });
  }

  return { handleBrowse, handleVoicePreview, handleVoiceDoubaoWeb, handleDeepseekStatus };
}
