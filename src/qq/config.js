/**
 * QQ 配置的唯一读取入口。
 *
 * 从 src/bridge.js 拆出。以前 config.json 在同一个文件里有 4 种读法
 * （loadConfig / readConfigObject / readJsonSafe / 裸 JSON.parse），
 * 默认值只存在于 loadConfig 一份，其它读法绕过默认值 —— 于是「新加的开关键
 * 在有的路径上 undefined、被当成 false」，表现为开关时灵时不灵。
 *
 * 现在：所有配置读取都从这里出发，默认值只有这一份。
 */
import { readJsonSafe } from './json-io.js';
import { normalizeQqFishGuard } from '../fish-guard.js';
import { discoverDshLaunchToken } from '../dsh-client.js';
import { normalizeCardMode } from '../bili-card.js';
import { normalizeClosureConfig } from '../conversation-closure.js';
import { normalizeHistoryConfig } from '../history-catchup.js';
import { normalizePurposeConfig } from '../purpose-engine.js';

// DeepSeek provider 明确支持的取值（见 dsh-llm-deepseek：其它值会抛 UNSUPPORTED_REASONING_EFFORT）。
// 'off' 虽然合法（关闭思考），但 QQ 聊天助手依赖思考，控制台不提供该档。
const REASONING_EFFORT_OPTIONS = ['low', 'high', 'max'];
const REASONING_EFFORT_DEFAULT = 'max';
function normalizeReasoningEffort(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!REASONING_EFFORT_OPTIONS.includes(v)) {
    throw new Error(`思考强度只能是 ${REASONING_EFFORT_OPTIONS.join(' / ')}`);
  }
  return v;
}

// 管理员 QQ（ownerQQ）规范化：空值=未设置；必须是正整数 QQ 号。
function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

// 白名单/黑名单值规范化：只接受字符串或数字数组，非数组按空列表处理（fail-closed 语义由调用方决定）。
function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}

// ── 配置 ────────────────────────────────────────────────────────────────────
export function loadConfig({ configFile, log = () => {}, roleInjectMaxCharsDefault = 6000, applyRoleInjectLimit = (v) => Number(v) || 6000, setRoleInjectMaxChars = () => {} }) {
  const p = configFile;
  const file = readJsonSafe(p, null, true);
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置格式错误：${p}`);
  const cfg = {
    dsh: {
      baseUrl: 'http://127.0.0.1:3080',
      provider: 'deepseek-official',
      // 多模态模型：DeepSeek-V41-Flash（DSH 模型目录里 inputModalities 含 image）。
      // 旧默认 deepseek-v4-flash-vision-exp 已被取代；config.json 未配置时用此兜底。
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      // 兼容新版 DSH 的 API 鉴权：如果 DSH 升级后要求非浏览器客户端带 token，
      // 在这里配置 token；默认走 Authorization: Bearer <token>。
      authToken: '',
      authHeader: 'authorization',
      authPrefix: 'Bearer',
      // 是否允许把 DSH launch token 发往非回环地址（默认 false：那是进程启动凭据）
      allowRemote: false,
      ...(file.dsh ?? {})
    },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },
    // 空 => 每个会话在 state/agents/<key> 下建独立工作目录
    sessionCwd: file.sessionCwd ?? '',
    agentPreset: file.agentPreset ?? 'qq-chat',
    workspaceTitle: file.workspaceTitle ?? 'QQ 聊天',
    ownerQQ: normalizeOwnerQQ(file.ownerQQ),
    // 管理员身份（QQ ⇄ B站 同一个人）的投影：由合体插件在保存时写入；
    // 旧配置没有这一段时 adminFromQqConfig 会回退到 ownerQQ。
    admin: file.admin && typeof file.admin === 'object' && !Array.isArray(file.admin) ? file.admin : null,
    allow: {
      private: normalizeIdList(file.allow?.private ?? file.allow?.privates ?? []),
      groups: normalizeIdList(file.allow?.groups ?? file.allow?.group ?? [])
    },
    deny: {
      // 人的黑名单（2026-10-23）：无论私聊还是哪个群，这个 QQ 号发来的消息一律不响应。
      // 与 private / groups 的区别：那两条按「会话」拦（会话本身进不来），这条按「人」拦
      // （会话仍在白名单里，只是这个人不触发、不进上下文）。见 senderBlocked()。
      users: [...new Set(normalizeIdList(file.deny?.users ?? file.deny?.people ?? file.deny?.persons ?? []))],
      private: normalizeIdList(file.deny?.private ?? file.deny?.privates ?? []),
      groups: normalizeIdList(file.deny?.groups ?? file.deny?.group ?? [])
    },
    // 私聊/群聊均未配置白名单时是否放行所有（true 时启动会打警告）
    allowAllWhenEmpty: file.allowAllWhenEmpty === true,
    ackMessage: file.ackMessage ?? '🤔 收到，正在思考…',
    sendDelayMs: file.sendDelayMs ?? 300,
    questionTimeoutMs: file.questionTimeoutMs ?? 5 * 60 * 1000,
    consolePort: file.consolePort ?? 3100,
    consoleToken: file.consoleToken ?? '',
    // 价目表覆盖项（可选）。留空即用 src/model-prices.js 的官方默认价。
    pricing: file.pricing ?? null,
    security: {
      interceptNotify: true,
      ...(file.security ?? {})
    },
    // QQ 群「鱼群保护」：多个同类 bot 同群时避免集体刷屏（设置页可关）。
    fishGuard: normalizeQqFishGuard(file.fishGuard),
    slang: {
      enabled: true,
      extractMinMessages: 10,
      extractCooldownMs: 5 * 60 * 1000,
      inferenceThresholds: [2, 4, 8],
      injectMax: 8,
      learnerPreset: 'qq-chat',
      workspaceTitle: 'QQ 黑话学习',
      autoResearch: true,
      ...(file.slang ?? {})
    },
    // 看图懂梗（内置版，移植自 astrbot_plugin_fatfish_seememe v0.4.0）
    seeMeme: {
      enabled: true,
      // 留空 = 用当前对话模型（需支持图片输入）
      provider: '',
      model: '',
      maxPerTurn: 3,
      maxChars: 180,
      hourlyLimit: 60,
      dailyLimit: 300,
      puns: true,
      lookup: true,
      timeoutMs: 25000,
      botNames: [],
      botLook: '',
      ...(file.seeMeme ?? {})
    },
    social: {
      enabled: true,
      // 启动阶段（观望）
      triggerProbability: 0.1,        // 普通消息触发进入活跃的概率
      contextWindow: 20,              // 触发/活跃回复时附带的上下文条数
      // 活跃阶段（对话进行中）
      activeCheckMinMs: 10 * 1000,    // 活跃期检测间隔范围（当前控制台保存值）
      activeCheckMaxMs: 30 * 1000,
      activeReplyDelayMinMs: 2 * 1000, // 活跃期回复延迟范围（当前控制台保存值）
      activeReplyDelayMaxMs: 8 * 1000,
      // 活跃超时主动退出（防止活跃群中一直保持活跃）
      activeDurationEnabled: true,     // 总开关：是否启用“活跃超过时长后主动收尾退场”
      activeDurationMinMs: 15 * 60 * 1000, // 活跃状态最长持续时间下限（进入活跃那一刻起算，分钟）
      activeDurationMaxMs: 30 * 60 * 1000, // 活跃状态最长持续时间上限（分钟）
      // 冷场处理
      idleWindowMs: 6 * 60 * 1000,    // 活跃期多久没人说话算冷场
      idleRetryProbability: 0.25,     // 冷场时 AI 继续说一句（试探群友意愿）的概率
      idleRetryWaitMs: 2 * 60 * 1000, // 试探后等待回应的窗口，仍无人说话则 100% 回观望
      // 二期：观望阶段主动开话题（第三种触发）
      proactiveEnabled: true,         // 总开关
      proactiveIdleThresholdMs: 30 * 60 * 1000, // 群安静多久才进入可判定状态
      proactiveCheckMinMs: 45 * 60 * 1000,      // 判定间隔范围
      proactiveCheckMaxMs: 90 * 60 * 1000,
      proactiveProbability: 0.2,      // 每次判定的成功概率（小概率开口）
      // 选择性沉默/退让
      skipProbability: 0.15,          // 普通闲聊沉默概率（当前控制台保存值）
      surrenderProbability: 0,        // 已弃用：桥接不再直接生成退让短句（避免割裂），保留字段兼容旧配置
      // 摘要与展示
      maxReplyChars: 500,             // 单条 QQ 消息安全长度上限（防 AI 出 bug；分句交给 AI 用空格控制）
      mustReplyKeywords: ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗'],
      // 真人式多消息分条发送：按空格分句，AI 用空格表示“这里要分成下一条”
      burstEnabled: true,             // 总开关：是否允许按空格拆成多条 QQ 消息
      burstIntervalMinMs: 1000,       // 条间随机间隔下限（毫秒）
      burstIntervalMaxMs: 3000,       // 条间随机间隔上限（毫秒）
      longGapProbability: 0.1,        // 长间隔概率（当前控制台保存值）
      longGapMinMs: 2500,             // 长间隔下限（当前控制台保存值）
      longGapMaxMs: 5000,             // 长间隔上限（当前控制台保存值）
      ...(file.social ?? {})
    },
    socialV2: {
      enabled: true,
      autoReplyCheckMs: 30000,
      agentPreset: 'qq-chat-v2',
      provideRecommendations: true,
      tools: {
        getPrompt: true,

        getSnapshot: true,
        getUnread: true,
        getRecent: true,
        socialState: true,
        sendGroup: true,
        sendPrivate: true,
        reply: true,
        sendBurst: true,
        sendMessage: true,
        waitMessages: true,
        feedback: true,
        getMyRecent: true,
        getMessageDetail: true,
        getActiveMembers: true,
        setWakeConfig: true,
        markRead: true,
        memory: true,
        getImages: true,
        getForwardMsg: true,
        sendPoke: true,
        listStickers: true,
        getStickerImage: true,
        sendSticker: true,
        setStickerRemark: false,
        stickerNote: true,
        collectSticker: true,
        getSelfImage: true,
        closeConversation: true
      },
      wake: {
        defaultMode: 'diving',
        preSleepWaitEnabled: true,      // 沉睡前强制观察窗口开关：防止 AI 聊两句就潜水
        preSleepWaitMs: 300000,          // 默认沉睡前至少等待/观察 5 分钟（后台可调）
        recommendedDefaultInfinite: true, // 默认下一次唤醒是否无限期（true=永久潜水等条件；false=有限时长）
        sleepMinMs: 60000,
        sleepMaxMs: 0,
        recommendedSleepMinMs: 300000,
        recommendedSleepMaxMs: 7200000,
        recommendedProbability: 0.05,
        recommendedKeywords: ['小鲸鱼', 'DeepSeek', 'deepseek', 'DS', 'D老师', 'd老师', 'D指导', 'd指导', 'D师傅', 'd师傅', '深度求索', '大肥鱼', '鲸鱼', 'DeepSeek V3', 'DeepSeek R1', 'R1'],
        recommendedAtMention: true,
        recommendedNameMention: true,
        recommendedQuestion: true,
        recommendedPoke: true,
        recommendedHint: '如果你要潜水，推荐先调用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话就可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看 newMessages，判断不需要你参与可直接沉睡，若参与了则下次想睡需再等观察窗口。潜水时长推荐 5~120 分钟，普通消息概率 0.05；@/名字/关键词/提问唤醒建议保持开启。需要等特定某人/某几人时，可额外设置 triggers.speakerIds。',
        batchWindowMs: 8000,
        maxWakePerMinute: 1,
        maxWakePerHour: 12,
        noActionLimit: 3,
        // 重启补唤醒最多叫醒几个会话。默认从 5 降到 3：backlog 冷启动最贵，
        // 先处理最积压的 3 个，其余留到下一轮/自然唤醒，不一次开五个冷会话。
        backlogMaxSessions: 3,
        maxWakeConfigReminders: 2
      },
      send: {
        burstEnabled: true,
        burstMaxMessages: 8,
        burstIntervalMinMs: 1000,
        burstIntervalMaxMs: 3000,
        longGapProbability: 0.2,
        longGapMinMs: 5000,
        longGapMaxMs: 10000,
        maxSendPerMinute: 8,
        maxSendPerHour: 60,
        maxMessageChars: 500,
        maxGapMs: 10000,
        gapBaseMs: 800,
        gapPerCharMs: 20,
        recommendedHint: '普通闲聊建议一次 1~3 条，条间 1~3 秒；讲故事/回忆可以 5~10 秒间隔；不要连续刷屏。'
      },
      // 2026-10-23 用户定：Token 防爆破。鱼群守则管“鱼多不多”，这里管“这次醒来的开销”。
      tokenGuard: {
        enabled: true,
        maxWakesPerDay: 20,          // 单会话每天最多真实唤醒次数（群）
        privateMaxWakesPerDay: 10,   // 私聊单独更紧
        minWakeGapMs: 120000,        // 同一会话两次苏醒至少隔 2 分钟
        directBypassGap: true,        // 被 @/叫到/引用时越过这个最小间隔（每日/花费上限仍生效）
        maxOutboundPerTurn: 8,       // 一次醒来最多发 8 条（burst/单发/表情/拍一拍/语音都算）
        maxDailyCostCNY: 8,          // 近 24h 全局花费上限；0 = 不限
      },
      wait: {
        defaultMs: 30000,
        minMs: 5000,
        maxMs: 600000,
        defaultQuietMs: 8000,
        minQuietAfterNewMs: 10000   // 收到新消息后至少再等这么久（默认 10 秒），防止抢话
      },
      sticker: {
        enabled: true,             // 表情包体系总开关
        syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
        maxListCount: 100,         // qq_list_stickers 单次最大返回数
        includeInPrompt: true,     // 是否在 qq_get_prompt / 唤醒提示里附带表情摘要与策略
        promptMaxStickers: 8,      // 提示里最多列出的常用表情数
        collect: {
          enabled: true,           // AI 收藏他人表情总开关
          maxPerMinute: 2,         // 每分钟最多收藏次数
          maxPerHour: 10,          // 每小时最多收藏次数
          maxRemarkChars: 20       // 收藏时备注最大长度
        }
      },
      proactive: {
        enabled: true,
        checkIntervalMinMs: 30 * 60 * 1000,
        checkIntervalMaxMs: 90 * 60 * 1000,
        idleThresholdMs: 15 * 60 * 1000,
        probability: 0.3
      },
      feedback: {
        maxLength: 500,
        notifyOwnerOnError: false
      },
      context: {
        recentLimit: 100,
        unreadLimit: 30,
        contextWindow: 20,
        inlineWakeMessages: true,
        wakeMessageLimit: 12,
        wakeRecentLimit: 4,
        wakeMaxChars: 6000,
        // 唤醒快照从"最近"往回取：更早的未读折叠成一条计数（PITFALLS #76）。
        // false = 恢复旧行为（从最早未读开始塞，积压时会先回老消息）。
        wakeFoldOld: true,
      },
      // 上线补历史消息（2026-10-24 用户要求：默认勾选打开）：
      // 桥接启动 / QQ 账号重新上线时，用 OneBot 历史接口补看掉线期间错过的白名单会话。
      history: {
        enabled: true,
        limit: 30,          // 每个会话最多补几条（历史接口按最新 N 条返回）
        maxAgeMinutes: 720, // 只补最近 12 小时，避免把隔夜旧账翻出来
        wake: true,         // 真补到消息时主动唤醒一次，让 AI 知道掉线期间发生了什么
        includePrivate: true // 私聊也补（白名单内）
      },
      // 操作者在控制台为单个会话预写的「初始提示词」的字数上限（只在首次唤醒时注入一次）。
      // 它不是安全边界，只是防止误粘贴一篇长文把首次唤醒的 prompt 撑爆。
      initialPromptMaxChars: 2000,
      // 图片/表情（含动图）的数量与体积上限。QQ 的动图表情常见 1~4MB，
      // 旧的 4MB 单条总上限会误伤；这里默认 8MB，仍受 DSH 的 20MB/64MP 限制约束。
      media: {
        maxBytes: 8 * 1024 * 1024,
        maxPixels: 64_000_000,
        maxCount: 5
      },
      ...(file.socialV2 ?? {})
    }
  };

  // 大肥鱼表情包配置（qq 配置的 stickers 段；不参与其它逻辑）
  cfg.stickers = file.stickers && typeof file.stickers === 'object' && !Array.isArray(file.stickers) ? file.stickers : {};
  // 活人感（兜底 + 打字刹车；内置版原生实现的第一阶段）
  cfg.humanize = {
    cleanReply: true,   // 去掉英文草稿、"作为一个AI"、"希望对你有帮助"这类客服腔
    burstBrake: true,   // 分段发到一半对方又说话了 → 剩下的不发
    gather: true,       // 攒一攒：先等一个安静窗口再回
    groupGate: true,    // 群里没点名时按接话打分决定接不接
    profile: 'default', // quiet / default / loud / custom
    ...(file.humanize && typeof file.humanize === 'object' ? file.humanize : {})
  };

  // socialV2.tools 需要与默认值深度合并：旧 config.json 若缺少新增工具开关，
  // 不能因为外层 spread 覆盖而丢失默认开关。
  cfg.socialV2.tools = {
    getPrompt: true,

    getSnapshot: true,
    getUnread: true,
    getRecent: true,
    socialState: true,
    sendGroup: true,
    sendPrivate: true,
    reply: true,
    sendBurst: true,
    sendMessage: true,
    waitMessages: true,
    feedback: true,
    getMyRecent: true,
    getMessageDetail: true,
    getActiveMembers: true,
    setWakeConfig: true,
    markRead: true,
    memory: true,
    slangQuery: true,
    slangSubmit: true,
    getImages: true,
    getForwardMsg: true,
    sendPoke: true,
    listStickers: true,
    getStickerImage: true,
    sendSticker: true,
    setStickerRemark: false,
    stickerNote: true,
    collectSticker: true,
    getSelfImage: true,
    closeConversation: true,
    sendVoice: false,
    ...(cfg.socialV2.tools ?? {})
  };

  // ── 对话收尾判断（2026-10-24）────────────────────────────────────────────
  // 用户要求：「一次对话总是有结束的，结束不是终止，而是一段信息输出的合理结束，
  // 和下次更好的开始」。这里只保存策略参数；判断本身在 conversation-closure.js，
  // 最终「收不收」由模型调用 qq_close_conversation 决定。
  // 默认开、旧 config 没有这一块也生效。
  cfg.socialV2.closure = normalizeClosureConfig(cfg.socialV2.closure ?? {});

  // socialV2.voice：语音发送（把准备好的音频文件当 QQ 语音发出去）。
  // dir 为相对仓库根目录的语音库路径；AI 的 qq_send_voice 默认只能从这个目录取文件，
  // 绝对路径需要显式开 allowAbsolutePath（默认关，避免 prompt injection 读到任意本地文件）。
  //
  // 默认**关闭**（enabled/sendVoice 均为 false）：语音是"开口说话"的强表达，且需要你先准备好
  // 语音库内容。没放音频就让 AI 发语音只会得到一串错误。把音频放进 audio/ 后，
  // 在控制台「二代仿真 → 语音库与语音发送」里打开开关即可。
  cfg.socialV2.voice = {
    enabled: false,
    dir: 'audio',
    maxSeconds: 300,
    maxBytes: 20 * 1024 * 1024,
    maxPerMinute: 2,
    maxPerHour: 10,
    allowAbsolutePath: false,
    // 音量：默认倍数（1 = 原样）+ 智能音量档位 + ffmpeg 位置（空 = 走 PATH）。
    // SnowLuma 的 record 段没有增益字段，所以音量必须在本地先调好再发。
    defaultVolume: 1,
    loudness: 'normal',
    ffmpegPath: '',
    autoReadback: true,
    ...(cfg.socialV2?.voice ?? {})
  };

  // socialV2.sticker.collect 也需要深度合并，避免旧配置缺失 collect 子项时丢默认值。
  cfg.socialV2.sticker = {
    enabled: true,
    syncTtlMs: 60000,
    maxListCount: 100,
    includeInPrompt: true,
    promptMaxStickers: 8,
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    },
    ...(cfg.socialV2?.sticker ?? {}),
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    }
  };

  // socialV2.media：图片/表情的数量与体积上限。旧配置没有这一段，必须深度合并出默认值，
  // 否则 `{...defaults, ...file.socialV2}` 里缺失的 media 会取到 undefined（等于无上限判断）。
  cfg.socialV2.media = {
    maxBytes: 8 * 1024 * 1024,
    maxPixels: 64_000_000,
    maxCount: 5,
    ...((cfg.socialV2?.media && typeof cfg.socialV2.media === 'object' && !Array.isArray(cfg.socialV2.media)) ? cfg.socialV2.media : {})
  };

  // socialV2.history：上线补历史消息。旧 config.json 没有这一段时必须落默认值（默认开启），
  // 手写坏值（字符串/负数）也要收敛，不能把「没配」解释成「关闭」。
  cfg.socialV2.history = normalizeHistoryConfig(cfg.socialV2?.history);

  // socialV2.initialPromptMaxChars：会话「初始提示词」的字数上限。config.json 是用户可编辑的，
  // 手工写进字符串/负数/超大值时要收敛到安全区间，否则要么保存接口永远报"过长"，要么等于没上限。
  {
    const raw = Number(cfg.socialV2?.initialPromptMaxChars);
    cfg.socialV2.initialPromptMaxChars = Number.isFinite(raw) && raw > 0
      ? Math.min(8000, Math.max(100, Math.round(raw)))
      : 2000;
  }

  // DSH 0.1.7 起 launch token 是**每进程现生成的 32 字节随机数，只存在内存里**，
  // 不落盘、不可推导；只有启动器把 `dsh web` 的 stdout 重定向到文件时才能从日志读到。
  // 所以这里发现的 token 只是兜底，主路径是客户端用 ~/.dsh 里持久化的签名密钥
  // 离线铸造会话 Cookie（见 dsh-client 的 mintBrowserSessionCookie）。
  // authTokenExplicit 记录「token 是用户填的还是这里猜的」，客户端据此排优先级。
  cfg.dsh.authTokenExplicit = Boolean(cfg.dsh.authToken);
  if (!cfg.dsh.authToken) cfg.dsh.authToken = discoverDshLaunchToken();

  // 思考强度可能被手工改成非法值（config.json 是用户可编辑的）。DeepSeek 适配器对非法值
  // 会硬拒绝，若直接透传会让每个会话的 selectModel 每次都失败；这里统一规范化并告警。
  try {
    cfg.dsh.reasoningEffort = normalizeReasoningEffort(cfg.dsh.reasoningEffort ?? REASONING_EFFORT_DEFAULT);
  } catch (error) {
    log(`⚠️ config.json 的 dsh.reasoningEffort「${cfg.dsh.reasoningEffort}」非法，已回退 ${REASONING_EFFORT_DEFAULT}（${error?.message ?? error}）`);
    cfg.dsh.reasoningEffort = REASONING_EFFORT_DEFAULT;
  }

  // 人格卡注入上限（字符）。历史硬编码 6000，现在可配：每条约 4~6k token 的成本护栏。
  cfg.role = { maxInjectChars: roleInjectMaxCharsDefault, ...(file.role ?? {}) };
  const roleInjectMaxChars = applyRoleInjectLimit(cfg.role.maxInjectChars);
  setRoleInjectMaxChars(roleInjectMaxChars);
  if (roleInjectMaxChars !== cfg.role.maxInjectChars) {
    log(`人格注入上限已按范围校正为 ${roleInjectMaxChars} 字符（配置值 ${cfg.role.maxInjectChars}，允许 1000~20000）`);
  }

  // chat 模式：上下文窗口 / 别人之间说话过滤 / 群聊生物钟 / 主动搭话
  cfg.chat = {
    contextMessages: Math.min(100, Math.max(0, Math.round(Number(file.chat?.contextMessages ?? 10)))),
    // 按群覆盖上下文条数：{ "群号": 条数 }，没配的群用 contextMessages
    groupContextMessages: Object.fromEntries(
      Object.entries(file.chat?.groupContextMessages ?? {})
        .map(([k, v]) => [String(k).trim(), Math.min(100, Math.max(0, Math.round(Number(v))))])
        .filter(([k, v]) => /^\d+$/.test(k) && Number.isFinite(v))
    ),
    addressFilter: {
      enabled: file.chat?.addressFilter?.enabled !== false,
      silenceWhenAddressedToOther: Math.max(0, Math.min(1, Number(file.chat?.addressFilter?.silenceWhenAddressedToOther ?? 0.4)))
    },
    // 生物钟：每小时内约 40% 的时长在线（自己分配成 1~2 段）；离线时只回应 @（含引用/点名）。
    presence: {
      enabled: file.chat?.presence?.enabled !== false,
      onlineShare: Math.max(0, Math.min(1, Number(file.chat?.presence?.onlineShare ?? file.chat?.presence?.onlineProbability ?? 0.4))),
      offlineMinMs: Math.max(60_000, Number(file.chat?.presence?.offlineMinMs ?? 600_000)),
      wakeWindowMs: Math.max(30_000, Number(file.chat?.presence?.wakeWindowMs ?? 180_000))
    },
    // 主动搭话：在线时结合最近消息自己找乐子 @ 一个人，每群每小时最多一次。
    proactive: {
      enabled: file.chat?.proactive?.enabled !== false,
      minIntervalMs: Math.max(600_000, Number(file.chat?.proactive?.minIntervalMs ?? 3_600_000)),
      minMessages: Math.max(3, Math.round(Number(file.chat?.proactive?.minMessages ?? 10)))
    }
  };

  // 每天定时问候（config.json → greetings.morning）
  {
    const m = file.greetings?.morning;
    const uin = m ? normalizeIdList([m.uin])[0] : null;
    cfg.greetings = {
      enabled: file.greetings?.enabled !== false && Boolean(m && uin),
      morning: m && uin ? { time: String(m.time ?? '08:00'), uin, name: String(m.name ?? '').trim().slice(0, 40) } : null
    };
  }

  // 目的机制（2026-10-24 用户要求）：从近期 QQ + B站 记忆里提炼「目的」，
  // 定期主动私聊主人，分享所想（🧀）或提出索取。默认开，但受安静时段/每日上限/token 额度约束。
  cfg.purpose = normalizePurposeConfig(file.purpose, { ownerQQ: cfg.ownerQQ });

  // B站记忆 / 动态同步 / 每日分享（config.json → biliBridge，全部可选，默认开启）。
  {
    const b = file.biliBridge && typeof file.biliBridge === 'object' && !Array.isArray(file.biliBridge) ? file.biliBridge : {};
    const clampMs = (value, fallback, min, max) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
    };
    const rawTimes = Array.isArray(b.share?.times) ? b.share.times : null;
    const times = (rawTimes && rawTimes.length ? rawTimes : ['07:00', '11:00', '13:00', '15:00', '17:00', '19:00', '21:00', '23:00'])
      .map((t) => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? '').trim());
        if (!m) return '';
        return `${String(Math.min(23, Number(m[1]))).padStart(2, '0')}:${String(Math.min(59, Number(m[2]))).padStart(2, '0')}`;
      })
      .filter(Boolean);
    // 卡片样式：link（默认，普通分享卡）/ miniapp（B站小程序已下架，opt-in）/ off。
    // 旧配置只有 card:boolean，normalizeCardMode 会把它收敛掉。
    const shareCardMode = normalizeCardMode(b.share ?? {});
    cfg.biliBridge = {
      enabled: b.enabled !== false,
      memory: {
        enabled: b.memory?.enabled !== false,
        refreshIntervalMs: clampMs(b.memory?.refreshIntervalMs, 10 * 60 * 1000, 60 * 1000, 60 * 60 * 1000)
      },
      dynamics: {
        enabled: b.dynamics?.enabled !== false,
        pollIntervalMs: clampMs(b.dynamics?.pollIntervalMs, 3 * 60 * 1000, 60 * 1000, 60 * 60 * 1000),
        groups: normalizeIdList(b.dynamics?.groups)
      },
      share: {
        enabled: b.share?.enabled !== false && times.length > 0,
        times,
        groups: normalizeIdList(b.share?.groups),
        gapMs: clampMs(b.share?.gapMs, 4000, 0, 60_000),
        cardMode: shareCardMode,
        card: shareCardMode !== 'off'
      }
    };
  }

  // DSH 每次重启可能换 Web 端口（GUI URL 是动态的）。DSH 启动的子进程会带
  // DSH_WEB_URL；优先用它，避免桥接还指着上一次的端口。手动从 Explorer 启动时
  // 没有这个环境变量，就回退 config.json。
  const dshWebUrl = String(process.env.DSH_WEB_URL ?? '').trim();
  if (dshWebUrl) cfg.dsh.baseUrl = dshWebUrl;

  return cfg;
}

export {
  normalizeOwnerQQ, normalizeIdList,
  normalizeReasoningEffort, REASONING_EFFORT_OPTIONS, REASONING_EFFORT_DEFAULT,
};

