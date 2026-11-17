/**
 * 协议邻近 HTTP 端点（组件化迁移 #11）：图片查询、桌宠代发、统一发送、
 * 会话/工作区重置、重启与记忆卡告警。
 *
 * 这些端点与 QQ 协议细节耦合较深（media 元数据、agent 会话令牌、发送限流），
 * 但又必须复用 bridge 里的运行时状态与会话队列。因此这里不 import bridge，
 * 全部依赖由工厂注入；state/pending/queued/social/socialV2/sessionEpoch 等
 * 仍只保留在 bridge 闭包里一份，模块只通过引用/getter 操作。
 *
 * handler 统一签名：`handle(req, res, url, sendJson, readBody)`，已处理返回 true。
 * 全局鉴权、CSRF、只读降级与模式判定仍在 bridge 里先于这里执行。
 */
import fs from 'node:fs';
import path from 'node:path';

export function createProtocolRoutes(deps) {
  const {
    log, getConfig, getMode, agentTokenOk, v2ToolEnabled, modeAllowed,
    findMessageMedia, fetchMediaData, sendToQQ, lastSendSucceeded,
    scheduleSocialReply, ownerMessageTag, resolveReplyTargetV2,
    sendMessagesV2, recordSentMessagesV2, sendRateLimitInfo, reportLimitEvent,
    shouldBlockSilentReply, getSocialV2State, saveSocialV2State,
    appendActivity, scheduleReplyCheckV2, cancelPendingEntry,
    drainPromptQueue, drainAllPromptQueues, cancelSocialTimers, cancelAllSocialTimers,
    clearSocialV2Timers, clearAllSocialV2Timers,
    slang, forgetAgentToken, flushSocialV2State, saveState,
    api, withTimeout, unwrap, onebotSend, releaseLock, auditOwner,
    DSH_CONTROL_TIMEOUT_MS, SEND_TIMEOUT_MS, embed, getEmbeddedRuntime,
    state, social, socialV2, pending, queued, queuedHintAt, sessionPromises,
    messageMediaStore, seenForwardIds, modelAppliedSessions, reverse, collectors,
    sendToolSucceededSessions, pendingSendToolCalls, v2TurnStartAt, turnLeaseNoted,
    toolCallNames, pendingWakeKeys, wakeConfigUpdatedKeys, markReadCalledKeys,
    wakeConfigMissCount, CONVERSATION_TOKENS, KNOWN_AGENT_TOKENS,
    memoryCardNotifyAt, bumpSessionEpoch, SENSITIVE_RE, ILLEGAL_CONTENT_RE,
    unquoteJsonString, STATE_DIR, ACTIVITY_LOG,
  } = deps || {};
  for (const [name, value] of Object.entries({
    log, getConfig, getMode, agentTokenOk, v2ToolEnabled, modeAllowed,
    findMessageMedia, fetchMediaData, sendToQQ, lastSendSucceeded,
    scheduleSocialReply, ownerMessageTag, resolveReplyTargetV2,
    sendMessagesV2, recordSentMessagesV2, sendRateLimitInfo, reportLimitEvent,
    shouldBlockSilentReply, getSocialV2State, saveSocialV2State,
    appendActivity, scheduleReplyCheckV2, cancelPendingEntry,
    drainPromptQueue, drainAllPromptQueues, cancelSocialTimers, cancelAllSocialTimers,
    clearSocialV2Timers, clearAllSocialV2Timers,
    slang, forgetAgentToken, flushSocialV2State, saveState,
    api, withTimeout, unwrap, onebotSend, releaseLock, auditOwner,
    DSH_CONTROL_TIMEOUT_MS, SEND_TIMEOUT_MS, embed, getEmbeddedRuntime,
    state, social, socialV2, pending, queued, queuedHintAt, sessionPromises,
    messageMediaStore, seenForwardIds, modelAppliedSessions, reverse, collectors,
    sendToolSucceededSessions, pendingSendToolCalls, v2TurnStartAt, turnLeaseNoted,
    toolCallNames, pendingWakeKeys, wakeConfigUpdatedKeys, markReadCalledKeys,
    wakeConfigMissCount, CONVERSATION_TOKENS, KNOWN_AGENT_TOKENS,
    memoryCardNotifyAt, bumpSessionEpoch, SENSITIVE_RE, ILLEGAL_CONTENT_RE,
    unquoteJsonString, STATE_DIR, ACTIVITY_LOG,
  })) {
    if (value === undefined || value === null) throw new TypeError(`protocol-routes 缺少依赖：${name}`);
  }

  // ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ──────────────────
  async function handleImagesMessage(req, res, url, sendJson) {
    if (!(req.method === 'GET' && url.pathname === '/api/images/message')) return false;
    const cfg = getConfig();
    const currentMode = getMode();
    const key = String(url.searchParams.get('key') ?? '').trim();
    const messageId = String(url.searchParams.get('messageId') ?? '').trim();
    const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
    if (!messageId) { sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return true; }
    if (currentMode === 'reserved2' && !agentToken) {
      sendJson({ ok: false, error: 'reserved2 模式读取图片必须携带 agent token' }, 403);
      return true;
    }
    if (currentMode === 'chat' || currentMode === 'reserved') {
      sendJson({ ok: false, error: '一代 chat/reserved 模式图片已自动内联，按需图片工具仅 reserved2 模式可用' }, 403);
      return true;
    }
    if (agentToken && !agentTokenOk(key, agentToken)) {
      sendJson({ ok: false, error: 'agent token 无效' }, 403);
      return true;
    }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
      sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
      return true;
    }
    if (agentToken && !v2ToolEnabled('getImages')) {
      sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
      return true;
    }
    if (!agentToken && currentMode === 'closed-agent' && !v2ToolEnabled('getImages')) {
      sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
      return true;
    }
    const media = findMessageMedia(key, messageId);
    if (!media.length) {
      sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' });
      return true;
    }
    try {
      const images = await fetchMediaData(media);
      sendJson({ ok: true, messageId, media, images });
    } catch (error) {
      log(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`);
      sendJson({ ok: false, error: `图片查询失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  // ── 桌宠挂件代主人发消息（控制台令牌鉴权，只允许主人私聊） ──────────────────
  async function handlePetQqSend(req, res, url, sendJson, readBody) {
    if (!(req.method === 'POST' && url.pathname === '/api/pet/qq-send')) return false;
    const cfg = getConfig();
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const message = String(body.text ?? '').trim();
    const ownerKey = cfg.ownerQQ ? `private:${cfg.ownerQQ}` : '';
    if (!ownerKey) { sendJson({ ok: false, error: '还没配置 ownerQQ' }, 409); return true; }
    if (key !== ownerKey) { sendJson({ ok: false, error: '桌宠只能给主人发私聊' }, 403); return true; }
    if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return true; }
    if (message.length > 1000) { sendJson({ ok: false, error: '单条消息太长' }, 400); return true; }
    if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return true; }
    if (ILLEGAL_CONTENT_RE.test(message)) { sendJson({ ok: false, error: '消息命中违规关键词黑名单，已阻止发送' }, 403); return true; }
    await sendToQQ(key, message, { mirror: false });
    if (!lastSendSucceeded(key)) { sendJson({ ok: false, error: 'QQ 发送失败，检查 SnowLuma 连接' }, 502); return true; }
    sendJson({ ok: true });
    return true;
  }

  // ── 桌宠输入 → 当成「主人刚在 QQ 说了这句话」，走 agent 管线 ──────────────────
  // 关键：这条和她真正收到 QQ 消息是同一套上下文/记忆/会话记录，
  // 她的回复再由 agent 正常发回 QQ，桌宠那边通过 mirror 看到 —— 不再另起一套对话。
  async function handlePetOwnerMessage(req, res, url, sendJson, readBody) {
    if (!(req.method === 'POST' && url.pathname === '/api/pet/owner-message')) return false;
    const cfg = getConfig();
    const currentMode = getMode();
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const text = String(body.text ?? '').trim();
    const ownerKey = cfg.ownerQQ ? `private:${cfg.ownerQQ}` : '';
    if (!ownerKey) { sendJson({ ok: false, error: '还没配置 ownerQQ' }, 409); return true; }
    if (key !== ownerKey) { sendJson({ ok: false, error: '桌宠只能操作主人私聊' }, 403); return true; }
    if (!text) { sendJson({ ok: false, error: '消息不能为空' }, 400); return true; }
    if (text.length > 1000) { sendJson({ ok: false, error: '单条消息太长' }, 400); return true; }
    if (SENSITIVE_RE.test(text)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return true; }
    if (ILLEGAL_CONTENT_RE.test(text)) { sendJson({ ok: false, error: '消息命中违规关键词黑名单，已阻止发送' }, 403); return true; }
    // 二代（reserved2）里她的文本输出**不会自动发到 QQ**，回话必须自己调 qq_send_message；
    // 发送工具要求 token 传【会话令牌】、key 传会话值。这两行**不能在这里拼**：
    // 建会话/退役旧会话都会轮换 agentToken，提前取的令牌到投递时已作废
    // （2026-11-04 桌面版首次发消息实测：全部工具调用都报「会话令牌无效」）。
    // 令牌与【会话】由 deliverPromptNow 在 ensureSession 之后补齐（opts.petOwnerMessage）。
    const sendRule = currentMode === 'reserved2'
      ? '\n\n（这是主人在桌宠卡片里刚说的话，等同 QQ 私聊来信：单句、对方已经说完。'
        + '你的文本输出不会自动发到 QQ/卡片：要回话必须调用 qq_send_message，key 用上面【会话】里的值、token 用上面【会话令牌】里的值。'
        + '这种单句私聊直接回就行，**不要**再 qq_wait_for_messages(purpose="reply") 等静默；'
        + '回过之后这一轮就可以结束（可直接 qq_close_conversation 收尾，不必做沉睡前观察）。）'
      : '';
    // 固定 2s，不用 2~8s 随机：桌宠里连发几条时，随机延迟会让后面的消息
    // 抢到前面（实测"连发测试三"先到，她先回了三号，回头才发现一号二号没瞧见）。
    // 相同延迟下定时器按注册顺序触发，而 HTTP 请求本就按到达顺序处理，于是保序。
    scheduleSocialReply(key, `${ownerMessageTag()}${text}${sendRule}`, 2000, 2000, '桌宠输入', false, null, { petOwnerMessage: true });
    log(`桌宠输入已交给 agent：${key} ${text.slice(0, 60)}`);
    sendJson({ ok: true });
    return true;
  }

  // ── 统一发送端点（MCP 旧发送工具也走这里） ──────────────────────────────────
  async function handleSend(req, res, url, sendJson, readBody) {
    if (!(req.method === 'POST' && (url.pathname === '/api/send/group' || url.pathname === '/api/send/private' || url.pathname === '/api/send/reply'))) return false;
    const cfg = getConfig();
    const currentMode = getMode();
    const body = await readBody();
    const token = String(body.token ?? '').trim();
    const isPrivate = url.pathname === '/api/send/private';
    const isReply = url.pathname === '/api/send/reply';
    const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
    const message = unquoteJsonString(String(body.message ?? '').trim());
    // 引用 id 与端点无关：/api/send/reply 与另两个端点都允许带（是否真的引用由下游按 id 判断）。
    // 旧写法 `isReply ? body.replyToMessageId : body.replyToMessageId` 两个分支一模一样，
    // 保留 isReply 变量只是为了下面的端点语义判断，别再让人以为这里有过分支逻辑。
    const replyToMessageId = body.replyToMessageId;
    const atUserId = body.atUserId ?? null;
    const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
    // 安全边界：发送工具只允许在 closed-agent（管理员私聊）或 reserved2（二代 AI 带会话令牌）下使用；
    // chat/reserved 的自动转发已覆盖正常回复，MCP 发送工具不应成为 prompt injection 的越权出口。
    if (currentMode === 'chat' || currentMode === 'reserved') {
      sendJson({ ok: false, error: '发送工具仅限 closed-agent / reserved2 模式使用' }, 403);
      return true;
    }
    if (socialV2.paused && token) {
      sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
      return true;
    }
    if (!targetId || !message) { sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return true; }
    if (isPrivate && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return true; }
    if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
      sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
      return true;
    }
    if (currentMode === 'reserved2' && !token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; }
    if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
    if (token && !v2ToolEnabled(flag)) { sendJson({ ok: false, error: `工具未启用：${flag}` }, 403); return true; }
    if (shouldBlockSilentReply(key)) {
      sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
      return true;
    }
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式无效' }, 400); return true; }
    const kind = keyMatch[1];
    const id = Number(keyMatch[2]);
    if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
      sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
      return true;
    }
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
      sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
      return true;
    }
    let quotedInfo = null;
    let actualReplyToMessageId = replyToMessageId;
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const stForReply = getSocialV2State(key);
      const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
      if (!resolved) {
        sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
        return true;
      }
      quotedInfo = resolved.info;
      actualReplyToMessageId = resolved.messageId;
    }
    const sendCfg = cfg.socialV2?.send ?? {};
    const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
    if (message.length > maxChars) { sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字；内容太长先总结/挑重点，不要拆成 10 条刷屏` }, 400); return true; }
    if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return true; }
    if (ILLEGAL_CONTENT_RE.test(message)) { sendJson({ ok: false, error: '消息命中违规关键词黑名单，已阻止发送' }, 403); return true; }
    // st/now 必须声明在 try **之外**：下面的 catch 要用它们回滚预占的发送额度。
    // 写在 try 里时 catch 拿到的是块作用域外的名字 ⇒ ReferenceError（send-burst
    // 曾整段踩过同型问题，见体检报告 #1 / R2）。后果不是"少一行日志"，而是
    // 失败响应变成「st is not defined」、额度不回滚（接下来一分钟全是假 429），
    // 且部分成功的已发消息不会被记进 recentMessages。
    const st = getSocialV2State(key);
    const now = Date.now();
    try {
      const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
      const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
      const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
      const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
      const rateLimit = sendRateLimitInfo(key, st, sendCfg, 1);
      if (rateLimit) { reportLimitEvent(key, rateLimit); sendJson(rateLimit, 429); return true; }
      st.sendTimes.push(now);
      if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
      const sentMessages = await sendMessagesV2(key, [message], [], actualReplyToMessageId, atUserId);
      recordSentMessagesV2(key, sentMessages);
      st.lastAiReplyAt = now;
      st.lastActionAt = now;
      st.wakeConfig.noActionCount = 0;
      saveSocialV2State();
      log(`[send] ${url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
      appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
      if (sentMessages.length > 0) scheduleReplyCheckV2(key);
      sendJson({ ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo });
    } catch (error) {
      if (error?.sent?.length) {
        recordSentMessagesV2(key, error.sent);
        log(`[send] ${url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
      }
      // 失败/未发出的消息回滚预占的发送额度，避免假 429。
      const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
      const failedCount = Math.max(0, 1 - sentCount);
      for (let i = 0; i < failedCount; i++) {
        const idx = st.sendTimes.indexOf(now);
        if (idx >= 0) st.sendTimes.splice(idx, 1);
      }
      if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
      saveSocialV2State();
      sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
    }
    return true;
  }

  // ── 清除上下文 ────────────────────────────────────────────────────────────
  async function handleSessionReset(req, res, url, sendJson, readBody) {
    if (!(req.method === 'POST' && url.pathname === '/api/session/reset')) return false;
    const body = await readBody();
    const key = String(body.key ?? '');
    if (!key || !state.sessions[key]) { sendJson({ ok: false, error: '会话不存在' }, 404); return true; }
    bumpSessionEpoch();
    const oldSessionId = state.sessions[key];
    delete state.sessions[key];
    modelAppliedSessions.delete(oldSessionId);
    // 权限元数据必须与映射一起删除，否则会永久残留在 sessions.json 里。
    delete state.sessionPolicies[key];
    reverse.delete(oldSessionId);
    collectors.delete(oldSessionId);
    sendToolSucceededSessions.delete(oldSessionId);
    pendingSendToolCalls.delete(oldSessionId);
    v2TurnStartAt.delete(oldSessionId);
    turnLeaseNoted.delete(oldSessionId);
    toolCallNames.delete(oldSessionId);
    const pe = pending.get(key);
    if (pe) {
      clearTimeout(pe.timer);
      cancelPendingEntry(pe).catch(() => {});
    }
    pending.delete(key);
    queued.delete(key);
    queuedHintAt.delete(key);
    sessionPromises.delete(key);
    drainPromptQueue(key, '会话已重置');
    social.recentMessages.delete(key);
    messageMediaStore.delete(key);
    social.pendingSummaries.delete(key);
    social.states.delete(key);
    social.silentContext.delete(key);
    social.silentTurns.delete(oldSessionId);
    social.exitingSessions.delete(oldSessionId);
    slang.resetKey(key);
    cancelSocialTimers(key);
    clearSocialV2Timers(key);
    pendingWakeKeys.delete(key);
    wakeConfigUpdatedKeys.delete(key);
    markReadCalledKeys.delete(key);
    wakeConfigMissCount.delete(key);
    forgetAgentToken(key);
    socialV2.conversations.delete(key);
    seenForwardIds.delete(key);
    flushSocialV2State();
    saveState();
    // 归档只隐藏会话，不终止 DSH 侧排队的工作；先清队列并取消当前回合。
    try { await withTimeout(api.stopSessionWork(oldSessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
    catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
    try { await withTimeout(api.workspace.archiveSession({ sessionId: oldSessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
    log(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已停止并归档）`);
    sendJson({ ok: true, key, archived: oldSessionId });
    return true;
  }

  // ── 清空工作区 ────────────────────────────────────────────────────────────
  async function handleWorkspaceReset(req, res, url, sendJson) {
    if (!(req.method === 'POST' && url.pathname === '/api/workspace/reset')) return false;
    bumpSessionEpoch();
    let archivedCount = 0;
    let stoppedCount = 0;
    try {
      // 新版 DSH 不再提供 workspace.list；改为扫描本桥接创建的会话目录并归档。
      // 只处理 cwd 位于 qq-bridge state/ 下的根会话；子代理会话由父会话管理，不能误归档。
      const list = unwrap(await withTimeout(api.sessions.list({}), DSH_CONTROL_TIMEOUT_MS, 'sessions.list'), 'session.list');
      const stateDir = path.resolve(STATE_DIR);
      const statePrefix = path.normalize(stateDir + path.sep);
      const normPath = (p) => path.normalize(String(p ?? '').replace(/\//g, path.sep));
      const isUnderState = (cwd) => process.platform === 'win32'
        ? cwd.toLowerCase().startsWith(statePrefix.toLowerCase())
        : cwd.startsWith(statePrefix);
      for (const item of list.items ?? []) {
        if (item.origin === 'subagent' || item.parentSessionId) continue;
        const cwd = normPath(item.cwd);
        if (isUnderState(cwd)) {
          // 归档只隐藏会话；必须先把 DSH 侧排队的工作清掉并取消当前回合。
          try { await withTimeout(api.stopSessionWork(item.sessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); stoppedCount += 1; }
          catch (error) { log(`⚠️ 停止旧会话失败 ${item.sessionId}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await withTimeout(api.workspace.archiveSession({ sessionId: item.sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); archivedCount += 1; } catch {}
        }
      }
    } catch {}
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      cancelPendingEntry(entry).catch(() => {});
    }
    pending.clear();
    queued.clear();
    queuedHintAt.clear();
    sessionPromises.clear();
    drainAllPromptQueues('工作区已清空');
    social.states.clear();
    social.recentMessages.clear();
    messageMediaStore.clear();
    seenForwardIds.clear();
    social.pendingSummaries.clear();
    social.silentContext.clear();
    social.silentTurns.clear();
    social.exitingSessions.clear();
    slang.resetAllWindows();
    cancelAllSocialTimers();
    clearAllSocialV2Timers();
    // 清空工作区 = 所有会话连同 token 一起作废，两张表整体清掉（比逐会话摘除更不容易漏）。
    socialV2.conversations.clear();
    CONVERSATION_TOKENS.clear();
    KNOWN_AGENT_TOKENS.clear();
    flushSocialV2State();
    state.sessions = {};
    state.sessionPolicies = {};
    reverse.clear();
    collectors.clear();
    sendToolSucceededSessions.clear();
    pendingSendToolCalls.clear();
    v2TurnStartAt.clear();
    toolCallNames.clear();
    saveState();
    try { fs.writeFileSync(ACTIVITY_LOG, ''); } catch {}
    log(`控制台：已清空 QQ 聊天工作区（停止 ${stoppedCount} 个、归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
    sendJson({ ok: true, archivedCount, stoppedCount });
    return true;
  }

  // ── 重启桥接（守护模式下 5 秒后自动拉起） ────────────────────────────────────
  async function handleRestart(req, res, url, sendJson) {
    if (!(req.method === 'POST' && url.pathname === '/api/restart')) return false;
    if (embed) {
      // 嵌入模式不能 process.exit（那会带走整个 DSH）。改成热重载配置。
      const embeddedRuntime = getEmbeddedRuntime();
      const reloaded = embeddedRuntime?.reload ? await embeddedRuntime.reload() : { ok: false, error: '嵌入运行时尚未就绪' };
      sendJson(reloaded, reloaded.ok ? 200 : 500);
      return true;
    }
    sendJson({ ok: true, message: '正在重启桥接（若由守护窗口启动，5 秒后自动恢复）…' });
    setTimeout(() => {
      log('控制台：重启桥接');
      // 退出前落盘：SIGINT/SIGTERM 的收尾路径会 saveState()/saveSocialV2State()，
      // 而重启这条路径以前直接 process.exit，500ms 窗口内改动的唤醒配置/计数器会丢。
      try { saveState(); } catch (error) { log('重启前保存会话映射失败:', error?.message ?? error); }
      try { flushSocialV2State(); } catch (error) { log('重启前保存二代会话状态失败:', error?.message ?? error); }
      releaseLock();
      process.exit(0);
    }, 500);
    return true;
  }

  // ── 记忆卡容量告警：只私聊管理员本人，不发群、不接受任意收件人 ──────────────────
  async function handleMemoryCardNotify(req, res, url, sendJson, readBody) {
    if (!(req.method === 'POST' && url.pathname === '/api/memory-card/notify')) return false;
    const cfg = getConfig();
    const body = JSON.parse(await readBody() || '{}');
    if (!cfg.ownerQQ) { sendJson({ ok: false, error: '未配置管理员 QQ（ownerQQ）' }, 400); return true; }
    const level = Math.max(1, Math.min(3, Number(body.level) || 1));
    const now = Date.now();
    if ((memoryCardNotifyAt.get(level) ?? 0) + 10 * 60 * 1000 > now) {
      sendJson({ ok: true, skipped: 'cooldown' });
      return true;
    }
    const percent = Math.max(0, Math.min(999, Number(body.percent) || 0));
    const chars = Math.max(0, Math.min(10_000_000, Number(body.chars) || 0));
    const maxChars = Math.max(0, Math.min(10_000_000, Number(body.maxChars) || 0));
    const message = `【记忆卡】容量已到 ${percent}%（${chars}/${maxChars} 字）。该压缩了：打开 DSH → 设置 → dsh-Dfy → 角色 → 记忆卡与同步。`;
    try {
      // 走统一发送收口（本机路径脱敏 / 令牌拦截 / 失败记账都在那里）。
      await withTimeout(onebotSend('private', Number(cfg.ownerQQ), message), SEND_TIMEOUT_MS, '记忆卡告警私聊');
      memoryCardNotifyAt.set(level, now);
      log(`已私聊管理员记忆卡容量告警（${percent}%）`);
      auditOwner('memory.alert', {
        actor: { id: String(cfg.ownerQQ), isOwner: true },
        rule: 'ownerQQ',
        decision: 'allow',
        ref: { level, percent },
      });
      sendJson({ ok: true });
    } catch (error) {
      sendJson({ ok: false, error: `发送失败：${error?.message ?? error}` }, 502);
    }
    return true;
  }

  return {
    handleImagesMessage,
    handlePetQqSend,
    handlePetOwnerMessage,
    handleSend,
    handleSessionReset,
    handleWorkspaceReset,
    handleRestart,
    handleMemoryCardNotify,
  };
}
