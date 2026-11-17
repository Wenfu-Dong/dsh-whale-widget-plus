/**
 * 二代（reserved2）管理 / AI 工具端点（组件化迁移 #14）：
 * 状态重置、语音发送、语音库列表、黑话查询与提交、旧读授权。
 *
 * 全局鉴权（控制台令牌 / agent token 白名单 / CSRF / 只读降级）仍由 bridge 先执行；
 * 这里只做会话级令牌、工具开关、模式白名单与业务参数校验。所有运行时状态由工厂注入。
 *
 * handler 统一签名：`handle(req, res, url, sendJson, readBody)`，已处理返回 true。
 */
import path from 'node:path';

export function createV2AdminRoutes(deps) {
  const {
    log, getConfig, getMode, modeAllowed,
    agentTokenOk, v2SessionAllowed, v2ToolEnabled, shouldBlockSilentReply,
    voice, auditOwner, fishGuardSendBlock, tokenGuardSendBlock, getSocialV2State,
    bumpSessionEpoch, sessionPromises, clearAllSocialV2Timers, drainAllPromptQueues,
    socialV2, state, stopRetiredSessionWork,
    sessionModels, modelAppliedSessions, reverse, collectors, v2TurnStartAt,
    turnLeaseNoted, toolCallNames, pendingSendToolCalls, sendToolSucceededSessions,
    api, forgetAgentToken, seenForwardIds, saveState,
    pendingWakeKeys, clearAllPendingWakeLeases, wakeConfigUpdatedKeys,
    markReadCalledKeys, wakeConfigMissCount, cancelSocialV2PendingSave,
    atomicWriteJson, SOCIAL_V2_FILE,
    slang, appendActivity, redactKnownTokensOnly,
    inspectAudio, describeAudio, listAudioFiles,
  } = deps || {};
  for (const [name, value] of Object.entries({
    log, getConfig, getMode, modeAllowed,
    agentTokenOk, v2SessionAllowed, v2ToolEnabled, shouldBlockSilentReply,
    voice, auditOwner, fishGuardSendBlock, tokenGuardSendBlock, getSocialV2State,
    bumpSessionEpoch, sessionPromises, clearAllSocialV2Timers, drainAllPromptQueues,
    socialV2, state, stopRetiredSessionWork,
    sessionModels, modelAppliedSessions, reverse, collectors, v2TurnStartAt,
    turnLeaseNoted, toolCallNames, pendingSendToolCalls, sendToolSucceededSessions,
    api, forgetAgentToken, seenForwardIds, saveState,
    pendingWakeKeys, clearAllPendingWakeLeases, wakeConfigUpdatedKeys,
    markReadCalledKeys, wakeConfigMissCount, cancelSocialV2PendingSave,
    atomicWriteJson, SOCIAL_V2_FILE,
    slang, appendActivity, redactKnownTokensOnly,
    inspectAudio, describeAudio, listAudioFiles,
  })) {
    if (value === undefined || value === null) throw new TypeError(`v2-admin 缺少依赖：${name}`);
  }

  // ── 状态重置（会话、定时器、唤醒配置清空，工具日志保留） ───────────────────
  async function handleReset(req, res, url, sendJson) {
    if (!(req.method === 'POST' && url.pathname === '/api/socialV2/reset')) return false;
    bumpSessionEpoch();
    sessionPromises.clear();
    clearAllSocialV2Timers();
    drainAllPromptQueues('二代状态已重置');
    for (const key of [...socialV2.conversations.keys()]) {
      const sid = state.sessions[key];
      if (sid) {
        delete state.sessions[key];
        // 与 retireSession / session-reset / workspace-reset 一致：先让 DSH 停下这个会话的活。
        // 少了这一步，DSH 会继续跑完在途/排队的 turn（token 照烧、副作用照做），
        // 而桥接这边已经把所有映射删掉 —— 输出被静默丢弃，agentToken 也已轮换（它的 MCP 发送全部 403）。
        stopRetiredSessionWork(sid, key);
        sessionModels.delete(sid);
        modelAppliedSessions.delete(sid);
        reverse.delete(sid);
        collectors.delete(sid);
        v2TurnStartAt.delete(sid);
        turnLeaseNoted.delete(sid);
        toolCallNames.delete(sid);
        pendingSendToolCalls.delete(sid);
        sendToolSucceededSessions.delete(sid);
        // 订阅也要退掉，否则它会在每次重连时被重新 follow 并重发整份快照。
        api.events.forget?.(sid);
      }
      delete state.sessionPolicies[key];
      forgetAgentToken(key);
      socialV2.conversations.delete(key);
      seenForwardIds.delete(key);
    }
    saveState();
    pendingWakeKeys.clear();
    clearAllPendingWakeLeases();
    wakeConfigUpdatedKeys.clear();
    markReadCalledKeys.clear();
    wakeConfigMissCount.clear();
    socialV2.paused = false;
    // 这里是「直写空状态」而不是走合并写：必须先把合并窗口里待写的**旧快照**取消，
    // 否则 300ms 后它会把刚清空的会话原样写回来（重置当场复活）。
    try { cancelSocialV2PendingSave(); } catch {}
    try { atomicWriteJson(SOCIAL_V2_FILE, { conversations: {} }); } catch (error) { log('重置二代状态：写空状态文件失败:', error?.message ?? error); }
    log('控制台：二代 AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留）');
    sendJson({ ok: true });
    return true;
  }

  // ── 语音发送（AI 通道：reserved2 + agent token，只能发自己那个会话） ──────
  async function handleSendVoice(req, res, url, sendJson, readBody) {
    if (!(req.method === 'POST' && url.pathname === '/api/socialV2/send-voice')) return false;
    const cfg = getConfig();
    const currentMode = getMode();
    const body = await readBody();
    const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
    const key = String(body.key ?? body.target ?? '').trim();
    const voiceSettings = voice.cfg();
    if (!voiceSettings.enabled) {
      sendJson({
        ok: false, code: 'VOICE_DISABLED',
        error: '语音功能已关闭（总闸）',
        hint: '去 设置 → dsh-Dfy → 系统 → 语音设置，打开「允许 AI 发语音条（总闸）」并保存',
      }, 403);
      return true;
    }
    if (!key) { sendJson({ ok: false, error: 'key 不能为空（格式 group:群号 或 private:QQ号）' }, 400); return true; }
    if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
    if (!token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; }
    if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (!v2ToolEnabled('sendVoice')) {
      sendJson({
        ok: false, code: 'VOICE_TOOL_DISABLED',
        error: '工具开关未启用：qq_send_voice',
        hint: '去 设置 → dsh-Dfy → 平台 → QQ → 高级设置 → 二代·工具开关，打开 sendVoice（或 socialV2.tools.sendVoice=true），保存后点「保存并热重载」',
      }, 403);
      return true;
    }
    if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return true; }
    {
      const m = /^(group|private):(\d+)$/.exec(key);
      const block = m ? voice.triggerBlock(key, m[1], Number(m[2])) : 'key 格式不对';
      if (block) { sendJson({ ok: false, error: block }, 403); return true; }
      // 语音触发是 owner 授权的特权操作：过闸即记审计（实际发送失败不影响这条授权记录）。
      auditOwner('voice.trigger', {
        actor: { id: String(cfg.ownerQQ ?? ''), isOwner: true },
        rule: 'voice.trigger',
        decision: 'allow',
        ref: { session: key },
      });
    }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
      sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
      return true;
    }
    const st = getSocialV2State(key);
    const fishBlock = fishGuardSendBlock(key, st);
    if (fishBlock) { sendJson({ ok: false, ...fishBlock }, 403); return true; }
    const tokenBlock = body.dryRun === true ? null : tokenGuardSendBlock(key, st, 1);
    if (tokenBlock) { sendJson({ ok: false, ...tokenBlock }, 429); return true; }
    // 两条来源：text（现场合成，需要本地 voxd）与 voice/file（语音库现成音频）。二选一。
    const sayText = String(body.text ?? '').trim();
    const libRef = body.voice ?? body.file ?? '';
    if (sayText && libRef) { sendJson({ ok: false, error: 'text 和 voice 只能传一个' }, 400); return true; }
    if (!sayText && !libRef) { sendJson({ ok: false, error: '缺少 text 或 voice（二选一）' }, 400); return true; }

    let resolved = null;
    if (sayText) {
      // 先查额度再合成：超限就别白烧一次 GPU
      try {
        voice.budgetCheck(key, voiceSettings);
        resolved = await voice.synthesizeText(sayText, {
          character: body.character ? String(body.character) : '',
          route: body.route ? String(body.route) : ''
        });
      } catch (error) {
        const msg = error?.message ?? String(error);
        const code = /频率超限/.test(msg) ? 429 : /语音合成|TTS/.test(msg) ? 502 : 400;
        sendJson({ ok: false, code: error?.code || '', hint: error?.hint || '', error: msg }, code);
        return true;
      }
    } else {
      try {
        resolved = voice.resolvePathForV2(libRef);
      } catch (error) {
        sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
        return true;
      }
    }
    try {
      voice.budgetCheck(key, voiceSettings);
      if (body.dryRun === true) {
        const probe = await inspectAudio(resolved.path, { maxBytes: voiceSettings.maxBytes, maxSeconds: voiceSettings.maxSeconds });
        if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return true; }
        sendJson({ ok: true, dryRun: true, key, file: resolved.path, detail: describeAudio(probe) });
        return true;
      }
      const sent = await voice.sendForV2(key, libRef || sayText, {
        label: body.label ? String(body.label).slice(0, 100) : '',
        verify: body.verify,
        readback: body.readback === true,
        resolved,
        // AI 也可以调音量（默认走 config 的 defaultVolume）
        audio: (body.volume !== undefined || body.normalize === true || body.loudness !== undefined)
          ? { volume: body.volume, normalize: body.normalize === true, loudness: body.loudness }
          : null
      });
      voice.markSent(key);
      sendJson({
        ok: true,
        key,
        messageId: sent.messageId,
        file: path.basename(sent.file),
        source: sayText ? 'tts' : 'library',
        tts: sayText ? { cached: resolved.ttsCached, durationMs: resolved.ttsDurationMs } : null,
        detail: sent.detail,
        audioProcessing: sent.audioProcessing,
        // verified=true 表示已用 get_msg 回读到这条消息的 record 段（"真的发出去了"的硬证据）
        verified: sent.verification?.confirmed === true,
        readback: sent.readback,
        warnings: sent.warnings
      });
    } catch (error) {
      // 额度只在真正发出后才记账（voiceBudgetCommit），所以失败路径无需回滚。
      sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
    }
    return true;
  }

  // 语音库列表。两条通道共用：
  //   - 带 agent token（AI 的 qq_list_voices）→ 必须带 key，校验会话白名单/工具开关；
  //   - 不带 agent token（控制台调试面板 / CLI）→ 只需控制台令牌，不需要 key。
  // 返回一律只有文件名/大小/时长，**不含绝对路径**（AI 侧防路径外泄，控制台侧由试发接口解析）。
  async function handleVoices(req, res, url, sendJson) {
    if (!(req.method === 'GET' && (url.pathname === '/api/socialV2/voices' || url.pathname === '/api/voice/list'))) return false;
    const key = String(url.searchParams.get('key') ?? '').trim();
    const voiceSettings = voice.cfg();
    const agentCall = Boolean(req.headers['x-agent-token']);
    // 与发送接口同样的分层：enabled 只关 AI 通道；操作者（控制台面板）仍可列语音库。
    if (agentCall && !voiceSettings.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return true; }
    if (agentCall && !key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (agentCall && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (agentCall && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (agentCall && !v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return true; }
    const wantProbe = url.searchParams.get('probe') !== '0';
    try {
      const files = listAudioFiles(voiceSettings.dir);
      const items = [];
      for (const f of files.slice(0, 100)) {
        const entry = { name: path.relative(voiceSettings.dir, f).split(path.sep).join('/') };
        if (wantProbe) {
          const info = await inspectAudio(f, { maxBytes: voiceSettings.maxBytes, maxSeconds: voiceSettings.maxSeconds });
          entry.ok = info.ok;
          entry.bytes = info.size;
          entry.detail = info.ok ? describeAudio(info) : null;
          entry.seconds = info.duration ?? null;
          if (!info.ok) entry.error = info.error;
        }
        items.push(entry);
      }
      sendJson({
        ok: true,
        key: key || null,
        dir: agentCall ? undefined : voiceSettings.dir,
        count: items.length,
        voices: items,
        limits: { maxSeconds: voiceSettings.maxSeconds, maxBytes: voiceSettings.maxBytes, maxPerMinute: voiceSettings.maxPerMinute, maxPerHour: voiceSettings.maxPerHour },
        // ⚠️ 提示语里也不能出现绝对路径：AI 通道下同样要脱敏。
        hint: items.length
          ? '用 qq_send_voice 传 name 即可把其中一个当语音发出去'
          : (agentCall ? '语音库为空：请让管理员先把音频放进语音库' : `语音库为空：把音频文件放进 ${voiceSettings.dir} 后重试`)
      });
    } catch (error) {
      sendJson({ ok: false, error: `读取语音库失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  // ── 二代黑话学习（reserved2）：AI 查询/提交黑话候选 ─────────────────────
  async function handleSlangQuery(req, res, url, sendJson) {
    if (!(req.method === 'GET' && url.pathname === '/api/socialV2/slang/query')) return false;
    const key = String(url.searchParams.get('key') ?? '').trim();
    const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('slangQuery')) { sendJson({ ok: false, error: '工具未启用：qq_slang_query' }, 403); return true; }
    const list = slang.confirmedList().filter((e) => {
      if (!q) return true;
      return e.content.toLowerCase().includes(q)
        || e.meaning.toLowerCase().includes(q)
        || e.usage.toLowerCase().includes(q)
        || e.example.toLowerCase().includes(q);
    });
    sendJson({
      ok: true,
      key,
      total: list.length,
      entries: list,
      block: slang.context()
    });
    return true;
  }

  async function handleSlangSubmit(req, res, url, sendJson, readBody) {
    if (!(req.method === 'POST' && url.pathname === '/api/socialV2/slang/submit')) return false;
    const cfg = getConfig();
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const content = redactKnownTokensOnly(String(body.content ?? '')).trim();
    const context = redactKnownTokensOnly(String(body.context ?? '')).trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('slangSubmit')) { sendJson({ ok: false, error: '工具未启用：qq_slang_submit' }, 403); return true; }
    if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403); return true; }
    if (!content) { sendJson({ ok: false, error: 'content 不能为空' }, 400); return true; }
    if (content.length > 50) { sendJson({ ok: false, error: '黑话词条过长（最多 50 字）' }, 400); return true; }
    const submitted = slang.submitCandidate({ key, content, context });
    if (!submitted.ok) {
      sendJson({ ok: false, error: submitted.error }, submitted.statusCode || 400);
      return true;
    }
    if (!submitted.duplicate) {
      appendActivity(`${key} [reserved2] AI 提交黑话候选：${content}${context ? '（附语境）' : ''}`);
    }
    sendJson(submitted);
    return true;
  }

  // ── 旧只读工具授权 ────────────────────────────────────────────────────────
  async function handleAuthorizeRead(req, res, url, sendJson, readBody) {
    if (!(req.method === 'POST' && url.pathname === '/api/authorize/read')) return false;
    const cfg = getConfig();
    const currentMode = getMode();
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const token = String(body.token ?? '').trim();
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
    if (!token || !agentTokenOk(key, token)) {
      // 空 token 一律拒绝：该端点对 agent 流量开放（见 console 的 agent 白名单），
      // 而 MCP 的 agentApi 总是带着真实控制台令牌，所以「不传 token 就跳过校验」
      // 等于把它变成免鉴权端点。
      sendJson({ ok: false, error: token ? 'agent token 无效' : '缺少会话令牌；旧只读工具在需要令牌的模式下不可用，请改用带会话令牌的 v2 读工具' }, 403);
      return true;
    }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
      sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
      return true;
    }
    sendJson({ ok: true, key });
    return true;
  }

  async function dispatch(req, res, url, sendJson, readBody) {
    if (await handleReset(req, res, url, sendJson, readBody)) return true;
    if (await handleSendVoice(req, res, url, sendJson, readBody)) return true;
    if (await handleVoices(req, res, url, sendJson, readBody)) return true;
    if (await handleSlangQuery(req, res, url, sendJson, readBody)) return true;
    if (await handleSlangSubmit(req, res, url, sendJson, readBody)) return true;
    if (await handleAuthorizeRead(req, res, url, sendJson, readBody)) return true;
    return false;
  }

  return {
    handleReset,
    handleSendVoice,
    handleVoices,
    handleSlangQuery,
    handleSlangSubmit,
    handleAuthorizeRead,
    dispatch,
  };
}
