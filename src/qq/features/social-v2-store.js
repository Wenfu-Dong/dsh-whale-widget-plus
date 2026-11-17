/**
 * 二代社交状态存储（组件化迁移 #13）：加载 / 快照 / 合并写 / 立即写。
 *
 * 这些逻辑原先散在 src/bridge.js 的 main() 里（loadSocialV2State、buildSocialV2Snapshot、
 * socialV2Writer 及其三个包装）。它们只围绕一个东西转：state/social-v2.json。
 * 拆出来之后 bridge 剩下的是「什么时候存、存什么状态」的调用点，而不是文件读写的细节。
 *
 * 语义约定（与拆分前完全一致）：
 *   · save()   —— **可丢的合并写**：300ms 窗口内多次调用只落盘一次，用于高频记账。
 *   · flush()  —— **必须的立即写**：崩溃恢复/收尾/配置变更/会话重置/写后读回/进程退出。
 *   · cancel() —— 丢弃待写的合并任务（调用方即将直写目标文件时用，避免旧快照复活）。
 *
 * 为什么合并写：原先 save 是同步全量重写，每条入站/出站消息、每次记忆更新都会调它。
 * 多会话实例单次写几十~几百 KB，繁忙群等于「每条消息一次全文件同步写」压在 DSH
 * 事件循环上（桥接与 QQ 事件同一个循环），表现为控制台与回复一起抖动。
 *
 * 运行时状态（socialV2 / seenForwardIds）与读写函数全部由工厂注入，模块内不持有副本；
 * 缺少任何依赖直接抛 TypeError，避免拆完在运行期才炸。
 */

export function createSocialV2Store(deps) {
  const {
    fs, crypto, SOCIAL_V2_FILE, readJsonSafe, atomicWriteJson, createCoalescingWriter,
    log, getConfig, socialV2, seenForwardIds,
    defaultWakeConfigV2, pickWakeTriggersV2, normalizeSpeakerIdsV2, refreshDefaultWakeConfigV2,
    normalizeClosureRecord, sanitizeForwardId, rememberAgentToken,
    ensureWakeableV2, scheduleProactiveCheckV2,
  } = deps || {};
  for (const [name, value] of Object.entries({
    fs, crypto, SOCIAL_V2_FILE, readJsonSafe, atomicWriteJson, createCoalescingWriter,
    log, getConfig, socialV2, seenForwardIds,
    defaultWakeConfigV2, pickWakeTriggersV2, normalizeSpeakerIdsV2, refreshDefaultWakeConfigV2,
    normalizeClosureRecord, sanitizeForwardId, rememberAgentToken,
    ensureWakeableV2, scheduleProactiveCheckV2,
  })) {
    if (value === undefined || value === null) throw new TypeError(`social-v2-store 缺少依赖：${name}`);
  }

  /** 把内存态压成可落盘的对象（各数组按上限截断，避免状态文件无限增长）。 */
  function buildSnapshot() {
    const obj = { paused: socialV2.paused, conversations: Object.create(null) };
    // 会话级淘汰：机器人待过的每个群/私聊此前都会永久保留，快照又是全量重写 ——
    // 长期在多群使用后文件体积与每次写盘耗时线性增长。这里跳过长期无活动的会话
    // （内存态仍在，重启后该 key 会按默认配置重建；用户可在配置里调整或设为 0 关闭）。
    const cfg = getConfig();
    const ttlDays = Number(cfg.socialV2?.context?.conversationTtlDays);
    const ttlDisabled = ttlDays === 0;
    const ttlMs = (Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 30) * 86_400_000;
    const now = Date.now();
    for (const [key, st] of socialV2.conversations) {
      // 从未有过活动记录的旧数据（时间戳全 0）一律保留，避免升级时误删。
      const lastActive = Math.max(
        Number(st.lastIncomingAt) || 0,
        Number(st.lastAiReplyAt) || 0,
        Number(st.lastActionAt) || 0,
        Number(st.lastHistoryCheckedAt) || 0,
        Number(st.lastSendFailureAt) || 0
      );
      if (!ttlDisabled && lastActive > 0 && now - lastActive > ttlMs) continue;
      obj.conversations[key] = {
        wakeConfig: st.wakeConfig,
        recentMessages: st.recentMessages.slice(-200),
        unread: st.unread.slice(-100),
        lastWakeReason: st.lastWakeReason,
        lastAiReplyAt: st.lastAiReplyAt,
        lastActionAt: st.lastActionAt,
        agentToken: st.agentToken,
        bootstrapSent: st.bootstrapSent,
        wakeTimes: st.wakeTimes.slice(-200),
        sendTimes: st.sendTimes.slice(-500),
        stickerCollectTimes: Array.isArray(st.stickerCollectTimes) ? st.stickerCollectTimes.slice(-500) : [],
        lastIncomingAt: st.lastIncomingAt || 0,
        lastHistoryMessageTime: st.lastHistoryMessageTime || 0,
        lastHistoryCheckedAt: st.lastHistoryCheckedAt || 0,
        lastHistoryCatchup: st.lastHistoryCatchup && typeof st.lastHistoryCatchup === 'object' ? st.lastHistoryCatchup : null,
        preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
        preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,
        sendFailureStreak: st.sendFailureStreak || 0,
        wakeSuspendedUntil: st.wakeSuspendedUntil || 0,
        lastSendFailureAt: st.lastSendFailureAt || 0,
        channelGateLoggedAt: st.channelGateLoggedAt || 0,
        preSleepWaitAccumMs: st.preSleepWaitAccumMs || 0,
        lastUnreadSeq: st.lastUnreadSeq || 0,
        lastReadThroughSeq: st.lastReadThroughSeq || 0,
        activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-50) : [],
        pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.slice(-50) : [],
        memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
        // 对话收尾记录：只存结论（收在哪 / 下次怎么接）+ 冷却时间，不存额外消息副本。
        closure: st.closure && typeof st.closure === 'object' ? st.closure : undefined,
        // 鱼群保护状态（2026-10-23）：冷却、直呼放行、最近触发记录。
        fishGuard: st.fishGuard && typeof st.fishGuard === 'object' ? st.fishGuard : undefined,
        fishGuardBypass: st.fishGuardBypass && typeof st.fishGuardBypass === 'object' ? st.fishGuardBypass : undefined,
        lastFishGuard: st.lastFishGuard && typeof st.lastFishGuard === 'object' ? st.lastFishGuard : undefined,
        fishGuardLog: Array.isArray(st.fishGuardLog) ? st.fishGuardLog.slice(-30) : [],
        seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)
      };
    }
    return obj;
  }

  // 惰性创建：save/flush/cancel 都是函数声明（会被提升），如果 main() 里更早的同步代码
  // 在 writer 初始化之前调用它们，直接用 const 会踩 TDZ 抛 ReferenceError。
  // 惰性化后「谁先调谁创建」，行为不变但消除了这个执行顺序地雷。
  let writer = null;
  function writerInstance() {
    if (!writer) {
      writer = createCoalescingWriter({
        write: () => atomicWriteJson(SOCIAL_V2_FILE, buildSnapshot()),
        coalesceMs: 300,
        log: (message, error) => log(`${message}:`, error?.message ?? error),
      });
    }
    return writer;
  }

  /** 合并写：高频记账用，最终会落盘（崩溃最多丢一个合并窗口）。 */
  function save() {
    return writerInstance().schedule();
  }

  /** 立即写：崩溃恢复/收尾/配置变更/会话重置/写后读回/进程退出必须走这条。 */
  function flush() {
    return writerInstance().flush();
  }

  /** 丢弃待写的合并任务（调用方即将直写 SOCIAL_V2_FILE 时必须先调它）。 */
  function cancel() {
    return writerInstance().cancel();
  }

  function fileStamp() {
    try {
      const s = fs.statSync(SOCIAL_V2_FILE);
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return null;
    }
  }

  function loadState() {
    try {
      const cfg = getConfig();
      // 记下读取时刻的文件指纹。加载末尾会统一落盘一次（为了让 ensureWakeableV2
      // 中途的改动不丢），但如果这期间**别的进程**已经写过这个文件，我们手上的
      // 内存态就是旧的 —— 再写回去等于把它那份更新的状态覆盖掉。
      // 这不是假想：日志里出现过两个桥接实例同时启动，第二个实例在加载后立刻回写，
      // 把第一个实例刚更新的读水位/唤醒时间/转发 id 全部退回旧值。
      const beforeStamp = fileStamp();
      let raw = readJsonSafe(SOCIAL_V2_FILE, null);
      // 文件存在但解析失败：先备份现场，再做任何后续写入。否则下一次合并写会用
      // 空/默认状态把损坏文件覆盖掉，用户连人工抢救原始内容的机会都没有。
      // 空文件（size 0）是首次启动的正常形态，不备份。
      if (raw === null) {
        try {
          if (fs.statSync(SOCIAL_V2_FILE).size > 0) {
            const backup = `${SOCIAL_V2_FILE}.corrupt-${Date.now()}`;
            fs.renameSync(SOCIAL_V2_FILE, backup);
            log(`⚠️ state/social-v2.json 解析失败，已备份为 ${backup.slice(SOCIAL_V2_FILE.length + 1)}，本次从空状态开始`);
          }
        } catch {}
      }
      socialV2.paused = raw?.paused === true;
      if (raw && typeof raw.conversations === 'object') {
        const seenTokens = new Set();
        for (const [key, val] of Object.entries(raw.conversations)) {
          if (!val || typeof val !== 'object') continue;
          if (!/^(group|private):\d+$/.test(key)) continue;
          const defaultWc = defaultWakeConfigV2();
          let agentToken = String(val.agentToken || crypto.randomBytes(16).toString('hex'));
          if (!agentToken || seenTokens.has(agentToken)) {
            agentToken = crypto.randomBytes(16).toString('hex');
          }
          seenTokens.add(agentToken);
          const st = {
            wakeConfig: {
              ...defaultWc,
              ...(val.wakeConfig ?? {}),
              // 加载时也按已知字段过滤：旧状态文件里可能残留任意键（见 WAKE_TRIGGER_KEYS）。
              triggers: pickWakeTriggersV2((val.wakeConfig?.triggers) ?? {}, defaultWc.triggers)
            },
            recentMessages: Array.isArray(val.recentMessages) ? val.recentMessages : [],
            unread: Array.isArray(val.unread) ? val.unread : [],
            lastWakeReason: String(val.lastWakeReason ?? ''),
            lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
            lastActionAt: Number(val.lastActionAt) || 0,
            agentToken,
            bootstrapSent: !!val.bootstrapSent,
            wakeTimes: Array.isArray(val.wakeTimes) ? val.wakeTimes : [],
            sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
            stickerCollectTimes: Array.isArray(val.stickerCollectTimes) ? val.stickerCollectTimes : [],
            pendingWakeTimer: null,
            sleepTimer: null,
            replyCheckTimer: null,
            proactiveTimer: null,
            lastIncomingAt: Number(val.lastIncomingAt) || 0,
            // 上线补历史的水位：上次补历史见到的最新远端时间 + 上次检查时间。
            // 旧状态文件没有这两个字段时回落到 0，第一次上线会按 maxAgeMinutes 窗口补。
            lastHistoryMessageTime: Number(val.lastHistoryMessageTime) || 0,
            lastHistoryCheckedAt: Number(val.lastHistoryCheckedAt) || 0,
            lastHistoryCatchup: (val.lastHistoryCatchup && typeof val.lastHistoryCatchup === 'object')
              ? val.lastHistoryCatchup : null,
            preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
            preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,
            preSleepWaitAccumMs: Number(val.preSleepWaitAccumMs) || 0,
            lastUnreadSeq: Number(val.lastUnreadSeq) || 0,
            lastReadThroughSeq: Number.isSafeInteger(val.lastReadThroughSeq) && val.lastReadThroughSeq >= 0
              ? Math.min(val.lastReadThroughSeq, Number(val.lastUnreadSeq) || 0) : 0,
            modelSeenSeqs: new Set(),
            activeTopics: Array.isArray(val.activeTopics) ? val.activeTopics : [],
            pendingThoughts: Array.isArray(val.pendingThoughts) ? val.pendingThoughts : [],
            memberImpressions: (() => {
              const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
              const clean = {};
              for (const [k, v] of Object.entries(rawImp)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                clean[k] = v;
              }
              return clean;
            })(),
            // 上次自然收尾：跨重启保留，才是「结束是下次更好的开始」。
            // 旧状态文件没有这个字段 → null，不影响唤醒。
            closure: normalizeClosureRecord(val.closure, cfg.socialV2?.closure),
            // 鱼群保护的冷却/直呼放行/触发记录要跨桥接重启保留，
            // 否则每次重启都失忆（2026-10-23 补；也供设置页读取）。
            fishGuard: (val.fishGuard && typeof val.fishGuard === 'object') ? val.fishGuard : undefined,
            fishGuardBypass: (val.fishGuardBypass && typeof val.fishGuardBypass === 'object') ? val.fishGuardBypass : undefined,
            lastFishGuard: (val.lastFishGuard && typeof val.lastFishGuard === 'object') ? val.lastFishGuard : undefined,
            fishGuardLog: (Array.isArray(val.fishGuardLog) ? val.fishGuardLog : [])
              .filter((x) => x && typeof x === 'object')
              .slice(-30)
          };
          // 拉黑之后，他**拉黑前**堆在未读/最近上下文里的消息也不能再喂给模型 ——
          // 否则下一次唤醒（哪怕是被别人触发的）会把它们当成新消息来回应，
          // 看起来就像「黑名单没生效」。只清入站缓存，不动记忆卡里已沉淀的内容。
          {
            const blocked = new Set((cfg.deny?.users ?? []).map(String));
            if (blocked.size) {
              const before = st.unread.length + st.recentMessages.length;
              st.unread = st.unread.filter((m) => !blocked.has(String(m?.userId ?? '')));
              st.recentMessages = st.recentMessages.filter((m) => !blocked.has(String(m?.userId ?? '')));
              const removed = before - st.unread.length - st.recentMessages.length;
              if (removed > 0) {
                log(`[黑名单] ${key} 启动时清掉 ${removed} 条来自 deny.users 的未读/上下文（积压不再喂给模型）`);
              }
            }
          }
          // 旧状态/异常状态里的指定成员名单也统一归一化，防止“null”/非法值污染。
          if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
            st.wakeConfig.triggers.speakerIds = normalizeSpeakerIdsV2(st.wakeConfig.triggers.speakerIds);
            if (key.startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
          }
          // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
          refreshDefaultWakeConfigV2(st);
          rememberAgentToken(key, st.agentToken);
          socialV2.conversations.set(key, st);
          // 重启后从已持久化的消息与 seenForwardIds 字段重建“本会话见过的 forward id”
          {
            const rebuilt = new Set();
            if (Array.isArray(val.seenForwardIds)) {
              for (const fid of val.seenForwardIds) {
                const safe = sanitizeForwardId(fid);
                if (safe) rebuilt.add(safe);
              }
            }
            for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
              if (Array.isArray(m?.forwardIds)) {
                for (const fid of m.forwardIds) {
                  const safe = sanitizeForwardId(fid);
                  if (safe) rebuilt.add(safe);
                }
              }
            }
            if (rebuilt.size) seenForwardIds.set(key, rebuilt);
          }
          ensureWakeableV2(st, { skipSave: true, key });
          scheduleProactiveCheckV2(key);
        }
        // 加载阶段统一落盘一次，避免 ensureWakeableV2 中途写盘覆盖未加载会话。
        // 但只有在文件仍是「我们读到的那一份」时才写：否则说明有另一个进程写过它，
        // 我们手里的内存态已经过时，回写会静默吞掉对方的新数据。
        const afterStamp = fileStamp();
        if (beforeStamp !== null && afterStamp !== null && beforeStamp !== afterStamp) {
          log('⚠️ state/social-v2.json 在本次加载期间被其它进程改写，跳过回写以免覆盖更新的状态（是否误开了第二个桥接实例？）');
        } else {
          flush();
        }
      }
    } catch (error) {
      log('读取 socialV2 状态失败:', error?.message ?? error);
    }
  }

  return { loadState, buildSnapshot, save, flush, cancel };
}
