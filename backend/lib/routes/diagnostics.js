/**
 * 模式 / 诊断路由（组件化迁移 #11）。
 *
 * 从 backend/lib/index.js 的 apply(ctx) 闭包里原样搬出，依赖改为显式注入：
 *   · /mode          运行模式与 ownerQQ（本地 mode.json + DSH qq-mode 设置）
 *   · /diagnostics   体检、备份/恢复、新手一键安装（只写缺失项）
 *
 * 一键安装的 job 状态留在本模块闭包；路由分发与全局鉴权/只读降级仍在 index.js。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export function createDiagnosticsRoutes(deps) {
  const {
    getSettings, parseModeState,
    readJsonBody, json, pluginLog,
    readJson, writeJsonAtomic,
    QQ_STATE_DIR, readQqConfig, saveQqConfig, readUnified, saveUnified, readAll, callBridge,
    pathSummary, backupFile, safeBackupName, maskPath, resolvePersonaFile, activeMemoryPaths,
    STATE_DIR, QQBOT_ROOT, DSH_HOME, UNIFIED_FILE, BILI_MJS, BILI_CONFIG, BILI_CRED,
    QQ_CONFIG, ALIGN_FILE, QQ_ALIGNMENT_BRIEF, BILI_ALIGNMENT_FILE, BACKUP_DIR,
    bridgeStatus, astrbotSupervisor, astrbotApi, portOpen, currentDshUrl,
    discoverSnowLumaConnection, diagnoseSnowLuma, buildInstallChecks, installOk, planDoctorFix,
    normalizeAllowlist, startBridge,
  } = deps || {};

  const required = {
    getSettings, parseModeState,
    readJsonBody, json, pluginLog,
    readJson, writeJsonAtomic,
    QQ_STATE_DIR, readQqConfig, saveQqConfig, readUnified, saveUnified, readAll, callBridge,
    pathSummary, backupFile, safeBackupName, maskPath, resolvePersonaFile, activeMemoryPaths,
    STATE_DIR, QQBOT_ROOT, DSH_HOME, UNIFIED_FILE, BILI_MJS, BILI_CONFIG, BILI_CRED,
    QQ_CONFIG, ALIGN_FILE, QQ_ALIGNMENT_BRIEF, BILI_ALIGNMENT_FILE, BACKUP_DIR,
    bridgeStatus, astrbotSupervisor, astrbotApi, portOpen, currentDshUrl,
    discoverSnowLumaConnection, diagnoseSnowLuma, buildInstallChecks, installOk, planDoctorFix,
    normalizeAllowlist, startBridge,
  };
  for (const [name, value] of Object.entries(required)) {
    if (value === undefined || value === null) throw new TypeError(`diagnostics-routes 缺少依赖：${name}`);
  }

  // ── 模式 / ownerQQ ─────────────────────────────────────────────────────
  async function handleMode(req, res) {
    const settings = getSettings();
    if (req.method === 'GET') {
      let dshSetting = null;
      try {
        if (settings?.describe) {
          const rows = settings.describe({ redactSecrets: true });
          const row = rows.find((item) => item.ns === 'qq-mode');
          if (row) dshSetting = row.value;
        }
      } catch {}
      json(res, 200, { ok: true, ...parseModeState(), dshSetting });
      return;
    }
    const body = await readJsonBody(req);
    const mode = body.mode ? String(body.mode) : null;
    const ownerQQ = body.ownerQQ === undefined ? undefined : (body.ownerQQ === '' || body.ownerQQ === null ? null : String(body.ownerQQ));
    if (mode && !['chat', 'closed-agent', 'reserved', 'reserved2', 'simulation'].includes(mode)) {
      json(res, 400, { ok: false, error: 'mode 必须是 chat / closed-agent / reserved / reserved2 / simulation' });
      return;
    }
    const stateFile = path.join(QQ_STATE_DIR(), 'mode.json');
    const current = readJson(stateFile, {}) ?? {};
    const next = { ...current, ...(mode ? { mode } : {}) };
    writeJsonAtomic(stateFile, next);
    if (settings?.update) {
      try {
        await settings.update('qq-mode', {
          ...(mode ? { mode } : {}),
          ...(ownerQQ !== undefined ? { ownerQQ: ownerQQ ?? '' } : {}),
        });
      } catch (error) {
        pluginLog('写 DSH qq-mode 设置失败（本地 mode.json 已写）：', error?.message ?? error);
      }
    }
    if (ownerQQ !== undefined) {
      const qq = readQqConfig().config;
      qq.ownerQQ = ownerQQ;
      saveQqConfig(qq);
    }
    if (mode) {
      try { await callBridge('/api/mode', { method: 'POST', body: { mode } }); } catch {}
    }
    json(res, 200, { ok: true, mode: mode ?? current.mode ?? null, ownerQQ: ownerQQ ?? null, note: '若桥接未运行，下次启动时生效。' });
  }

  // ── 诊断 / 备份 ─────────────────────────────────────────────────────────
  // ── 新手体检（只读）＋ 一键配置（只写"缺失项"，绝不覆盖已有值）────────────
  // 目标：新人装完点一下就知道"还差什么、在哪补"，不用去翻文档。
  function dshProfileWithSurfcore() {
    const root = path.join(DSH_HOME, 'profiles');
    let names = [];
    try { names = fs.readdirSync(root).filter((n) => { try { return fs.statSync(path.join(root, n)).isDirectory(); } catch { return false; } }); } catch { return ''; }
    for (const name of names) {
      // 两种都能作为"已装进 DSH"的证据：
      //   ① profile package.json 的 dsh.profile.bundles 里有 surfcore；
      //   ② cordis.patch.yml 里有我们托管的 mcp 条目（不同版本写的是不同 id）。
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, name, 'package.json'), 'utf8'));
        const bundles = pkg?.dsh?.profile?.bundles;
        if (Array.isArray(bundles) && bundles.includes('surfcore')) return name;
      } catch {}
      try {
        const patch = fs.readFileSync(path.join(root, name, 'cordis.patch.yml'), 'utf8');
        if (/surfcore|mcp-snowluma/.test(patch)) return name;
      } catch {}
    }
    return '';
  }

  async function installChecks() {
    const all = readAll();
    const qqCfg = readQqConfig().config ?? {};
    const snow = qqCfg.snowluma ?? {};
    let snowState = { state: 'unknown', hint: '' };
    try { snowState = await diagnoseSnowLuma(snow); } catch {}
    const bridgeSrc = path.join(QQBOT_ROOT, 'src', 'bridge.js');
    return buildInstallChecks({
      nodeVersion: process.versions.node,
      hasUnified: readUnified().hasUserFile,
      unifiedMasked: maskPath(UNIFIED_FILE),
      ownerQQ: String(all.unified?.admin?.qq ?? '').trim(),
      groups: Array.isArray(qqCfg.allow?.groups) ? qqCfg.allow.groups : [],
      privates: Array.isArray(qqCfg.allow?.private) ? qqCfg.allow.private : [],
      snow,
      snowState,
      bridgeSrc: fs.existsSync(bridgeSrc),
      bridgeMasked: maskPath(bridgeSrc),
      profile: dshProfileWithSurfcore(),
    });
  }

  let installJob = { running: false, startedAt: null, finishedAt: null, steps: [] };

  function installStep(key, name) {
    const step = { key, name, status: 'running', detail: '', at: new Date().toISOString() };
    installJob.steps.push(step);
    return step;
  }

  function runCommand(cmd, args, { cwd, timeoutMs = 600_000 } = {}) {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd, windowsHide: true, shell: process.platform === 'win32' });
      let out = '';
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
      child.stdout?.on('data', (d) => { out += String(d).slice(0, 4000); });
      child.stderr?.on('data', (d) => { out += String(d).slice(0, 4000); });
      child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, out: String(error?.message ?? error) }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out: out.trim() }); });
    });
  }

  async function runInstall(opts) {
    const done = (step, ok, detail = '') => { step.status = ok ? 'ok' : 'fail'; step.detail = String(detail).slice(0, 600); };
    try {
      // 1) 依赖
      const depsStep = installStep('deps', '安装依赖（npm install）');
      if (fs.existsSync(path.join(QQBOT_ROOT, 'node_modules', '.package-lock.json')) || fs.existsSync(path.join(QQBOT_ROOT, 'node_modules', 'express'))) {
        done(depsStep, true, '已经装过，跳过');
      } else {
        const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const r = await runCommand(npm, ['install', '--no-audit', '--no-fund'], { cwd: QQBOT_ROOT, timeoutMs: 900_000 });
        done(depsStep, r.ok, r.ok ? '完成' : (r.out.slice(-400)));
        if (!r.ok) throw new Error('依赖安装失败');
      }

      // 2) 装进 DSH
      const dshStep = installStep('dsh', '装进 DSH（预设 / MCP / bundle）');
      if (dshProfileWithSurfcore()) {
        done(dshStep, true, '已注册，跳过');
      } else {
        // profile 必须跟着"当前 DSH 用的那个"走：setup-dsh 默认写 web，
        // 而用户可能是 desktop/自定义 profile —— 写错地方插件根本不会出现。
        let profile = String(process.env.DSH_PROFILE ?? '').trim();
        if (!profile) {
          try {
            const names = fs.readdirSync(path.join(DSH_HOME, 'profiles')).filter((n) => fs.statSync(path.join(DSH_HOME, 'profiles', n)).isDirectory() && !n.includes('.'));
            profile = names.includes('web') ? 'web' : (names[0] ?? 'web');
          } catch { profile = 'web'; }
        }
        const r = await runCommand(process.execPath, [path.join(QQBOT_ROOT, 'scripts', 'setup-dsh.mjs'), profile], { cwd: QQBOT_ROOT, timeoutMs: 120_000 });
        done(dshStep, r.ok, r.ok ? '已注册（重启 DSH 生效）' : (r.out.slice(-400)));
      }

      // 3) 配置与令牌
      const cfgStep = installStep('config', '生成配置 / 控制台令牌');
      const changed = doctorFix({ ownerQQ: opts.ownerQQ });
      done(cfgStep, true, changed.length ? changed.join('、') : '已经齐了');

      // 4) SnowLuma 端点 / token
      const snowStep = installStep('snowluma', '发现并写入 SnowLuma 连接');
      try {
        const found = await discoverSnowLumaConnection({ cfg: readQqConfig().config ?? {}, timeoutMs: 4000 });
        if (found.ok) {
          const snow = { httpUrl: found.baseUrl };
          if (found.wsUrl) snow.wsUrl = found.wsUrl;
          if (found.token) snow.accessToken = found.token;
          // 2026-11：WS 通道有自己的令牌，漏写会导致 HTTP 能通但 connected 永远 false
          if (found.wsToken) snow.wsToken = found.wsToken;
          saveQqConfig({ snowluma: snow });
          done(snowStep, true, `已连上 ${found.self?.nickname ?? ''}（${found.self?.user_id ?? ''}）`);
        } else {
          done(snowStep, false, String(found.error ?? '没连上：先启动 SnowLuma 并扫码登录'));
        }
      } catch (error) { done(snowStep, false, String(error?.message ?? error)); }

      // 5) 主人 + 白名单
      const idStep = installStep('identity', '写入主人 QQ 与白名单');
      if (opts.groups.length) {
        // 保留用户已有私聊白名单，只追加主人（2026-10-31：以前 [owner] 整体替换会冲掉用户加的人）
        const { allow, warnings } = normalizeAllowlist({
          allow: { ...(readQqConfig().config?.allow ?? {}), groups: opts.groups },
          ownerQQ: opts.ownerQQ,
        });
        saveQqConfig({ allow });
        for (const w of warnings) pluginLog(`[安装] 白名单：${w.code} ${w.message}`);
        done(idStep, true, `${opts.groups.length} 个群${opts.ownerQQ ? ' + 主人私聊' : ''}${warnings.length ? `（${warnings.length} 条修正）` : ''}`);
      } else {
        done(idStep, true, '没选群，跳过（之后在设置 → QQ → 白名单里加）');
      }

      // 6) 起桥接
      const bridgeStep = installStep('bridge', '启动 QQ 桥接');
      try {
        const before = await bridgeStatus().catch(() => ({ running: false }));
        if (before.running) done(bridgeStep, true, `已在运行（端口 ${before.port}）`);
        else {
          await startBridge({ dshWebUrl: currentDshUrl() });
          done(bridgeStep, true, '已启动');
        }
      } catch (error) { done(bridgeStep, false, String(error?.message ?? error)); }
    } catch (error) {
      const last = installJob.steps[installJob.steps.length - 1];
      if (last && last.status === 'running') { last.status = 'fail'; last.detail = String(error?.message ?? error); }
    } finally {
      installJob.running = false;
      installJob.finishedAt = new Date().toISOString();
    }
  }

  function doctorFix(body) {
    const all = readAll();
    const qqCfg = readQqConfig().config ?? {};
    const actions = planDoctorFix({
      hasUnified: readUnified().hasUserFile,
      hasToken: Boolean(String(qqCfg.consoleToken ?? '').trim()),
      ownerQQ: body?.ownerQQ,
      currentOwnerQQ: all.unified?.admin?.qq,
    });
    for (const action of actions) {
      if (action.startsWith('生成统一配置')) saveUnified({});
      else if (action.startsWith('生成控制台令牌')) saveQqConfig({ consoleToken: randomUUID().replace(/-/g, '') });
      else if (action.startsWith('写入管理员 QQ')) saveUnified({ admin: { qq: String(body.ownerQQ).trim() } });
    }
    return actions;
  }

  async function handleDiagnostics(req, res) {
    if (req.method === 'GET') {
      const checks = [];
      const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });
      // 2026-11 新架构（AstrBot 插件桥接）的检查要带 warn 级别和修复建议。
      const addLevel = (name, level, detail = '', fix = '') => checks.push({ name, level, ok: level !== 'fail', detail, fix });
      let bridge = { running: false };
      try { bridge = await bridgeStatus(); } catch {}
      // 先探测新架构的三件套：AstrBot 进程 / dsh_bridge 插件 / SnowLuma OneBot
      let astrbotStatus = null;
      let astrbotPlugins = [];
      try { astrbotStatus = await astrbotSupervisor.status(); } catch { astrbotStatus = null; }
      try { astrbotPlugins = await astrbotApi.listPlugins(); } catch { astrbotPlugins = []; }
      const bridgePlugin = astrbotPlugins.find((p) => p && p.name === 'astrbot_plugin_dsh_bridge' && p.enabled === true) ?? null;
      const astrbotQq = await astrbotApi.isQqConnected().catch(() => false);
      const snowRuntimeUp = (await portOpen(3000)) || (await portOpen(3001));
      // 旧的「SnowLuma 在线」是按内置桥的判断（桥停着就报 onebot-rejected），插件桥接模式下换真相。
      const install = (await installChecks()).filter((c) => !(bridgePlugin && c.name === 'SnowLuma 在线'));

      add('QQ 桥接源码', fs.existsSync(path.join(QQBOT_ROOT, 'src', 'bridge.js')), maskPath(path.join(QQBOT_ROOT, 'src', 'bridge.js')));
      add('B站工具链', fs.existsSync(BILI_MJS), maskPath(BILI_MJS));
      add('B站配置', fs.existsSync(BILI_CONFIG), maskPath(BILI_CONFIG));
      add('B站 cookie', fs.existsSync(BILI_CRED), fs.existsSync(BILI_CRED) ? '已写入（不回显内容）' : '未写入');
      add('人设卡', fs.existsSync(resolvePersonaFile()), maskPath(resolvePersonaFile()));
      const qqMemoryOn = readAll().unified.memory?.qqToBili?.enabled === true;
      add('QQ→B站记忆', qqMemoryOn ? fs.existsSync(activeMemoryPaths().qqForBili) : true,
        qqMemoryOn ? maskPath(activeMemoryPaths().qqForBili) : '未开启（正常）');
      let ffmpeg = false;
      try {
        const result = await new Promise((resolve) => execFile('ffmpeg', ['-version'], { timeout: 5000, windowsHide: true }, (error) => resolve(!error)));
        ffmpeg = result;
      } catch {}
      add('ffmpeg（可选）', ffmpeg, ffmpeg ? '可用' : '未安装：只影响"抽帧看画面"');

      // ── 新架构检查：QQ → SnowLuma → AstrBot（插件层）→ DSH 分会话 ──
      addLevel('AstrBot 运行', astrbotStatus?.running ? 'ok' : 'warn',
        astrbotStatus?.running ? `端口 ${astrbotStatus.port} · 插件 ${astrbotPlugins.length} 个` : '未运行（打开 DSH 会被自动拉起）',
        astrbotStatus?.running ? '' : '设置 → 维护 → AstrBot → 拉起');
      addLevel('QQ 接入（SnowLuma → AstrBot）', astrbotQq ? 'ok' : 'warn',
        astrbotQq ? '6199 反向 WS 已连接' : '6199 没有连接：SnowLuma 没把 QQ 接进 AstrBot',
        astrbotQq ? '' : '重启一次 SnowLuma（自动重连 5 秒）');
      addLevel('QQ 桥接插件（dsh_bridge）', bridgePlugin ? 'ok' : 'warn',
        bridgePlugin ? `${bridgePlugin.name} v${bridgePlugin.version}` : '未安装 / 未启用：QQ 会退回 provider 路线（一个固定会话，没有每段对话的窗口）',
        bridgePlugin ? '' : '设置 → 我的鱼 → 能力与插件 → 安装 astrbot_plugin_dsh_bridge');
      const bridgeHostFile = path.join(STATE_DIR, 'astrbot', 'dsh-bridge.json');
      let bridgeHost = null;
      try { bridgeHost = JSON.parse(fs.readFileSync(bridgeHostFile, 'utf8')); } catch { bridgeHost = null; }
      const bridgeHostOk = Boolean(bridgeHost?.baseUrl && bridgeHost?.token);
      addLevel('桥接发现文件', bridgeHostOk ? 'ok' : 'warn',
        bridgeHostOk ? `${bridgeHost.baseUrl}（DSH 每分钟重写，端口漂移自动跟随）` : '不存在 / 字段不全：插件加载时才会写',
        bridgeHostOk ? '' : '重载一次 dsh-Dfy 插件（或重启 DSH）');
      addLevel('SnowLuma OneBot 端口', snowRuntimeUp ? 'ok' : 'warn',
        snowRuntimeUp ? '3000 / 3001 在听' : '不在听：SnowLuma 没在运行（插件会自动拉起）',
        snowRuntimeUp ? '' : '概览 → 一键开始，或在维护页「只打开 SnowLuma」');
      if (bridgePlugin) {
        addLevel('内置 QQ 桥（旧）', bridge.running ? 'warn' : 'ok',
          bridge.running ? `仍在运行（端口 ${bridge.port}）：插件桥接模式下会和 AstrBot 双回复` : '已停止（插件桥接模式的正确状态）',
          bridge.running ? '设置 → 维护 → 模块与能力：停用 QQ 模块即可停旧桥' : '');
      } else {
        addLevel('QQ 桥接', bridge.running ? 'ok' : 'fail', bridge.running ? `端口 ${bridge.port}` : '未运行', bridge.running ? '' : '概览 → 一键开始');
      }
      // provider 指向：插件桥接模式下不影响 QQ，只影响面板「测试 DSH 大脑」/回退路线
      const routeB = (() => { try { return astrbotApi.getRouteB(); } catch { return { on: false, apiBase: '' }; } })();
      const currentBase = String(currentDshUrl() || '').replace(/\/+$/, '');
      const expectedApiBase = currentBase ? `${currentBase}/dsh-surfcore/v1` : '';
      const routeBStale = Boolean(routeB.on && expectedApiBase && String(routeB.apiBase ?? '').replace(/\/+$/, '') !== expectedApiBase);
      // 本机凭据目录权限（Windows 默认给 Users/Authenticated Users 写权限 → 同机其他账户可读凭据/聊天记录）
      try {
        if (process.platform === 'win32') {
          const aclOut = await new Promise((resolve) => {
            execFile('icacls', [STATE_DIR], { timeout: 5000, windowsHide: true }, (error, stdout) => resolve(error ? '' : String(stdout)));
          });
          const broad = /(Authenticated Users|Users|Everyone):\(.*[MW]/.test(aclOut);
          addLevel('本机凭据目录权限', broad ? 'warn' : 'ok',
            broad ? '当前用户组对凭据/聊天记录目录有写权限（Windows 默认）：同机其他账户可能读到 token 与聊天记录'
              : (aclOut ? '已收紧' : '读不到 ACL：忽略'),
            broad ? '以管理员运行 scripts/harden-state-acl.mjs（或 icacls 收紧 $DSH_HOME/surfcore）' : '');
        } else {
          addLevel('本机凭据目录权限', 'ok', '非 Windows：依赖 0600 文件权限', '');
        }
      } catch { /* ACL 检查失败不影响体检 */ }
      addLevel('dfy-fish 指向', routeBStale ? 'warn' : 'ok',
        routeBStale ? `写的是 ${routeB.apiBase}，当前 DSH 在 ${expectedApiBase}` : (routeB.apiBase || '未配置（插件桥接模式下不影响 QQ）'),
        routeBStale ? '设置 → 我的鱼 → 启动与连接 → 修复指向' : '');

      // 同名检查只留一条（installChecks 与旧 checks 有重叠，比如"QQ 桥接源码"）。
      const seen = new Set();
      const allChecks = [...install, ...checks].filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
      json(res, 200, { ok: allChecks.every((c) => c.ok || c.name.includes('可选')), checks: allChecks, installOk: installOk(install), install: installJob, bridge, paths: pathSummary() });
      return;
    }
    const body = await readJsonBody(req);
    // ── 一键安装：发现 SnowLuma → 拉群 → 写配置（只写这一台机器上真实存在的群）
    if (body.action === 'install-scan') {
      const cfg = readQqConfig().config ?? {};
      let found = { ok: false, error: '未探测' };
      try { found = await discoverSnowLumaConnection({ cfg, timeoutMs: 4000 }); } catch (error) { found = { ok: false, error: String(error?.message ?? error) }; }
      let groups = [];
      if (found.ok) {
        try {
          const resp = await fetch(`${found.baseUrl}/get_group_list`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(found.token ? { Authorization: `Bearer ${found.token}` } : {}) },
            body: '{}',
            signal: AbortSignal.timeout(10_000),
          });
          const data = await resp.json().catch(() => ({}));
          groups = (Array.isArray(data?.data) ? data.data : [])
            .map((g) => ({ id: String(g.group_id ?? ''), name: String(g.group_name ?? '') }))
            .filter((g) => /^\d{5,15}$/.test(g.id));
        } catch {}
      }
      json(res, 200, {
        ok: found.ok,
        error: found.ok ? '' : String(found.error ?? '连不上 SnowLuma'),
        snow: {
          online: Boolean(found.ok),
          uin: String(found.self?.user_id ?? ''),
          nickname: String(found.self?.nickname ?? ''),
          httpUrl: found.baseUrl ?? '',
          wsUrl: found.wsUrl ?? '',
          hasToken: Boolean(found.token),
          wsToken: Boolean(found.wsToken),
        },
        groups,
      });
      return;
    }
    // ── 一键安装：把整机装成"能用"的状态（依赖 → 装进 DSH → 配置 → SnowLuma → 白名单 → 桥接）
    if (body.action === 'install-run') {
      if (installJob.running) { json(res, 200, { ok: true, install: installJob }); return; }
      const opts = {
        ownerQQ: String(body.ownerQQ ?? '').trim(),
        groups: (Array.isArray(body.groups) ? body.groups : []).map((g) => String(g ?? '').trim()).filter((g) => /^\d{5,15}$/.test(g)),
      };
      installJob = { running: true, startedAt: new Date().toISOString(), finishedAt: null, steps: [] };
      void runInstall(opts);
      json(res, 200, { ok: true, install: installJob });
      return;
    }
    if (body.action === 'install-apply') {
      const changed = [];
      const cfg = readQqConfig().config ?? {};
      // 1) 端点 / token：服务端再发现一次（不把 token 交给浏览器）
      if (body.discoverSnow !== false) {
        try {
          const found = await discoverSnowLumaConnection({ cfg, timeoutMs: 4000 });
          if (found.ok) {
            const snow = { httpUrl: found.baseUrl };
            if (found.wsUrl) snow.wsUrl = found.wsUrl;
            if (found.token) snow.accessToken = found.token;
            // 2026-11：WS 通道有自己的令牌，漏写会导致 HTTP 能通但 connected 永远 false
            if (found.wsToken) snow.wsToken = found.wsToken;
            saveQqConfig({ snowluma: snow });
            changed.push('写入 SnowLuma 地址与 token');
          }
        } catch {}
      }
      // 2) 主人 QQ（用户确认过的才写）
      const owner = String(body.ownerQQ ?? '').trim();
      if (/^\d{5,15}$/.test(owner)) {
        saveUnified({ admin: { qq: owner } });
        changed.push('写入管理员 QQ');
      }
      // 3) 白名单：只写用户点过 confirm 的那些群
      const groups = (Array.isArray(body.groups) ? body.groups : [])
        .map((g) => String(g ?? '').trim())
        .filter((g) => /^\d{5,15}$/.test(g));
      if (body.applyGroups && groups.length) {
        // 同样保留现有私聊白名单（2026-10-31 反馈：安装/诊断修复后用户加的人丢失）
        const { allow, warnings } = normalizeAllowlist({
          allow: { ...(cfg.allow ?? {}), groups },
          ownerQQ: owner || cfg.ownerQQ || '',
        });
        saveQqConfig({ allow });
        for (const w of warnings) pluginLog(`[install-apply] 白名单：${w.code} ${w.message}`);
        changed.push(`写入白名单（${groups.length} 个群${owner ? ' + 主人私聊' : ''}${warnings.length ? `，${warnings.length} 条修正` : ''}）`);
      }
      // 4) 配置骨架 / 控制台令牌
      for (const action of doctorFix({ ownerQQ: owner })) {
        if (!changed.includes(action)) changed.push(action);
      }
      json(res, 200, { ok: true, changed, needRestart: changed.some((c) => /DSH|白名单/.test(c)) });
      return;
    }
    if (body.action === 'doctor-fix') {
      const changed = doctorFix(body);
      json(res, 200, { ok: true, changed, restartRequired: changed.length > 0 });
      return;
    }
    if (body.action === 'backup') {
      const created = [];
      for (const [label, file] of [
        ['qq-config', QQ_CONFIG], ['bili-config', BILI_CONFIG], ['unified-config', path.join(STATE_DIR, 'config.json')],
        ['persona', resolvePersonaFile()], ['alignments', ALIGN_FILE],
        ['qq-memory', activeMemoryPaths().qqForBili], ['qq-alignment', QQ_ALIGNMENT_BRIEF], ['bili-alignment', BILI_ALIGNMENT_FILE],
      ]) {
        const out = backupFile(file, label);
        if (out) created.push({ label, file: maskPath(out) });
      }
      json(res, 200, { ok: true, created });
      return;
    }
    if (body.action === 'restore') {
      const name = safeBackupName(body.name);
      if (!name) { json(res, 400, { ok: false, error: '备份名非法' }); return; }
      const source = path.join(BACKUP_DIR, name);
      if (!fs.existsSync(source)) { json(res, 404, { ok: false, code: 'PERSONA_BACKUP_MISSING', error: '备份不存在', hint: '刷新备份列表后重试' }); return; }
      const map = [
        ['qq-config-', QQ_CONFIG], ['bili-config-', BILI_CONFIG], ['unified-config-', path.join(STATE_DIR, 'config.json')],
        ['persona-', resolvePersonaFile()], ['alignments-', ALIGN_FILE],
      ];
      const hit = map.find(([prefix]) => name.startsWith(prefix));
      if (!hit) { json(res, 400, { ok: false, error: '这个备份不支持一键恢复（请手动复制）' }); return; }
      backupFile(hit[1], 'before-restore');
      fs.copyFileSync(source, hit[1]);
      json(res, 200, { ok: true, restored: name, target: maskPath(hit[1]) });
      return;
    }
    json(res, 400, { ok: false, error: '未知 action' });
  }

  return { handleMode, handleDiagnostics };
}
