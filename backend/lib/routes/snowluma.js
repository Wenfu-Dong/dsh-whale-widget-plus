/**
 * SnowLuma 路由与启动控制（组件化迁移 #11）。
 *
 * 从 backend/lib/index.js 的 apply(ctx) 闭包里原样搬出，依赖改为显式注入：
 *   · /snowluma             控制台直连（账号 / 注入进程 / 登录态）
 *   · 端口探测与安装识别    portOpen / findSnowLumaInstall / snowLumaWebui
 *   · 启动与自愈            launchSnowLuma / diagnoseSnowLuma / 启动完成弹窗
 *
 * 默认仍不允许自动拉起：必须用户在设置页显式开启 snowluma.allowLaunch。
 * 路由分发与全局鉴权/只读降级仍在 index.js。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discoverSnowLumaConnection, readOneBotTokens, snowLumaHomeCandidates } from '../../../src/snowluma-conn.js';
import { findSnowLumaInstall as findSnowLumaInstallIn } from '../snowluma-install.js';
import { createSnowLumaWebuiClient } from '../snowluma-webui.js';

export function createSnowLumaRoutes(deps) {
  const {
    readQqConfig, saveQqConfig, readUnified, readJsonBody, json, pluginLog,
    QQBOT_ROOT, STATE_DIR, writeFileAtomic, writeJsonAtomic,
    bridgeStatus, currentDshUrl, getSchedulerRunning,
  } = deps || {};

  const required = {
    readQqConfig, saveQqConfig, readUnified, readJsonBody, json, pluginLog,
    QQBOT_ROOT, STATE_DIR, writeFileAtomic, writeJsonAtomic,
    bridgeStatus, currentDshUrl, getSchedulerRunning,
  };
  for (const [name, value] of Object.entries(required)) {
    if (value === undefined || value === null) throw new TypeError(`snowluma-routes 缺少依赖：${name}`);
  }

  // ── SnowLuma 启动（只打开本机已安装程序，不安装、不部署、不代扫码）──────
  // 默认关闭；必须用户在设置页显式开启 snowluma.allowLaunch，且只在点击
  // 「一键启动 / 打开 SnowLuma」时执行。源码/测试里的 L6 边界仍保持：
  // MCP 工具面没有 start_snowluma，桥接本身也只探测不启动。
  function portOpen(port, timeout = 600) {
    return new Promise((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      const done = (ok) => { socket.destroy(); resolve(ok); };
      socket.setTimeout(timeout);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
  }

  function resolveSnowLumaLauncher() {
    const cfg = readQqConfig().config?.snowluma ?? {};
    const explicit = String(cfg.launchScript ?? '').trim();
    if (explicit) return path.isAbsolute(explicit) ? explicit : path.resolve(QQBOT_ROOT, explicit);
    const base = String(cfg.launcherPath ?? '').trim();
    if (!base) return '';
    const root = path.isAbsolute(base) ? base : path.resolve(QQBOT_ROOT, base);
    const candidates = [
      path.join(root, 'app', 'launcher.bat'),
      path.join(root, 'launcher.bat'),
      path.join(root, 'SnowLuma.exe'),
    ];
    return candidates.find((file) => { try { return fs.existsSync(file); } catch { return false; } }) ?? '';
  }

  // SnowLuma 安装位置识别：规则在 snowluma-install.js（「检测」与「浏览…」共用同一套，
  // 避免两边各猜各的）。这里只负责把当前 QQ 配置喂进去。
  function findSnowLumaInstall(extraPaths = []) {
    const snow = readQqConfig().config?.snowluma ?? {};
    return findSnowLumaInstallIn({ snowluma: snow, extraPaths });
  }

  // SnowLuma 没有原生窗口，它的界面是 WebUI（默认 http://127.0.0.1:5099）。
  // 端口从 SnowLuma 自己的 runtime.json 读，读不到就回退 5099（SnowLuma 2.3.x 默认）。
  function snowLumaWebui() {
    const cfg = readQqConfig().config?.snowluma ?? {};
    let port = 5099;
    try {
      const root = String(cfg.launcherPath ?? '').trim();
      if (root) {
        const runtime = JSON.parse(fs.readFileSync(path.join(root, 'app', 'config', 'runtime.json'), 'utf8'));
        if (Number(runtime?.webuiPort) > 0) port = Number(runtime.webuiPort);
      }
    } catch {}
    return { port, url: `http://127.0.0.1:${port}` };
  }

  // 面板直连 SnowLuma WebUI：账号列表 / QQ 注入进程都在设置页里管（密码只存本机，不回显）。
  const snowlumaWebuiClient = createSnowLumaWebuiClient({
    baseUrl: () => snowLumaWebui().url,
    readConfig: () => readQqConfig().config ?? {},
    saveConfig: (patch) => saveQqConfig(patch),
    log: pluginLog,
  });

  // 只用系统默认浏览器打开本地回环地址；URL 由端口拼出，不接受外部输入。
  function openLocalUrl(url) {
    if (process.env.SURFCORE_SKIP_AUTOSTART === '1') return false;
    if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(String(url))) return false;
    try {
      spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '""', `"${url}"`], {
        detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true,
      }).unref();
      return true;
    } catch {
      return false;
    }
  }

  // SnowLuma 连不上时到底卡在哪一步：进程没起 / 停在登录页 / token 或端口不对。
  // 桥接的 goodError 只有一句 fetch failed，光看它没法给用户任何可执行的信息。
  //
  // 2026-11-15 真机修正：以前只要 3000/3001 在监听、桥接没连上，就报「token 不匹配」。
  // 但桥接没启动时本来就不会连 —— 实测 token 完全正确也会被误报。这里直接按配置里的
  // accessToken 打一次 get_login_info，用真实响应判断，而不是靠“端口开着”猜。
  async function probeOneBotLogin(snow = {}) {
    const httpUrl = String(snow.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const token = String(snow.accessToken || '').trim();
    try {
      const res = await fetch(`${httpUrl}/get_login_info`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: '{}',
        signal: AbortSignal.timeout(4000),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.status === 'ok') {
        return { ok: true, nickname: String(data?.data?.nickname ?? ''), userId: String(data?.data?.user_id ?? '') };
      }
      return { ok: false, status: res.status, wording: String(data?.wording || data?.message || '') };
    } catch (error) {
      return { ok: false, status: 0, wording: String(error?.message ?? error) };
    }
  }

  async function diagnoseSnowLuma(bridgeSnow = {}) {
    if (bridgeSnow.connected === true) return { state: 'ok', hint: '' };
    const webui = snowLumaWebui();
    const onebot = (await portOpen(3000)) || (await portOpen(3001));
    const webuiUp = await portOpen(webui.port);
    if (onebot) {
      const probe = await probeOneBotLogin(bridgeSnow);
      if (probe.ok) return { state: 'ok', hint: '' };
      const detail = probe.status ? `HTTP ${probe.status}${probe.wording ? ` ${probe.wording}` : ''}` : probe.wording;
      return {
        state: 'onebot-rejected',
        hint: `OneBot 端口在监听但鉴权失败${detail ? `（${detail}）` : ''}：对齐 config.json 的 snowluma.accessToken，或确认 httpUrl 不是 WebSocket 端口`,
      };
    }
    if (webuiUp) {
      return { state: 'needs-login', hint: `SnowLuma 已启动但还没登录：打开 ${webui.url} 扫码/登录` };
    }
    return { state: 'not-running', hint: 'SnowLuma 没在运行：设置 → 维护 → SnowLuma 安装与运行 → 只打开 SnowLuma' };
  }

  // SnowLuma 自带「发现 QQ 进程就自动注入」的开关：app/config/runtime.json 的 hookAutoLoad。
  // 出厂是 false，所以不手动去它控制台点「注入」就会卡在 QQ 这一步——这正是用户反馈的问题。
  function snowLumaRuntimeFile(root) {
    const base = String(root ?? '').trim();
    if (!base) return '';
    const abs = path.isAbsolute(base) ? base : path.resolve(QQBOT_ROOT, base);
    const file = path.join(abs, 'app', 'config', 'runtime.json');
    try { return fs.existsSync(file) ? file : ''; } catch { return ''; }
  }
  function enableSnowLumaAutoHook(root) {
    const file = snowLumaRuntimeFile(root);
    if (!file) return false;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw?.hookAutoLoad === true) return true;
      writeFileAtomic(file, `${JSON.stringify({ ...raw, hookAutoLoad: true }, null, 2)}\n`, { mode: 0o600 });
      pluginLog('[snowluma] 已开启自动注入（hookAutoLoad=true），以后不用再去控制台点「注入」');
      return true;
    } catch (error) {
      pluginLog('[snowluma] 开启自动注入失败：', error?.message ?? error);
      return false;
    }
  }
  // 本机有没有登录过的账号记录（app/config/onebot_<uin>.json）。
  // 有 ⇒ 以前扫码登录过，这次只是没注入/没连上，就不该再弹控制台打扰。
  function snowLumaHasLocalAccount(root) {
    const base = String(root ?? '').trim();
    if (!base) return false;
    const abs = path.isAbsolute(base) ? base : path.resolve(QQBOT_ROOT, base);
    try {
      return fs.readdirSync(path.join(abs, 'app', 'config'))
        .some((name) => /^onebot_\d+\.json$/.test(name));
    } catch { return false; }
  }

  // Windows 上要真正「不出现控制台窗口」，只能靠 wscript 的 Run(cmd, 0, False)。
  // 实测 Node 的 spawn({ windowsHide: true, detached: true }) 仍会弹出一个 Windows Terminal 标签页
  // （标题就是 node.exe 路径），用户反馈的「SnowLuma 启动还有命令弹窗」就是这个。
  function spawnHidden(commandLine, cwd) {
    // 命令/路径里出现换行会把 .vbs 拆成两行、等于往脚本里注入语句；引号已有 `""` 转义，
    // 换行没有——所以在所有平台一律拒绝换行（安全审查 2026-11）。
    if (/[\r\n]/.test(String(commandLine ?? ''))) throw new Error('命令里不能含换行');
    if (/[\r\n]/.test(String(cwd ?? ''))) throw new Error('工作目录不能含换行');
    if (process.platform !== 'win32') {
      spawn(String(commandLine), [], { cwd, detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return true;
    }
    const esc = (value) => String(value ?? '').replace(/"/g, '""');
    const vbs = [
      'Set sh = CreateObject("WScript.Shell")',
      `sh.CurrentDirectory = "${esc(cwd)}"`,
      `sh.Run "${esc(commandLine)}", 0, False`,
      '',
    ].join('\r\n');
    const file = path.join(os.tmpdir(), `surfcore-hidden-${process.pid}-${Date.now()}.vbs`);
    // VBScript 在 wscript 下按 UTF-16LE + BOM 读最稳
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(vbs, 'utf16le')]));
    const child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'), ['//nologo', file], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    setTimeout(() => { try { fs.unlinkSync(file) } catch {} }, 60_000).unref?.();
    return true;
  }

  // SnowLuma 拉起状态落盘：桥接的弹窗决策要用（src/bridge.js readSnowLumaLaunchState）。
  // 自愈还在进行→桥接不弹窗；自愈失败→弹真实原因而不是笼统的 code=1006。
  // 所有启动路径（自愈巡检 / 一键开始 / 概览按钮）都走 launchSnowLuma，这里写一次全覆盖。
  function recordSnowLumaLaunchState(patch) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      writeJsonAtomic(path.join(STATE_DIR, 'snowluma-launch-state.json'), {
        version: 1,
        at: Date.now(),
        ...patch,
      });
    } catch { /* 状态写不进去只影响弹窗文案，不影响拉起本身 */ }
  }

  async function launchSnowLuma() {
    recordSnowLumaLaunchState({ phase: 'launching' });
    const result = await launchSnowLumaInner();
    recordSnowLumaLaunchState({
      phase: 'done',
      ok: result?.ok !== false && result?.skipped !== true,
      needsLogin: result?.needsLogin === true,
      error: result?.ok === false ? String(result?.error ?? '').slice(0, 300) : '',
      message: String(result?.message ?? result?.error ?? '').slice(0, 400),
    });
    return result;
  }

  async function launchSnowLumaInner() {
    if (process.env.SURFCORE_SKIP_AUTOSTART === '1') {
      return { ok: true, skipped: true, message: '测试环境：跳过打开 SnowLuma' };
    }
    const cfg = readQqConfig().config?.snowluma ?? {};
    if (cfg.allowLaunch !== true) {
      return { ok: false, error: '未开启「允许插件打开 SnowLuma」：设置 → 维护 → SnowLuma 安装与运行（重新检测一次会写入允许开关）' };
    }
    const webui = snowLumaWebui();

    // 已登录（OneBot 3000/3001 在听）：什么都不用做，也别弹窗口。
    if (await portOpen(3000) || await portOpen(3001)) {
      return { ok: true, already: true, opened: false, message: 'SnowLuma 已在运行且已登录' };
    }

    const root = String(cfg.launcherPath ?? '').trim();
    const hasAccount = snowLumaHasLocalAccount(root);

    // 进程在、但 OneBot 没起。以前一律弹控制台让人扫码；现在分两种情况：
    //   · 本机有账号记录 ⇒ 只是没注入，开自动注入等它自己连上，不打扰用户；
    //   · 从没登录过 ⇒ 必须扫码，这时才开控制台。
    if (await portOpen(webui.port)) {
      enableSnowLumaAutoHook(root);
      if (hasAccount) {
        return {
          ok: true,
          needsInject: true,
          opened: false,
          webui: webui.url,
          message: 'SnowLuma 在运行但没连上 QQ：已开启自动注入，等它注入完成',
        };
      }
      const opened = openLocalUrl(webui.url);
      return {
        ok: true,
        needsLogin: true,
        opened,
        webui: webui.url,
        message: opened ? `SnowLuma 首次使用：已打开控制台 ${webui.url} 扫码登录` : `SnowLuma 首次使用：请打开 ${webui.url} 扫码登录`,
      };
    }

    const launcher = resolveSnowLumaLauncher();
    if (!launcher) {
      return { ok: false, error: '找不到 SnowLuma 启动脚本：请在设置里填「SnowLuma 安装目录」或「启动脚本」' };
    }
    // 启动前就写好自动注入，避免「起来了还要人去控制台点注入」
    enableSnowLumaAutoHook(root);
    try {
      const cwd = path.dirname(launcher);
      const lower = launcher.toLowerCase();
      const appDir = path.basename(cwd).toLowerCase() === 'app' ? cwd : path.join(cwd, 'app');
      const nodeExe = path.join(appDir, 'node.exe');
      const entry = path.join(appDir, 'index.mjs');
      if (fs.existsSync(nodeExe) && fs.existsSync(entry)) {
        // 直接拉 node.exe：绕开 launcher.bat 结尾的 pause，且用 wscript 隐藏启动（不出现任何窗口）
        spawnHidden(`"${nodeExe}" "${entry}"`, appDir);
      } else if (lower.endsWith('.bat') || lower.endsWith('.cmd')) {
        // 2026-10-22 审计：旧写法把 basename 拼进 cmd 命令串，路径里带 `&` 可注入命令。
        // 现在整条路径作为「verbatim 参数」交给 cmd，并且拒绝含引号/换行的路径。
        // 2026-11：通过 wscript 隐藏启动，不弹控制台窗口。
        if (/["\r\n]/.test(launcher)) return { ok: false, error: '启动脚本路径含引号或换行，拒绝执行' };
        spawnHidden(`cmd /c "${launcher}"`, cwd);
      } else {
        spawnHidden(`"${launcher}"`, cwd);
      }
      // 等 OneBot 端口起来（最多 15 秒）：OneBot 通了才算真的连上 QQ，不再为了「WebUI 起来了」开浏览器。
      const until = Date.now() + 15_000;
      while (Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (await portOpen(3000) || await portOpen(3001)) {
          return {
            ok: true,
            started: true,
            opened: false,
            webui: webui.url,
            launcher,
            message: 'SnowLuma 已启动并连上 QQ（后台运行，没有命令窗）',
          };
        }
      }
      if (await portOpen(webui.port)) {
        const opened = hasAccount ? false : openLocalUrl(webui.url);
        return {
          ok: true, started: true, needsInject: !hasAccount, opened, webui: webui.url, launcher,
          message: opened
            ? `已启动 SnowLuma（后台），首次登录请扫码：${webui.url}`
            : 'SnowLuma 已在后台启动，等待注入 QQ（确保 QQ 已登录）',
        };
      }
      return { ok: true, started: true, pending: true, webui: webui.url, launcher, message: `已启动 SnowLuma，控制台稍后可访问：${webui.url}` };
    } catch (error) {
      return { ok: false, error: `打开 SnowLuma 失败：${error?.message ?? error}` };
    }
  }

  // ── 启动完成弹窗 ────────────────────────────────────────────────────────
  // 用 wscript 的 WScript.Shell.Popup：独立 GUI 窗口，不弹控制台，不依赖 DSH。
  function showStartupPopup(title, text, seconds = 30) {
    if (process.platform !== 'win32' || process.env.SURFCORE_SKIP_AUTOSTART === '1') return false;
    try {
      const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
      if (!fs.existsSync(wscript)) return false;
      const esc = (value) => String(value ?? '').replace(/"/g, '""');
      const body = String(text ?? '').replace(/\r?\n/g, '" & vbCrLf & "');
      const vbs = [
        'Set sh = CreateObject("WScript.Shell")',
        // 64 = vbInformation，4096 = vbSystemModal：强制置顶，避免弹到 DSH 后面。
        `sh.Popup "${body}", ${Math.max(5, Math.round(seconds))}, "${esc(title)}", ${64 + 4096}`,
        '',
      ].join('\r\n');
      const file = path.join(os.tmpdir(), `surfcore-startup-${process.pid}-${Date.now()}.vbs`);
      // VBScript 在 wscript 下按 UTF-16LE + BOM 读最稳，中文不会乱码。
      fs.writeFileSync(file, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(vbs, 'utf16le')]));
      const child = spawn(wscript, ['//nologo', file], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      pluginLog(`启动弹窗已请求：${title}（pid ${child.pid ?? '?'}，${seconds}s）`);
      setTimeout(() => { try { fs.unlinkSync(file); } catch {} }, 120000).unref?.();
      return true;
    } catch (error) {
      pluginLog('启动弹窗失败：', error?.message ?? error);
      return false;
    }
  }

  let startupWatcher = null;
  async function watchStartupCompletion({ qq = true, bili = true } = {}) {
    if (startupWatcher) return startupWatcher;
    startupWatcher = (async () => {
      try {
        const notify = readUnified().config.bridge?.startupNotify !== false;
        if (!notify || (!qq && !bili)) return;
        // DSH 重启/桥接切端口时，鉴权握手可能比 90 秒慢；给 3 分钟，
        // 并在超时前再做一次 final check，避免把“还在连”误报成“DSH 未连接”。
        const until = Date.now() + 180_000;
        const qqReady = (bridge) => {
          const snow = bridge?.snowluma ?? {};
          return Boolean(bridge?.running && bridge?.ok !== false && bridge?.dshReady === true
            && snow.connected === true && snow.accountOnline === true);
        };
        const allReady = (bridge, schedulerRunning) => Boolean(
          (!qq || qqReady(bridge)) && (!bili || schedulerRunning),
        );
        const successLines = (bridge) => {
          const snow = bridge?.snowluma ?? {};
          return [
            '全部启动成功 ✓',
            '',
            ...(qq ? [
              `QQ 桥接：运行中（端口 ${bridge.port ?? 3100}，DSH 已连接）`,
              `SnowLuma：已连接，QQ ${snow.accountOnline ? '在线' : '离线'}`,
            ] : ['QQ：启动开关关闭（未启动）']),
            ...(bili ? ['B站生物钟：运行中'] : ['B站：启动开关关闭（未启动）']),
          ];
        };
        let last = null;
        while (Date.now() < until) {
          const [bridge, schedulerRunning] = await Promise.all([
            bridgeStatus().catch((error) => ({ ok: false, running: false, error: String(error?.message ?? error) })),
            Promise.resolve(getSchedulerRunning()),
          ]);
          last = { bridge, schedulerRunning };
          if (allReady(bridge, schedulerRunning)) {
            const snow = bridge?.snowluma ?? {};
            pluginLog(`启动检查通过：qq=${qq} bili=${bili} DSH=${bridge.dshBaseUrl ?? '?'} SnowLuma=${snow.connected} 账号=${snow.accountOnline}`);
            showStartupPopup('SurfCore 启动完成', successLines(bridge).join('\n'), 30);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        // 最后一次补查：桥接可能刚好在超时边界上完成 DSH 握手。
        try {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const [bridge, schedulerRunning] = await Promise.all([
            bridgeStatus().catch(() => null),
            Promise.resolve(getSchedulerRunning()),
          ]);
          if (bridge) last = { bridge, schedulerRunning };
          if (bridge && allReady(bridge, schedulerRunning)) {
            showStartupPopup('SurfCore 启动完成', successLines(bridge).join('\n'), 30);
            return;
          }
        } catch {}
        const bridge = last?.bridge ?? {};
        const snow = bridge.snowluma ?? {};
        const snowDiag = await diagnoseSnowLuma(snow).catch(() => ({ state: 'unknown', hint: '' }));
        pluginLog(`启动检查未通过：qq=${qq} bili=${bili} running=${Boolean(bridge.running)} dshReady=${Boolean(bridge.dshReady)} dshBaseUrl=${bridge.dshBaseUrl ?? '?'} snow=${Boolean(snow.connected)} snowState=${snowDiag.state} account=${Boolean(snow.accountOnline)} scheduler=${Boolean(last?.schedulerRunning)}`);
        showStartupPopup('SurfCore 启动状态', [
          '还没全部就绪：',
          '',
          ...(qq ? [
            `QQ 桥接：${bridge.running ? (bridge.ok ? '运行中' : '运行中但状态异常') : '未运行'}`,
            `DSH：${bridge.dshReady
              ? '已连接'
              : (bridge.dshBaseUrl && bridge.dshBaseUrl !== currentDshUrl()
                ? `桥接还连着旧端口 ${bridge.dshBaseUrl}（当前 ${currentDshUrl()}）`
                : 'DSH 已打开，但桥接还在鉴权/等待连接')}`,
            `SnowLuma：${snow.connected ? '已连接' : `未就绪（${snowDiag.state}）`}`,
            ...(snowDiag.hint ? [`   → ${snowDiag.hint}`] : []),
          ] : ['QQ：启动开关关闭（未启动）']),
          ...(bili ? [`B站生物钟：${last?.schedulerRunning ? '运行中' : '未启动'}`] : ['B站：启动开关关闭（未启动）']),
        ].join('\n'), 40);
      } catch (error) {
        pluginLog('启动完成检查失败：', error?.message ?? error);
      } finally {
        startupWatcher = null;
      }
    })();
    return startupWatcher;
  }

  // 合并后的产品名/版本：设置页标题跟 dsh-Dfy 主包保持一致（2026-11 用户要求）。
  // 版本直接读合并包 package.json，避免设置页还显示 SurfCore 自己的版本号。
  function mergedPluginInfo() {
    const candidates = [
      // 单仓库布局：<dsh-dfy>/package.json
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json'),
    ];
    for (const file of candidates) {
      try {
        const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (pkg?.version) return { name: 'dsh-Dfy', version: String(pkg.version), dir: path.dirname(file) };
      } catch {}
    }
    return { name: 'dsh-Dfy', version: '', dir: '' };
  }

  // SnowLuma 本地账号清单：直接读它自己的 onebot_<uin>.json。
  // 这条路径**不需要控制台密码**——只要用户在 SnowLuma 里加过号，这里就一定能看到（
  // 2026-11 用户反馈「明明加过账号，面板却显示没有账号」：之前只信 WebUI 的 /api/qq-list，
  // 没填控制台密码就 401 → 账号列表空 → 误报）。
  function snowLumaLocalAccounts() {
    const cfg = readQqConfig().config ?? {};
    const out = new Map();
    for (const home of snowLumaHomeCandidates({ cfg })) {
      for (const entry of readOneBotTokens(home)) {
        const uin = String(entry.uin ?? '');
        if (!/^\d{5,15}$/.test(uin)) continue;
        if (!out.has(uin)) out.set(uin, { uin, nickname: '', online: null, source: 'local' });
      }
    }
    return [...out.values()];
  }

  // SnowLuma 控制台直连：账号列表 / QQ 注入进程，全部在设置页里操作（不用再开它的网页）。
  // 密码只存本机 config.json，任何响应都不回显。
  async function handleSnowLuma(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    const webui = snowLumaWebui();
    const up = await portOpen(webui.port);
    if (method === 'GET') {
      const base = { ok: true, webui: { ...webui, up }, authed: snowlumaWebuiClient.authed, hasPassword: snowlumaWebuiClient.hasPassword() };
      // 账号一律先给本地清单（不需要控制台密码）；控制台能连上时再补昵称/在线状态。
      const local = snowLumaLocalAccounts();
      if (!up) {
        json(res, 200, { ...base, accounts: local, processes: [], activeUin: '', note: 'SnowLuma 控制台没在运行：点顶部「一键开始」' });
        return;
      }
      const [accounts, processes] = await Promise.all([snowlumaWebuiClient.accounts(), snowlumaWebuiClient.processes()]);
      let list = local;
      let activeUin = '';
      if (accounts.ok) {
        const names = new Map((accounts.list ?? []).map((a) => [String(a.uin), a]));
        list = local.map((a) => ({ ...a, ...(names.get(a.uin) ? { nickname: names.get(a.uin).nickname || '' } : {}) }));
        // 本地没有记录、但控制台说在跑的账号也带上（比如刚从别处加的号）
        for (const a of accounts.list ?? []) {
          const uin = String(a.uin ?? '');
          if (uin && !list.some((x) => x.uin === uin)) list.push({ uin, nickname: String(a.nickname ?? ''), online: true, source: 'webui' });
        }
        activeUin = String(accounts.list?.[0]?.uin ?? '');
      } else if (local.length) {
        // 没填密码：本地清单照常显示；用一次轻量探测补「当前登录的号」昵称
        const found = await discoverSnowLumaConnection({ cfg: readQqConfig().config ?? {}, timeoutMs: 2000 }).catch(() => null);
        if (found?.ok) {
          const uin = String(found.self?.user_id ?? '');
          activeUin = uin;
          list = list.map((a) => (a.uin === uin ? { ...a, nickname: String(found.self?.nickname ?? ''), online: true } : a));
        }
      }
      json(res, 200, {
        ...base,
        authed: snowlumaWebuiClient.authed,
        accounts: list,
        activeUin,
        processes: processes.ok ? processes.list : [],
        error: accounts.ok ? '' : (accounts.code === 'WEBUI_NOT_AUTHORIZED' ? '' : accounts.error),
        note: accounts.ok ? '' : (local.length ? '账号来自 SnowLuma 本地配置文件（没填控制台密码也能看到）' : '还没发现账号'),
      });
      return;
    }
    if (method !== 'POST') {
      json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: '只支持 GET / POST' });
      return;
    }
    const body = await readJsonBody(req);
    const action = String(body.action ?? '');
    if (action === 'login') {
      const password = String(body.password ?? '').trim();
      if (!password) { json(res, 400, { ok: false, code: 'WEBUI_PASSWORD_REQUIRED', error: '请输入 SnowLuma 控制台密码' }); return; }
      const r = await snowlumaWebuiClient.login(password);
      if (!r.ok) { json(res, 401, r); return; }
      snowlumaWebuiClient.savePassword(password);
      json(res, 200, { ok: true, authed: true, message: '已连上 SnowLuma 控制台' });
      return;
    }
    if (action === 'logout') {
      snowlumaWebuiClient.logout({ forget: body.forget !== false });
      json(res, 200, { ok: true, authed: false });
      return;
    }
    if (action === 'process-load' || action === 'process-unload') {
      const pid = String(body.pid ?? '').trim();
      if (!/^\d+$/.test(pid)) { json(res, 400, { ok: false, code: 'BAD_PID', error: 'PID 无效' }); return; }
      const r = action === 'process-load' ? await snowlumaWebuiClient.loadProcess(pid) : await snowlumaWebuiClient.unloadProcess(pid);
      if (!r.ok) { json(res, 502, r); return; }
      json(res, 200, { ok: true, message: action === 'process-load' ? '已注入 SnowLuma（需在 QQ 里扫码登录）' : '已取消注入' });
      return;
    }
    json(res, 404, { ok: false, error: `未知 SnowLuma 动作：${action}` });
  }

  return {
    handleSnowLuma,
    mergedPluginInfo,
    portOpen,
    findSnowLumaInstall,
    resolveSnowLumaLauncher,
    snowLumaWebui,
    snowlumaWebuiClient,
    openLocalUrl,
    diagnoseSnowLuma,
    enableSnowLumaAutoHook,
    launchSnowLuma,
    watchStartupCompletion,
  };
}
