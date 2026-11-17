/**
 * 二代仿真：发送 / 等待 / 表情 / 记忆 / 反馈工具（组件化迁移 #10）。
 *
 * 路由体从 src/bridge.js 的 main() 原样搬出，只把闭包依赖改为显式注入；
 * 这样协议闸门（token/白名单/工具开关）仍在全局检查里，组件只处理业务。
 * 保留在 bridge：/reset、/send-voice（AI 语音协议）、/voices、/slang/*（协议）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineComponent } from '../core/registry.js';
import { SENSITIVE_RE } from '../../sensitive.js';
import { truncateText } from '../../md-to-plain.js';
import { looksLikeUnfinished } from '../../v2-wait.js';
import { canonicalV2Key } from '../policy.js';
import { atomicWriteJson } from '../json-io.js';
import { safeFetchBuffer } from '../../safe-fetch.js';
import { formatForwardResponse } from '../../forward.js';

// 代码根（本文件在 src/qq/features/ 下，向上三层即仓库根），用于读取随包素材。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function createSocialToolsComponent(deps) {
  const {
    getConfig, getMode, getSocialV2,
    agentTokenOk, v2SessionAllowed, v2ToolEnabled, modeAllowed, shouldBlockSilentReply,
    getSocialV2State, fishGuardSendBlock, tokenGuardSendBlock, sendRateLimitInfo, reportLimitEvent,
    computeGapsV2, sendMessagesV2, recordSentMessagesV2, saveSocialV2State,
    log, appendActivity,
    scheduleReplyCheckV2, cancelReplyCheckV2, sendNekoAfterReply,
    findCjkSpaceWarning, findSplitBoundaryWarning,
    resolveReplyTargetV2, resolveReplyInfo, assertGroupMember, captureSendGuard,
    getBot, stickers,
    sendStickerV2, collectStickerV2, readThroughSeqV2,
    waitStreaks, WAIT_STREAK_RESET_MS, WAIT_STREAK_LIMIT,
    activeWaits, ACTIVE_WAIT_LEASE_MS,
    suggestQuietMsV2, getState, v2TurnStartAt, sleep,
    preSleepWaitBlockedV2, flushSocialV2State,
    noteModelMessagesV2, unreadNoticeV2,
    readToolLog, TOOL_LOG_FILE,
    readFeedbackEntries, FEEDBACK_FILE, feedbackTimes, appendFeedbackEntry,
    seenForwardIds, fetchMediaData,
    appendMemoryV2, formatMemoryV2, redactKnownTokensOnly,
    MAX_MEDIA_BYTES, MAX_MEDIA_PIXELS, getImageDimensions, mimeFromBuffer, mimeFromUrl,
  } = deps || {};
  const required = {
    getConfig, getMode, getSocialV2,
    agentTokenOk, v2SessionAllowed, v2ToolEnabled, modeAllowed, shouldBlockSilentReply,
    getSocialV2State, fishGuardSendBlock, tokenGuardSendBlock, sendRateLimitInfo, reportLimitEvent,
    computeGapsV2, sendMessagesV2, recordSentMessagesV2, saveSocialV2State,
    log, appendActivity,
    scheduleReplyCheckV2, cancelReplyCheckV2, sendNekoAfterReply,
    findCjkSpaceWarning, findSplitBoundaryWarning,
    resolveReplyTargetV2, resolveReplyInfo, assertGroupMember, captureSendGuard,
    getBot, stickers,
    sendStickerV2, collectStickerV2, readThroughSeqV2,
    waitStreaks, WAIT_STREAK_RESET_MS, WAIT_STREAK_LIMIT,
    activeWaits, ACTIVE_WAIT_LEASE_MS,
    suggestQuietMsV2, getState, v2TurnStartAt, sleep,
    preSleepWaitBlockedV2, flushSocialV2State,
    noteModelMessagesV2, unreadNoticeV2,
    readToolLog, TOOL_LOG_FILE,
    readFeedbackEntries, FEEDBACK_FILE, feedbackTimes, appendFeedbackEntry,
    seenForwardIds, fetchMediaData,
    appendMemoryV2, formatMemoryV2, redactKnownTokensOnly,
    MAX_MEDIA_BYTES, MAX_MEDIA_PIXELS, getImageDimensions, mimeFromBuffer, mimeFromUrl,
  };
  for (const [name, value] of Object.entries(required)) {
    if (value === undefined || value === null) throw new TypeError(`social-tools 缺少依赖：${name}`);
  }

  return defineComponent({
    id: 'social-tools',
    routes: [
      {
        method: 'POST',
        path: '/api/socialV2/send-burst',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const cfg = getConfig();
          const currentMode = getMode();
          const socialV2 = getSocialV2();
          if (req.method === 'POST' && url.pathname === '/api/socialV2/send-burst') {
            const body = await readBody();
            const key = String(body.key ?? '').trim();
            let rawMessages = body.messages;
            if (typeof rawMessages === 'string') {
              const trimmed = rawMessages.trim();
              if (trimmed.startsWith('[')) {
                try {
                  const parsed = JSON.parse(trimmed);
                  if (Array.isArray(parsed)) rawMessages = parsed.map(String);
                } catch {}
              } else if (trimmed.startsWith('"')) {
                // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
                try {
                  const parsed = JSON.parse(trimmed);
                  if (typeof parsed === 'string') rawMessages = parsed;
                  else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
                } catch {}
              }
            }
            const messages = Array.isArray(rawMessages)
              ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
              : (typeof rawMessages === 'string' ? [String(rawMessages).trim()].filter(Boolean) : []);
            const replyToMessageId = body.replyToMessageId;
            if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
              sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' }, 400);
              return;
            }
            if (!key || !messages.length) {
              sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
              return;
            }
            const sendCfgBurst = cfg.socialV2?.send ?? {};
            if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
              sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
              return;
            }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('sendBurst')) { sendJson({ ok: false, error: '工具未启用：qq_send_burst' }, 403); return; }
            if (currentMode !== 'reserved2') {
              sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
              return;
            }
            if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
            const keyMatch = /^(group|private):(\d+)$/.exec(key);
            if (!keyMatch) {
              sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
              return;
            }
            const kind = keyMatch[1];
            const id = Number(keyMatch[2]);
            if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
              sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
              return;
            }
            if (shouldBlockSilentReply(key)) {
              sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
              return;
            }
            const sendCfg = cfg.socialV2?.send ?? {};
            const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
            const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
            if (messages.length > maxMsgs) {
              sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
              return;
            }
            for (const msg of messages) {
              if (msg.length > maxChars) {
                sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字；内容太长先总结/挑重点，不要拆成 10 条刷屏` }, 400);
                return;
              }
              if (SENSITIVE_RE.test(msg)) {
                sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
                return;
              }
            }
            const st = getSocialV2State(key);
            const fishBlock = fishGuardSendBlock(key, st);
            if (fishBlock) { sendJson({ ok: false, ...fishBlock }, 403); return; }
            const tokenBlock = tokenGuardSendBlock(key, st, messages.length);
            if (tokenBlock) { sendJson({ ok: false, ...tokenBlock }, 429); return; }
            const now = Date.now();
            try {
              const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
              const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
              const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
              const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
              const rateLimit = sendRateLimitInfo(key, st, sendCfg, messages.length);
              if (rateLimit) { reportLimitEvent(key, rateLimit); sendJson(rateLimit, 429); return; }
              // 先预占发送额度，避免并发绕过限频
              for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
              if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
              const delays = computeGapsV2(messages, 'auto', undefined, undefined, sendCfg);
              const sentMessages = await sendMessagesV2(key, messages, delays);
              recordSentMessagesV2(key, sentMessages);
              st.lastAiReplyAt = now;
              st.lastActionAt = now;
              st.wakeConfig.noActionCount = 0;
              saveSocialV2State();
              log(`[reserved2] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
              appendActivity(`${key} [reserved2] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
              if (sentMessages.length > 0) scheduleReplyCheckV2(key);
              // 大肥鱼表情包：工具发送（reserved2 模式的主路径）成功后再补一张。
              // 注意只能补一次：这里以前连着写了两行 sendNekoAfterReply，会补两张表情。
              if (sentMessages.length > 0) void sendNekoAfterReply(key, messages.join(' '));
              const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
              const spaceWarn = findCjkSpaceWarning(messages);
              const splitWarn = findSplitBoundaryWarning(messages);
              sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
            } catch (error) {
              if (error?.sent?.length) {
                recordSentMessagesV2(key, error.sent);
                log(`[reserved2] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
              }
              // 失败/未发出的消息回滚预占的发送额度，避免假 429。
              const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
              const failedCount = Math.max(0, messages.length - sentCount);
              for (let i = 0; i < failedCount; i++) {
                const idx = st.sendTimes.indexOf(now);
                if (idx >= 0) st.sendTimes.splice(idx, 1);
              }
              if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
              saveSocialV2State();
              sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
            }
            return;
          }
        },
      },
      {
        method: 'POST',
        path: '/api/socialV2/send-message',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const cfg = getConfig();
          const currentMode = getMode();
          const socialV2 = getSocialV2();
          if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
            const body = await readBody();
            const key = String(body.key ?? '').trim();
            let rawMessages = body.messages;
            if (typeof rawMessages === 'string') {
              const trimmed = rawMessages.trim();
              // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
              if (trimmed.startsWith('[')) {
                try {
                  const parsed = JSON.parse(trimmed);
                  if (Array.isArray(parsed)) rawMessages = parsed.map(String);
                } catch {}
              } else if (trimmed.startsWith('"')) {
                // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
                try {
                  const parsed = JSON.parse(trimmed);
                  if (typeof parsed === 'string') rawMessages = parsed;
                  else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
                } catch {}
              }
            }
            const isRawString = typeof rawMessages === 'string';
            const messages = Array.isArray(rawMessages)
              ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
              : (isRawString ? [String(rawMessages).trim()].filter(Boolean) : []);
            const replyToMessageId = body.replyToMessageId;
            const atUserId = body.atUserId ?? null;
            // 二代不再按空格自动分条：字符串就是一条消息，数组模式原样使用调用方间隔。
            // 旧写法是 `(isRawString && messages.length > 1) ? 'auto' : ...` —— 上面 messages 的构造
            // 保证 isRawString 为真时 length 恒为 1，这个分支永远不可达，留着只会让人以为
            // "字符串多段时有特殊间隔策略"。
            const gapMode = (body.gapMode === 'fixed' || body.gapMode === 'byLength') ? body.gapMode : 'auto';
            const gapMs = Number(body.gapMs);
            const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
            if (!key || !messages.length) {
              sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
              return;
            }
            const sendCfgBurst = cfg.socialV2?.send ?? {};
            if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
              sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
              return;
            }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('sendMessage')) { sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403); return; }
            if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
            if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
            const keyMatch = /^(group|private):(\d+)$/.exec(key);
            if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
            const kind = keyMatch[1];
            const id = Number(keyMatch[2]);
            if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
              sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
              return;
            }
            if (kind === 'private' && atUserId) {
              sendJson({ ok: false, error: '私聊不需要 @' }, 400);
              return;
            }
            if (shouldBlockSilentReply(key)) {
              sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
              return;
            }
            if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
              sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
              return;
            }
            const sendCfg = cfg.socialV2?.send ?? {};
            const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
            const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
            if (messages.length > maxMsgs) {
              sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
              return;
            }
            for (const msg of messages) {
              if (msg.length > maxChars) {
                sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字；内容太长先总结/挑重点，不要拆成 10 条刷屏` }, 400);
                return;
              }
              if (SENSITIVE_RE.test(msg)) {
                sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
                return;
              }
            }
            const delays = computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);
            // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
            const st = getSocialV2State(key);
            const fishBlock = fishGuardSendBlock(key, st);
            if (fishBlock) { sendJson({ ok: false, ...fishBlock }, 403); return; }
            const tokenBlock = tokenGuardSendBlock(key, st, messages.length);
            if (tokenBlock) { sendJson({ ok: false, ...tokenBlock }, 429); return; }
            const now = Date.now();
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            const rateLimit = sendRateLimitInfo(key, st, sendCfg, messages.length);
            if (rateLimit) { reportLimitEvent(key, rateLimit); sendJson(rateLimit, 429); return; }
            // 先预占发送额度，避免并发绕过限频
            for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            let quotedInfo = null;
            let actualReplyToMessageId = replyToMessageId;
            if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
              const resolved = await resolveReplyTargetV2(st, kind, id, String(replyToMessageId).trim());
              if (!resolved) {
                // 引用解析失败：回滚已预占的发送额度
                for (let i = 0; i < messages.length; i++) {
                  const idx = st.sendTimes.indexOf(now);
                  if (idx >= 0) st.sendTimes.splice(idx, 1);
                }
                saveSocialV2State();
                sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
                return;
              }
              quotedInfo = resolved.info;
              actualReplyToMessageId = resolved.messageId;
            }
            try {
              const sentMessages = await sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId);
              recordSentMessagesV2(key, sentMessages);
              st.lastAiReplyAt = now;
              st.lastActionAt = now;
              st.wakeConfig.noActionCount = 0;
              saveSocialV2State();
              log(`[reserved2] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
              appendActivity(`${key} [reserved2] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
              if (sentMessages.length > 0) scheduleReplyCheckV2(key);
              const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
              const spaceWarn = findCjkSpaceWarning(messages);
              const splitWarn = findSplitBoundaryWarning(messages);
              sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, delays, quoted: quotedInfo, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
            } catch (error) {
              if (error?.sent?.length) {
                recordSentMessagesV2(key, error.sent);
                log(`[reserved2] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
              }
              // 失败/未发出的消息回滚预占的发送额度，避免假 429。
              const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
              const failedCount = Math.max(0, messages.length - sentCount);
              for (let i = 0; i < failedCount; i++) {
                const idx = st.sendTimes.indexOf(now);
                if (idx >= 0) st.sendTimes.splice(idx, 1);
              }
              if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
              saveSocialV2State();
              sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
            }
            return;
          }
        },
      },
      {
        method: 'POST',
        path: '/api/socialV2/send-poke',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const cfg = getConfig();
          const currentMode = getMode();
          const socialV2 = getSocialV2();
          const bot = getBot();
          if (req.method === 'POST' && url.pathname === '/api/socialV2/send-poke') {
            const body = await readBody();
            const key = String(body.key ?? '').trim();
            const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
            if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
            if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
            if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送拍一拍必须携带 agent token' }, 403); return; }
            if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (!v2ToolEnabled('sendPoke')) { sendJson({ ok: false, error: '工具未启用：qq_send_poke' }, 403); return; }
            if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能发送拍一拍' }, 403); return; }
            const keyMatch = /^(group|private):(\d+)$/.exec(key);
            if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
            const kind = keyMatch[1];
            const id = Number(keyMatch[2]);
            if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
              sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
              return;
            }
            if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403); return; }
            if (kind === 'group' && !targetUserId) {
              sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）' }, 400);
              return;
            }
            if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
              sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
              return;
            }
            // 群聊必须确认目标确实是本群成员（私聊天然只有双方，无需校验）。
            if (kind === 'group') {
              const memberError = await assertGroupMember(id, targetUserId);
              if (memberError) { sendJson({ ok: false, error: memberError }, 403); return; }
            }
            const st = getSocialV2State(key);
            const fishBlock = fishGuardSendBlock(key, st);
            if (fishBlock) { sendJson({ ok: false, ...fishBlock }, 403); return; }
            const tokenBlock = tokenGuardSendBlock(key, st, 1);
            if (tokenBlock) { sendJson({ ok: false, ...tokenBlock }, 429); return; }
            const sendCfg = cfg.socialV2?.send ?? {};
            const now = Date.now();
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            const rateLimit = sendRateLimitInfo(key, st, sendCfg, 1);
            if (rateLimit) { reportLimitEvent(key, rateLimit); sendJson(rateLimit, 429); return; }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            // 成员校验是异步的（要问 OneBot）；期间操作者可能切模式/改白名单/开静默。
            // 拍一拍此前完全没有发送守卫，这里补上：真正发之前再确认一次。
            const sendGuard = captureSendGuard(key);
            try {
              sendGuard();
              if (shouldBlockSilentReply(key)) {
                const blocked = new Error('静默模式已开启，当前不允许拍一拍');
                blocked.statusCode = 403;
                throw blocked;
              }
              if (kind === 'group') {
                await bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
              } else {
                // 私聊拍一拍：send_poke 自动路由到当前私聊对象
                await bot.raw('send_poke', { user_id: id });
              }
              st.lastActionAt = now;
              st.lastAiReplyAt = now;
              st.wakeConfig.noActionCount = 0;
              const pokeText = kind === 'group'
                ? `[拍一拍] 我拍了拍 ${targetUserId}`
                : '[拍一拍] 我拍了拍你';
              st.recentMessages.push({
                messageId: null,
                sender: '我',
                text: pokeText,
                plain: pokeText,
                tail: pokeText,
                kind: 'poke',
                quoteTargetIsSelf: false,
                isOwner: true,
                ownerLabel: '我',
                isSelf: true,
                media: [],
                hasMedia: false,
                forwardIds: [],
                hasForward: false,
                poke: { targetId: targetUserId || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
                time: Date.now()
              });
              const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
              if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
              st.preSleepWaitSatisfiedAt = 0;
              st.preSleepWaitObservedAt = 0;
              st.preSleepWaitAccumMs = 0;
              saveSocialV2State();
              log(`[reserved2] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
              appendActivity(`${key} [reserved2] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
              sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
            } catch (error) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
              if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
              log(`[reserved2] 工具拍一拍失败 ${key}:`, error?.message ?? error);
              sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, error?.statusCode ?? 500);
            }
            return;
          }
        },
      },
      {
        method: 'GET',
        path: '/api/socialV2/sticker-image',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const socialV2 = getSocialV2();
          if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-image') {
            if (!stickers.enabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
            const key = String(url.searchParams.get('key') ?? '').trim();
            const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
            if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('getStickerImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403); return; }
            try {
              const entry = await stickers.getImage(stickerId);
              const fetched = await safeFetchBuffer(entry.url, MAX_MEDIA_BYTES);
              const dims = getImageDimensions(fetched.buffer);
              if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
                sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
                return;
              }
              const mimeType = mimeFromBuffer(fetched.buffer) || mimeFromUrl(entry.url);
              sendJson({
                ok: true,
                key,
                sticker: {
                  id: entry.id,
                  desc: entry.desc || '',
                  localNote: entry.localNote || '',
                  tags: entry.tags || [],
                  url: entry.url,
                  md5: entry.md5
                },
                image: { mimeType, data: fetched.buffer.toString('base64') }
              });
            } catch (error) {
              sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
            }
            return;
          }
        },
      },
      {
        method: 'GET',
        path: '/api/socialV2/self-image',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const socialV2 = getSocialV2();
          if (req.method === 'GET' && url.pathname === '/api/socialV2/self-image') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('getSelfImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_self_image' }, 403); return; }
            const selfPath = path.join(ROOT, 'assets', 'deepseek娘.png');
            try {
              if (!fs.existsSync(selfPath)) { sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404); return; }
              const buf = fs.readFileSync(selfPath);
              const mimeType = mimeFromBuffer(buf) || 'image/png';
              sendJson({ ok: true, key, image: { mimeType, data: buf.toString('base64') } });
            } catch (error) {
              sendJson({ ok: false, error: `读取 AI 形象图片失败：${error?.message ?? error}` }, 500);
            }
            return;
          }
        },
      },
      {
        method: 'POST',
        path: '/api/socialV2/sticker-note',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const socialV2 = getSocialV2();
          if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-note') {
            if (!stickers.enabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
            const body = await readBody();
            const key = String(body.key ?? '').trim();
            const stickerId = String(body.stickerId ?? '').trim();
            if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('stickerNote')) { sendJson({ ok: false, error: '工具未启用：qq_sticker_note' }, 403); return; }
            const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
            const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
            const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
            const emotion = body.emotion !== undefined && body.emotion !== null ? String(body.emotion).trim().slice(0, 24) : undefined;
            // 副情绪：漏了它 → 写入时只更新主情绪，emotionAlt 会被 ensureStickerIndex 用词表反推
            // （2026-10-24 实测 #05 因此拿到「赞同」：localNote 里「就是 wo 自己」命中了 agree）。
            const emotionAlt = body.emotionAlt !== undefined && body.emotionAlt !== null ? (Array.isArray(body.emotionAlt) ? body.emotionAlt.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 2) : String(body.emotionAlt).split(/[,，\s]+/).filter(Boolean).slice(0, 2)) : undefined;
            const content = body.content !== undefined && body.content !== null ? String(body.content).trim().slice(0, 120) : undefined;
            const keywords = body.keywords !== undefined && body.keywords !== null ? (Array.isArray(body.keywords) ? body.keywords.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 8) : String(body.keywords).split(/[,，\s]+/).filter(Boolean).slice(0, 8)) : undefined;
            const entry = stickers.note(stickerId, { note, tags, usage, emotion, emotionAlt, content, keywords });
            if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
            log(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
            sendJson({ ok: true, key, sticker: entry });
            return;
          }
        },
      },
      {
        method: 'POST',
        path: '/api/socialV2/sticker-remark',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const socialV2 = getSocialV2();
          if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-remark') {
            if (!stickers.enabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
            const body = await readBody();
            const key = String(body.key ?? '').trim();
            const stickerId = String(body.stickerId ?? '').trim();
            if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('setStickerRemark')) { sendJson({ ok: false, error: '工具未启用：qq_set_sticker_remark' }, 403); return; }
            try {
              const entry = await stickers.remark(stickerId, String(body.remark ?? ''));
              log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
              sendJson({ ok: true, key, sticker: entry });
            } catch (error) {
              sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
            }
            return;
          }
        },
      },
      {
        method: 'POST',
        path: '/api/socialV2/send-sticker',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const cfg = getConfig();
          const currentMode = getMode();
          const socialV2 = getSocialV2();
          if (req.method === 'POST' && url.pathname === '/api/socialV2/send-sticker') {
            if (!stickers.enabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
            const body = await readBody();
            const key = String(body.key ?? '').trim();
            const stickerId = String(body.stickerId ?? '').trim();
            const caption = String(body.message ?? body.caption ?? '').trim();
            const replyToMessageId = body.replyToMessageId;
            const atUserId = body.atUserId ?? null;
            if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
            // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
            if (caption) {
              sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
              return;
            }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('sendSticker')) { sendJson({ ok: false, error: '工具未启用：qq_send_sticker' }, 403); return; }
            if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
            if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
            const keyMatch = /^(group|private):(\d+)$/.exec(key);
            if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
            const kind = keyMatch[1];
            const id = Number(keyMatch[2]);
            if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
              sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
              return;
            }
            if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
            if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
            if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
              sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
              return;
            }
            let quotedInfo = null;
            let actualReplyToMessageId = replyToMessageId;
            if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
              const stForReply = getSocialV2State(key);
              const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
              if (!resolved) {
                sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
                return;
              }
              quotedInfo = resolved.info;
              actualReplyToMessageId = resolved.messageId;
            }
            const sendCfg = cfg.socialV2?.send ?? {};
            const now = Date.now();
            try {
              const st = getSocialV2State(key);
              const fishBlock = fishGuardSendBlock(key, st);
              if (fishBlock) { sendJson({ ok: false, ...fishBlock }, 403); return; }
              const tokenBlock = tokenGuardSendBlock(key, st, 1);
              if (tokenBlock) { sendJson({ ok: false, ...tokenBlock }, 429); return; }
              const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
              const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
              const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
              const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
              const rateLimit = sendRateLimitInfo(key, st, sendCfg, 1);
              if (rateLimit) { reportLimitEvent(key, rateLimit); sendJson(rateLimit, 429); return; }
              st.sendTimes.push(now);
              if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
              const sent = await sendStickerV2(key, stickerId, {
                replyToMessageId: actualReplyToMessageId,
                atUserId
              });
              // 记录到二代会话的 recentMessages，让 AI 知道自己发过这个表情
              const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
              const text = `[表情包:${label}]`;
              st.recentMessages.push({
                messageId: sent.messageId ? String(sent.messageId) : null,
                sender: '我',
                text: truncateText(text, 200),
                plain: truncateText(text, 200),
                quoteTargetIsSelf: false,
                isOwner: true,
                ownerLabel: '我',
                isSelf: true,
                media: [],
                hasMedia: false,
                forwardIds: [],
                hasForward: false,
                sticker: { id: sent.entry?.id || stickerId, desc: sent.entry?.desc || '', localNote: sent.entry?.localNote || '' },
                time: Date.now()
              });
              const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
              if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
              st.lastAiReplyAt = now;
              st.lastActionAt = now;
              st.wakeConfig.noActionCount = 0;
              st.preSleepWaitSatisfiedAt = 0;
              st.preSleepWaitObservedAt = 0;
              st.preSleepWaitAccumMs = 0;
              saveSocialV2State();
              scheduleReplyCheckV2(key);
              log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
              appendActivity(`${key} [sticker] 工具发送表情：${label}`);
              sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
            } catch (error) {
              const st = getSocialV2State(key);
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
              if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
              saveSocialV2State();
              log(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
              sendJson({ ok: false, error: `发送表情失败：${error?.message ?? error}` }, 500);
            }
            return;
          }
        },
      },
      {
        method: 'POST',
        path: '/api/socialV2/collect-sticker',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const cfg = getConfig();
          const socialV2 = getSocialV2();
          if (req.method === 'POST' && url.pathname === '/api/socialV2/collect-sticker') {
            if (!stickers.enabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
            const body = await readBody();
            const key = String(body.key ?? '').trim();
            const messageRef = String(body.messageId ?? body.seq ?? '').trim();
            const remark = String(body.remark ?? '').trim();
            if (!key || !messageRef) { sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return; }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('collectSticker')) { sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403); return; }
            const keyMatch = /^(group|private):(\d+)$/.exec(key);
            if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
            const st = getSocialV2State(key);
            const collectCfg = cfg.socialV2?.sticker?.collect ?? {};
            if (collectCfg.enabled === false) { sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return; }
            const now = Date.now();
            const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
            const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
            const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({
                ok: false,
                code: 'STICKER_COLLECT_RATE_LIMIT',
                error: `表情收藏频率超限：这个会话每分钟 ${recentMinute} 条 / 每小时 ${recentHour} 条，已到上限。`,
                setting: maxPerMinute > 0 && recentMinute + 1 > maxPerMinute ? 'socialV2.sticker.collect.maxPerMinute' : 'socialV2.sticker.collect.maxPerHour',
                hint: '去 QQ → 高级设置 → 表情包 → 调整「每分钟最多收藏 / 每小时最多收藏」。',
              }, 429);
              return;
            }
            // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
            st.stickerCollectTimes = st.stickerCollectTimes || [];
            st.stickerCollectTimes.push(now);
            if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
            try {
              const result = await collectStickerV2(key, messageRef, remark, {
                emotion: body.emotion,
                content: body.content,
                keywords: body.keywords
              });
              saveSocialV2State();
              log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
              appendActivity(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
              sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
            } catch (error) {
              const idx = st.stickerCollectTimes.indexOf(now);
              if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
              if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
              saveSocialV2State();
              log(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
              sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
            }
            return;
          }
        },
      },
      {
        method: 'GET',
        path: '/api/socialV2/sticker-list',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const cfg = getConfig();
          const socialV2 = getSocialV2();
          if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-list') {
            if (!stickers.enabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
            const key = String(url.searchParams.get('key') ?? '').trim();
            const query = String(url.searchParams.get('query') ?? '').trim();
            const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
            const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
            // GET 上**不再支持** refresh：强制同步是有副作用的写操作（拉 OneBot 收藏表情并落盘），
            // 挂在 GET 上会绕开「非 GET 必须 application/json + 同源 Origin」的 CSRF 防护。
            // 需要强制同步时请用同一路径的 POST，或控制台的 POST /api/stickers/sync。
            const force = false;
            if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
            try {
              const meta = await stickers.listMeta(query, count, { force });
              sendJson({ ok: true, key, ...meta.list, syncedAt: meta.syncedAt, fromCache: meta.fromCache });
            } catch (error) {
              sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
            }
            return;
          }
        },
      },
      {
        method: 'POST',
        path: '/api/socialV2/sticker-list',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const cfg = getConfig();
          const socialV2 = getSocialV2();
          if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-list') {
            if (!stickers.enabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
            const body = await readBody();
            const key = String(body.key ?? '').trim();
            const query = String(body.query ?? '').trim();
            const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
            const count = Math.min(500, Math.max(1, Math.min(Number(body.count) || 48, maxCount)));
            let force = body.refresh === true;
            if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
            // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
            if (req.headers['x-agent-token']) force = stickers.throttleForce(force);
            try {
              const meta = await stickers.listMeta(query, count, { force });
              sendJson({ ok: true, key, ...meta.list, syncedAt: meta.syncedAt, fromCache: meta.fromCache });
            } catch (error) {
              sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
            }
            return;
          }
        },
      },
      {
        method: 'POST',
        path: '/api/socialV2/wait',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const cfg = getConfig();
          const currentMode = getMode();
          const socialV2 = getSocialV2();
          // state 会在 loadState 时整体替换，这里取实时引用，避免拿到旧对象。
          const state = getState();
          if (req.method === 'POST' && url.pathname === '/api/socialV2/wait') {
            const body = await readBody();
            const key = String(body.key ?? '').trim();
            if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
            if (body.purpose !== undefined && !['messages', 'reply'].includes(body.purpose)) {
              sendJson({ ok: false, error: 'purpose 必须是 messages（等后续消息）或 reply（回复前短静默）' }, 400);
              return;
            }
            const replyWait = body.purpose === 'reply';
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('waitMessages')) { sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403); return; }
            if (socialV2.paused) {
              const st = getSocialV2State(key);
              sendJson({ ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], readThroughSeq: readThroughSeqV2(st), unreadCount: st.unread.length });
              return;
            }
            const waitCfg = cfg.socialV2?.wait ?? {};
            const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
            const defaultMs = Number(waitCfg.defaultMs) || 30000;
            const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
            const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
            const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
            const st = getSocialV2State(key);
            // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
            // 租约按**归一后的** key 记账：`group:0123` 与 `group:123` 是同一个会话，
            // 用原始 key 会给出两个租约槽（同一会话并发多个 5~10 分钟等待、互相踩水位）。
            // 租约过期则视为残留（handler 异常退出没清干净），允许接管而不是永久 429。
            const leaseKey = canonicalV2Key(key) ?? key;
            // 连续等待上限：第三次直接回一条「别等了，收尾」，不进入长轮询。
            {
              const now = Date.now();
              const prev = waitStreaks.get(leaseKey);
              const count = prev && now - prev.lastAt < WAIT_STREAK_RESET_MS ? prev.count : 0;
              // 只拦「长轮询」型等待；短等待（<5s，测试/探针常用）不参与计数，
              // 否则会把「等待中权限被撤销」这类用例的 403 语义挡掉。
              if (timeoutMs >= 5000 && count >= WAIT_STREAK_LIMIT) {
                sendJson({
                  ok: true,
                  key,
                  purpose: replyWait ? 'reply' : 'messages',
                  arrived: false,
                  quiet: false,
                  timeout: false,
                  waitedMs: 0,
                  stopped: true,
                  reason: 'consecutive-wait-limit',
                  message: `本回合已经连续等待 ${WAIT_STREAK_LIMIT} 次，不要再调用 qq_wait_for_messages；请设置下一次唤醒（或结束本回合）。`,
                  shouldSleep: true,
                  newMessages: [],
                  readThroughSeq: readThroughSeqV2(st),
                  unreadCount: st.unread.length,
                });
                return;
              }
              waitStreaks.set(leaseKey, { count: count + 1, lastAt: now });
            }
            if (activeWaits.has(leaseKey) && Date.now() - activeWaits.get(leaseKey) < ACTIVE_WAIT_LEASE_MS) {
              sendJson({ ok: false, error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束' }, 429);
              return;
            }
            const leaseStamp = Date.now();
            activeWaits.set(leaseKey, leaseStamp);
            // 只由「自己那一份租约」负责删除：超时接管后，旧等待结束时不能把新租约删掉。
            const finishWait = () => { if (activeWaits.get(leaseKey) === leaseStamp) activeWaits.delete(leaseKey); };
            req.on('close', finishWait);
            // 响应关闭也兜底清租约：handler 中途抛错时由外层 catch 回一个 JSON，
            // 那条路径不会经过下面的 finishWait()，会留下 15 分钟的假 429。
            res.on('close', finishWait);
            const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
            const suggestedQuietMs = Math.max(suggestQuietMsV2(st), minQuietAfterNewMs);
            const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
            // 收到新消息后至少再等 minQuietAfterNewMs（默认 10 秒），防止抢话；
            // 即使 AI 传了 quietMs=0，也会被抬升到最小静默窗口。
            // 同时给 quietMs 加上限，避免被模型/群友诱导导致 HTTP handler 长时间挂起。
            const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(120000, Number(waitCfg.maxMs) || 600000));
            const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
            if (st.pendingWakeTimer) {
              clearTimeout(st.pendingWakeTimer);
              st.pendingWakeTimer = null;
            }
            cancelReplyCheckV2(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
            // 基线必须是「模型已经看过的水位」，不是「请求这一刻的 lastUnreadSeq」：
            // 模型开始本轮 → 思考 → 才调 wait，这期间到的消息已经进了 unread，
            // 旧写法会把它们算进基线，于是 wait 永远看不到、要等本轮结束再被重新投一遍
            // （2026-10-31 用户反馈：收消息到 wait 之间的信息丢了）。
            // 只有「本回合正在进行」时才把基线降到模型已看水位：
            // 回合外调用 wait 时仍按旧语义（只等请求之后的新消息），
            // 避免把历史未读一次性倒给一个还没开始处理它们的回合。
            const turnSid = state.sessions[key];
            const turnActive = Boolean(turnSid) && Number(v2TurnStartAt.get(turnSid)) > 0;
            const canReadHistory = v2ToolEnabled('getUnread') || v2ToolEnabled('getRecent');
            const baseline = (replyWait || turnActive) && canReadHistory
              ? readThroughSeqV2(st)
              : (st.lastUnreadSeq || 0);
            const start = Date.now();
            let arrived = false;
            let lastNewAt = 0;
            let aborted = false;
            req.on('close', () => { aborted = true; });
            if (replyWait) {
              const incomingAt = () => {
                const value = Number(st.lastIncomingAt);
                return Number.isFinite(value) && value > 0 ? Math.min(value, Date.now()) : start;
              };
              lastNewAt = incomingAt();
              let observedSeq = st.lastUnreadSeq || 0;
              // Batch delay and model reading time already count towards quiet.
              // New arrivals restart quiet, but timeoutMs remains a hard budget.
              while (!aborted && Date.now() - start < timeoutMs) {
                if ((st.lastUnreadSeq || 0) !== observedSeq) {
                  observedSeq = st.lastUnreadSeq || 0;
                  lastNewAt = incomingAt();
                }
                const remaining = quietMs - (Date.now() - lastNewAt);
                if (remaining <= 0) break;
                await sleep(Math.max(1, Math.min(100, remaining, timeoutMs - (Date.now() - start))));
              }
              // A message may arrive during the final sleep, exactly at timeout.
              // Its timestamp must still invalidate the previous quiet window.
              lastNewAt = incomingAt();
              arrived = (st.lastUnreadSeq || 0) > baseline;
            } else while (Date.now() - start < timeoutMs && !aborted) {
              let nowSeq = st.lastUnreadSeq || 0;
              if (nowSeq - baseline >= minNew) {
                arrived = true;
                lastNewAt = Date.now();
                // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
                // 这里不再受原始 timeoutMs 限制，确保对方可能连续发消息时不会抢话。
                while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + maxQuietMs + 5000 && !aborted) {
                  if ((st.lastUnreadSeq || 0) > nowSeq) {
                    nowSeq = st.lastUnreadSeq || 0;
                    lastNewAt = Date.now();
                  }
                  await sleep(200);
                }
                break;
              }
              await sleep(300);
            }
            const waitedMs = Date.now() - start;
            if (socialV2.conversations.get(canonicalV2Key(key)) !== st ||
                (req.headers['x-agent-token'] && (currentMode !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false
                  || !agentTokenOk(key, req.headers['x-agent-token']) || !v2SessionAllowed(key) || !v2ToolEnabled('waitMessages')))) {
              finishWait();
              sendJson({ ok: false, error: '等待期间会话已重置或权限已变化，请重新读取会话' }, 403);
              return;
            }
            const preSleepWaitMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            const preSleepRemainingMs = preSleepWaitBlockedV2(st)
              ? Math.max(0, preSleepWaitMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0))
              : 0;
            const quiet = (replyWait || (arrived && quietMs > 0)) && (Date.now() - lastNewAt >= quietMs);
            // 判断这次等待是否是“沉睡前观察尝试”：AI 明确请求等满观察窗口（默认 5 分钟）。
            // 只有这种尝试里等到新消息，才会把“已观察并看到新消息”标记下来，允许 AI 看过新消息后直接决定不参与并沉睡。
            const preSleepAttempt = !replyWait && timeoutMs >= preSleepWaitMs;
            // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足沉睡前等待；
            // 不能因为总时长到了但最后一条消息才刚过 10 秒就误判满足。
            const preSleepSatisfiedNow = !replyWait && (!arrived
              ? waitedMs >= preSleepWaitMs
              : (quiet && (Date.now() - lastNewAt) >= preSleepWaitMs));
            if (preSleepSatisfiedNow) {
              st.preSleepWaitSatisfiedAt = Date.now();
              st.preSleepWaitObservedAt = 0;
              st.preSleepWaitAccumMs = 0;
            } else if (!replyWait && !arrived) {
              // 短等待不累计：必须单次等满观察窗口（或实际安静时间已足够时由 preSleepWaitBlockedV2 放行）
              st.preSleepWaitAccumMs = 0;
            } else if (!replyWait) {
              // 等待期间有新消息：
              // - 如果这是一次 5 分钟沉睡前观察尝试，则标记“已观察”，AI 看过 newMessages 后可自行决定是否参与；
              // - 否则只清空累计，不算完成沉睡前观察。
              if (preSleepAttempt) {
                st.preSleepWaitObservedAt = Date.now();
              }
              st.preSleepWaitAccumMs = 0;
            }
            if (!replyWait) flushSocialV2State();
            // Each buffer is governed by its own tool switch: the unread buffer by
            // getUnread, the recent buffer by getRecent. A disabled switch must not leak
            // through either newMessages or the watermark, so the buffer is dropped
            // before arrival is judged -- not filtered afterwards.
            // unread 也要能交给 wait：模型跑本轮时到的消息先落在 unread 里，
            // 只读 recent 会漏掉它们（同上）。
            const history = [
              ...(v2ToolEnabled('getUnread') ? st.unread : []),
              ...(v2ToolEnabled('getRecent') && Array.isArray(st.recentMessages) ? st.recentMessages : []),
            ];
            const pending = [...new Map(history
              .filter((m) => m && !m.isSelf && (m.seq || 0) > baseline)
              .map((m) => [m.seq, m])).values()].sort((a, b) => a.seq - b.seq);
            // `arrived` is recomputed against what this request may actually hand over,
            // so a suppressed buffer cannot report an arrival it is not allowed to show.
            const newMessages = replyWait ? pending : (arrived ? pending : []);
            const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, newMessages) : readThroughSeqV2(st);
            const unreadNotice = unreadNoticeV2(st);
            const lastNew = newMessages.length ? newMessages[newMessages.length - 1]
              : replyWait ? [...st.recentMessages].reverse().find((m) => m && !m.isSelf) : null;
            const lastMessageUnfinished = lastNew ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
            // 等待期间到的新消息也带表情推荐（没有唤醒提示可依赖，见 stickerMatchFor 注释）
            const stickerMatch = newMessages.length ? stickers.suggest(newMessages) : null;
            // 等到消息 → 这是正常工作，不是空转，清零连续等待计数。
            if (arrived) waitStreaks.delete(leaseKey);
            finishWait();
            sendJson({
              ok: true,
              key,
              purpose: replyWait ? 'reply' : 'messages',
              arrived,
              quiet,
              quietMs,
              suggestedQuietMs,
              speakerLikelyDone: quiet,
              lastMessageUnfinished,
              timeout: replyWait ? !quiet : !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
              waitedMs,
              preSleepWaitSatisfied: preSleepSatisfiedNow,
              // 观察已经满足 → 明确告诉模型「可以睡了」：请设置唤醒并结束回合，不要再调一次 wait。
              shouldSleep: !replyWait && preSleepSatisfiedNow,
              nextStep: !replyWait && preSleepSatisfiedNow ? '调用 qq_set_wake_config 设置下一次唤醒，然后结束本回合，不要再次调用 qq_wait_for_messages' : undefined,
              preSleepWaitObserved: !replyWait && !!st.preSleepWaitObservedAt,
              // A reply check has no sleep countdown; showing one here suggests
              // the model should complete sleep observation before its first reply.
              ...(!replyWait ? { preSleepWaitMs, preSleepWaitRemainingMs: preSleepRemainingMs } : {}),
              ...(stickerMatch ? { stickerMatch } : {}),
              ...(unreadNotice || {}),
              newMessages,
              readThroughSeq,
              unreadCount: st.unread.length
            });
            return;
          }
        },
      },
      {
        method: 'POST',
        path: '/api/socialV2/check-send',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const socialV2 = getSocialV2();
          if (req.method === 'POST' && url.pathname === '/api/socialV2/check-send') {
            const body = await readBody();
            const key = String(body.key ?? '').trim();
            const tool = String(body.tool ?? '').trim();
            const token = String(body.token ?? '').trim();
            if (!key || !tool || !token) {
              sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
              return;
            }
            if (!agentTokenOk(key, token)) {
              sendJson({ ok: false, error: 'agent token 无效' }, 403);
              return;
            }
            if (!v2SessionAllowed(key)) {
              sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
              return;
            }
            const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
            const flag = flagMap[tool];
            if (!flag) {
              sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
              return;
            }
            if (!v2ToolEnabled(flag)) {
              sendJson({ ok: false, error: `工具未启用：qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}` }, 403);
              return;
            }
            sendJson({ ok: true, key, tool });
            return;
          }
        },
      },
      {
        method: 'GET',
        path: '/api/socialV2/tool-log',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const socialV2 = getSocialV2();
          if (req.method === 'GET' && url.pathname === '/api/socialV2/tool-log') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            sendJson({ ok: true, entries: readToolLog(limit) });
            return;
          }
        },
      },
      {
        method: 'POST',
        path: '/api/socialV2/tool-log/clear',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const socialV2 = getSocialV2();
          if (req.method === 'POST' && url.pathname === '/api/socialV2/tool-log/clear') {
            if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
            try { fs.writeFileSync(TOOL_LOG_FILE, '', 'utf8'); } catch {}
            log('控制台：工具调用日志已清空');
            sendJson({ ok: true });
            return;
          }
        },
      },
      {
        method: 'GET',
        path: '/api/socialV2/feedback',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const socialV2 = getSocialV2();
          if (req.method === 'GET' && url.pathname === '/api/socialV2/feedback') {
            sendJson({ ok: true, entries: readFeedbackEntries() });
            return;
          }
        },
      },
      {
        method: 'POST',
        path: '/api/socialV2/feedback-clear',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const socialV2 = getSocialV2();
          if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback-clear') {
            if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
            atomicWriteJson(FEEDBACK_FILE, []);
            log('控制台：清空 AI 反馈');
            sendJson({ ok: true });
            return;
          }
        },
      },
      {
        method: 'POST',
        path: '/api/socialV2/feedback',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const cfg = getConfig();
          const socialV2 = getSocialV2();
          if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback') {
            const body = await readBody();
            const key = String(body.key ?? '').trim();
            const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
            const rawMessage = String(body.message ?? '').trim();
            if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return; }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('feedback')) { sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403); return; }
            // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
            const fNow = Date.now();
            const fTimes = feedbackTimes.get(key) || [];
            const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
            const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
            if (fRecentMinute >= 5 || fRecentHour >= 20) {
              sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
              return;
            }
            fTimes.push(fNow);
            feedbackTimes.set(key, fTimes.slice(-100));
            const maxLength = Math.max(1, Number(cfg.socialV2?.feedback?.maxLength) || 500);
            const message = truncateText(rawMessage, maxLength);
            appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
            log(`[reserved2] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
            appendActivity(`${key} [reserved2] AI 反馈 [${level}]：${message.slice(0, 80)}`);
            if (cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && cfg.ownerQQ) {
              log(`[reserved2] 错误级反馈，可通知 owner ${cfg.ownerQQ}（当前仅记录日志）`);
            }
            sendJson({ ok: true, key, level, message });
            return;
          }
        },
      },
      {
        method: 'GET',
        path: '/api/socialV2/my-recent',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const socialV2 = getSocialV2();
          if (req.method === 'GET' && url.pathname === '/api/socialV2/my-recent') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
            if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('getMyRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_my_recent_messages' }, 403); return; }
            const st = getSocialV2State(key);
            const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
            sendJson({ ok: true, key, messages: mine, readThroughSeq: readThroughSeqV2(st) });
            return;
          }
        },
      },
      {
        method: 'POST',
        path: '/api/socialV2/record-sent',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const socialV2 = getSocialV2();
          if (req.method === 'POST' && url.pathname === '/api/socialV2/record-sent') {
            // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
            sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
            return;
          }
        },
      },
      {
        method: 'GET',
        path: '/api/socialV2/message-detail',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const socialV2 = getSocialV2();
          if (req.method === 'GET' && url.pathname === '/api/socialV2/message-detail') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            const messageId = String(url.searchParams.get('messageId') ?? '').trim();
            if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return; }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('getMessageDetail')) { sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403); return; }
            const keyMatch = /^(group|private):(\d+)$/.exec(key);
            if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
            const kind = keyMatch[1];
            const id = Number(keyMatch[2]);
            try {
              const st = getSocialV2State(key);
              const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
              const forwardFields = found ? {
                forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
                hasForward: !!found.hasForward
              } : {};
              let info = null;
              // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
              if (found && found.messageId && String(found.messageId) !== messageId) {
                info = {
                  sender: String(found.sender || ''),
                  text: String(found.text || found.plain || '').slice(0, 200),
                  userId: found.userId ? String(found.userId) : null,
                  messageId: String(found.messageId),
                  seq: found.seq
                };
              } else {
                info = await resolveReplyInfo(kind, id, messageId);
                if (!info && found) {
                  info = {
                    sender: String(found.sender || ''),
                    text: String(found.text || found.plain || '').slice(0, 200),
                    userId: found.userId ? String(found.userId) : null,
                    messageId: found.messageId ? String(found.messageId) : null,
                    seq: found.seq
                  };
                }
              }
              // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
              if (info && found) Object.assign(info, forwardFields);
              // 正文本就是 200 字符预览；显式告知截断，避免模型把预览当成全文。
              if (info) info.textTruncated = String(info.text ?? '').length >= 200;
              sendJson({ ok: true, key, messageId, info });
            } catch (error) {
              sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
            }
            return;
          }
        },
      },
      {
        method: 'GET',
        path: '/api/socialV2/forward-message',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const cfg = getConfig();
          const currentMode = getMode();
          const socialV2 = getSocialV2();
          // bot 在 bridge 的 main() 里晚于组件注册才创建，这里用注入的 getBot 延迟取。
          const bot = getBot();
          if (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            const id = String(url.searchParams.get('id') ?? '').trim();
            const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
            const keyMatch = /^(group|private):(\d+)$/.exec(key);
            if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
            if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
            if (currentMode !== 'reserved2') {
              sendJson({ ok: false, error: '合并转发查看仅 reserved2 模式可用' }, 403);
              return;
            }
            if (!agentToken) {
              sendJson({ ok: false, error: 'reserved2 模式读取合并转发必须携带 agent token' }, 403);
              return;
            }
            if (!agentTokenOk(key, agentToken)) {
              sendJson({ ok: false, error: 'agent token 无效' }, 403);
              return;
            }
            const kind = keyMatch[1];
            const num = Number(keyMatch[2]);
            if (!Number.isFinite(num) || num <= 0 || !modeAllowed(key, kind, num, cfg, currentMode)) {
              sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
              return;
            }
            if (!v2ToolEnabled('getForwardMsg')) {
              sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
              return;
            }
            // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
            const st = getSocialV2State(key);
            const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
            const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
            const seenInMemory = seenForwardIds.get(key)?.has(id) === true;
            if (!seenInRecent && !seenInUnread && !seenInMemory) {
              sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
              return;
            }
            try {
              const data = await bot.raw('get_forward_msg', { id });
              const formatted = formatForwardResponse(data);
              const remember = (fid) => {
                if (!fid) return;
                let set = seenForwardIds.get(key);
                if (!set) {
                  set = new Set();
                  seenForwardIds.set(key, set);
                }
                set.add(fid);
                if (set.size > 1000) {
                  for (const old of set) {
                    set.delete(old);
                    if (set.size <= 1000) break;
                  }
                }
              };
              // 把本层出现的嵌套 forward id 登记为“本会话已见过”，AI 后续可直接再次读取。
              for (const m of formatted.messages || []) {
                for (const fid of m.nestedForwardIds || []) remember(fid);
              }
              // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
              const nestedPreviews = [];
              const nestedIds = [];
              const seenNested = new Set();
              for (const m of formatted.messages || []) {
                for (const fid of m.nestedForwardIds || []) {
                  if (!seenNested.has(fid) && nestedIds.length < 5) {
                    seenNested.add(fid);
                    nestedIds.push(fid);
                  }
                }
              }
              for (const fid of nestedIds) {
                try {
                  const ndata = await bot.raw('get_forward_msg', { id: fid });
                  const nfmt = formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
                  for (const nm of nfmt.messages || []) {
                    for (const nfid of nm.nestedForwardIds || []) remember(nfid);
                  }
                  nestedPreviews.push({ id: fid, ...nfmt });
                } catch (error) {
                  log(`嵌套转发预览失败 ${key} ${fid}:`, error?.message ?? error);
                  nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
                }
              }
              sendJson({ ok: true, key, id, ...formatted, nestedPreviews });
            } catch (error) {
              log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
              sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
            }
            return;
          }
        },
      },
      {
        method: 'POST',
        path: '/api/socialV2/forward-media',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const currentMode = getMode();
          const socialV2 = getSocialV2();
          const bot = getBot();
          if (req.method === 'POST' && url.pathname === '/api/socialV2/forward-media') {
            const body = await readBody();
            const key = String(body.key ?? '').trim();
            const media = Array.isArray(body.media) ? body.media : [];
            if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('getForwardMsg')) { sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403); return; }
            if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '转发媒体读取仅 reserved2 模式可用' }, 403); return; }
            if (!media.length) { sendJson({ ok: true, key, media: [], images: [] }); return; }
            try {
              const images = await fetchMediaData(media);
              sendJson({ ok: true, key, media, images });
            } catch (error) {
              log(`转发媒体读取失败 ${key}:`, error?.message ?? error);
              sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
            }
            return;
          }
        },
      },
      {
        method: 'GET',
        path: '/api/socialV2/active-members',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const socialV2 = getSocialV2();
          if (req.method === 'GET' && url.pathname === '/api/socialV2/active-members') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
            if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('getActiveMembers')) { sendJson({ ok: false, error: '工具未启用：qq_get_active_members' }, 403); return; }
            const st = getSocialV2State(key);
            const map = new Map();
            for (const m of st.recentMessages) {
              if (!m || m.isSelf) continue;
              const uid = m.userId ? String(m.userId) : '';
              const key2 = uid || String(m.sender || '未知');
              const cur = map.get(key2) || { sender: m.sender || key2, userId: uid || undefined, count: 0, lastTime: 0, isOwner: !!m.isOwner };
              if (!cur.userId && uid) cur.userId = uid;
              cur.count += 1;
              if (m.time > cur.lastTime) cur.lastTime = m.time;
              if (m.isOwner) cur.isOwner = true;
              map.set(key2, cur);
            }
            const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit);
            sendJson({ ok: true, key, members });
            return;
          }
        },
      },
      {
        method: 'POST',
        path: '/api/socialV2/memory-append',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const socialV2 = getSocialV2();
          if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-append') {
            const body = await readBody();
            const key = String(body.key ?? '').trim();
            const category = String(body.category ?? '').trim();
            const content = String(body.content ?? '').trim();
            const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
            if (!key || !category || !content) { sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return; }
            if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
            if (category === 'memberImpression' && !String(extra.target || '').trim()) { sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400); return; }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403); return; }
            const st = getSocialV2State(key);
            appendMemoryV2(st, category, content, extra);
            sendJson({ ok: true, key, category, content, memory: formatMemoryV2(st) });
            return;
          }
        },
      },
      {
        method: 'POST',
        path: '/api/socialV2/memory-update',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const socialV2 = getSocialV2();
          if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-update') {
            const body = await readBody();
            const key = String(body.key ?? '').trim();
            const category = String(body.category ?? '').trim();
            const oldContent = String(body.oldContent ?? '').trim();
            const target = redactKnownTokensOnly(String(body.target ?? '').trim());
            const newContent = body.newContent !== undefined && body.newContent !== null ? redactKnownTokensOnly(String(body.newContent).trim()) : undefined;
            const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
            const redactExtra = (v) => redactKnownTokensOnly(String(v ?? '')).trim();
            const cleanNewExtra = {
              ...newExtra,
              pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
              participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
              motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
              target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined
            };
            if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
            if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
            if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return; }
            if (category !== 'memberImpression' && !oldContent) { sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return; }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return; }
            const st = getSocialV2State(key);
            if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
              const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
              if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return; }
              if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
              if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
              if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
            } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
              const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
              if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return; }
              if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
              if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
              if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
            } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
              const oldTarget = target;
              if (['__proto__', 'constructor', 'prototype'].includes(oldTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
              // 必须命中**已有**条目（own property）：否则任意 target 都能凭空建一条，
              // 而 'toString'/'valueOf' 这类名字会从 Object.prototype 上取到继承来的函数，
              // 往函数对象上写 traits —— JSON.stringify 又会把它整个丢掉（静默数据丢失）。
              if (!Object.prototype.hasOwnProperty.call(st.memberImpressions, oldTarget)) {
                sendJson({ ok: false, error: '找不到要编辑的群友印象（新印象请用 qq_memory_append 添加）' }, 404);
                return;
              }
              const im = st.memberImpressions[oldTarget];
              const newTarget = String(cleanNewExtra.target || oldTarget).trim().slice(0, 64);
              if (!newTarget || ['__proto__', 'constructor', 'prototype'].includes(newTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
              if (newContent !== undefined) {
                im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
              }
              if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
              if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
              st.memberImpressions[newTarget] = im;
              // 与控制台/AI 的 append 路径保持一致：条目数上限 50，超了按 lastSeenAt 淘汰最旧，
              // 否则 memory-update 能无限塞名字（每次 1MB 请求 → 状态文件与每轮 prompt 一起膨胀）。
              const impressionEntries = Object.entries(st.memberImpressions);
              if (impressionEntries.length > 50) {
                impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
                for (let i = 0; i < impressionEntries.length - 50; i += 1) delete st.memberImpressions[impressionEntries[i][0]];
              }
            }
            saveSocialV2State();
            sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
            return;
          }
        },
      },
      {
        method: 'GET',
        path: '/api/socialV2/memory',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const socialV2 = getSocialV2();
          if (req.method === 'GET' && url.pathname === '/api/socialV2/memory') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            const category = String(url.searchParams.get('category') ?? '').trim();
            if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_query' }, 403); return; }
            const st = getSocialV2State(key);
            const raw = {
              activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
              pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20) : [],
              memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {}
            };
            if (category === 'activeTopic') {
              raw.pendingThoughts = [];
              raw.memberImpressions = {};
            } else if (category === 'pendingThought') {
              raw.activeTopics = [];
              raw.memberImpressions = {};
            } else if (category === 'memberImpression') {
              raw.activeTopics = [];
              raw.pendingThoughts = [];
            }
            sendJson({ ok: true, key, category, formatted: formatMemoryV2({ ...st, ...raw }), raw });
            return;
          }
        },
      },
      {
        method: 'POST',
        path: '/api/socialV2/memory-remove',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const socialV2 = getSocialV2();
          if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-remove') {
            const body = await readBody();
            const key = String(body.key ?? '').trim();
            const category = String(body.category ?? '').trim();
            const content = String(body.content ?? '').trim();
            const target = String(body.target ?? '').trim();
            if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
            if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
            if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400); return; }
            if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            if (category !== 'memberImpression' && !content) { sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return; }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403); return; }
            const st = getSocialV2State(key);
            if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
              st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
            } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
              st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
            } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
              delete st.memberImpressions[target];
            }
            saveSocialV2State();
            sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
            return;
          }
        },
      },
      {
        method: 'POST',
        path: '/api/socialV2/memory-clear',
        async handle(ctx, { req, res, url, params, readBody, sendJson }) {
          const socialV2 = getSocialV2();
          if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-clear') {
            const body = await readBody();
            const key = String(body.key ?? '').trim();
            const category = String(body.category ?? '').trim();
            if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
            if (category && !['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403); return; }
            const st = getSocialV2State(key);
            if (!category || category === 'activeTopic') st.activeTopics = [];
            if (!category || category === 'pendingThought') st.pendingThoughts = [];
            if (!category || category === 'memberImpression') st.memberImpressions = {};
            saveSocialV2State();
            sendJson({ ok: true, key, category: category || 'all', memory: formatMemoryV2(st) });
            return;
          }
        },
      },
    ],
  });
}
