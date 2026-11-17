/**
 * 目的机制（组件化迁移 #4）：定期从近期 QQ / B站记忆里提炼「目的」，
 * 像人一样「想弄明白 / 想做点什么」，再据此私聊主人。
 *
 * 从 src/bridge.js 的 main() 整块搬出：状态文件定位与重载、排程、60 秒 tick、
 * 回合回执、载体切换（QQ / 桌宠）、专注模式、控制台三条路由。
 *
 * 稳定性的四个来源（历史踩坑，勿删）：
 *   ① 状态落盘：排程 / 今日次数 / 惦记的事 / 最近说过什么，重启不重发；
 *   ② 60 秒 tick：系统时钟跳变、停机久了都能自己纠正，不押一次性长定时器；
 *   ③ 回合回执：只有真的发出消息才记 sent；投递失败 / 回合报错按 retryMs 重试；
 *   ④ 硬闸门：安静时段、每日上限、主人正在聊天、token 额度、好友关系，任一不过都不发。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineComponent } from '../core/registry.js';
import {
  analyzePersona, applyPurposeOutcome, buildPurposePrompt, collectMaterials, deriveDrives,
  ensurePurposeDay, ensurePurposeSchedule, evaluatePurposeTick, formGoalHypotheses,
  markPurposeDelivered, markPurposeSkip, minePurposeSeeds, normalizePurposeState,
  parsePurposeMemo, planNextFire, selectPurpose, summarizePurposeState,
} from '../../purpose-engine.js';
import { atomicWriteJson, readJsonSafe } from '../json-io.js';

const REQUIRED = [
  'log', 'getConfig', 'getMode', 'isDshReady', 'allowed', 'getSocialV2State',
  'getConversations', 'isConversationBusy', 'flushSocialV2State', 'isSocialPaused',
  'readRoleName', 'readBiliEntries', 'readMemoryRecords', 'personaText',
  'selfIdentityText', 'adminPromptLine', 'adminIdentity', 'biliBrief', 'memoryCardText',
  'tokenGuardWakeBlock', 'friendCheck', 'deliverPrompt', 'resolveStateFile', 'defaultStateDir',
  'configFile',
];

export function createPurposeComponent(deps) {
  for (const name of REQUIRED) {
    if (deps?.[name] === undefined || deps?.[name] === null) {
      throw new TypeError(`purpose 缺少依赖：${name}`);
    }
  }
  const {
    log, getConfig, getMode, isDshReady, allowed, getSocialV2State, getConversations,
    isConversationBusy, flushSocialV2State, isSocialPaused, readRoleName, readBiliEntries,
    readMemoryRecords, personaText, selfIdentityText, adminPromptLine, adminIdentity,
    biliBrief, memoryCardText, tokenGuardWakeBlock, friendCheck, deliverPrompt,
    resolveStateFile, defaultStateDir, configFile,
  } = deps;

  let stateFile = '';
  let state = null;
  let stateMtime = 0;
  let timer = null;
  let run = null;               // { runId, at, key, sessionId, planned, sentTexts, timer }
  let lastLog = { at: 0, reason: '', nextFireAt: 0 };
  let evaluating = false;
  let warming = false;
  let carrierCache = { at: 0, carrier: 'qq' };
  let focusCache = { at: 0, enabled: false };
  let focusLogAt = 0;
  const startedTimeouts = new Set();

  // ── 状态文件 ────────────────────────────────────────────────────────────
  // 目的状态跟着「当前角色」走：换人格卡/记忆卡后不应该继承上一个角色的欲望。
  function pickStateFile() {
    try {
      const file = resolveStateFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      return file;
    } catch (error) {
      log(`[目的] 角色目录不可写，回退到 state/purpose-outreach.json：${error?.message ?? error}`);
      const fallback = path.join(defaultStateDir, 'purpose-outreach.json');
      fs.mkdirSync(defaultStateDir, { recursive: true });
      return fallback;
    }
  }

  function fileMtime() {
    try { return fs.statSync(stateFile).mtimeMs || 0; } catch { return 0; }
  }

  function saveState() {
    try {
      atomicWriteJson(stateFile, state);
      stateMtime = fileMtime();
    } catch (error) {
      log(`[目的] 写 state/purpose-outreach.json 失败：${error?.message ?? error}`);
    }
  }

  function loadState() {
    state = normalizePurposeState(readJsonSafe(stateFile, null));
    // 上次进程在回合中途退出：不知道她到底发没发出去。别立刻补发（会变成连发），
    // 记成 interrupted，等一个初始延迟后再来一次。
    if (state.lastOutcome === 'pending') {
      state.lastOutcome = 'interrupted';
      state.nextFireAt = 0;
    }
    ensurePurposeSchedule(state, { now: Date.now(), config: getConfig().purpose });
    stateMtime = 0;
    saveState();
  }

  // ── 载体 / 专注模式 ─────────────────────────────────────────────────────
  // 载体由 config.json 决定（30 秒缓存）：carrier=pet 时桥接的**自动** tick 不出发，
  // 交给桌宠插件，两边共用同一份状态文件，但任何时刻只有一个执行者。
  function carrierNow() {
    if (Date.now() - carrierCache.at < 30_000) return carrierCache.carrier;
    let carrier = 'qq';
    try {
      const raw = readJsonSafe(configFile, null);
      if (raw?.purpose?.carrier === 'pet') carrier = 'pet';
    } catch {}
    carrierCache = { at: Date.now(), carrier };
    return carrier;
  }

  const FOCUS_FILE = path.join(
    String(process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh'),
    'surfcore', 'pet', 'focus.json',
  );

  function focusEnabled() {
    if (Date.now() - focusCache.at < 10_000) return focusCache.enabled;
    let enabled = false;
    try {
      enabled = readJsonSafe(FOCUS_FILE, null)?.enabled === true;
    } catch {}
    focusCache = { at: Date.now(), enabled };
    return enabled;
  }

  function logFocusSkip() {
    if (Date.now() - focusLogAt < 30 * 60_000) return;
    focusLogAt = Date.now();
    log('[目的] 专注模式开着：暂停自动主动搭话（QQ / 桌宠都不会发；手动试一次仍可用）');
  }

  // ── 素材 / 上下文 ───────────────────────────────────────────────────────
  function ownerId() {
    const cfg = getConfig();
    return String(cfg.purpose?.ownerUin || cfg.ownerQQ || '').replace(/[^\d]/g, '').slice(0, 12);
  }

  function conversations() {
    const list = [];
    for (const [key, st] of getConversations()) {
      if (!st) continue;
      list.push({
        key,
        recentMessages: st.recentMessages,
        unread: st.unread,
        activeTopics: st.activeTopics,
        pendingThoughts: st.pendingThoughts,
        lastIncomingAt: st.lastIncomingAt,
      });
    }
    return list;
  }

  function personaTextResolved() {
    try { return String(personaText() ?? '').trim(); } catch { return ''; }
  }

  function gatherMaterials(now = Date.now()) {
    return collectMaterials({
      now,
      config: getConfig().purpose,
      ownerUin: ownerId(),
      roleName: String(readRoleName() || ''),
      conversations: conversations(),
      biliEntries: readBiliEntries(),
      memoryRecords: readMemoryRecords(),
    });
  }

  function contextBlocks() {
    const roleLine = readRoleName() ? `【当前角色】${readRoleName()}（完整角色卡请调用 qq_get_prompt 查看）` : '';
    const identityLine = selfIdentityText();
    const adminText = adminPromptLine(true);
    const persona = personaTextResolved();
    const memoryCard = memoryCardText();
    const bili = biliBrief();
    return [
      roleLine,
      // 人格卡是动机的先验：她是什么样的人，决定她更容易被什么打动。
      persona ? `【人格卡（你是这样的人）】\n${persona.slice(0, 2200)}` : '',
      identityLine,
      adminText,
      memoryCard ? `【记忆卡】\n${memoryCard.slice(0, 2400)}` : '',
      bili ? `【B站记忆】\n${bili.slice(0, 1800)}` : '',
    ].filter(Boolean);
  }

  function logWait(reason, nextFireAt) {
    const now = Date.now();
    const throttle = reason === 'quiet' ? 6 * 60 * 60 * 1000 : 10 * 60 * 1000;
    const same = reason === lastLog.reason && Math.abs((nextFireAt || 0) - lastLog.nextFireAt) < 60_000;
    if (same && now - lastLog.at < throttle) return;
    lastLog = { at: now, reason, nextFireAt: nextFireAt || 0 };
    if (reason === 'quiet') {
      log(`[目的] 安静时段，等到 ${new Date(nextFireAt).toLocaleString()} 之后再看`);
      return;
    }
    // 「等下一枪 / 等主人闲下来」是常态，不每分钟刷日志；只有真的被挡住才说。
    if (reason === 'waiting' || reason === 'owner-active' || reason === 'disabled') return;
    const nextText = nextFireAt ? `，下次 ${new Date(nextFireAt).toLocaleString()}` : '';
    log(`[目的] 暂不出发：${reason}${nextText}`);
  }

  /**
   * 只读准备：素材 + 人格先验 + 驱动 + 目标假设。
   * 不投递、不写盘；`run()` 和启动时的预热共用，避免两套逻辑漂移。
   */
  function prepareContext(now, st) {
    const cfg = getConfig();
    const packet = gatherMaterials(now);
    const materials = packet.items;
    const pending = Array.isArray(state.pending) ? state.pending : [];
    const persona = analyzePersona(personaTextResolved());
    const hasSelfSource = Boolean(persona.hasText)
      || materials.some((m) => m.kind === 'memory' || m.kind === 'thought');
    const seenMaterialIds = new Set();
    for (const obs of Array.isArray(state.observations) ? state.observations : []) {
      for (const id of Array.isArray(obs?.seenIds) ? obs.seenIds : []) seenMaterialIds.add(String(id));
    }
    const freshMaterials = materials.filter((m) => !m.id || !seenMaterialIds.has(String(m.id)));
    const derived = deriveDrives({
      drives: state.drives,
      drivesAt: state.drivesAt,
      materials: freshMaterials,
      now,
      lastMasterAt: Number(st?.lastIncomingAt) || 0,
      personaBias: persona.bias,
    });
    const drives = derived.drives;
    const formed = formGoalHypotheses({
      materials,
      goals: state.goals,
      observations: state.observations,
      drives,
      now,
      lastMasterAt: Number(st?.lastIncomingAt) || 0,
      config: cfg.purpose,
      roleName: String(readRoleName() || ''),
      persona,
    });
    return { packet, materials, pending, persona, hasSelfSource, derived, drives, formed };
  }

  async function runOnce({ force = false, preview = false } = {}) {
    const cfg = getConfig();
    const owner = ownerId();
    if (!owner) return { ok: false, reason: 'no-owner', error: '未配置管理员 QQ（ownerQQ）' };
    if (cfg.purpose?.enabled === false && !preview && !force) return { ok: false, reason: 'disabled' };
    if (getMode() !== 'reserved2') return { ok: false, reason: 'mode', error: '目的机制只在 reserved2 模式运行' };
    if (!allowed('private', Number(owner), cfg)) {
      return { ok: false, reason: 'owner-not-allowed', error: `管理员 ${owner} 不在 allow.private 白名单` };
    }
    // 载体可能刚从桌宠切回 QQ（或桌宠离线回落）：先对齐桌宠写过的状态文件，
    // 否则会用启动时的旧状态覆盖「今日次数 / 下次时间 / 惦记的事」。
    if (!preview && !run) reloadIfChanged();
    // 专注模式：自动轮次直接不出声；force（用户手动试一次）仍放行。
    if (!preview && !force && focusEnabled()) {
      logFocusSkip();
      return { ok: false, reason: 'focus', error: '专注模式开着：暂停自动主动搭话' };
    }
    const key = `private:${owner}`;
    const now = Date.now();
    // 预览是只读的：没有会话状态时不要顺手创建（创建会挂主动检查/睡眠定时器）。
    let st = getConversations().get(key);
    if (!st) {
      st = preview
        ? { agentToken: '', lastIncomingAt: 0, lastAiReplyAt: 0, wakeTimes: [] }
        : getSocialV2State(key);
    }
    const idleMs = now - Math.max(Number(st.lastIncomingAt) || 0, Number(st.lastAiReplyAt) || 0);
    const busy = isConversationBusy(key, st);

    if (!preview) {
      const decision = force
        ? { action: 'run', reason: 'force', nextFireAt: now }
        : evaluatePurposeTick({
          now,
          config: cfg.purpose,
          state,
          env: {
            enabled: cfg.purpose?.enabled !== false && cfg.socialV2?.enabled !== false,
            modeOk: true,
            dshReady: isDshReady(),
            paused: isSocialPaused(),
            ownerAllowed: true,
            busy,
            ownerIdleMs: idleMs,
            friendOk: true,
            budgetBlocked: false,
          },
        });
      if (decision.action !== 'run') {
        markPurposeSkip(state, { now, reason: decision.reason, nextFireAt: decision.nextFireAt });
        saveState();
        logWait(decision.reason, decision.nextFireAt);
        return { ok: false, reason: decision.reason, nextFireAt: decision.nextFireAt };
      }
      if (!isDshReady()) return { ok: false, reason: 'dsh' };
    }

    // Token 额度 / 私聊每日唤醒上限：主动找主人也算一次唤醒，不能绕过。
    if (!preview) {
      const budgetBlock = tokenGuardWakeBlock(key, st, { direct: false });
      if (budgetBlock) {
        markPurposeSkip(state, { now, reason: `budget: ${budgetBlock.error}`, nextFireAt: now + 30 * 60 * 1000 });
        saveState();
        log(`[目的] 暂不出发：${budgetBlock.error}`);
        return { ok: false, reason: 'budget', error: budgetBlock.error };
      }
    }

    // 不是好友时 QQ 会直接拒收（result=16）；别每分钟重试，也别把原因只留在日志。
    if (!preview) {
      const reach = await friendCheck(owner).catch(() => ({ checked: false, ok: true }));
      if (reach.checked && !reach.ok) {
        markPurposeSkip(state, { now, reason: 'not-friend', nextFireAt: now + 6 * 60 * 60 * 1000 });
        saveState();
        log(`[目的] 暂不出发：管理员 ${owner} 不在小肥鱼好友列表（QQ 会拒收私聊）`);
        return { ok: false, reason: 'not-friend', error: '目标不在好友列表' };
      }
    }

    const ctx = prepareContext(now, st);
    const { packet, materials, pending, persona, hasSelfSource, derived, drives, formed } = ctx;
    if (!preview) {
      state.drives = drives;
      state.drivesAt = derived.drivesAt;
      state.goals = formed.goals;
      state.observations = formed.observations;
      state.lastMaterialCount = materials.length;
      state.lastCandidateCount = 0;
    }
    if (!preview && materials.length < cfg.purpose.minMaterials && pending.length === 0 && !hasSelfSource) {
      const next = planNextFire({
        now, config: cfg.purpose, lastRunAt: state.lastRunAt, countToday: state.countToday,
      });
      markPurposeSkip(state, { now, reason: `no-material(${materials.length})`, nextFireAt: next });
      saveState();
      log(`[目的] 素材太少（${materials.length} 条），这轮不硬找话；下次 ${new Date(next).toLocaleString()}`);
      return { ok: false, reason: 'no-material', materials: materials.length };
    }

    const seeds = minePurposeSeeds({
      materials,
      now,
      roleName: String(readRoleName() || ''),
      config: cfg.purpose,
      drives,
      history: state.history,
      lastMasterAt: Number(st.lastIncomingAt) || 0,
    });
    const selection = selectPurpose({
      seeds,
      goals: formed.goals,
      pending,
      history: state.history,
      config: cfg.purpose,
      drives,
      now,
      lastMasterAt: Number(st.lastIncomingAt) || 0,
    });
    if (!preview) state.lastCandidateCount = selection.candidates.length;
    if (!selection.purpose) {
      const next = planNextFire({
        now, config: cfg.purpose, lastRunAt: state.lastRunAt, countToday: state.countToday,
      });
      markPurposeSkip(state, { now, reason: 'no-purpose', nextFireAt: next });
      saveState();
      log('[目的] 这轮没有提炼出可执行的目的，先不打扰');
      return { ok: false, reason: 'no-purpose' };
    }

    const token = getMode() === 'reserved2' ? String(st.agentToken || '') : '';
    const prompt = buildPurposePrompt({
      now,
      config: cfg.purpose,
      mode: getMode(),
      ownerUin: owner,
      ownerName: String(adminIdentity()?.displayName || '').trim() || '主人',
      token,
      contextBlocks: contextBlocks(),
      materials,
      candidates: selection.candidates,
      selected: selection.purpose,
      pending,
      history: state.history,
      stats: packet.stats,
      drives,
    });

    if (preview) {
      // 预览会进设置页/截图：会话令牌必须脱敏，不能跟着提示词一起露出来。
      const safePrompt = token ? prompt.split(token).join('********') : prompt;
      return {
        ok: true,
        preview: true,
        key,
        prompt: safePrompt,
        materials,
        selected: selection.purpose,
        candidates: selection.candidates,
        stats: packet.stats,
        goals: formed.goals,
        // 预览不写回 state，但要把「如果真跑会形成哪些目标」展示出来。
        state: summarizePurposeState({ ...state, goals: formed.goals, observations: formed.observations }, { config: cfg.purpose, now }),
      };
    }

    const runId = `${now}-${Math.random().toString(36).slice(2, 8)}`;
    run = {
      runId,
      at: now,
      key,
      sessionId: '',
      planned: selection.purpose,
      sentTexts: [],
      timer: null,
    };
    markPurposeDelivered(state, { now, planned: selection.purpose });
    state.nextFireAt = 0; // 等回合回执再排下一枪
    saveState();
    try {
      st.wakeTimes = Array.isArray(st.wakeTimes) ? st.wakeTimes : [];
      st.wakeTimes.push(now);
      if (st.wakeTimes.length > 200) st.wakeTimes = st.wakeTimes.slice(-200);
      st.lastWakeReason = 'purpose';
      flushSocialV2State();
      const result = await deliverPrompt(key, prompt);
      if (!result || result.ok !== true) throw new Error(result?.error || '投递被拒绝');
      run.sessionId = String(result.sessionId || '');
      if (!run.sessionId) {
        // 没有 sessionId 就没法可靠收回合回执；按投递失败处理，下一轮重试。
        throw new Error('投递成功但没有拿到 sessionId');
      }
      const current = run;
      current.timer = setTimeout(() => {
        if (!run || run.runId !== runId) return;
        const stuck = run;
        run = null;
        const outcome = stuck.sentTexts.length > 0 ? 'sent' : 'failed';
        applyPurposeOutcome(state, {
          now: Date.now(), config: getConfig().purpose, outcome, text: stuck.sentTexts[0] || '', planned: stuck.planned,
        });
        saveState();
        log(`[目的] 回合 20 分钟没有回执，按 ${outcome} 收尾`);
      }, 20 * 60 * 1000);
      current.timer.unref?.();
      log(`[目的] 已投递（${selection.purpose.kind}）：${selection.purpose.text.slice(0, 60)} — 等回合回执`);
      return {
        ok: true,
        delivered: true,
        runId,
        key,
        selected: selection.purpose,
        state: summarizePurposeState(state, { config: getConfig().purpose, now }),
      };
    } catch (error) {
      run = null;
      // 投递都没成功 = 模型回合没跑，不应吃掉今天的次数。
      state.countToday = Math.max(0, Number(state.countToday || 0) - 1);
      applyPurposeOutcome(state, {
        now: Date.now(),
        config: getConfig().purpose,
        outcome: 'delivery-failed',
        text: '',
        planned: selection.purpose,
      });
      saveState();
      log(`[目的] 投递失败：${error?.message ?? error}（${Math.round(getConfig().purpose.retryMs / 60000)} 分钟后重试）`);
      return { ok: false, reason: 'delivery-failed', error: String(error?.message ?? error) };
    }
  }

  // 串行化：一次只允许一个目的回合在跑（60 秒 tick / 手动「试一次」/ 预览共用一把锁）。
  async function runPurpose(options = {}) {
    if (evaluating) return { ok: false, reason: 'busy' };
    evaluating = true;
    try {
      return await runOnce(options);
    } finally {
      evaluating = false;
    }
  }

  async function tick() {
    if (evaluating || run || warming) return;
    // 载体切到桌宠后，桥接不再自动出发（手动「立即试一次」/ 桌宠离线回落仍可走 runPurpose）。
    if (carrierNow() === 'pet') return;
    // 桌宠专注模式：连 QQ 载体的自动主动搭话也一起停，避免用户开着专注还被私聊。
    if (focusEnabled()) { logFocusSkip(); return; }
    try {
      await runPurpose({});
    } catch (error) {
      log(`[目的] tick 异常：${error?.message ?? error}`);
    }
  }

  /**
   * 启动时先「想一遍」：读当前人格卡/记忆卡/QQ/B站，生成目标假设写进状态。
   * 不投递、不发 QQ；这样刚载入一个角色，设置页/状态接口马上能看到动机。
   */
  async function warm() {
    if (warming) return;
    if (getMode() !== 'reserved2') return;
    if (carrierNow() === 'pet') return;
    if (focusEnabled()) return;
    const owner = ownerId();
    if (!owner) return;
    warming = true;
    try {
      const key = `private:${owner}`;
      const st = getConversations().get(key) || { agentToken: '', lastIncomingAt: 0, lastAiReplyAt: 0, wakeTimes: [] };
      const now = Date.now();
      const ctx = prepareContext(now, st);
      state.drives = ctx.drives;
      state.drivesAt = ctx.derived.drivesAt;
      state.goals = ctx.formed.goals;
      state.observations = ctx.formed.observations;
      state.lastMaterialCount = ctx.materials.length;
      // 预热时也算一次候选（不投递），让设置页的「素材→观察→目标→候选」链路是完整的。
      const seeds = minePurposeSeeds({
        materials: ctx.materials,
        now,
        roleName: String(readRoleName() || ''),
        config: getConfig().purpose,
        drives: ctx.drives,
        history: state.history,
        lastMasterAt: Number(st.lastIncomingAt) || 0,
      });
      const selection = selectPurpose({
        seeds,
        goals: ctx.formed.goals,
        pending: ctx.pending,
        history: state.history,
        config: getConfig().purpose,
        drives: ctx.drives,
        now,
        lastMasterAt: Number(st.lastIncomingAt) || 0,
      });
      state.lastCandidateCount = selection.candidates.length;
      saveState();
      log(`[目的] 已用当前人格卡/记忆卡生成 ${ctx.formed.goals.length} 个目标假设（未投递）`);
    } finally {
      warming = false;
    }
  }

  function start() {
    if (timer) return;
    ensurePurposeSchedule(state, { now: Date.now(), config: getConfig().purpose });
    saveState();
    timer = setInterval(() => { void tick(); }, 60 * 1000);
    timer.unref?.();
    log(`[目的] 已启动：每 60 秒检查一次；下次 ${state.nextFireAt ? new Date(state.nextFireAt).toLocaleString() : '未排定'}`);
    // 先冷启动「想一遍」（不投递），再等 30 分钟后的第一枪。
    const warmTimer = setTimeout(() => { void warm().catch((error) => log(`[目的] 预热失败：${error?.message ?? error}`)); }, 1500);
    warmTimer.unref?.();
    // 启动时立刻看一次：停机期间错过的那一枪，只要不在安静时段 / 主人正在聊天就补上。
    const firstTick = setTimeout(() => { void tick(); }, 8000);
    firstTick.unref?.();
    startedTimeouts.add(warmTimer);
    startedTimeouts.add(firstTick);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    for (const t of startedTimeouts) { try { clearTimeout(t); } catch {} }
    startedTimeouts.clear();
    if (run?.timer) { try { clearTimeout(run.timer); } catch {} run.timer = null; }
  }

  /** 和桌宠载体共用同一份状态文件：外部改过就重读，避免用旧状态覆盖。 */
  function reloadIfChanged() {
    const mtime = fileMtime();
    if (!mtime || mtime === stateMtime) return false;
    try {
      state = normalizePurposeState(readJsonSafe(stateFile, null), Date.now());
      if (state.lastOutcome === 'pending') state.lastOutcome = 'interrupted';
      ensurePurposeSchedule(state, { now: Date.now(), config: getConfig().purpose });
      stateMtime = mtime;
      log('[目的] 状态文件被外部更新（桌宠载体），已重新载入');
      return true;
    } catch (error) {
      log(`[目的] 重新载入状态失败：${error?.message ?? error}`);
      return false;
    }
  }

  /** 角色切换会改变状态文件位置；热重载时重新定位并载入（保留已启动的 tick）。 */
  function reloadStateFile() {
    stateFile = pickStateFile();
    loadState();
  }

  /** 她真的往主人私聊发了消息（所有发送端点最终都会记到这里）。 */
  function noteOutbound(key, messages) {
    if (!run || run.key !== key) return;
    for (const message of Array.isArray(messages) ? messages : []) {
      const text = String(message ?? '').trim();
      if (text) run.sentTexts.push(text.slice(0, 200));
    }
  }

  /** 回合结束：解析内部备忘、记 sent/silent/failed，并排下一枪。 */
  function noteTurnEnded(sessionId, ended, sendToolSucceeded) {
    if (!run || !sessionId || run.sessionId !== sessionId) return;
    const current = run;
    run = null;
    if (current.timer) clearTimeout(current.timer);
    const delivered = Boolean(sendToolSucceeded) || current.sentTexts.length > 0;
    const completed = ended?.reason?.kind === 'completed';
    const outcome = delivered ? 'sent' : (completed ? 'silent' : 'failed');
    const memo = parsePurposeMemo(ended?.text ?? '');
    applyPurposeOutcome(state, {
      now: Date.now(),
      config: getConfig().purpose,
      outcome,
      text: current.sentTexts[0] || '',
      memo,
      planned: current.planned,
    });
    saveState();
    const tail = outcome === 'sent' ? `（${current.sentTexts[0]?.slice(0, 40) || '已发送'}）` : '';
    log(`[目的] 回合结束：${outcome}${tail}${memo?.purpose ? ` · ${memo.purpose.slice(0, 50)}` : ''}`);
  }

  function status() {
    const cfg = getConfig();
    ensurePurposeDay(state, Date.now());
    return {
      ok: true,
      enabled: cfg.purpose?.enabled !== false,
      mode: getMode(),
      ownerUin: ownerId(),
      ownerName: String(adminIdentity()?.displayName || '').trim() || '主人',
      config: cfg.purpose,
      state: summarizePurposeState(state, { config: cfg.purpose }),
      running: Boolean(run),
    };
  }

  function summarize() {
    return summarizePurposeState(state, { config: getConfig().purpose });
  }

  function preview() {
    return runPurpose({ preview: true });
  }

  function runNow(options = {}) {
    return runPurpose(options);
  }

  function init() {
    stateFile = pickStateFile();
    loadState();
    return api;
  }

  const api = {
    start,
    stop,
    tick,
    warm,
    run: runNow,
    preview,
    status,
    summarize,
    reloadIfChanged,
    reloadStateFile,
    noteOutbound,
    noteTurnEnded,
    isRunning: () => Boolean(run),
  };

  return defineComponent({
    id: 'purpose',
    init,
    start,
    stop,
    routes: [
      {
        method: 'GET',
        path: '/api/purpose/status',
        handle: (ctx, io) => { io.sendJson(status()); },
      },
      {
        method: 'POST',
        path: '/api/purpose/preview',
        handle: async (ctx, io) => {
          try {
            const result = await preview();
            io.sendJson(result, result.ok ? 200 : 400);
          } catch (error) {
            io.sendJson({ ok: false, error: `预览失败：${error?.message ?? error}` }, 500);
          }
        },
      },
      {
        method: 'POST',
        path: '/api/purpose/run',
        handle: async (ctx, io) => {
          try {
            const body = await io.readBody();
            // 真的发：force 会跳过排程/安静时段/主人空闲判断，但额度、好友、白名单、模式仍然生效。
            const result = await runNow({ force: body.force !== false });
            io.sendJson(result, result.ok ? 200 : 409);
          } catch (error) {
            io.sendJson({ ok: false, error: `试一次失败：${error?.message ?? error}` }, 500);
          }
        },
      },
    ],
  });
}
