/**
 * B站 / 贴吧 / 偏好路由（组件化迁移 #11）。
 *
 * 从 backend/lib/index.js 的 apply(ctx) 闭包里原样搬出：
 *   · /bili/*       依赖体检、cookie、扫码、账号核查、待审回复、通知测试、鱼群保护
 *   · /tieba/*      扫码登录、状态、动作、观看记录（生物钟共用）
 *   · /qq/fish-guard 最近触发
 *   · /watch-history 观看历史
 *   · /preference-scan 偏好关键词扫描（只读）
 *
 * 路由分发与全局鉴权/只读降级仍在 index.js。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export function createBiliTiebaRoutes(deps) {
  const {
    getCtx, getScheduler, isSchedulerRunning,
    readJson, readJsonBody, json, pluginLog, maskPath, writeJsonAtomic,
    readQqConfig, QQ_STATE_DIR, readBiliConfig, saveBiliConfig,
    BILI_MJS, BILI_TOOLS_DIR, BILI_CRED, BILI_AI_DIR, BILI_DIR, BACKUP_DIR, ALIGN_FILE,
    activePlatformStateDir, readCurrentCharacter,
    readWatchHistory, enrichWatchHistory, scanPreferences,
    fishGuardStateSummary, summarizeQqFishGuard, automationSnapshot,
    callBridge, findNodeExe, applySessionPermission, biliCookieHeader,
    readFishAccount, readOwnerAccount, pollQrLogin, startQrLogin, cancelQrLogin, verifyStoredCredentials,
    saveTiebaCookieLogin, markTiebaVerified, verifyStoredTiebaCredentials, readTiebaViewHistory, tiebaStatus, tiebaAction,
    clearTiebaCredentials,
    startTiebaQrLogin, pollTiebaQrLogin, cancelTiebaQrLogin,
  } = deps || {};

  const required = {
    getCtx, getScheduler, isSchedulerRunning,
    readJson, readJsonBody, json, pluginLog, maskPath, writeJsonAtomic,
    readQqConfig, QQ_STATE_DIR, readBiliConfig, saveBiliConfig,
    BILI_MJS, BILI_TOOLS_DIR, BILI_CRED, BILI_AI_DIR, BILI_DIR, BACKUP_DIR, ALIGN_FILE,
    activePlatformStateDir, readCurrentCharacter,
    readWatchHistory, enrichWatchHistory, scanPreferences,
    fishGuardStateSummary, summarizeQqFishGuard, automationSnapshot,
    callBridge, findNodeExe, applySessionPermission, biliCookieHeader,
    readFishAccount, readOwnerAccount, pollQrLogin, startQrLogin, cancelQrLogin, verifyStoredCredentials,
    saveTiebaCookieLogin, markTiebaVerified, verifyStoredTiebaCredentials, readTiebaViewHistory, tiebaStatus, tiebaAction,
    clearTiebaCredentials,
    startTiebaQrLogin, pollTiebaQrLogin, cancelTiebaQrLogin,
  };
  for (const [name, value] of Object.entries(required)) {
    if (value === undefined || value === null) throw new TypeError(`bili-tieba-routes 缺少依赖：${name}`);
  }

  // ── B站动作：依赖体检 / cookie / 待审 / 通知测试 ────────────────────────
  function runBili(args, timeoutMs = 120_000) {
    return new Promise((resolve) => {
      execFile(findNodeExe(), [BILI_MJS, ...args], {
        cwd: BILI_TOOLS_DIR,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      }, (error, stdout, stderr) => resolve({
        ok: !error,
        code: error?.code ?? 0,
        out: String(stdout ?? '').slice(-20_000),
        err: String(stderr ?? '').slice(-4000),
      }));
    });
  }

  // ── QQ 鱼群保护（设置页「最近触发」）────────────────────────────────────
  // 桥接把每次新触发写进 social-v2.json 的 fishGuardLog（每群最多 30 条）；
  // 设置页只读这个文件，不再靠翻活动日志。见 PITFALLS #30 / #31。
  function handleQqFishGuard(res) {
    try {
      const file = path.join(QQ_STATE_DIR(), 'social-v2.json');
      const data = readJson(file, {}) ?? {};
      const summary = summarizeQqFishGuard(data, { now: Date.now() });
      json(res, 200, {
        ok: true,
        file,
        now: new Date().toISOString(),
        ...summary,
        config: readQqConfig().config?.fishGuard ?? {},
      });
    } catch (error) {
      json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  }

  // ── 观看历史（设置页「观看历史」）───────────────────────────────────────
  // 数据来自当前角色 bili/watch-history.jsonl；旧数据从 bili-memory.json 补。
  function handleWatchHistory(res, url) {
    try {
      const current = readCurrentCharacter();
      const data = readWatchHistory({
        limit: Number(url.searchParams.get('limit')) || 200,
        q: url.searchParams.get('q') ?? '',
        days: Number(url.searchParams.get('days')) || 0,
      });
      // 2026-10-23 用户要求：每条看过之后她做了什么（评论怎么发的/收藏/动态）。
      const enriched = enrichWatchHistory(data.items);
      json(res, 200, {
        ok: true,
        character: current ? { id: current.id, name: current.name, epoch: current.epoch } : null,
        ...data,
        items: enriched.items,
        actions: enriched.actions,
      });
    } catch (error) {
      json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  }

  // ── 偏好关键词扫描（设置页「口味权重 / 一键抓取」）──────────────────────
  // 只读：从当前账号的观看历史 / 收藏夹 + 本地记录里抽候选词，不写配置、不外发。
  async function handlePreferenceScan(res, url) {
    const raw = String(url.searchParams.get('sources') ?? '').trim();
    const sources = raw
      ? raw.split(/[,，]/).map((item) => item.trim()).filter(Boolean)
      : undefined;
    const target = ['fish', 'owner', 'both'].includes(String(url.searchParams.get('target') ?? ''))
      ? String(url.searchParams.get('target'))
      : 'fish';
    const limit = Math.max(4, Math.min(60, Number(url.searchParams.get('limit')) || 24));
    let timer = null;
    try {
      const result = await Promise.race([
        scanPreferences({ sources, limit, target }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('扫描超时（20 秒）：网络太慢，可先在命令行跑 prefs scan')), 20_000);
          timer.unref?.();
        }),
      ]);
      json(res, 200, result);
    } catch (error) {
      json(res, 500, { ok: false, error: String(error?.message ?? error) });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function handleBili(req, res, url) {
    const pathname = url.pathname;
    if (req.method === 'GET' && pathname.endsWith('/fish-guard')) {
      const dir = activePlatformStateDir(BILI_DIR);
      const stateFile = path.join(dir, 'fish-guard.json');
      const state = readJson(stateFile, {}) ?? {};
      const cfg = readBiliConfig().config?.fishGuard ?? {};
      const current = readCurrentCharacter();
      json(res, 200, {
        ok: true,
        character: current ? { id: current.id, name: current.name, epoch: current.epoch } : null,
        credentials: fs.existsSync(BILI_CRED),
        stateFile,
        fishGuard: fishGuardStateSummary(state, cfg),
      });
      return;
    }
    if (req.method === 'POST' && pathname.endsWith('/session-permission')) {
      // 手动修复：把当前角色的 B站 会话切到配置的权限（默认 danger-full-access）。
      // 定时器也会自动做；这个按钮用于「现在就想让她能跑命令」时立刻生效。
      const body = await readJsonBody(req);
      const current = readCurrentCharacter();
      const sessionId = current ? `bili-whale-${current.id}` : 'bili-whale';
      const target = String(body.target ?? readBiliConfig().config?.agent?.sandbox ?? 'danger-full-access');
      let inspected = false;
      try {
        const ctx = getCtx();
        if (ctx.sessionController?.inspect) { await ctx.sessionController.inspect(sessionId); inspected = true; }
      } catch (error) {
        pluginLog(`[权限] inspect ${sessionId} 失败：${error?.message ?? error}`);
      }
      // inspect 之后 session 可能还没同步进 ctx.sessions。
      if (inspected) await new Promise((resolve) => setTimeout(resolve, 120));
      const result = applySessionPermission(getCtx(), sessionId, target, (message) => pluginLog(message));
      json(res, 200, {
        ok: result.ok,
        sessionId,
        target,
        inspected,
        ...result,
        message: result.ok
          ? (result.changed ? `已切到 ${target}` : `已经是 ${target}`)
          : ({
            'session-not-active': '会话还没挂上（等下一次醒来会自动设置）',
            'permission-services-unavailable': 'DSH 没有提供 permissionPresets 服务',
            'set-failed': `设置失败：${result.error ?? '未知错误'}`,
          }[result.reason] ?? result.reason),
      });
      return;
    }
    if (req.method === 'GET' && pathname.endsWith('/deps')) {
      const result = await runBili(['deps', '--json'], 60_000);
      let parsed = null;
      try { parsed = JSON.parse(result.out); } catch {}
      json(res, 200, { ok: parsed?.ok === true, ...(parsed ?? {}), raw: result.out.slice(0, 2000), err: result.err });
      return;
    }
    if (req.method === 'GET' && pathname.endsWith('/pending')) {
      const file = path.join(BILI_AI_DIR, 'pending-replies.json');
      const data = readJson(file, { items: [] }) ?? { items: [] };
      json(res, 200, { ok: true, items: data.items ?? [] });
      return;
    }
    if (req.method === 'GET' && pathname.endsWith('/automation')) {
      json(res, 200, automationSnapshot());
      return;
    }
    if (req.method === 'GET' && pathname.endsWith('/notify-config')) {
      const cfg = readBiliConfig().config;
      json(res, 200, { ok: true, notify: cfg.notify, listen: cfg.listen, share: cfg.share, quota: cfg.quota });
      return;
    }
    // 「立即分享一次」：转发到桥接控制台的 /api/bili/share-now。
    // 这是**真的会发到群**的操作，UI 侧必须二次确认；这里只做代理，不自己挑素材。
    if (req.method === 'POST' && pathname.endsWith('/share-now')) {
      const result = await callBridge('/api/bili/share-now', { method: 'POST', body: {}, timeoutMs: 120_000 });
      const payload = result.data ?? {};
      // 桥接返回 { ok, result: { ok, sent, card, why } }；这里摊平成 UI 好用的形状。
      const inner = payload.result ?? payload;
      // 留一行日志：点「立即分享一次」后出问题时，能直接看到是桥接没响应还是桥接拒绝。
      pluginLog(`「立即分享一次」bridge=${result.status} ok=${result.ok} sent=${inner.sent ?? 0}`
        + `${inner.card?.bvid ? ` bvid=${inner.card.bvid}` : ''}`
        + `${result.ok ? '' : ` error=${result.error || payload.error || 'unknown'}`}`);
      json(res, result.ok ? 200 : 502, {
        ok: result.ok && payload.ok !== false && inner.ok !== false,
        sent: Number(inner.sent ?? 0),
        card: inner.card ?? null,
        ...(inner.why ? { why: inner.why } : {}),
        ...(result.ok ? {} : { error: result.error || payload.error || '桥接没有响应' }),
      });
      return;
    }
    if (req.method === 'GET' && pathname.endsWith('/accounts')) {
      const cfg = readBiliConfig().config ?? {};
      const fish = readFishAccount();
      // 旧 credentials.json 只有 sessdata/bili_jct/buvid3；mid/昵称回落到配置里的 self。
      if (fish.configured && !fish.mid && cfg.self?.mid) {
        fish.mid = String(cfg.self.mid);
        fish.name = String(cfg.self.name ?? '');
      }
      json(res, 200, {
        ok: true,
        fish,
        owner: readOwnerAccount(),
        expected: {
          self: { mid: String(cfg.self?.mid ?? ''), name: String(cfg.self?.name ?? '') },
          owner: { mid: String(cfg.owner?.mid ?? ''), name: String(cfg.owner?.name ?? '') },
        },
      });
      return;
    }
    if (req.method === 'GET' && pathname.endsWith('/qr/poll')) {
      const id = String(url.searchParams.get('id') ?? '').trim();
      if (!/^qr_[0-9a-f-]{36}$/i.test(id)) { json(res, 400, { ok: false, error: 'id 不合法' }); return; }
      const result = await pollQrLogin(id);
      // ok:false 也是有效状态（wrong-account/failed），用 200 让前端按 status 处理。
      json(res, 200, result);
      return;
    }
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 GET/POST' }); return; }
    const body = await readJsonBody(req);
    const action = String(body.action ?? '');
    if (pathname.endsWith('/qr/start')) {
      const target = body.target === 'fish' ? 'fish' : 'owner';
      const cfg = readBiliConfig().config ?? {};
      const expected = target === 'owner'
        ? { mid: String(cfg.owner?.mid ?? ''), name: String(cfg.owner?.name ?? '') }
        : { mid: String(cfg.self?.mid ?? ''), name: String(cfg.self?.name ?? '') };
      try {
        pluginLog(`[扫码登录] 打开 B站 登录页 target=${target}`);
        const result = await startQrLogin({
          target,
          expectedMid: expected.mid,
          expectedName: expected.name,
          allowSameAsOwner: body.allowSameAsOwner === true,
        });
        json(res, 200, { ok: true, ...result });
      } catch (error) {
        pluginLog(`[扫码登录] 打开失败：${String(error?.message ?? error)}`);
        json(res, 503, {
          ok: false, code: 'bili.qr-start-failed',
          error: String(error?.message ?? error),
          hint: '确认本机有 Edge（扫码用 headless Edge 打开 B站 登录页）；再试一次或重启 DSH 后重试',
        });
      }
      return;
    }
    // 核查已登录账号：读文件 → 再问一次 B站 nav → 核对 mid（不是只信扫码那一刻）。
    if (pathname.endsWith('/account/verify')) {
      const target = body.target === 'fish' ? 'fish' : 'owner';
      try {
        const result = await verifyStoredCredentials(target);
        json(res, 200, { ok: result.ok, target, ...result });
      } catch (error) {
        json(res, 500, {
          ok: false, code: 'bili.verify-failed',
          error: `核查失败：${String(error?.message ?? error).slice(0, 160)}`,
          hint: '确认网络能访问 api.bilibili.com 后重试；持续失败请重新扫码',
        });
      }
      return;
    }

    // 核查「UID 与昵称是否同一个人」：查 B站 公开名片，把真实昵称带回来比对。
    if (pathname.endsWith('/verify-user')) {
      const mid = String(body.mid ?? '').trim();
      const name = String(body.name ?? '').trim();
      if (!/^\d{4,20}$/.test(mid)) {
        json(res, 400, {
          ok: false, code: 'bili.mid-invalid',
          error: `「${mid || '(空)'}」不是合法的 B站 UID`,
          hint: 'B站 UID 是 4~20 位数字（在个人空间地址 space.bilibili.com/<数字> 里能看到）',
        });
        return;
      }
      try {
        const res2 = await fetch(`https://api.bilibili.com/x/web-interface/card?mid=${encodeURIComponent(mid)}`, {
          headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36', referer: 'https://www.bilibili.com/' },
          signal: AbortSignal.timeout(10_000),
        });
        const jsonBody = await res2.json().catch(() => null);
        const actual = jsonBody?.data?.card;
        if (!res2.ok || !actual?.mid) {
          json(res, 200, {
            ok: false, code: 'bili.user-not-found',
            error: `B站 查不到 UID ${mid}${jsonBody?.code ? `（code ${jsonBody.code}）` : ''}`,
            hint: '核对 UID 是否填错（个人空间地址里的数字）；B站 偶发风控时稍后重试',
          });
          return;
        }
        const actualName = String(actual.name ?? '');
        const match = !name || actualName.trim() === name.trim();
        json(res, 200, {
          ok: true, mid: String(actual.mid), actualName, inputName: name, match,
          error: match ? '' : `昵称对不上：UID ${mid} 的 B站 昵称是「${actualName}」，你填的是「${name}」`,
          hint: match ? '' : '点「用 B站 昵称填上」自动改正；或确认 UID 是否填成了别人的',
        });
      } catch (error) {
        json(res, 200, {
          ok: false, code: 'bili.verify-network',
          error: `查询 B站 失败：${String(error?.message ?? error).slice(0, 160)}`,
          hint: '检查网络能否访问 api.bilibili.com；稍后重试',
        });
      }
      return;
    }

    // 换 B站 号：把旧凭据/对齐归档后清掉，允许重新扫码绑定（2026-10-27 用户反馈"换号被卡死"）
    if (pathname.endsWith('/account/reset')) {
      const target = body.target === 'owner' ? 'owner' : (body.target === 'both' ? 'both' : 'fish');
      const archived = [];
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const destDir = path.join(BACKUP_DIR, `bili-switch-${stamp}`);
      const archive = (file, label) => {
        try {
          if (!fs.existsSync(file)) return;
          fs.mkdirSync(destDir, { recursive: true });
          const dest = path.join(destDir, `${label}${path.extname(file) || '.json'}`);
          fs.copyFileSync(file, dest);
          archived.push(maskPath(dest));
        } catch (error) {
          pluginLog(`[换号] 归档失败 ${label}：${String(error?.message ?? error)}`);
        }
      };
      const ownerCred = path.join(BILI_DIR, 'owner-credentials.json');
      if (target === 'fish' || target === 'both') {
        archive(BILI_CRED, 'fish-credentials');
        archive(ALIGN_FILE, 'alignments');
        try { fs.rmSync(BILI_CRED, { force: true }); } catch {}
      }
      if (target === 'owner' || target === 'both') {
        archive(ownerCred, 'owner-credentials');
        try { fs.rmSync(ownerCred, { force: true }); } catch {}
      }
      // 清掉配置里对应的 mid，避免下一次扫码又被"不是当前小肥鱼/主人"挡住
      try {
        const bili = readBiliConfig().config ?? {};
        if (target === 'fish' || target === 'both') bili.self = { mid: '', name: '' };
        if (target === 'owner' || target === 'both') bili.owner = { mid: '', name: '' };
        saveBiliConfig(bili);
      } catch (error) {
        pluginLog(`[换号] 清配置失败：${String(error?.message ?? error)}`);
      }
      pluginLog(`[换号] 已归档并清除 target=${target}；归档 ${archived.length} 个文件`);
      json(res, 200, { ok: true, target, archived });
      return;
    }
    if (pathname.endsWith('/qr/cancel')) {
      const id = String(body.id ?? '').trim();
      if (id) cancelQrLogin(id);
      json(res, 200, { ok: true });
      return;
    }
    if (action === 'cookie') {
      const sessdata = String(body.sessdata ?? '').trim();
      const bili_jct = String(body.bili_jct ?? '').trim();
      const buvid3 = String(body.buvid3 ?? '').trim();
      if (!sessdata || !bili_jct) { json(res, 400, { ok: false, error: 'SESSDATA 和 bili_jct 必填' }); return; }
      fs.mkdirSync(path.dirname(BILI_CRED), { recursive: true });
      writeJsonAtomic(BILI_CRED, { sessdata, bili_jct, buvid3 });
      try { fs.chmodSync(BILI_CRED, 0o600); } catch {}
      let whoNow = null;
      try {
        const navRes = await fetch('https://api.bilibili.com/x/web-interface/nav', {
          headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/', cookie: biliCookieHeader({ sessdata, bili_jct, buvid3 }) },
          signal: AbortSignal.timeout(10_000),
        });
        const navJson = await navRes.json().catch(() => ({}));
        if (navJson?.data?.isLogin && navJson.data.mid) {
          whoNow = { mid: String(navJson.data.mid), name: String(navJson.data.uname ?? '') };
          const bili = readBiliConfig().config;
          bili.self = whoNow;
          saveBiliConfig(bili);
        }
      } catch {}
      json(res, 200, { ok: true, detail: whoNow ? `已写入 ✓ 当前登录：${whoNow.name}（mid ${whoNow.mid}）` : '已写入（但 nav 没确认成功 —— cookie 可能缺项或过期）', self: whoNow });
      return;
    }
    if (action === 'notify-test') {
      const notifyMjs = path.join(BILI_TOOLS_DIR, 'commands', 'notify.mjs');
      const result = await new Promise((resolve) => {
        execFile(findNodeExe(), [notifyMjs, '--test'], { cwd: BILI_TOOLS_DIR, timeout: 60_000, windowsHide: true }, (error, stdout, stderr) => resolve({
          ok: !error, out: String(stdout ?? '').slice(0, 2000), err: String(stderr ?? '').slice(0, 2000),
        }));
      });
      json(res, 200, { ok: result.ok, ...result });
      return;
    }
    if (action === 'pending-approve' || action === 'pending-reject') {
      const id = String(body.id ?? '');
      if (!id) { json(res, 400, { ok: false, error: '需要 id' }); return; }
      if (action === 'pending-reject') {
        const result = await runBili(['reply-draft', 'drop', id], 30_000);
        json(res, 200, { ok: result.ok, out: result.out.slice(0, 500), err: result.err.slice(0, 500) });
        return;
      }
      const take = await runBili(['reply-draft', 'take', id], 30_000);
      let item = null;
      try { item = JSON.parse(take.out.trim().split('\n').pop()); } catch {}
      if (!item) { json(res, 400, { ok: false, error: '队列里没有这条（可能已经发过）', out: take.out.slice(0, 500) }); return; }
      const args = ['comment', '--oid', item.oid, '--root', item.root, '--parent', item.parent,
        '--message', item.message, '--auto', '--go'];
      if (item.bvid) args.push('--bvid', item.bvid);
      const send = await runBili(args, 120_000);
      json(res, 200, { ok: send.ok && /code=0/.test(send.out), out: send.out.slice(-1000), err: send.err.slice(-500) });
      return;
    }
    json(res, 400, { ok: false, error: '未知 action' });
  }

  async function handleTieba(req, res, url) {
    const pathname = url.pathname;
    // 保存 BDUSS 并当场验证（curl 网络层，百度不认 Node fetch 的 TLS 指纹）
    if (pathname.endsWith('/login')) {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return; }
      let body = {};
      try { body = await readJsonBody(req); } catch { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
      try {
        pluginLog('[贴吧登录] 保存 BDUSS');
        const result = await saveTiebaCookieLogin(String(body.cookie ?? body.bduss ?? ''));
        try { markTiebaVerified(); } catch {}
        json(res, 200, { ok: true, ...result });
      } catch (error) {
        pluginLog(`[贴吧登录] 失败：${String(error?.message ?? error)}`);
        json(res, 400, { ok: false, code: String(error?.code ?? ''), error: String(error?.message ?? error) });
      }
      return;
    }
    // 手机扫码登录：换到 BDUSS 后由后端用 curl 验证并落盘，用户不用复制任何东西
    if (pathname.endsWith('/qr/start')) {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return; }
      try {
        pluginLog('[贴吧登录] 生成二维码');
        json(res, 200, { ok: true, ...(await startTiebaQrLogin()) });
      } catch (error) {
        pluginLog(`[贴吧登录] 二维码失败：${String(error?.message ?? error)}`);
        json(res, 503, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    if (pathname.endsWith('/qr/poll')) {
      if (req.method !== 'GET') { json(res, 405, { ok: false, error: '只支持 GET' }); return; }
      const id = String(url.searchParams.get('id') ?? '').trim();
      if (!/^tieba_qr_[0-9a-f-]{36}$/i.test(id)) { json(res, 400, { ok: false, error: 'id 不合法' }); return; }
      const result = await pollTiebaQrLogin(id);
      if (result?.status === 'failed') pluginLog(`[贴吧登录] 扫码失败：${String(result.error ?? '').slice(0, 300)}`);
      if (result?.status === 'confirmed') { try { markTiebaVerified(); } catch {} }
      json(res, 200, result);
      return;
    }
    if (pathname.endsWith('/qr/cancel')) {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return; }
      let body = {};
      try { body = await readJsonBody(req); } catch {}
      cancelTiebaQrLogin(String(body.id ?? '').trim());
      json(res, 200, { ok: true });
      return;
    }
    // 浏览器自动化入口已废弃（Chrome 136 读不到加密 cookie，且要关浏览器）
    if (pathname.endsWith('/open-token')) {
      json(res, 410, {
        ok: false, code: 'tieba.legacy-login-removed',
        error: '领取 token 页已移除，请用扫码登录',
        hint: '点「扫码登录」，手机确认后自动完成',
      });
      return;
    }
    // 旧的浏览器登录入口（已废弃）
    if (pathname.includes('/login/start') || pathname.includes('/login/poll') || pathname.includes('/login/cancel')) {
      json(res, 410, {
        ok: false, code: 'tieba.legacy-login-removed',
        error: '浏览器自动登录已移除，改为粘贴 BDUSS',
        hint: '把 BDUSS 粘贴到输入框，点「保存并测试」',
      });
      return;
    }
    if (pathname.endsWith('/credentials/clear')) {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return; }
      clearTiebaCredentials();
      json(res, 200, { ok: true });
      return;
    }
    if (pathname.endsWith('/account/verify')) {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return; }
      try { json(res, 200, await verifyStoredTiebaCredentials()); }
      catch (error) { json(res, 500, { ok: false, error: `核查失败：${String(error?.message ?? error).slice(0, 160)}` }); }
      return;
    }
    // 看过的帖子（设置页「观看记录」）
    if (req.method === 'GET' && pathname.endsWith('/history')) {
      try {
        json(res, 200, {
          ok: true,
          ...readTiebaViewHistory({
            limit: Number(url.searchParams.get('limit')) || 200,
            q: url.searchParams.get('q') ?? '',
            days: Number(url.searchParams.get('days')) || 0,
          }),
        });
      } catch (error) {
        json(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    // 默认 GET → 状态
    if (req.method === 'GET') { json(res, 200, tiebaStatus()); return; }
    // POST → action 分发（heartbeat-now / verify / feed / ...）
    let body = {};
    try { body = await readJsonBody(req); } catch { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
    const action = String(body.action ?? '');
    if (action === 'heartbeat-now') {
      if (!isSchedulerRunning()) {
        json(res, 400, { ok: false, error: 'B站生物钟没在运行：贴吧跟它共用作息，先启动 B站 平台' });
        return;
      }
      try {
        const result = await getScheduler()?.wakeTieba?.('手动');
        json(res, 200, { ok: true, ...result });
      } catch (error) {
        json(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    const allowed = ['verify', 'feed', 'thread', 'floor', 'replyme', 'post', 'reply', 'like', 'unlike', 'sign', 'delete-thread', 'delete-post', 'rename', 'summary', 'status'];
    if (!allowed.includes(action)) { json(res, 400, { ok: false, error: `未知贴吧动作：${action || '（空）'}` }); return; }
    try {
      const result = await tiebaAction(action, body);
      json(res, 200, { ok: true, ...result });
    } catch (error) {
      json(res, 400, { ok: false, error: String(error?.message ?? error), code: String(error?.code ?? '') });
    }
  }

  return { handleQqFishGuard, handleWatchHistory, handlePreferenceScan, handleBili, handleTieba };
}
