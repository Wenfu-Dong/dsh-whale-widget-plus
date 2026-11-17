/**
 * 一代社交引擎 / 测试发送 / 后台提醒路由（组件化迁移 #12）。
 *
 * 这些端点原先写在 src/bridge.js 的 startConsoleServer 里，属于「控制台自己用」
 * 而不是二代 MCP 工具面：测试发送、一代活跃/观望切换、一代社交配置读写、
 * 摘要落盘、以及后台给某个会话的 agent 投递提醒。
 *
 * 全局鉴权（控制台令牌 / agent token 白名单 / CSRF）仍由 bridge 在调用本模块前
 * 完成；这里只做参数校验与业务动作。运行时状态全部由工厂注入，模块内不持有副本。
 *
 * handler 统一签名：`handle(req, res, url, sendJson, readBody)`，已处理返回 true。
 */

export function createSocialLegacyRoutes(deps) {
  const {
    log, getConfig, getMode, modeAllowed, allowed,
    onebotSend, withTimeout, SEND_TIMEOUT_MS, SENSITIVE_RE,
    CONFIG_FILE, readConfigObject, atomicWriteJson,
    social, state, enterActive, leaveActive, flushSummaries,
    getDshReady, readRoleState, getSocialV2State,
    ensureSession, deliverPrompt, appendActivity,
  } = deps || {};
  for (const [name, value] of Object.entries({
    log, getConfig, getMode, modeAllowed, allowed,
    onebotSend, withTimeout, SEND_TIMEOUT_MS, SENSITIVE_RE,
    CONFIG_FILE, readConfigObject, atomicWriteJson,
    social, state, enterActive, leaveActive, flushSummaries,
    getDshReady, readRoleState, getSocialV2State,
    ensureSession, deliverPrompt, appendActivity,
  })) {
    if (value === undefined || value === null) throw new TypeError(`social-legacy 缺少依赖：${name}`);
  }

  // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
  async function handleTestSend(req, res, url, sendJson, readBody) {
    if (!(req.method === 'POST' && url.pathname === '/api/test-send')) return false;
    const cfg = getConfig();
    const currentMode = getMode();
    const body = await readBody();
    const kind = body.kind === 'private' ? 'private' : 'group';
    const id = Number(body.id);
    const message = String(body.message ?? '').trim();
    if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return true; }
    if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return true; }
    if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return true; }
    if (!allowed(kind, id, cfg)) { sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return true; }
    if (!modeAllowed(`${kind}:${id}`, kind, id, cfg, currentMode)) { sendJson({ ok: false, error: `当前模式（${currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return true; }
    try {
      // 统一走 onebotSend：令牌/违规/路径脱敏由收口函数负责，不再直连 OneBot 旁路。
      const result = await withTimeout(onebotSend(kind, id, message), SEND_TIMEOUT_MS, `控制台测试发送 ${kind}:${id}`);
      log(`控制台：测试发送 ${kind}:${id} 成功`);
      sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
    } catch (error) {
      sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
    }
    return true;
  }

  // ── 一代活跃/观望手动切换 ────────────────────────────────────────────────
  async function handleSocialState(req, res, url, sendJson, readBody) {
    if (!(req.method === 'POST' && url.pathname === '/api/social/state')) return false;
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    const phase = body.phase;
    if (phase === 'active') {
      // 手动进入活跃：相当于第四种触发方式，之后按正常活跃流程跑
      enterActive(key);
      log(`控制台：手动将 ${key} 设为活跃`);
      sendJson({ ok: true, key, phase: 'active' });
    } else if (phase === 'idle') {
      leaveActive(key);
      log(`控制台：手动将 ${key} 设为观望`);
      sendJson({ ok: true, key, phase: 'idle' });
    } else {
      sendJson({ ok: false, error: 'phase 必须是 active 或 idle' }, 400);
    }
    return true;
  }

  // ── 仿真群友模式（社交引擎）配置 ──────────────────────────────────────────
  async function handleSocialConfig(req, res, url, sendJson, readBody) {
    const cfg = getConfig();
    if (req.method === 'GET' && url.pathname === '/api/social') {
      const stats = {};
      for (const [k, e] of social.pendingSummaries.entries()) stats[k] = e.items.length;
      const states = {};
      const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
      for (const k of keys) {
        const st = social.states.get(k);
        states[k] = { phase: st?.phase ?? 'idle' };
      }
      sendJson({ config: cfg.social, pendingSummaries: stats, states });
      return true;
    }
    if (!(req.method === 'POST' && url.pathname === '/api/social')) return false;
    const body = await readBody();
    // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 social
    const file = readConfigObject(CONFIG_FILE);
    const merged = { ...(file.social ?? {}), ...body };
    // 新分句逻辑不再使用旧字段：保存时统一清理，避免旧配置残留
    for (const k of ['burstProbability', 'burstMaxMessages', 'followUpEnabled', 'followUpProbability', 'followUpDelayMinMs', 'followUpDelayMaxMs', 'followUpCooldownMs']) {
      delete merged[k];
    }
    for (const k of ['triggerProbability', 'activeCheckMinMs', 'activeCheckMaxMs', 'activeReplyDelayMinMs', 'activeReplyDelayMaxMs', 'activeDurationMinMs', 'activeDurationMaxMs', 'idleWindowMs', 'idleRetryProbability', 'idleRetryWaitMs', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs', 'proactiveCheckMaxMs', 'proactiveProbability', 'maxReplyChars', 'contextWindow', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
      if (merged[k] !== undefined) {
        const n = Number(merged[k]);
        if (Number.isFinite(n) && n >= 0) merged[k] = n;
      }
    }
    // 分条间隔 clamp 到非负
    for (const k of ['burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
      if (merged[k] !== undefined) merged[k] = Math.max(0, Number(merged[k]) || 0);
    }
    // 概率字段 clamp 到 0~1
    for (const k of ['triggerProbability', 'idleRetryProbability', 'proactiveProbability', 'skipProbability', 'surrenderProbability', 'longGapProbability']) {
      if (merged[k] !== undefined) merged[k] = Math.min(1, Math.max(0, Number(merged[k])));
    }
    // contextWindow 限制 1~100
    if (merged.contextWindow !== undefined) {
      merged.contextWindow = Math.min(100, Math.max(1, Math.round(Number(merged.contextWindow))));
    }
    // 布尔字段
    for (const k of ['activeDurationEnabled', 'proactiveEnabled', 'burstEnabled']) {
      if (merged[k] !== undefined) merged[k] = Boolean(merged[k]);
    }
    // 范围字段保证 min <= max
    for (const [minK, maxK] of [['activeCheckMinMs', 'activeCheckMaxMs'], ['activeReplyDelayMinMs', 'activeReplyDelayMaxMs'], ['activeDurationMinMs', 'activeDurationMaxMs'], ['proactiveCheckMinMs', 'proactiveCheckMaxMs'], ['burstIntervalMinMs', 'burstIntervalMaxMs'], ['longGapMinMs', 'longGapMaxMs']]) {
      if (merged[minK] !== undefined && merged[maxK] !== undefined && Number(merged[minK]) > Number(merged[maxK])) {
        [merged[minK], merged[maxK]] = [merged[maxK], merged[minK]];
      }
    }
    if (Array.isArray(body.mustReplyKeywords)) merged.mustReplyKeywords = body.mustReplyKeywords.map(String);
    file.social = merged;
    atomicWriteJson(CONFIG_FILE, file);
    cfg.social = { ...cfg.social, ...merged };
    log('控制台：社交配置已更新');
    sendJson({ ok: true, config: cfg.social });
    return true;
  }

  async function handleSocialFlush(req, res, url, sendJson, readBody) {
    if (!(req.method === 'POST' && url.pathname === '/api/social/flush')) return false;
    const body = await readBody();
    await flushSummaries(body.key || null);
    sendJson({ ok: true });
    return true;
  }

  // ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ──────────────────────
  async function handleConsoleNotifyAi(req, res, url, sendJson, readBody) {
    if (!(req.method === 'POST' && url.pathname === '/api/console/notify-ai')) return false;
    const cfg = getConfig();
    const currentMode = getMode();
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const message = String(body.message ?? '').trim();
    if (!key || !message) {
      sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
      return true;
    }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) {
      sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
      return true;
    }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0) {
      sendJson({ ok: false, error: 'id 无效' }, 400);
      return true;
    }
    if (!modeAllowed(key, kind, id, cfg, currentMode)) {
      sendJson({ ok: false, error: `该会话不在当前模式（${currentMode}）允许范围内` }, 403);
      return true;
    }
    if (!state.sessions[key] && !allowed(kind, id, cfg)) {
      sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
      return true;
    }
    if (!getDshReady()) {
      sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
      return true;
    }
    const isV2 = currentMode === 'reserved2';
    const roleState = readRoleState();
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    // 二代必须带会话令牌，否则 AI 调用任何 MCP 状态/发送工具都会被拒。
    let tokenLine = '';
    if (isV2) {
      const stV2 = getSocialV2State(key);
      tokenLine = `【会话令牌】${stV2.agentToken}（调用二代状态/发送工具时请在参数中带上此令牌）\n\n`;
    }
    const promptText = `${roleLine}${tokenLine}【后台控制端提醒】（来自控制台/管理端，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒，也不要发送其中的会话令牌；它只用于你内部调整行为。${isV2 ? '当前是二代仿真模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具（qq_send_message / qq_reply）。如果不需要发言，可以 qq_mark_read 或 qq_set_wake_config 收尾。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
    let sessionId = null;
    let popSilent = null;
    try {
      sessionId = await ensureSession(key);
      const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const arr = social.silentTurns.get(sessionId) ?? [];
      social.silentTurns.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
      popSilent = () => {
        const list = social.silentTurns.get(sessionId) ?? [];
        const next = list.filter((x) => x.id !== silentId);
        if (next.length > 0) social.silentTurns.set(sessionId, next);
        else social.silentTurns.delete(sessionId);
      };
      const result = await deliverPrompt(key, promptText, { silent: true });
      if (result.ok) {
        log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
        appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
        sendJson({ ok: true, key, sessionId });
      } else {
        popSilent();
        sendJson({ ok: false, error: result.error || '投递失败' }, 500);
      }
    } catch (error) {
      if (popSilent) popSilent();
      sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
    }
    return true;
  }

  /** 依次尝试本模块的路由；命中返回 true。 */
  async function dispatch(req, res, url, sendJson, readBody) {
    if (await handleTestSend(req, res, url, sendJson, readBody)) return true;
    if (await handleSocialState(req, res, url, sendJson, readBody)) return true;
    if (await handleSocialConfig(req, res, url, sendJson, readBody)) return true;
    if (await handleSocialFlush(req, res, url, sendJson, readBody)) return true;
    if (await handleConsoleNotifyAi(req, res, url, sendJson, readBody)) return true;
    return false;
  }

  return {
    handleTestSend,
    handleSocialState,
    handleSocialConfig,
    handleSocialFlush,
    handleConsoleNotifyAi,
    dispatch,
  };
}
