/**
 * 桥接动作路由（组件化迁移 #11b）。
 *
 * 从 backend/lib/index.js 的 apply(ctx) 闭包里原样搬出，依赖改为显式注入：
 *   · /bridge            桥接状态 / 启停 / 重启 / 一键开始 / SnowLuma 探测与拉起
 *   · 启动项动作         平台启动开关、组件启停、启动完成弹窗
 *
 * 所有 action 分支、状态码、错误文案、日志与顺序均保持原样；
 * 路由分发与全局鉴权/只读降级仍在 index.js。
 */
export function createBridgeActions(deps) {
  const {
    json, readJsonBody, bridgeStatus, startBridge, restartBridge, stopBridge,
    currentDshUrl, launchSnowLuma, platformStartEnabled, platformStartState,
    bridgeStaleReason, idleSchedulerStatus, startSchedulerNow,
    getScheduler, getSchedulerStatus,
    runLaunchAction, startComponent, watchStartupCompletion,
    snowLumaWebui, portOpen, openLocalUrl,
    readQqConfig, saveQqConfig, findSnowLumaInstall, enableSnowLumaAutoHook,
    discoverSnowLumaConnection, normalizeSnowLumaInstall, snowLumaMissingReport,
    callBridge, refreshBiliToQq,
  } = deps || {};

  const required = {
    json, readJsonBody, bridgeStatus, startBridge, restartBridge, stopBridge,
    currentDshUrl, launchSnowLuma, platformStartEnabled, platformStartState,
    bridgeStaleReason, idleSchedulerStatus, startSchedulerNow,
    getScheduler, getSchedulerStatus,
    runLaunchAction, startComponent, watchStartupCompletion,
    snowLumaWebui, portOpen, openLocalUrl,
    readQqConfig, saveQqConfig, findSnowLumaInstall, enableSnowLumaAutoHook,
    discoverSnowLumaConnection, normalizeSnowLumaInstall, snowLumaMissingReport,
    callBridge, refreshBiliToQq,
  };
  for (const [name, value] of Object.entries(required)) {
    if (value === undefined || value === null) throw new TypeError(`bridge-actions-routes 缺少依赖：${name}`);
  }

  async function handleBridge(req, res) {
    if (req.method === 'GET') { json(res, 200, { ok: true, status: await bridgeStatus() }); return; }
    const body = await readJsonBody(req);
    const action = String(body.action ?? 'status');
    if (action === 'status') { json(res, 200, { ok: true, status: await bridgeStatus() }); return; }
    if (action === 'start') {
      if (!platformStartEnabled('qq')) {
        json(res, 409, { ok: false, error: 'QQ 启动开关已关闭：去「维护 → QQ（旧桥）」打开「启动 QQ」并保存' });
        return;
      }
      json(res, 200, await startBridge({ dshWebUrl: currentDshUrl() }));
      return;
    }
    if (action === 'start-qq') {
      // 概览的「启动 QQ」：桥接 + 按需打开 SnowLuma（仍是用户显式点击，不自动弹）。
      if (!platformStartEnabled('qq')) {
        json(res, 409, { ok: false, error: 'QQ 启动开关已关闭：去「QQ」页打开「启动 QQ」并保存' });
        return;
      }
      const bridge = await startBridge({ dshWebUrl: currentDshUrl() });
      const snowluma = await launchSnowLuma();
      json(res, 200, {
        ok: bridge?.ok !== false,
        message: [bridge?.message, snowluma?.message || snowluma?.error].filter(Boolean).join('；'),
        bridge,
        snowluma,
      });
      return;
    }
    if (action === 'start-bili') {
      if (!platformStartEnabled('bili')) {
        json(res, 409, { ok: false, error: 'B站 启动开关已关闭：去「B站」页打开「启动 B站」并保存' });
        return;
      }
      const running = Boolean(getScheduler() && getSchedulerStatus().running);
      const schedulerState = startSchedulerNow();
      json(res, 200, {
        ok: schedulerState.running === true,
        message: running ? 'B站生物钟本来就在跑' : (schedulerState.running ? 'B站生物钟已启动' : `B站生物钟未启动：${schedulerState.lastError ?? '看插件日志'}`),
        scheduler: schedulerState,
      });
      return;
    }
    if (action === 'start-selected' || action === 'start-components') {
      json(res, 200, await runLaunchAction('start', body));
      return;
    }
    if (action === 'stop-selected' || action === 'stop-components') {
      json(res, 200, await runLaunchAction('stop', body));
      return;
    }
    if (action === 'start-all') {
      // 一键启动：按平台启动开关拉起 QQ 桥接 / B站生物钟；QQ 打开时才尝试打开 SnowLuma。
      const starts = platformStartState();
      const status = await bridgeStatus();
      const stale = await bridgeStaleReason(status);
      const dshWebUrl = currentDshUrl();
      const bridge = starts.qq
        ? (stale ? await restartBridge({ dshWebUrl }) : await startBridge({ dshWebUrl }))
        : { ok: true, skipped: true, message: 'QQ 启动开关关闭，已跳过桥接' };
      const schedulerState = starts.bili
        ? startSchedulerNow()
        : { ...idleSchedulerStatus('disabled'), message: 'B站 启动开关关闭，已跳过生物钟' };
      const snowluma = starts.qq ? await launchSnowLuma() : { ok: true, skipped: true, message: 'QQ 启动开关关闭，已跳过 SnowLuma' };
      const coreOk = (!starts.qq || bridge?.ok !== false) && (!starts.bili || schedulerState.running);
      const message = [
        bridge?.message,
        starts.bili ? (schedulerState.running ? 'B站生物钟在跑' : 'B站生物钟未启动') : '',
        snowluma?.message || snowluma?.error,
        starts.qq || starts.bili ? '启动完成后会弹窗告诉你结果' : 'QQ 和 B站 的启动开关都关着，没有需要启动的平台',
      ].filter(Boolean).join('；');
      json(res, 200, {
        ok: coreOk,
        pending: starts.qq || starts.bili,
        message,
        bridge,
        scheduler: schedulerState,
        snowluma,
        platformStart: starts,
      });
      if (starts.qq || starts.bili) void watchStartupCompletion(starts);
      return;
    }
    if (action === 'start-snowluma') {
      json(res, 200, await launchSnowLuma());
      return;
    }
    // 一键打开 SnowLuma 控制台（扫码登录 / 添加 QQ 账号都在它自己的 WebUI 里做）。
    // 插件只开本机回环地址，不接受外部 URL。
    if (action === 'open-snowluma-webui') {
      const webui = snowLumaWebui();
      const up = await portOpen(webui.port);
      const opened = up ? openLocalUrl(webui.url) : false;
      json(res, 200, {
        ok: opened,
        opened,
        webui: { ...webui, up },
        error: opened ? '' : (up
          ? '打不开系统浏览器（可能不在本机桌面）'
          : `SnowLuma 控制台没在监听 ${webui.url}：先点「启动」拉起 SnowLuma`),
        hint: up ? '在控制台里扫码登录 / 添加 QQ 账号；登录后 Bridge 会自动连上' : '点「启动」会拉起 SnowLuma 并自动打开控制台',
      });
      return;
    }
    // 一键开始（傻瓜式）：识别安装 → 拉起 SnowLuma（要扫码就自动开控制台）→ 等 OneBot →
    // 自动发现并写入当前账号 → 启动桥接 → 启动 B站。用户只需要点一次。
    if (action === 'auto-start') {
      const steps = [];
      const add = (id, label, ok, detail) => { steps.push({ id, label, ok: ok !== false, detail: String(detail ?? '') }); };

      // 1) 安装位置
      const launcherPath = String(readQqConfig().config?.snowluma?.launcherPath ?? '').trim();
      if (!launcherPath) {
        const found = findSnowLumaInstall();
        if (found.ok) { saveQqConfig({ snowluma: { launcherPath: found.root, allowLaunch: true } }); add('detect', '识别 SnowLuma', true, found.root); }
        else add('detect', '识别 SnowLuma', false, found.error || '没找到 SnowLuma：去「安装与维护」页点「手动选择」指定目录');
      } else add('detect', '识别 SnowLuma', true, launcherPath);

      // 2) 拉起 SnowLuma（后台运行、无命令窗；已登录过就不再弹控制台）
      const launched = await launchSnowLuma().catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
      add('launch', '启动 SnowLuma', launched.ok !== false, launched.message || launched.error || '');

      // 2.5) 自动注入：SnowLuma 的 hookAutoLoad 出厂是 false，不开就会卡在 QQ 这一步等人去点控制台
      const hookRoot = String(readQqConfig().config?.snowluma?.launcherPath ?? '').trim();
      const hookOn = enableSnowLumaAutoHook(hookRoot);
      add('inject', '开启 QQ 自动注入', hookOn, hookOn ? '已开启：SnowLuma 会自动注入 QQ 进程' : '没找到 runtime.json（安装位置可能不对）');

      // 3) 等 OneBot 起来（最多 20 秒；已知要扫码就不干等），顺手把当前账号写进配置
      let account = null;
      let wroteConfig = false;
      const deadline = Date.now() + (launched.needsLogin === true ? 0 : 20_000);
      // loop-allow: 等 OneBot 端口就绪；deadline 到点 break
      while (true) {
        if ((await portOpen(3000)) || (await portOpen(3001))) {
          const found = await discoverSnowLumaConnection({ cfg: readQqConfig().config ?? {}, timeoutMs: 5000 }).catch(() => null);
          if (found?.ok) {
            const snow = { httpUrl: found.baseUrl };
            if (found.wsUrl) snow.wsUrl = found.wsUrl;
            if (found.token) snow.accessToken = found.token;
            // 2026-11：WS 通道有自己的令牌，漏写会导致 HTTP 能通但 connected 永远 false
            if (found.wsToken) snow.wsToken = found.wsToken;
            saveQqConfig({ snowluma: snow });
            wroteConfig = true;
            account = { nickname: String(found.self?.nickname ?? ''), uin: String(found.self?.user_id ?? ''), httpUrl: found.baseUrl };
            break;
          }
        }
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      if (account) add('account', '识别并写入账号', true, `${account.nickname || '已登录'}（${account.uin || '?'}）`);
      else {
        const hint = launched.needsLogin
          ? '还没扫码登录：去 SnowLuma 控制台登录一次，之后就不用再开了'
          : '没连上 QQ：先确认电脑上的 QQ 客户端已打开并登录（SnowLuma 靠注入 QQ 进程工作），然后点「重新检测」';
        add('account', '识别并写入账号', false, hint);
      }

      // 4) QQ 桥接（配置变了就重启，让桥接读新 token）
      if (!platformStartEnabled('qq')) {
        add('bridge', '启动 QQ 桥接', true, 'QQ 启动开关关闭，跳过');
      } else {
        try {
          const before = await bridgeStatus().catch(() => ({ running: false }));
          if (before.running && wroteConfig) { await restartBridge({ dshWebUrl: currentDshUrl() }); add('bridge', '重启 QQ 桥接', true, '已按新账号重启'); }
          else if (before.running) add('bridge', '启动 QQ 桥接', true, `已在运行（端口 ${before.port}）`);
          else { await startBridge({ dshWebUrl: currentDshUrl() }); add('bridge', '启动 QQ 桥接', true, '已启动'); }
        } catch (error) { add('bridge', '启动 QQ 桥接', false, String(error?.message ?? error)); }
      }

      // 5) B站（按平台开关，不额外点）
      if (!platformStartEnabled('bili')) add('bili', '启动 B站', true, 'B站 启动开关关闭，跳过');
      else {
        const item = await startComponent('bili').catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
        add('bili', '启动 B站', item.ok !== false, item.message || item.error || '');
      }

      const webui = snowLumaWebui();
      const status = await bridgeStatus().catch(() => null);
      json(res, 200, {
        ok: steps.every((s) => s.ok),
        steps,
        account,
        needsLogin: !account,
        webui: { ...webui, up: await portOpen(webui.port) },
        bridge: status,
      });
      return;
    }
    if (action === 'detect-snowluma') {
      // 可选 path：用户点「浏览…」选了解压目录/app 目录/launcher.bat 时，**只验证这个路径**——
      // 用户明确选了一个，就不能悄悄回退去猜别的目录（否则会"检测成功"但保存的是另一份安装）。
      const picked = String(body.path ?? '').trim();
      const direct = picked ? normalizeSnowLumaInstall(picked) : null;
      const found = picked
        ? (direct ? { ok: true, ...direct, tried: [{ path: picked, ok: true }] } : { ok: false, tried: [{ path: picked, ok: false }] })
        : findSnowLumaInstall();
      if (!found.ok) {
        // 失败必须有结构化报告：code + 人读的 error + 下一步 hint + 试过的路径（AGENTS 1.7）。
        const report = snowLumaMissingReport({ picked, tried: found.tried.map((x) => x.path).slice(0, 12) });
        json(res, 200, { ok: false, code: report.code, title: report.title, error: report.error, hint: report.hint, tried: report.tried });
        return;
      }
      saveQqConfig({ snowluma: { launcherPath: found.root, allowLaunch: true } });
      json(res, 200, { ok: true, found: true, path: found.root, launcher: found.launcher, message: `已找到 SnowLuma：${found.root}` });
      return;
    }
    if (action === 'stop') { json(res, 200, await stopBridge()); return; }
    if (action === 'restart') {
      if (!platformStartEnabled('qq')) {
        json(res, 409, { ok: false, error: 'QQ 启动开关已关闭：先在「QQ」页打开「随插件自动启动 QQ」并保存' });
        return;
      }
      json(res, 200, await restartBridge({ dshWebUrl: currentDshUrl() }));
      return;
    }
    if (action === 'greeting-test') {
      const result = await callBridge('/api/greeting/test', { method: 'POST', body: {} });
      json(res, result.status || 200, result.data ?? { ok: result.ok, error: result.error });
      return;
    }
    // 目的机制：状态 / 只读预览 / 立刻试一次（真发，设置页会先 confirm）。
    if (action === 'purpose-status') {
      const result = await callBridge('/api/purpose/status', { timeoutMs: 8000 });
      json(res, result.status || 200, result.data ?? { ok: result.ok, error: result.error });
      return;
    }
    if (action === 'purpose-preview') {
      const result = await callBridge('/api/purpose/preview', { method: 'POST', body: {}, timeoutMs: 20000 });
      json(res, result.status || 200, result.data ?? { ok: result.ok, error: result.error });
      return;
    }
    if (action === 'purpose-run') {
      const result = await callBridge('/api/purpose/run', { method: 'POST', body: { force: true }, timeoutMs: 25000 });
      json(res, result.status || 200, result.data ?? { ok: result.ok, error: result.error });
      return;
    }
    if (action === 'refresh-bili') { json(res, 200, await refreshBiliToQq({ callBridge })); return; }
    json(res, 400, { ok: false, error: '未知 action' });
  }

  return { handleBridge };
}
