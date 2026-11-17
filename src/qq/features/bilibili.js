/**
 * B 站桥（组件化迁移 #5）：记忆注入、动态同步、每日分享。
 *
 * 从 src/bridge.js 的 main() 搬出三样东西：
 *   - biliMemory 的实例与刷新定时器；
 *   - biliDynamics（动态同步）；
 *   - biliShare（每天 8 次分享）。
 *
 * 只读公开数据（投稿/动态/公开见闻），不读私信；`status()/briefBlock()/recallBlock()`
 * 仍由 bridge 的提示词与状态接口按需取用，组件内部不感知 QQ 协议细节。
 */
import fs from 'node:fs';
import path from 'node:path';
import { defineComponent } from '../core/registry.js';
import { createBiliMemory } from '../../bili-memory.js';
import { createBiliDynamicsSync } from '../../bili-dynamics.js';
import { createBiliShareScheduler } from '../../bili-share-scheduler.js';

export function createBilibiliComponent(deps) {
  const {
    stateDir, unifiedDir, log, getConfig, getMode, isDshReady, isGatewayReady,
    sendToQQ, deliverPrompt, sendCard, currentRoleHint,
  } = deps || {};
  for (const [name, value] of Object.entries({
    stateDir, unifiedDir, log, getConfig, getMode, isDshReady, isGatewayReady,
    sendToQQ, deliverPrompt, sendCard,
  })) {
    if (value === undefined || value === null) throw new TypeError(`bilibili 缺少依赖：${name}`);
  }

  const memory = createBiliMemory({ stateDir, log });
  let dynamics = null;
  let share = null;
  let refreshTimer = null;
  let startCache = { at: 0, enabled: true };

  function startedByUnified() {
    const now = Date.now();
    if (now - startCache.at < 30_000) return startCache.enabled;
    let enabled = true;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(unifiedDir, 'config.json'), 'utf8'));
      enabled = data?.platforms?.start?.bili !== false;
    } catch {}
    startCache = { at: now, enabled };
    return enabled;
  }

  const groupList = (list) => (Array.isArray(list) ? list : [])
    .map((v) => String(v).trim())
    .filter((v) => /^\d+$/.test(v));

  function start() {
    const cfg = getConfig();
    if (!cfg.biliBridge?.enabled) return;
    // groups 为空时默认跟随 allow.groups（白名单群）。
    const shareGroups = groupList(cfg.biliBridge.share.groups.length ? cfg.biliBridge.share.groups : cfg.allow?.groups);
    const dynamicsGroups = groupList(cfg.biliBridge.dynamics.groups.length ? cfg.biliBridge.dynamics.groups : cfg.allow?.groups);
    if (cfg.biliBridge.memory.enabled) {
      void memory.refresh({ force: true });
      refreshTimer = setInterval(() => { void memory.refresh(); }, cfg.biliBridge.memory.refreshIntervalMs);
      refreshTimer.unref?.();
    }
    if (cfg.biliBridge.dynamics.enabled && dynamicsGroups.length) {
      dynamics = createBiliDynamicsSync({
        stateDir,
        log,
        sendToQQ,
        groups: dynamicsGroups,
        isReady: () => isGatewayReady() === true,
        intervalMs: cfg.biliBridge.dynamics.pollIntervalMs,
        selfName: memory.selfName?.() ?? '',
      });
      dynamics.start();
    } else if (cfg.biliBridge.dynamics.enabled) {
      log('[B站动态] 没有白名单群，未启动');
    }
    if (cfg.biliBridge.share.enabled && shareGroups.length) {
      share = createBiliShareScheduler({
        stateDir,
        log,
        deliverPrompt,
        groups: shareGroups,
        memory,
        isReady: () => isDshReady(),
        times: cfg.biliBridge.share.times,
        gapMs: cfg.biliBridge.share.gapMs,
        getMode: () => getMode(),
        sendCard,
        isEnabled: () => getConfig().biliBridge?.enabled !== false && startedByUnified(),
      });
      share.start();
    } else if (cfg.biliBridge.share.enabled) {
      log('[B站分享] 没有白名单群，未启动');
    }
  }

  function stop() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    try { dynamics?.stop?.(); } catch {}
    try { share?.stop?.(); } catch {}
    dynamics = null;
    share = null;
  }

  function status() {
    const cfg = getConfig();
    return {
      enabled: cfg.biliBridge?.enabled !== false,
      memory: memory.status(),
      dynamics: dynamics?.status() ?? { enabled: false },
      share: share?.status() ?? { enabled: false },
      groups: {
        allow: cfg.allow?.groups ?? [],
        dynamics: cfg.biliBridge?.dynamics?.groups ?? [],
        share: cfg.biliBridge?.share?.groups ?? [],
      },
    };
  }

  function promptPreview(text) {
    const query = String(text ?? '').slice(0, 500);
    return {
      ok: true,
      text: query,
      briefChars: (memory.briefBlock() ?? '').length,
      recall: memory.recallBlock(query),
      roleHint: typeof currentRoleHint === 'function' ? currentRoleHint() : '',
    };
  }

  async function refresh() {
    const stats = await memory.refresh({ force: true });
    return { ok: stats?.ok !== false, stats };
  }

  async function shareNow() {
    if (!share) return { ok: false, statusCode: 400, error: '分享调度未启用（检查 biliBridge.share / 白名单群）' };
    const result = await share.fireNow();
    return { ok: result?.ok !== false, result };
  }

  async function pollDynamics() {
    if (!dynamics) return { ok: false, statusCode: 400, error: '动态同步未启用（检查 biliBridge.dynamics / 白名单群）' };
    const result = await dynamics.pollOnce();
    return { ok: result?.ok !== false, result };
  }

  const api = {
    start,
    stop,
    status,
    promptPreview,
    refresh,
    shareNow,
    pollDynamics,
    memory,
    briefBlock: () => memory.briefBlock(),
    recallBlock: (text) => memory.recallBlock(text),
    selfInfo: () => memory.selfInfo?.(),
    selfName: () => memory.selfName?.(),
  };

  return defineComponent({
    id: 'bilibili',
    init: () => api,
    routes: [
      { method: 'GET', path: '/api/bili/status', handle: (ctx, io) => { io.sendJson(status()); } },
      {
        method: 'GET',
        path: '/api/bili/prompt-preview',
        handle: (ctx, io) => { io.sendJson(promptPreview(io.url.searchParams.get('text') ?? '')); },
      },
      {
        method: 'POST',
        path: '/api/bili/memory/refresh',
        handle: async (ctx, io) => { io.sendJson(await refresh()); },
      },
      {
        method: 'POST',
        path: '/api/bili/share-now',
        handle: async (ctx, io) => {
          const result = await shareNow();
          io.sendJson(result, result.ok ? 200 : (result.statusCode || 400));
        },
      },
      {
        method: 'POST',
        path: '/api/bili/dynamics/poll',
        handle: async (ctx, io) => {
          const result = await pollDynamics();
          io.sendJson(result, result.ok ? 200 : (result.statusCode || 400));
        },
      },
    ],
  });
}
