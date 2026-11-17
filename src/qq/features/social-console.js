/**
 * 二代仿真：控制台 / 智能体读取接口（组件化迁移 #9）。
 *
 * 从 src/bridge.js 的 main() 搬出：
 *   - 配置与活动开关（/config、/activity）；
 *   - 会话状态与上下文（/state、/states、/prompt、/snapshot、/unread、/recent）；
 *   - 已读水位与收尾（/mark-read、/close、/wake-config）；
 *   - 群策略、限流静音、手动唤醒、上线补历史、会话初始提示词。
 *
 * 留在 bridge 的部分：
 *   - /api/socialV2/reset：要同时拆定时器、退订阅、清各类会话映射，属于运行时核弹操作；
 *   - 发送类接口（send-* / wait / check-send / 表情 / 记忆）。
 *
 * 依赖全部显式注入；组件不读 bridge 的闭包变量。
 */
import { defineComponent } from '../core/registry.js';
import { atomicWriteJson, readConfigObject } from '../json-io.js';
import { normalizeGroupPolicy } from '../../group-policy.js';
import { buildContextSnapshot } from '../../context-snapshot.js';
import { normalizeHistoryConfig } from '../../history-catchup.js';
import { canonicalV2Key } from '../policy.js';

export function createSocialConsoleComponent(deps) {
  const {
    log, getConfig, configFile, socialV2,
    getSocialV2State, flushSocialV2State, saveState,
    clearAllSocialV2Timers, setupSleepTimerV2, scheduleProactiveCheckV2,
    refreshAllDefaultWakeConfigsV2, cancelReplyCheckV2,
    agentTokenOk, v2SessionAllowed, v2ToolEnabled,
    getMode, modeAllowed,
    stickers, slang, voice,
    readRoleState,
    selfName, selfUserId, selfIdentityText, currentRoleHint, currentRoleHintV2,
    memoryCardPaths, memoryCardPromptBlock, groupPolicyFile,
    readGroupPolicy, ensureGroupMeta, groupProfile, setGroupPolicyCache,
    limitMuteFile, readLimitMutes, gateEvents,
    sendWakePromptV2, runHistoryCatchUp, closeConversation,
    initialPrompts, initialPromptMaxChars, isInitialPromptsWritable, setInitialPrompt,
    acknowledgeMessagesV2, assessClosureV2, closureConfigV2, closureStatus, computeWakeSafetyV2,
    ensureWakeableV2, formatMemoryV2, formatParticipationV2, isSleepingConfigV2,
    normalizeSpeakerIdsV2, noteModelMessagesV2, pickWakeTriggersV2, preSleepWaitBlockedV2,
    readThroughSeqV2, replyTimingV2, requestedReadThroughSeqV2, unreadNoticeV2,
    markReadCalledKeys, wakeConfigUpdatedKeys, wakeConfigMissCount,
  } = deps || {};
  const required = {
    log, getConfig, configFile, socialV2, getSocialV2State, flushSocialV2State, saveState,
    clearAllSocialV2Timers, setupSleepTimerV2, scheduleProactiveCheckV2,
    refreshAllDefaultWakeConfigsV2, cancelReplyCheckV2,
    agentTokenOk, v2SessionAllowed, v2ToolEnabled, getMode, modeAllowed,
    stickers, slang, voice, readRoleState, selfIdentityText, currentRoleHint, currentRoleHintV2,
    memoryCardPaths, memoryCardPromptBlock, groupPolicyFile, readGroupPolicy, ensureGroupMeta, groupProfile, setGroupPolicyCache,
    limitMuteFile, readLimitMutes, gateEvents, sendWakePromptV2, runHistoryCatchUp, closeConversation,
    initialPrompts, initialPromptMaxChars, setInitialPrompt,
    acknowledgeMessagesV2, assessClosureV2, closureConfigV2, closureStatus, computeWakeSafetyV2,
    ensureWakeableV2, formatMemoryV2, formatParticipationV2, isSleepingConfigV2,
    normalizeSpeakerIdsV2, noteModelMessagesV2, pickWakeTriggersV2, preSleepWaitBlockedV2,
    readThroughSeqV2, replyTimingV2, requestedReadThroughSeqV2, unreadNoticeV2,
    markReadCalledKeys, wakeConfigUpdatedKeys, wakeConfigMissCount,
  };
  for (const [name, value] of Object.entries(required)) {
    if (value === undefined || value === null) throw new TypeError(`social-console 缺少依赖：${name}`);
  }

  /** 智能体通道的公共校验：token、会话范围、工具开关。 */
  function agentGate(key, req, sendJson, toolFlag, toolName) {
    if (!req.headers['x-agent-token']) return true;
    if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return false; }
    if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return false; }
    if (!v2ToolEnabled(toolFlag)) { sendJson({ ok: false, error: `工具未启用：${toolName}` }, 403); return false; }
    return true;
  }

  const routes = [
    {
      method: 'GET',
      path: '/api/socialV2/config',
      handle(ctx, { sendJson }) {
        sendJson({ ok: true, config: getConfig().socialV2 ?? {} });
      },
    },
    {
      method: 'POST',
      path: '/api/socialV2/config',
      async handle(ctx, { readBody, sendJson }) {
        const cfg = getConfig();
        const body = await readBody();
        const file = readConfigObject(configFile);
        // current 必须是「当前**生效**的 socialV2」，而不是文件里恰好写着的那一份。
        // config.json 里没有 socialV2 段时，若用空对象兜底，工具开关归一化会把默认关闭的
        // setStickerRemark / sendVoice 静默打开。cfg.socialV2 是文件与默认值深度合并后的
        // 运行时配置，用它兜底才和真正生效的设置一致。
        const fileV2 = (file.socialV2 && typeof file.socialV2 === 'object' && !Array.isArray(file.socialV2))
          ? file.socialV2
          : null;
        const current = fileV2 ?? ((cfg.socialV2 && typeof cfg.socialV2 === 'object') ? cfg.socialV2 : {});
        const merged = { ...current, ...body };
        // 子对象必须是非 null 对象；null/数组/基本类型会覆盖默认值导致工具开关被绕过。
        for (const sub of ['tools', 'wake', 'send', 'wait', 'proactive', 'sticker', 'feedback', 'context', 'tokenGuard', 'history']) {
          if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
            merged[sub] = current[sub] ?? {};
          }
        }
        if (merged.autoReplyCheckMs !== undefined) {
          const n = Number(merged.autoReplyCheckMs);
          merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);
        }
        const toolFlags = ['getPrompt', 'getUnread', 'getRecent', 'socialState', 'sendGroup', 'sendPrivate', 'reply', 'sendBurst', 'sendMessage', 'waitMessages', 'feedback', 'getMyRecent', 'getMessageDetail', 'getActiveMembers', 'setWakeConfig', 'markRead', 'memory', 'slangQuery', 'slangSubmit', 'getImages', 'getForwardMsg', 'sendPoke', 'listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker', 'getSelfImage', 'sendVoice'];
        if (body.tools && typeof body.tools === 'object') {
          merged.tools = { ...(current.tools ?? {}), ...body.tools };
          for (const k of toolFlags) {
            if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;
          }
        }
        if (body.wake && typeof body.wake === 'object') {
          merged.wake = { ...(current.wake ?? {}), ...body.wake };
          for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'noActionLimit', 'backlogMaxSessions', 'maxWakeConfigReminders', 'preSleepWaitMs']) {
            if (merged.wake[k] !== undefined) {
              const n = Number(merged.wake[k]);
              merged.wake[k] = Number.isFinite(n) ? n : current.wake?.[k] ?? 0;
              // 毫秒/次数类字段统一非负取整；概率字段单独 clamp。
              if (k !== 'recommendedProbability') merged.wake[k] = Math.max(0, Math.round(merged.wake[k]));
            }
          }
          if (merged.wake.recommendedProbability !== undefined) merged.wake.recommendedProbability = Math.min(1, Math.max(0, Number(merged.wake.recommendedProbability) || 0));
          if (merged.wake.preSleepWaitEnabled !== undefined) merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
          if (merged.wake.recommendedDefaultInfinite !== undefined) merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
          if (merged.wake.recommendedPoke !== undefined) merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
          if (merged.wake.recommendedKeywords !== undefined) {
            merged.wake.recommendedKeywords = (Array.isArray(merged.wake.recommendedKeywords) ? merged.wake.recommendedKeywords : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)).map(String).filter(Boolean);
          }
          if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
          if (merged.wake.recommendedHint !== undefined) merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
        }
        if (body.send && typeof body.send === 'object') {
          merged.send = { ...(current.send ?? {}), ...body.send };
          for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs']) {
            if (merged.send[k] !== undefined) {
              const n = Number(merged.send[k]);
              merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
              // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
              if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
            }
          }
          if (merged.send.longGapProbability !== undefined) merged.send.longGapProbability = Math.min(1, Math.max(0, Number(merged.send.longGapProbability) || 0));
          if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
          if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
        }
        if (body.tokenGuard && typeof body.tokenGuard === 'object') {
          merged.tokenGuard = { ...(current.tokenGuard ?? {}), ...body.tokenGuard };
          if (merged.tokenGuard.enabled !== undefined) merged.tokenGuard.enabled = merged.tokenGuard.enabled === true;
          if (merged.tokenGuard.directBypassGap !== undefined) merged.tokenGuard.directBypassGap = merged.tokenGuard.directBypassGap === true;
          for (const k of ['maxWakesPerDay', 'privateMaxWakesPerDay', 'minWakeGapMs', 'maxOutboundPerTurn', 'maxDailyCostCNY']) {
            if (merged.tokenGuard[k] !== undefined) {
              const n = Number(merged.tokenGuard[k]);
              merged.tokenGuard[k] = Number.isFinite(n) ? Math.max(0, n) : current.tokenGuard?.[k] ?? 0;
              if (k !== 'maxDailyCostCNY') merged.tokenGuard[k] = Math.round(merged.tokenGuard[k]);
            }
          }
        }
        if (body.wait && typeof body.wait === 'object') {
          merged.wait = { ...(current.wait ?? {}), ...body.wait };
          for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs']) {
            if (merged.wait[k] !== undefined) {
              const n = Number(merged.wait[k]);
              merged.wait[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.wait?.[k] ?? 5000;
            }
          }
        }
        if (body.proactive && typeof body.proactive === 'object') {
          merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
          for (const k of ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs', 'probability']) {
            if (merged.proactive[k] !== undefined) {
              const n = Number(merged.proactive[k]);
              merged.proactive[k] = Number.isFinite(n) ? n : current.proactive?.[k] ?? 0;
              // 毫秒类字段统一非负取整；概率字段单独 clamp。
              if (k !== 'probability') merged.proactive[k] = Math.max(0, Math.round(merged.proactive[k]));
            }
          }
          if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
          if (merged.proactive.probability !== undefined) merged.proactive.probability = Math.min(1, Math.max(0, Number(merged.proactive.probability) || 0));
        }
        if (body.sticker && typeof body.sticker === 'object') {
          merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
          if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
          for (const k of ['syncTtlMs', 'maxListCount', 'promptMaxStickers']) {
            if (merged.sticker[k] !== undefined) {
              const n = Number(merged.sticker[k]);
              merged.sticker[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.[k] ?? 0;
            }
          }
          if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
          if (merged.sticker.promptMaxStickers !== undefined) merged.sticker.promptMaxStickers = Math.min(30, Math.max(1, merged.sticker.promptMaxStickers));
          if (merged.sticker.includeInPrompt !== undefined) merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
          if (body.sticker.collect && typeof body.sticker.collect === 'object') {
            merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
            if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
            for (const k of ['maxPerMinute', 'maxPerHour', 'maxRemarkChars']) {
              if (merged.sticker.collect[k] !== undefined) {
                const n = Number(merged.sticker.collect[k]);
                merged.sticker.collect[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.collect?.[k] ?? 0;
              }
            }
          }
        }
        if (body.feedback && typeof body.feedback === 'object') {
          merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
          if (merged.feedback.maxLength !== undefined) {
            const n = Number(merged.feedback.maxLength);
            merged.feedback.maxLength = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.feedback?.maxLength ?? 500;
          }
          if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
        }
        if (body.context && typeof body.context === 'object') {
          merged.context = { ...(current.context ?? {}), ...body.context };
          for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
            if (merged.context[k] !== undefined) {
              const n = Number(merged.context[k]);
              merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.context?.[k] ?? 20;
            }
          }
          for (const [name, fallback, min, max] of [['wakeMessageLimit', 12, 1, 100], ['wakeRecentLimit', 4, 0, 20], ['wakeMaxChars', 6000, 500, 20000]]) {
            const n = Number(merged.context[name] ?? fallback);
            merged.context[name] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
          }
          if (merged.context.inlineWakeMessages !== undefined) merged.context.inlineWakeMessages = merged.context.inlineWakeMessages === true;
          // 唤醒快照默认「从最近往回看」（更早的未读折叠）；显式 false 可恢复旧行为。
          if (merged.context.wakeFoldOld !== undefined) merged.context.wakeFoldOld = merged.context.wakeFoldOld !== false;
        }
        if (body.history && typeof body.history === 'object') {
          merged.history = normalizeHistoryConfig({ ...(current.history ?? {}), ...body.history });
        }
        if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
        if (merged.provideRecommendations !== undefined) merged.provideRecommendations = merged.provideRecommendations === true;
        if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
        file.socialV2 = merged;
        atomicWriteJson(configFile, file);
        cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...merged };
        // 仅当「会影响默认唤醒配置」的字段变化时，才同步到仍使用默认配置的现有会话。
        // 避免只改发送/等待/工具开关时，意外重置正在等待的潜水/唤醒计划。
        const WAKE_DEFAULT_KEYS = [
          'defaultMode', 'recommendedDefaultInfinite',
          'recommendedSleepMinMs', 'recommendedSleepMaxMs',
          'recommendedProbability', 'recommendedKeywords',
          'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
          'sleepMinMs', 'sleepMaxMs', 'batchWindowMs'
        ];
        const wakeDefaultChanged = body.wake && typeof body.wake === 'object' &&
          WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
        if (wakeDefaultChanged) refreshAllDefaultWakeConfigsV2();
        log('控制台：二代仿真配置已更新');
        sendJson({ ok: true, config: cfg.socialV2 });
      },
    },
    {
      method: 'GET',
      path: '/api/socialV2/activity',
      handle(ctx, { sendJson }) {
        sendJson({ ok: true, paused: socialV2.paused });
      },
    },
    {
      method: 'POST',
      path: '/api/socialV2/activity',
      async handle(ctx, { readBody, sendJson }) {
        const body = await readBody();
        const paused = body.paused === true;
        socialV2.paused = paused;
        if (paused) {
          clearAllSocialV2Timers();
          log('控制台：二代 AI 已暂停（唤醒/等待任务已停止）');
        } else {
          log('控制台：二代 AI 已恢复');
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
        }
        flushSocialV2State();
        sendJson({ ok: true, paused: socialV2.paused });
      },
    },
    {
      method: 'GET',
      path: '/api/socialV2/state',
      handle(ctx, { req, url, sendJson }) {
        const key = String(url.searchParams.get('key') ?? '').trim();
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (!agentGate(key, req, sendJson, 'socialState', 'qq_social_state')) return;
        const st = getSocialV2State(key);
        sendJson({
          ok: true,
          key,
          wakeConfig: st.wakeConfig,
          wakeSafety: computeWakeSafetyV2(st.wakeConfig),
          unreadCount: st.unread.length,
          recentCount: st.recentMessages.length,
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          ...(unreadNoticeV2(st) || {}),
          // 对话收尾：最近一次自然结束的位置 + 下次接法 + 是否还在冷却。
          closure: closureStatus(st.closure, Date.now()),
          closureAssessment: (() => {
            const a = assessClosureV2(key, st);
            return { verdict: a.verdict, score: a.score, reasons: a.reasons };
          })()
        });
      },
    },
    {
      method: 'GET',
      path: '/api/socialV2/prompt',
      async handle(ctx, { req, url, sendJson }) {
        const cfg = getConfig();
        const key = String(url.searchParams.get('key') ?? '').trim();
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (!agentGate(key, req, sendJson, 'getPrompt', 'qq_get_prompt')) return;
        const st = getSocialV2State(key);
        // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
        if (cfg.socialV2?.sticker?.enabled !== false) {
          try { await stickers.sync(false); } catch {}
        }
        const roleState = readRoleState();
        const toolMap = {
          getPrompt: 'qq_get_prompt',
          getUnread: 'qq_get_unread_messages',
          getRecent: 'qq_get_recent_messages',
          socialState: 'qq_social_state',
          sendGroup: 'qq_send_group_message',
          sendPrivate: 'qq_send_private_message',
          reply: 'qq_reply',
          sendBurst: 'qq_send_burst',
          sendMessage: 'qq_send_message',
          waitMessages: 'qq_wait_for_messages',
          feedback: 'qq_report_feedback',
          getMyRecent: 'qq_get_my_recent_messages',
          getMessageDetail: 'qq_get_message_detail',
          getActiveMembers: 'qq_get_active_members',
          setWakeConfig: 'qq_set_wake_config',
          markRead: 'qq_mark_read',
          closeConversation: 'qq_close_conversation',
          memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
          slangQuery: 'qq_slang_query',
          slangSubmit: 'qq_slang_submit',
          getImages: 'qq_get_message_images',
          getForwardMsg: 'qq_get_forward_msg',
          sendPoke: 'qq_send_poke',
          listStickers: 'qq_list_stickers',
          getStickerImage: 'qq_get_sticker_image',
          sendSticker: 'qq_send_sticker',
          setStickerRemark: 'qq_set_sticker_remark',
          stickerNote: 'qq_sticker_note',
          collectSticker: 'qq_collect_sticker',
          getSelfImage: 'qq_get_self_image',
          sendVoice: 'qq_send_voice / qq_list_voices'
        };
        const tools = cfg.socialV2?.tools ?? {};
        const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker']);
        const enabledTools = [];
        for (const [flag, name] of Object.entries(toolMap)) {
          if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !stickers.enabled())) enabledTools.push(name);
        }
        sendJson({
          ok: true,
          key,
          time: new Date().toISOString(),
          // 机器人自己的身份：agent 需要它才能把「@樰」对到自己身上（issue #29）。
          self: {
            nickname: selfName?.() || null,
            userId: selfUserId?.() || null,
            line: selfIdentityText().trim() || null
          },
          role: (() => {
            const personaMode = url.searchParams.get('mode') === 'full' ? 'full' : (key.startsWith('group:') ? 'tone' : 'full');
            return { name: roleState.role ?? null, mode: personaMode, hint: getMode() === 'reserved2' ? currentRoleHintV2(key, personaMode) : currentRoleHint(key, personaMode) };
          })(),
          memoryCard: memoryCardPromptBlock(
            (Boolean(cfg.ownerQQ) && key === `private:${String(cfg.ownerQQ)}`)
              ? memoryCardPaths.promptQq
              : memoryCardPaths.promptBili
          ),
          recommended: cfg.socialV2?.provideRecommendations === false ? null : {
            wake: cfg.socialV2?.wake ?? {},
            send: cfg.socialV2?.send ?? {},
            wait: cfg.socialV2?.wait ?? {},
            proactive: cfg.socialV2?.proactive ?? {}
          },
          enabledTools,
          replyTiming: replyTimingV2(st),
          unreadCount: st.unread.length,
          recentCount: st.recentMessages.length,
          currentWakeConfig: st.wakeConfig,
          wakeSafety: computeWakeSafetyV2(st.wakeConfig),
          memory: formatMemoryV2(st),
          participation: formatParticipationV2(st),
          slang: {
            enabled: slang.enabled(),
            entries: slang.confirmedList(),
            block: slang.context()
          },
          stickers: {
            enabled: cfg.socialV2?.sticker?.enabled !== false,
            total: stickers.entries().length,
            context: cfg.socialV2?.sticker?.includeInPrompt !== false ? stickers.context(cfg.socialV2?.sticker?.promptMaxStickers ?? 8) : '',
            strategy: cfg.socialV2?.sticker?.includeInPrompt !== false ? stickers.strategy() : ''
          },
          // 对话收尾：给模型的当前判断参数 + 上次结束点；收不收由模型决定。
          closure: {
            config: deps.closureConfigV2(),
            assessment: (() => {
              const a = assessClosureV2(key, st);
              return { verdict: a.verdict, score: a.score, reasons: a.reasons, signals: a.signals };
            })(),
            last: closureStatus(st.closure, Date.now())
          },
          // 语音库摘要：让 AI 一开始就知道有哪些语音可发（真发之前用 qq_list_voices 看详情）。
          voices: cfg.socialV2?.voice?.enabled === false ? { enabled: false } : {
            enabled: true,
            total: voice.listLibrary().length,
            names: voice.listLibrary().slice(0, 12).map((v) => v.name),
            maxSeconds: voice.cfg().maxSeconds,
            hint: '可用 qq_list_voices 查看语音库，再用 qq_send_voice 把其中一个当语音发出去'
          }
        });
      },
    },
    {
      method: 'GET',
      path: '/api/socialV2/snapshot',
      handle(ctx, { req, url, sendJson }) {
        const cfg = getConfig();
        const key = String(url.searchParams.get('key') ?? '').trim();
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (!agentGate(key, req, sendJson, 'getSnapshot', 'qq_get_context_snapshot')) return;
        const include = String(url.searchParams.get('include') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
        const st = getSocialV2State(key);
        const configured = cfg.socialV2?.snapshot ?? {};
        const caps = {
          unread: url.searchParams.get('unreadLimit') ?? configured.unread,
          recent: url.searchParams.get('recentLimit') ?? configured.recent,
          activeMembers: url.searchParams.get('activeLimit') ?? configured.activeMembers,
          textChars: url.searchParams.get('textChars') ?? configured.textChars,
        };
        const snapshot = buildContextSnapshot({
          key,
          st,
          include,
          caps,
          afterSeq: Number(url.searchParams.get('afterSeq') ?? 0) || 0,
        });
        sendJson({ ...snapshot, ...(unreadNoticeV2(st) || {}) });
      },
    },
    {
      method: 'GET',
      path: '/api/socialV2/unread',
      handle(ctx, { req, url, sendJson }) {
        const key = String(url.searchParams.get('key') ?? '').trim();
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (!agentGate(key, req, sendJson, 'getUnread', 'qq_get_unread_messages')) return;
        const afterRaw = url.searchParams.get('afterSeq');
        const afterSeq = afterRaw === null ? null : Number(afterRaw);
        if (afterRaw !== null && (!/^\d+$/.test(afterRaw) || !Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
          sendJson({ ok: false, error: 'afterSeq 必须是非负安全整数；从最早未读开始请传 0' }, 400);
          return;
        }
        const st = getSocialV2State(key);
        // 默认保持旧的「读尾巴」语义；游标分页让一次装不下的积压也能完整读完。
        const messages = afterSeq === null ? st.unread.slice(-limit)
          : st.unread.filter((m) => Number.isSafeInteger(m.seq) && m.seq > afterSeq).slice(0, limit);
        const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
        // 翻未读是最常见的新消息入口，同样带上表情推荐
        const stickerMatch = stickers.suggest(messages);
        sendJson({ ok: true, key, unreadCount: st.unread.length, ...(stickerMatch ? { stickerMatch } : {}), messages, readThroughSeq, ...(unreadNoticeV2(st) || {}) });
      },
    },
    {
      method: 'GET',
      path: '/api/socialV2/recent',
      handle(ctx, { req, url, sendJson }) {
        const key = String(url.searchParams.get('key') ?? '').trim();
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (!agentGate(key, req, sendJson, 'getRecent', 'qq_get_recent_messages')) return;
        const st = getSocialV2State(key);
        const start = Math.max(0, st.recentMessages.length - offset - limit);
        const end = Math.max(0, st.recentMessages.length - offset);
        const messages = st.recentMessages.slice(start, end);
        const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
        sendJson({ ok: true, key, messages, readThroughSeq, ...(unreadNoticeV2(st) || {}) });
      },
    },
    {
      method: 'POST',
      path: '/api/socialV2/mark-read',
      async handle(ctx, { req, readBody, sendJson }) {
        const cfg = getConfig();
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (!agentGate(key, req, sendJson, 'markRead', 'qq_mark_read')) return;
        const st = getSocialV2State(key);
        // 注意：不带 throughSeq 的调用会清空全部未读，这是**有意保留的兼容语义**
        // （旧 preset 与「没有水位」的收尾调用）。当前 preset 会明确要求带上 readThroughSeq 水位。
        const throughSeq = requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
        // 如果当前已经是“潜水”唤醒配置，且最近还有对话/刚被唤醒，不允许用 mark_read 直接回到潜水；
        // 必须先等够沉睡前观察窗口，避免“聊两句又去潜水”。
        if (isSleepingConfigV2(st.wakeConfig) && preSleepWaitBlockedV2(st)) {
          const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
          const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
          const remainMin = Math.ceil(remaining / 60000);
          sendJson({
            ok: false,
            code: 'PRE_SLEEP_WAIT_REQUIRED',
            error: `还不能通过 qq_mark_read 直接回到潜水：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接收尾沉睡，若你参与了则需下次再等观察窗口。`,
            hint: '不要重复 mark_read；先 wait，等返回 shouldSleep=true 后再设置唤醒/收尾。',
            nextStep: 'qq_wait_for_messages',
            preSleepWaitMs: preSleepMs,
            preSleepWaitRemainingMs: remaining,
            retryAfterMs: remaining
          }, 400);
          return;
        }
        const markedCount = acknowledgeMessagesV2(st, throughSeq);
        st.lastActionAt = Date.now();
        st.wakeConfig.noActionCount = 0;
        // 防止“有限潜水被 timeout 唤醒后 sleepUntil 被清空、又 mark_read 收尾”导致无定时器无触发条件的静默态。
        if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) {
          st.wakeConfig.infinite = true;
        }
        ensureWakeableV2(st, { key });
        st.wakeConfig.confirmedAt = Date.now();
        st.wakeConfig.confirmedBy = 'mark_read';
        deps.markReadCalledKeys.add(key);
        flushSocialV2State();
        log(`[reserved2] 控制台/工具标记 ${key} 未读已读：${markedCount} 条，已确认下一次唤醒配置`);
        sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: readThroughSeqV2(st), wakeGuaranteed: computeWakeSafetyV2(st.wakeConfig).guaranteed, wakeSafety: computeWakeSafetyV2(st.wakeConfig), wakeConfig: st.wakeConfig });
      },
    },
    {
      method: 'POST',
      path: '/api/socialV2/close',
      async handle(ctx, { req, readBody, sendJson }) {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (!agentGate(key, req, sendJson, 'closeConversation', 'qq_close_conversation')) return;
        try {
          const result = closeConversation(key, body);
          sendJson(result);
        } catch (error) {
          sendJson({
            ok: false,
            error: error?.message ?? String(error),
            code: error?.code,
            assessment: error?.assessment,
          }, Number(error?.statusCode) || 400);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/socialV2/wake-config',
      async handle(ctx, { req, readBody, sendJson }) {
        const cfg = getConfig();
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (!agentGate(key, req, sendJson, 'setWakeConfig', 'qq_set_wake_config')) return;
        const st = getSocialV2State(key);
        const throughSeq = requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
        // Preserve the deployed behavior: with markRead disabled, update wake configuration only.
        const acknowledgeOnClose = throughSeq !== null && v2ToolEnabled('markRead');
        const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
        const current = st.wakeConfig;
        const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
        const normalizeTriggerBool = (name, fallback) => {
          if (name in inputTriggers) return inputTriggers[name] === true;
          return fallback;
        };
        const rawKeywords = inputTriggers.keywords;
        const nextKeywords = rawKeywords !== undefined
          ? (Array.isArray(rawKeywords)
            ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
            : [])
          : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
        const next = {
          ...current,
          mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
          infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
          sleepUntil: current.sleepUntil,
          triggers: {
            // 只带已知字段（见 WAKE_TRIGGER_KEYS 的说明）；未知键一律丢弃。
            ...pickWakeTriggersV2(inputTriggers, current.triggers),
            atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
            nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
            question: normalizeTriggerBool('question', current.triggers.question === true),
            anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
            poke: normalizeTriggerBool('poke', current.triggers.poke === true),
            keywords: nextKeywords
          },
          batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
            ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
            : current.batchWindowMs
        };
        // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
        if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
          next.triggers.anyMessage = false;
        }
        if (next.mode === 'active') {
          next.infinite = true;
          next.sleepUntil = null;
          next.triggers.anyMessage = true;
        }
        if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
        if (next.infinite) {
          next.sleepUntil = null;
        } else if (input.sleepUntil) {
          const d = new Date(String(input.sleepUntil));
          if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
        } else if (Number.isFinite(Number(input.sleepMs))) {
          let ms = Math.max(0, Math.round(Number(input.sleepMs)));
          const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
          const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
          if (ms < minMs) ms = minMs;
          if (maxMs > 0 && ms > maxMs) ms = maxMs;
          next.sleepUntil = new Date(Date.now() + ms).toISOString();
        } else if (!next.sleepUntil && !next.infinite) {
          // 既没有无限也没有时间：使用推荐默认有限时长
          const recMin = Number(cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
          const recMax = Number(cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
          const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
          next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
        }
        // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
        if (!next.infinite && next.sleepUntil) {
          const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
          const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
          let until = Date.parse(next.sleepUntil);
          if (Number.isFinite(until)) {
            if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
            if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
            next.sleepUntil = new Date(until).toISOString();
          }
        }
        // 归一化概率
        if (next.triggers.probability !== undefined) {
          next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
        }
        // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
        if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
          next.triggers.poke = input.triggers.poke === true;
        }
        // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
        // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
        next.triggers.speakerIds = normalizeSpeakerIdsV2(next.triggers.speakerIds);
        // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
        if (key.startsWith('private:')) {
          next.triggers.speakerIds = [];
        }
        // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
        if (next.infinite) {
          const tr = next.triggers ?? {};
          const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
          if (!hasTrigger) {
            sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
            return;
          }
        }
        // 沉睡前强制观察窗口：除非对方明确结束、或已经安静/等待足够时间，否则不允许 AI 聊两句就设置潜水。
        if (isSleepingConfigV2(next) && preSleepWaitBlockedV2(st)) {
          const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
          const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
          const remainMin = Math.ceil(remaining / 60000);
          sendJson({
            ok: false,
            error: `还不能立刻设置潜水/下一次唤醒：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。`,
            preSleepWaitMs: preSleepMs,
            preSleepWaitRemainingMs: remaining
          }, 400);
          return;
        }
        const markedCount = acknowledgeOnClose ? acknowledgeMessagesV2(st, throughSeq) : 0;
        st.wakeConfig = next;
        st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
        st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
        st.wakeConfig.noActionCount = 0;
        st.wakeConfig.confirmedAt = Date.now();
        st.wakeConfig.confirmedBy = 'set_wake_config';
        st.lastActionAt = Date.now();
        // 已成功设置下一次唤醒：本轮沉睡前观察标记作废，下次想再睡需重新走 5 分钟观察。
        st.preSleepWaitSatisfiedAt = 0;
        st.preSleepWaitObservedAt = 0;
        st.preSleepWaitAccumMs = 0;
        flushSocialV2State();
        deps.wakeConfigUpdatedKeys.add(key);
        deps.wakeConfigMissCount.delete(key);
        if (st.pendingWakeTimer) {
          clearTimeout(st.pendingWakeTimer);
          st.pendingWakeTimer = null;
        }
        cancelReplyCheckV2(key); // AI 已主动设置新的唤醒配置，取消回复检查
        setupSleepTimerV2(key);
        log(`[reserved2] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
        sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: readThroughSeqV2(st), wakeConfig: next, wakeSafety: computeWakeSafetyV2(next) });
      },
    },
    {
      method: '*',
      path: '/api/socialV2/group-policy',
      async handle(ctx, { req, readBody, sendJson }) {
        if (req.method === 'GET') {
          const policy = readGroupPolicy();
          const groups = [];
          for (const [key, st] of socialV2.conversations) {
            if (!String(key).startsWith('group:')) continue;
            const id = String(key).split(':')[1];
            await ensureGroupMeta(id);
            const profile = groupProfile(key, st);
            groups.push({
              key,
              name: profile.name || '',
              memberCount: profile.memberCount || 0,
              activityCount: profile.activityCount || 0,
              tier: profile.tier,
              source: profile.source,
              override: policy.overrides[key] || 'auto',
            });
          }
          groups.sort((a, b) => (b.memberCount || 0) - (a.memberCount || 0));
          sendJson({ ok: true, policy, groups });
          return;
        }
        if (req.method === 'POST') {
          const rawBody = await readBody();
          const body = typeof rawBody === 'string' ? JSON.parse(rawBody || '{}') : (rawBody || {});
          const next = normalizeGroupPolicy({
            ...readGroupPolicy(),
            ...(body && typeof body === 'object' ? body : {}),
            overrides: body?.overrides && typeof body.overrides === 'object' ? body.overrides : readGroupPolicy().overrides,
          });
          atomicWriteJson(groupPolicyFile, next);
          setGroupPolicyCache({ key: '', value: next });
          sendJson({ ok: true, policy: next });
          return;
        }
        sendJson({ ok: false, code: 'GROUP_POLICY_METHOD', error: '只支持 GET/POST', hint: '刷新设置页后重试' }, 405);
      },
    },
    {
      method: 'POST',
      path: '/api/socialV2/limit-mute',
      async handle(ctx, { readBody, sendJson }) {
        const raw = await readBody();
        const body = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
        const code = String(body.code || '').trim();
        if (!code) { sendJson({ ok: false, code: 'LIMIT_MUTE_CODE_REQUIRED', error: 'code 不能为空', hint: '刷新错误报告后再点永久不再显示' }, 400); return; }
        const mutes = readLimitMutes();
        mutes.muted = { ...(mutes.muted || {}), [code]: { at: Date.now(), setting: String(body.setting || '') } };
        atomicWriteJson(limitMuteFile, mutes);
        try {
          const rows = gateEvents.list({ limit: 500, includeAcked: false }).events
            .filter((ev) => ev.gate === 'limit' && ev.reason?.code === code)
            .map((ev) => ev.id);
          if (rows.length) gateEvents.ack(rows);
        } catch {}
        sendJson({ ok: true, code, muted: true });
      },
    },
    {
      method: 'GET',
      path: '/api/socialV2/states',
      handle(ctx, { sendJson }) {
        const list = [];
        for (const [key, st] of socialV2.conversations) {
          list.push({
            key,
            wakeConfig: st.wakeConfig,
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            lastWakeReason: st.lastWakeReason,
            lastAiReplyAt: st.lastAiReplyAt,
            noActionCount: st.wakeConfig.noActionCount || 0
          });
        }
        sendJson({ ok: true, conversations: list });
      },
    },
    {
      method: 'POST',
      path: '/api/socialV2/wake',
      async handle(ctx, { readBody, sendJson }) {
        const cfg = getConfig();
        const currentMode = getMode();
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const reason = String(body.reason ?? 'admin').trim() || 'admin';
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
        const keyMatch = /^(group|private):(\d+)$/.exec(key);
        if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
        const kind = keyMatch[1];
        const id = Number(keyMatch[2]);
        if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
          sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
          return;
        }
        const st = getSocialV2State(key);
        if (st.pendingWakeTimer) {
          clearTimeout(st.pendingWakeTimer);
          st.pendingWakeTimer = null;
        }
        // 第一次唤醒必须走 bootstrap：那条 prompt 里带着「二代协议说明 + 操作者为这个会话
        // 预写的初始提示词（群环境/氛围）」。若用手动唤醒的 admin 文案顶掉它，这个会话就
        // 永远拿不到引导 —— 而 bootstrapSent 一旦置真，后续再也不会补发。
        const firstWake = !st.bootstrapSent;
        if (firstWake) st.bootstrapSent = true;
        const effectiveReason = firstWake ? 'bootstrap' : reason;
        flushSocialV2State();
        // 和其它唤醒入口保持一致：sendWakePromptV2 是异步的，这里不 await（不能让 HTTP 回复
        // 等一个可能卡几十秒的模型回合），但必须挂 catch。裸调用一旦 reject 就是
        // unhandledRejection：Node 会打警告甚至按配置退出进程。
        void sendWakePromptV2(key, effectiveReason).catch((error) => log(`[reserved2] 手动唤醒异常 ${key}:`, error?.message ?? error));
        log(`控制台：手动唤醒 ${key}（${effectiveReason}${firstWake && reason !== effectiveReason ? `，首次唤醒，请求原因 ${reason} 已升级为 bootstrap` : ''}）`);
        sendJson({ ok: true, key, reason: effectiveReason, requestedReason: reason, firstWake });
      },
    },
    {
      method: 'POST',
      path: '/api/socialV2/history-catchup',
      async handle(ctx, { readBody, sendJson }) {
        const body = await readBody();
        try {
          const result = await runHistoryCatchUp('manual', { force: body.force === true });
          sendJson(result);
        } catch (error) {
          sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
        }
      },
    },
    {
      method: '*',
      path: '/api/socialV2/initial-prompt',
      async handle(ctx, { req, url, readBody, sendJson }) {
        if (req.method === 'GET') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) {
            const entries = [...initialPrompts.entries()]
              .map(([entryKey, entry]) => ({
                key: entryKey,
                chars: entry.text.length,
                createdAt: entry.createdAt || 0,
                updatedAt: entry.updatedAt || 0,
                preview: entry.text.replace(/\s+/g, ' ').slice(0, 80)
              }))
              .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            sendJson({ ok: true, entries, maxChars: initialPromptMaxChars(), writable: isInitialPromptsWritable() });
            return;
          }
          const canonical = canonicalV2Key(key);
          if (!canonical) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const entry = initialPrompts.get(canonical) ?? null;
          sendJson({
            ok: true,
            key: canonical,
            exists: !!entry,
            text: entry?.text ?? '',
            createdAt: entry?.createdAt || 0,
            updatedAt: entry?.updatedAt || 0,
            maxChars: initialPromptMaxChars(),
            writable: isInitialPromptsWritable()
          });
          return;
        }
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const explicitDelete = body.delete === true;
        // 只接受 { key, text: string } 或 { key, delete: true }：
        // 缺 text 时不当作"清空"（否则一次漏字段的调用就把操作者写的内容删了）。
        if (!explicitDelete && typeof body.text !== 'string') {
          sendJson({ ok: false, error: 'text 必须是字符串（留空表示删除），或用 delete:true 显式删除' }, 400);
          return;
        }
        const result = setInitialPrompt(key, explicitDelete ? '' : body.text);
        if (!result.ok) { sendJson({ ok: false, error: result.error }, result.statusCode ?? 400); return; }
        log(`控制台：${result.deleted ? '已删除' : '已保存'}会话初始提示词 ${result.key}${result.deleted ? '' : `（${result.chars} 字符，仅首次唤醒注入）`}`);
        sendJson({
          ok: true,
          key: result.key,
          deleted: result.deleted,
          chars: result.chars,
          exists: !!result.entry,
          updatedAt: result.entry?.updatedAt || 0,
          maxChars: initialPromptMaxChars()
        });
      },
    },
  ];

  return defineComponent({ id: 'social-console', routes });
}
