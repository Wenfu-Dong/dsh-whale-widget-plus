/**
 * 语音发送（组件化迁移 #6）。
 *
 * 从 src/bridge.js 的 main() 搬出整条语音链路：
 *   - 语音配置解析（voiceCfg）、语音库定位与安全检查（库内解析 / 操作者解析）；
 *   - 文本合成（synthesizeVoiceText → 八音源分发）、试听、自检、豆包网页音源管理；
 *   - 语音限流（分钟/小时）、触发规则（谁能让她出声）、发送与落地校验；
 *   - 操作者通道 /api/voice/send 与 /api/send/voice 的控制台接口。
 *
 * 留在 bridge 的部分（协议层，不在组件里做）：
 *   - /api/socialV2/send-voice 的 agent token、会话白名单、工具开关、静默/鱼群/token 闸门；
 *   - /api/socialV2/voices 的 agent 通道鉴权。
 *   这些接口只调用本组件导出的方法。
 */
import fs from 'node:fs';
import path from 'node:path';
import { defineComponent } from '../core/registry.js';
import {
  AUDIO_EXTS,
  cleanupTemp,
  describeAudio,
  inspectAudio,
  listAudioFiles,
  parseTargetKey,
  processAudioVolume,
  resolveAudioProcessing,
  resolveAudioSource,
  safeJoinLibrary,
} from '../../send-voice-lib.js';
import { SENSITIVE_RE } from '../../sensitive.js';
import { DEFAULT_EDGE_VOICE } from '../../voice-edge-tts.js';
import { DEFAULT_BASE_URL as DEFAULT_VOXD_URL } from '../../voice-tts.js';
import { DEFAULT_ONLINE_DESC, DEFAULT_ONLINE_LANGUAGE } from '../../voice-online-tts.js';
import { DOUBAO_DEFAULT_VOICE } from '../../voice-doubao-tts.js';
import { QWEN_DEFAULT_VOICE, QWEN_DEFAULT_MODEL } from '../../voice-qwen-tts.js';
import { DEEPSEEK_DEFAULT_VOICE } from '../../voice-deepseek-tts.js';
import { doubaoWebStatus, listDoubaoWebVoices, openDoubaoWebLogin, selectDoubaoWebVoice } from '../../voice-doubao-web.js';
import { synthesizeToFileByRoute, VOICE_ROUTES } from '../../voice-routes.mjs';
import { classifyVoiceError } from '../../voice-diagnostics.js';
import { truncateText } from '../../md-to-plain.js';
import { resolveSearchApiKey } from '../../web-search.js';
import { atomicWriteJson, readConfigObject } from '../json-io.js';
import { KNOWN_AGENT_TOKENS } from '../redaction.js';

export function createVoiceComponent(deps) {
  const {
    stateDir, dataRoot, rootDir, configFile,
    log, getConfig, getMode, appendActivity, shouldAuditKey,
    captureSendGuard, enqueueSend,
    getSocialV2State, saveSocialV2State, modeAllowed,
  } = deps || {};
  for (const [name, value] of Object.entries({
    stateDir, dataRoot, rootDir, configFile, log, getConfig,
    appendActivity, shouldAuditKey, captureSendGuard, enqueueSend,
    getSocialV2State, saveSocialV2State, modeAllowed,
  })) {
    if (value === undefined || value === null) throw new TypeError(`voice 缺少依赖：${name}`);
  }

  // 语音发送时间戳（scopeKey → number[]）：与文本发送分开计数，语音额度独立。
  const voiceSendTimes = new Map();
  // 「谁在触发」：每个会话记住最后一条入站消息的发送者。
  const voiceLastSpeaker = new Map(); // key -> { userId, isOwner, at }
  // 本会话上一次语音发出的时间：保证「一条主人消息最多换一条语音」。
  const voiceLastSentAt = new Map(); // key -> ts
  // 主人最近一次开口的时间。别人发表情/转发不该把主人的授权冲掉。
  const voiceOwnerAt = new Map(); // key -> ts

  /**
   * 语音库目录解析：绝对路径原样用；相对路径按数据根解析。
   * 旧 clone 安装的仓库根下若已有该目录（且数据根还没有），继续用旧位置。
   */
  function resolveVoiceDir(rawDir) {
    const raw = String(rawDir ?? 'audio');
    if (path.isAbsolute(raw)) return raw;
    const dataDir = path.resolve(dataRoot, raw);
    try {
      if (!fs.existsSync(dataDir)) {
        const legacyDir = path.resolve(rootDir, raw);
        if (legacyDir !== dataDir && fs.existsSync(legacyDir)) return legacyDir;
      }
    } catch {}
    return dataDir;
  }

  function voiceCfg() {
    const cfg = getConfig();
    const v = cfg.socialV2?.voice ?? {};
    return {
      enabled: v.enabled !== false,
      dir: resolveVoiceDir(v.dir),
      maxSeconds: Number(v.maxSeconds) > 0 ? Number(v.maxSeconds) : 300,
      maxBytes: Number(v.maxBytes) > 0 ? Number(v.maxBytes) : 20 * 1024 * 1024,
      maxPerMinute: Number(v.maxPerMinute) >= 0 ? Number(v.maxPerMinute) : 2,
      maxPerHour: Number(v.maxPerHour) >= 0 ? Number(v.maxPerHour) : 10,
      allowAbsolutePath: v.allowAbsolutePath === true,
      defaultVolume: Number(v.defaultVolume) > 0 ? Number(v.defaultVolume) : 1,
      loudness: v.loudness || 'normal',
      ffmpegPath: process.env.FFMPEG_PATH || v.ffmpegPath || null,
      autoReadback: v.autoReadback !== false,
      trigger: {
        who: ['owner', 'anyone', 'list'].includes(String(v.trigger?.who)) ? String(v.trigger.who) : 'owner',
        members: Array.isArray(v.trigger?.members) ? v.trigger.members.map(String) : [],
        groups: Array.isArray(v.trigger?.groups) ? v.trigger.groups.map(String) : [],
      },
      tts: {
        enabled: v.tts?.enabled === true,
        timeoutMs: Number(v.tts?.timeoutMs) > 0 ? Number(v.tts.timeoutMs) : 60000,
        maxChars: Number(v.tts?.maxChars) > 0 ? Number(v.tts.maxChars) : 120,
        character: String(v.tts?.character || ''),
        route: VOICE_ROUTES.includes(String(v.tts?.route)) ? String(v.tts.route) : 'edge',
        edgeVoice: String(v.tts?.edgeVoice || DEFAULT_EDGE_VOICE),
        localBaseUrl: String(v.tts?.localBaseUrl || DEFAULT_VOXD_URL).trim() || DEFAULT_VOXD_URL,
        localVoice: String(v.tts?.localVoice || ''),
        cloudBaseUrl: String(v.tts?.cloudBaseUrl || 'http://127.0.0.1:8767').trim() || 'http://127.0.0.1:8767',
        cloudVoice: String(v.tts?.cloudVoice || ''),
        onlineDesc: String(v.tts?.onlineDesc || DEFAULT_ONLINE_DESC),
        onlineLanguage: String(v.tts?.onlineLanguage || DEFAULT_ONLINE_LANGUAGE),
        doubaoApiKey: String(v.tts?.doubaoApiKey || '').trim(),
        doubaoResourceId: String(v.tts?.doubaoResourceId || 'seed-tts-2.0').trim(),
        doubaoAppId: String(v.tts?.doubaoAppId || '').trim(),
        doubaoToken: String(v.tts?.doubaoToken || '').trim(),
        doubaoVoice: String(v.tts?.doubaoVoice || DOUBAO_DEFAULT_VOICE),
        doubaoEncoding: ['mp3', 'wav', 'ogg_opus'].includes(String(v.tts?.doubaoEncoding)) ? String(v.tts.doubaoEncoding) : 'mp3',
        qwenApiKey: String(v.tts?.qwenApiKey || '').trim(),
        qwenVoice: String(v.tts?.qwenVoice || QWEN_DEFAULT_VOICE),
        qwenModel: String(v.tts?.qwenModel || QWEN_DEFAULT_MODEL),
        qwenLanguage: String(v.tts?.qwenLanguage || 'Auto'),
        deepseekApiKey: String(v.tts?.deepseekApiKey || '').trim(),
        deepseekVoice: String(v.tts?.deepseekVoice || DEEPSEEK_DEFAULT_VOICE),
        doubaoWebVoice: String(v.tts?.doubaoWebVoice || '').trim(),
        doubaoWebProfileDir: String(v.tts?.doubaoWebProfileDir || '').trim(),
        doubaoWebHeadless: v.tts?.doubaoWebHeadless !== false,
        ffmpegPath: process.env.FFMPEG_PATH || v.ffmpegPath || null,
        cacheVersion: Number(v.tts?.cacheVersion) || 0,
        dir: path.join(stateDir, 'voice-tts'),
      },
    };
  }

  // DeepSeek 语音 key 兜底：设置页没单独填 key 时复用联网搜索那把 DeepSeek key。
  // 只在发给合成器的局部副本上补，不回填 voiceCfg()，避免 key 泄进任何响应。
  function withDeepseekVoiceKey(tts, routeOverride = '') {
    const effective = String(routeOverride || tts?.route || '');
    if (effective === 'deepseek' && tts && !tts.deepseekApiKey) {
      return { ...tts, deepseekApiKey: resolveSearchApiKey(getConfig().webSearch).key };
    }
    return tts;
  }

  /** 语音失败留痕（JSONL）：失败时能判断是谁的锅。 */
  function logVoiceError(record) {
    try {
      const file = path.join(stateDir, 'voice-errors.log');
      fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...record }) + String.fromCharCode(10));
    } catch {}
  }

  /** 给错误补上 code/hint/stage，让上层接口能把「谁的锅」写清楚。 */
  function codedVoiceError(error, info = null) {
    const message = error?.message ?? String(error);
    const meta = info ?? classifyVoiceError(message);
    const err = error instanceof Error ? error : new Error(message);
    err.code = meta.code;
    err.stage = meta.stage;
    err.hint = meta.hint;
    return err;
  }

  /** text → 音频文件。AI 通道与操作者通道共用，抛出的错误已是可直接展示的句子。 */
  async function synthesizeVoiceText(text, { voice = '', character = '', route = '' } = {}) {
    const vc = voiceCfg();
    const say = String(text ?? '').trim();
    if (!say) throw codedVoiceError(new Error('要合成的内容是空的'));
    if (!vc.tts.enabled) {
      const err = new Error('语音合成未开启（socialV2.voice.tts.enabled）');
      err.code = 'voice.tts-disabled'; err.stage = 'config';
      err.hint = '去 设置 → dsh-Dfy → 桌宠 → 语音设置，打开「允许 AI 发语音条（总闸）」和「语音合成开关」';
      throw err;
    }
    if (say.length > vc.tts.maxChars) throw codedVoiceError(new Error(`要说的话最多 ${vc.tts.maxChars} 字（收到 ${say.length}）`));

    try {
      const result = await synthesizeByRoute({ text: say, voice: voice || character, route });
      return { path: result.path, via: 'tts', ttsCached: result.cached, ttsDurationMs: result.durationMs, route: result.route };
    } catch (error) {
      const info = classifyVoiceError(error?.message ?? error);
      logVoiceError({
        scope: 'synth', route: vc.tts.route, code: info.code, stage: info.stage,
        message: String(error?.message ?? error).slice(0, 400),
      });
      throw codedVoiceError(error, info);
    }
  }

  /** 按当前音源合成一段话（语音条、卡片朗读、试听共用）。 */
  async function synthesizeByRoute({ text, voice = '', rate = '+0%', pitch = '+0Hz', timeoutMs, route: routeOverride = '', allowFallback = true } = {}) {
    const vc = voiceCfg();
    return synthesizeToFileByRoute({
      text,
      voice,
      rate,
      pitch,
      route: routeOverride,
      tts: withDeepseekVoiceKey({ ...vc.tts, dir: vc.tts.dir }, routeOverride),
      timeoutMs,
      allowFallback,
    });
  }

  function voiceLibrary() {
    const dir = voiceCfg().dir;
    const files = listAudioFiles(dir);
    return files.map((f) => {
      let stat = null;
      try { stat = fs.statSync(f); } catch {}
      return { name: path.relative(dir, f).split(path.sep).join('/'), bytes: stat?.size ?? 0, mtimeMs: stat?.mtimeMs ?? 0 };
    });
  }

  /**
   * 把「AI 给的语音引用」解析成可发送的本地绝对路径。
   *
   * 安全边界：AI 只能从语音库目录里取文件（防 prompt injection 拿任意本地文件当语音外发）。
   * 即使 socialV2.voice.allowAbsolutePath=true，也要求绝对路径必须落在语音库目录之内。
   */
  function voicePathInsideLibrary(vc, absPath) {
    const rel = path.relative(vc.dir, absPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return null;
    return safeJoinLibrary(vc.dir, rel);
  }

  function resolveVoicePathForV2(input) {
    const vc = voiceCfg();
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('缺少音频：给语音库里的文件名（可用 qq_list_voices 查看）');
    if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
      throw new Error('语音只接受语音库里的本地文件；不接受 base64://、data: 或 http(s):// 来源');
    }
    const isAbs = path.isAbsolute(raw) || /^file:\/\//i.test(raw) || raw.startsWith('~');

    let resolved = null;
    if (isAbs) {
      const r = resolveAudioSource(raw, {});
      const confined = r.path ? voicePathInsideLibrary(vc, r.path) : null;
      if (confined) {
        resolved = { path: confined, via: `${r.via}+library-confined` };
      } else {
        // 只报目录名，不报绝对路径：这条消息会经 MCP 工具错误回给模型。
        throw new Error(`语音只能从语音库取文件（语音库目录：${path.basename(vc.dir)}）；即使是绝对路径也必须位于语音库之内（socialV2.voice.allowAbsolutePath 已不再放宽 AI 通道）。请把音频放进语音库，或用操作者通道（CLI / 控制台）发送库外文件。`);
      }
    } else {
      // 安全关键：相对路径只能在语音库内解析，一律先过 safeJoinLibrary（含 realpath 复核）。
      const joined = safeJoinLibrary(vc.dir, raw);
      if (joined && fs.existsSync(joined) && fs.statSync(joined).isFile()) {
        resolved = { path: joined, via: 'voice-dir-safe' };
      } else {
        if (!path.extname(raw)) {
          for (const ext of AUDIO_EXTS) {
            const cand = safeJoinLibrary(vc.dir, `${raw}${ext}`);
            if (cand && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
              resolved = { path: cand, via: 'voice-dir-safe+ext' };
              break;
            }
          }
        }
        if (!resolved) {
          const looksLikeEscape = /(^|[\\/])\.\.([\\/]|$)/.test(raw) || path.isAbsolute(raw);
          if (looksLikeEscape) {
            throw new Error('语音只能从语音库取文件：路径里出现了「..」或绝对路径，已拒绝（防止读到库外的本机文件）');
          }
        }
      }
    }

    if (resolved) return { path: resolved.path, via: resolved.via, resolvedFrom: raw };

    const library = voiceLibrary();
    const hint = library.length
      ? `语音库里现有：${library.slice(0, 12).map((x) => x.name).join('、')}${library.length > 12 ? ` 等 ${library.length} 个` : ''}`
      : `语音库（${path.basename(vc.dir)}）目前是空的，先把音频文件放进去`;
    const want = path.basename(raw).toLowerCase();
    const wantNoExt = want.replace(/\.[^.]+$/, '');
    const fuzzyHits = library
      .filter((x) => {
        const base = path.basename(x.name).toLowerCase();
        return base === want || base.replace(/\.[^.]+$/, '') === wantNoExt;
      })
      .map((x) => x.name);
    const fuzzy = fuzzyHits.length ? `；近似匹配：${fuzzyHits.join('、')}` : '';
    throw new Error(`语音库里找不到「${raw}」${fuzzy}。${hint}`);
  }

  /** 操作者通道（CLI）的路径解析：允许绝对路径，相对路径先按语音库再按 cwd。 */
  function resolveVoicePathForOperator(input) {
    const vc = voiceCfg();
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('缺少音频路径');
    if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
      throw new Error('语音只接受本地文件；不接受 base64://、data: 或 http(s):// 来源');
    }
    const r = resolveAudioSource(raw, { voiceDir: vc.dir });
    if (r.path) return { path: r.path, via: r.via, resolvedFrom: raw };
    const fuzzy = r.candidates?.length ? `；语音库近似匹配：${r.candidates.map((c) => path.basename(c.path)).join('、')}` : '';
    throw new Error(`找不到音频「${raw}」${fuzzy}`);
  }

  /**
   * 出站语音的内容审计：凡是「疑似敏感信息 / 含会话令牌」的文件名都不允许外发。
   */
  function assertOutboundAuditOk(key, subject) {
    const text = String(subject ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && text.includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 语音发送被安全策略拦截 (${key})：${hasKnownToken ? '文件名含会话令牌' : '文件名疑似含敏感信息'}`);
      appendActivity(`${key} [voice] 发送被拦截（文件名疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      throw new Error('音频文件名疑似包含敏感信息（路径/凭据/会话令牌），已阻止发送；请重命名后再发');
    }
  }

  /**
   * 语音触发规则（谁能让她出声）。
   *
   * 群聊：只要主人在最近 10 分钟内开过口就放行；别人说话/发表情/转发不会取消授权。
   * 一条主人消息最多换一条语音：发过之后要等主人再说一句。
   */
  function voiceTriggerBlock(key, kind, id) {
    const cfgVoice = voiceCfg();
    const cfg = getConfig();
    const who = cfgVoice.trigger.who;
    if (who === 'anyone') return null;

    const owner = String(cfg.ownerQQ ?? '');
    if (kind === 'private') {
      if (who === 'owner' && String(id) !== owner) return '仅主人可触发语音（当前私聊对象不是主人）';
      if (who === 'list' && !cfgVoice.trigger.members.includes(String(id)) && String(id) !== owner) {
        return '该成员不在语音触发名单里';
      }
      return null;
    }

    const ownerAt = Number(voiceOwnerAt.get(String(key)) ?? 0);
    if (!ownerAt) return '仅主人可触发语音（这个群还没有主人发言记录）';
    const WINDOW = 10 * 60 * 1000;
    if (Date.now() - ownerAt > WINDOW) {
      return '最近 10 分钟主人都没说话，不能主动发语音';
    }
    if ((voiceLastSentAt.get(String(key)) ?? 0) >= ownerAt) {
      return '这条消息已经发过语音了，等主人再说一句';
    }
    if (who === 'list') {
      const last = voiceLastSpeaker.get(String(key)) ?? {};
      const ok = last.isOwner === true || cfgVoice.trigger.members.includes(String(last.userId));
      if (!ok) return '该成员不在语音触发名单里';
    }
    return null;
  }

  /**
   * 语音发送限流：与文本发送分开计数。
   * 只检查不占额度，额度在真正发出去之后才由 budgetCommit 记账。
   */
  function voiceBudgetCheck(scopeKey, cfgV = voiceCfg()) {
    const now = Date.now();
    const bucket = voiceSendTimes.get(scopeKey) ?? [];
    const inMinute = bucket.filter((t) => now - t < 60000);
    const inHour = bucket.filter((t) => now - t < 3600000);
    const limited = (per, n) => {
      const err = new Error(`语音发送频率超限（每${per}最多 ${n} 条），请稍后再试`);
      err.code = 'voice.rate-limited';
      err.stage = 'send';
      err.hint = '这是发送限流，不是 TTS 故障：等一会儿再发，或调大 socialV2.voice.maxPerMinute / maxPerHour';
      return err;
    };
    if (cfgV.maxPerMinute > 0 && inMinute.length + 1 > cfgV.maxPerMinute) throw limited('分钟', cfgV.maxPerMinute);
    if (cfgV.maxPerHour > 0 && inHour.length + 1 > cfgV.maxPerHour) throw limited('小时', cfgV.maxPerHour);
  }

  /** 语音真正发出后记账（顺带裁掉超过 1 小时的旧时间戳）。 */
  function voiceBudgetCommit(scopeKey, at = Date.now()) {
    const bucket = (voiceSendTimes.get(scopeKey) ?? []).filter((t) => at - t < 3600000);
    bucket.push(at);
    voiceSendTimes.set(scopeKey, bucket);
  }

  /**
   * 底层发送：把音频作为 record 段交给 SnowLuma。
   * guard=true（AI 通道）时，发送前必须通过 captureSendGuard；操作者通道不套会话闸门。
   */
  async function sendVoiceV2(key, filePath, { guard = false, audit = true, audio = null } = {}) {
    const cfg = getConfig();
    const vc = voiceCfg();
    if (audit) assertOutboundAuditOk(key, `[语音:${path.basename(filePath)}]`);
    let info;
    try {
      info = await inspectAudio(filePath, { maxBytes: vc.maxBytes, maxSeconds: vc.maxSeconds });
    } catch (error) {
      throw new Error(`音频检查失败：${error?.message ?? error}`);
    }
    if (!info.ok) throw new Error(`音频不可发送：${info.error}`);

    let processed;
    try {
      processed = await processAudioVolume(filePath, {
        volume: audio?.volume ?? vc.defaultVolume,
        normalize: audio?.normalize === true,
        loudness: audio?.loudness ?? vc.loudness,
        ffmpegPath: vc.ffmpegPath,
      });
    } catch (error) {
      throw new Error(`音量处理失败：${error?.message ?? error}`);
    }
    const sendPath = processed.path;

    const assertSendAllowed = guard ? captureSendGuard(key) : null;
    const [kind, id] = key.split(':');
    const recordSegment = { type: 'record', data: { file: sendPath } };
    let resolveSend;
    let rejectSend;
    const sendPromise = new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; });
    enqueueSend(async () => {
      try {
        if (assertSendAllowed) assertSendAllowed();
        // 语音条要过一次 SILK 转码，给 60s 预算；与文本共用发送队列，不会插队。
        const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
        const params = kind === 'private'
          ? { user_id: Number(id), message: [recordSegment] }
          : { group_id: Number(id), message: [recordSegment] };
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}),
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(60000),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        resolveSend(body.data);
      } catch (error) {
        rejectSend(error);
      }
    });
    try {
      const data = await sendPromise;
      return {
        messageId: data?.message_id ?? null,
        bytes: info.size,
        duration: info.duration ?? null,
        codec: info.codec ?? '',
        warnings: info.warnings ?? [],
        detail: describeAudio(info),
        audioProcessing: processed.detail,
        volume: processed.volume,
        loudness: processed.loudness,
        audioMode: processed.mode,
      };
    } finally {
      cleanupTemp(sendPath, processed.converted);
    }
  }

  /** 把「我发了条语音」写进二代会话的 recentMessages，让 AI 自己知道刚发过什么。 */
  function recordVoiceSentV2(key, sent, label) {
    const st = getSocialV2State(key);
    const display = label || `[语音 ${sent.detail}]`;
    const entry = {
      messageId: sent.messageId ? String(sent.messageId) : null,
      sender: '我',
      text: truncateText(display, 200),
      plain: truncateText(display, 200),
      quoteTargetIsSelf: false,
      isOwner: true,
      ownerLabel: '我',
      isSelf: true,
      at: Date.now(),
    };
    st.recentMessages.push(entry);
    if (st.recentMessages.length > 200) st.recentMessages = st.recentMessages.slice(-200);
    st.lastAiReplyAt = entry.at;
    st.lastActionAt = entry.at;
    st.wakeConfig.noActionCount = 0;
    saveSocialV2State();
  }

  /**
   * 发完语音后的落地验证：把消息从网关读回来，确认它真的带着 record 段。
   * 只回报「确认成功 + 时长」，不回传 file/url（避免本机路径进模型上下文）。
   */
  async function verifyVoiceMessageSent(messageId) {
    if (!messageId) return null;
    const cfg = getConfig();
    try {
      const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
      const res = await fetch(`${httpUrl}/get_msg`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}),
        },
        body: JSON.stringify({ message_id: Number(messageId) }),
        signal: AbortSignal.timeout(30000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok' || body.retcode !== 0) return null;
      const segments = Array.isArray(body.data?.message) ? body.data.message : [];
      const record = segments.find((s) => s?.type === 'record');
      if (!record) return null;
      return {
        confirmed: true,
        duration: record.data?.duration != null ? Number(record.data.duration) : null,
      };
    } catch (error) {
      log(`[voice] 发送后回读校验失败（不影响已发送）：${error?.message ?? error}`);
      return null;
    }
  }

  /** 读回语音转写（实验用；自己发的语音通常没有转写）。 */
  async function fetchVoiceTranscript(messageId) {
    if (!messageId) return null;
    const cfg = getConfig();
    try {
      const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
      const res = await fetch(`${httpUrl}/fetch_ptt_text`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}),
        },
        body: JSON.stringify({ message_id: String(messageId) }),
        signal: AbortSignal.timeout(30000),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.status === 'ok' && body.retcode === 0) return body.data?.text ?? '';
    } catch (error) {
      log(`[voice] 语音转写回读失败（不影响已发送）：${error?.message ?? error}`);
    }
    return null;
  }

  /** AI 通道入口：解析引用 → 限流 → 发送 → 记账 → 回读校验。 */
  async function sendVoiceForV2(key, voiceRef, { label = '', verify = null, readback = false, audio = null, resolved = null } = {}) {
    const vc = voiceCfg();
    if (!vc.enabled) throw new Error('语音功能已关闭（socialV2.voice.enabled=false）');
    const target = resolved ?? resolveVoicePathForV2(voiceRef);
    if (audio) resolveAudioProcessing({ volume: audio.volume ?? vc.defaultVolume, normalize: audio.normalize === true, loudness: audio.loudness ?? vc.loudness });
    voiceBudgetCheck(key, vc);
    const sent = await sendVoiceV2(key, target.path, { guard: true, audit: true, audio });
    voiceBudgetCommit(key);
    recordVoiceSentV2(key, sent, label);
    log(`[voice] ${key} 已发送语音 ${path.basename(target.path)} (${sent.detail}, messageId=${sent.messageId ?? '?'})`);
    appendActivity(`${key} [voice] 发送语音 ${path.basename(target.path)} (${sent.detail})`);
    const readbackText = readback === true ? await fetchVoiceTranscript(sent.messageId) : null;
    const wantVerify = verify === true || (verify !== false && vc.autoReadback);
    const verification = wantVerify ? await verifyVoiceMessageSent(sent.messageId) : null;
    return { ...sent, key, file: target.path, via: target.via, verification, readback: readbackText };
  }

  function noteSpeaker(key, { userId = '', isOwner = false, at = Date.now() } = {}) {
    voiceLastSpeaker.set(String(key), { userId: String(userId), isOwner: isOwner === true, at });
    if (isOwner === true) voiceOwnerAt.set(String(key), at);
  }

  // ── 路由 ────────────────────────────────────────────────────────────────
  const routes = [
    {
      method: 'POST',
      path: '/api/voice/tts-check',
      async handle(ctx, { sendJson }) {
        // 语音自检：只剩 Edge 在线端点（无本地服务可探活），所以从「真实合成」开始。
        const route = 'edge';
        const stages = [{ name: 'service', ok: true, ms: 0, detail: 'Edge 在线端点（无需本地服务）' }];
        {
          const t0 = Date.now();
          try {
            const r = await synthesizeVoiceText('语音自检');
            stages.push({
              name: 'synth', ok: true, ms: Date.now() - t0,
              detail: `route=${r.route} · ${r.ttsCached ? '缓存' : '实时合成'} · ${Math.round((r.ttsDurationMs || 0))}ms`,
            });
          } catch (error) {
            const info = classifyVoiceError(error?.message ?? error);
            stages.push({ name: 'synth', ok: false, ms: Date.now() - t0, code: info.code, hint: info.hint, detail: String(error?.message ?? error).slice(0, 220) });
          }
        }
        {
          const cfg = getConfig();
          const v = voiceCfg();
          const toolOn = Boolean(v?.enabled) && cfg.socialV2?.tools?.sendVoice !== false;
          const bucket = voiceSendTimes.get('selftest') ?? [];
          const now = Date.now();
          const perMin = bucket.filter((t) => now - t < 60000).length;
          const perHour = bucket.filter((t) => now - t < 3600000).length;
          stages.push({
            name: 'send', ok: toolOn && v.enabled,
            detail: `${v.enabled ? '语音可用' : '语音总闸已关'} · 工具${cfg.socialV2?.tools?.sendVoice === false ? '关' : '开'} · 本分钟已发 ${perMin}/${v.maxPerMinute} · 本小时 ${perHour}/${v.maxPerHour}`,
            code: toolOn && v.enabled ? '' : 'voice.tool-disabled',
            hint: toolOn && v.enabled ? '' : '去 设置 → dsh-Dfy → 桌宠 → 语音设置：打开总闸与「语音合成开关」',
          });
        }
        sendJson({ ok: stages.every((x) => x.ok), route, stages });
      },
    },
    {
      method: 'GET',
      path: '/api/voice/doubao-web/status',
      async handle(ctx, { sendJson }) {
        const v = voiceCfg();
        const status = await doubaoWebStatus({
          profileDir: v.tts.doubaoWebProfileDir,
          headless: v.tts.doubaoWebHeadless,
        });
        sendJson(status);
      },
    },
    {
      method: 'POST',
      path: '/api/voice/doubao-web/login',
      async handle(ctx, { sendJson }) {
        const v = voiceCfg();
        try {
          const r = await openDoubaoWebLogin({
            profileDir: v.tts.doubaoWebProfileDir,
            timeoutMs: 4 * 60 * 1000,
          });
          sendJson({ ok: true, uid: r?.uid || '' });
        } catch (error) {
          sendJson({ ok: false, error: String(error?.message ?? error).slice(0, 300) });
        }
      },
    },
    {
      method: 'GET',
      path: '/api/voice/doubao-web/voices',
      async handle(ctx, { sendJson }) {
        const v = voiceCfg();
        try {
          sendJson(await listDoubaoWebVoices({
            profileDir: v.tts.doubaoWebProfileDir,
            headless: v.tts.doubaoWebHeadless,
          }));
        } catch (error) {
          sendJson({ ok: false, error: String(error?.message ?? error).slice(0, 300) });
        }
      },
    },
    {
      method: 'POST',
      path: '/api/voice/doubao-web/voice',
      async handle(ctx, { readBody, sendJson }) {
        const v = voiceCfg();
        const body = await readBody().catch(() => ({}));
        const name = String(body?.name ?? '').trim();
        try {
          const r = await selectDoubaoWebVoice({
            name,
            profileDir: v.tts.doubaoWebProfileDir,
            headless: v.tts.doubaoWebHeadless,
          });
          // 只改浏览器不改内存 cfg 的话，下一次合成又会按旧配置切回去（表现为「改了不生效」）。
          const cfg = getConfig();
          cfg.socialV2 = cfg.socialV2 && typeof cfg.socialV2 === 'object' ? cfg.socialV2 : {};
          cfg.socialV2.voice = cfg.socialV2.voice && typeof cfg.socialV2.voice === 'object' ? cfg.socialV2.voice : {};
          cfg.socialV2.voice.tts = cfg.socialV2.voice.tts && typeof cfg.socialV2.voice.tts === 'object' ? cfg.socialV2.voice.tts : {};
          cfg.socialV2.voice.tts.doubaoWebVoice = name;
          sendJson({ ...r, name });
        } catch (error) {
          sendJson({ ok: false, error: String(error?.message ?? error).slice(0, 300) });
        }
      },
    },
    {
      method: 'GET',
      path: '/api/voice/preview',
      async handle(ctx, { res, url, sendJson }) {
        const vc = voiceCfg();
        const voice = String(url.searchParams.get('voice') || '');
        const routeParam = String(url.searchParams.get('route') || '');
        const rate = String(url.searchParams.get('rate') || '+0%');
        const pitch = String(url.searchParams.get('pitch') || '+0Hz');
        const text = String(url.searchParams.get('text') || '').trim() || '你好，我是现在这个音色。';
        if (text.length > 200) { sendJson({ ok: false, error: '试听文本最多 200 字' }, 400); return; }
        try {
          const out = await synthesizeByRoute({
            text,
            voice,
            rate,
            pitch,
            route: routeParam,
            allowFallback: false,
            timeoutMs: (routeParam || vc.tts.route) === 'doubao-web'
              // 豆包网页要等模型复读 + 朗读合成，30 秒不够；这条链路慢是设计代价。
              ? Math.max(Number(vc.tts.timeoutMs) || 60000, 90000)
              : Math.min(Number(vc.tts.timeoutMs) || 60000, 30000),
          });
          const buf = fs.readFileSync(out.path);
          res.writeHead(200, {
            'content-type': out.contentType || 'audio/mpeg',
            'content-length': String(buf.length),
            'cache-control': 'no-store',
            'x-route': out.route,
          });
          res.end(buf);
        } catch (error) {
          const route = routeParam || vc.tts.route;
          sendJson({
            ok: false,
            error: `试听合成失败：${error?.message ?? error}`,
            hint: route === 'local'
              ? '本地语音服务（8765）没起来，或音色名不存在'
              : (route === 'cloud'
                ? '云端声音复刻服务（8767）没起来，或音色名不存在'
                : (route === 'online'
                  ? '免费在线模型偶尔排队或失败，重试一次；需要联网'
                  : (route === 'doubao'
                    ? '检查豆包 AppID / Access Token 是否填对，音色 voice_type 是否已开通'
                    : (route === 'qwen'
                      ? '检查百炼 API Key 是否有效、免费额度是否用完'
                      : (route === 'deepseek'
                        ? '检查 DeepSeek API Key（留空则自动复用联网搜索的 Key）和账户余额'
                        : (route === 'doubao-web'
                          ? '豆包网页音源失败已自动回落 Edge：检查登录态（node scripts/doubao-web-login.mjs）、ffmpeg 是否可用'
                          : '需要联网；微软 Edge 端点偶尔超时，重试一次即可')))))),
          }, 502);
        }
      },
    },
    {
      method: '*',
      path: '/api/voice/rules',
      async handle(ctx, { req, readBody, sendJson }) {
        try {
          if (req.method === 'GET') {
            const c = readConfigObject(configFile);
            const v = c.socialV2?.voice || {};
            sendJson({
              ok: true,
              triggerWho: v.trigger?.who || 'owner',
              maxPerMinute: v.maxPerMinute ?? 2,
              maxPerHour: v.maxPerHour ?? 10,
              aiEnabled: v.tts?.enabled === true,
              route: 'edge',
            });
            return;
          }
          if (req.method === 'POST') {
            const body = await readBody();
            const c = readConfigObject(configFile);
            c.socialV2 = c.socialV2 || {};
            c.socialV2.voice = c.socialV2.voice || {};
            const v = c.socialV2.voice;
            const who = ['owner', 'anyone', 'list'].includes(String(body.triggerWho)) ? String(body.triggerWho) : 'owner';
            v.trigger = { ...(v.trigger || {}), who };
            if (Number.isFinite(Number(body.maxPerMinute))) v.maxPerMinute = Math.max(1, Math.min(60, Number(body.maxPerMinute)));
            if (Number.isFinite(Number(body.maxPerHour))) v.maxPerHour = Math.max(1, Math.min(600, Number(body.maxPerHour)));
            v.tts = v.tts || {};
            v.tts.enabled = body.aiEnabled === true;
            atomicWriteJson(configFile, c);
            sendJson({ ok: true });
            return;
          }
          sendJson({ ok: false, error: '方法不允许' }, 405);
        } catch (e) {
          sendJson({ ok: false, error: String(e?.message || e) }, 500);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/voice/send',
      handle: operatorSend,
    },
    {
      method: 'POST',
      path: '/api/send/voice',
      handle: operatorSend,
    },
  ];

  /**
   * 操作者通道（CLI / 控制台 / 图形界面）：由控制台令牌鉴权。
   * socialV2.voice.enabled 是「AI 能不能发语音」的总闸，不该连手动试发一起关掉。
   * /api/send/voice 带 agent token 时一律拒绝，避免 AI 借操作者通道绕过会话限制。
   */
  async function operatorSend(ctx, { req, url, readBody, sendJson }) {
    const cfg = getConfig();
    const body = await readBody();
    const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
    const voice = voiceCfg();
    if (url.pathname === '/api/send/voice' && agentToken) {
      sendJson({
        ok: false,
        error: 'AI 请改用 /api/socialV2/send-voice（带 key + token）',
      }, 403);
      return;
    }
    const key = String(body.target ?? body.key ?? '').trim();
    const parsedTarget = parseTargetKey(key);
    if (!parsedTarget) { sendJson({ ok: false, error: 'target 格式应为 group:群号 或 private:QQ号' }, 400); return; }
    if (!modeAllowed(key, parsedTarget.kind, Number(parsedTarget.id), cfg, getMode())) {
      const a = cfg.allow ?? {};
      sendJson({
        ok: false,
        error: `目标 ${key} 不在白名单内（config.json allow.groups / allow.private：群 ${(a.groups ?? []).join(', ') || '空'}；私聊 ${(a.private ?? []).join(', ') || '空'}）`,
      }, 403);
      return;
    }
    const opText = String(body.text ?? '').trim();
    let resolved;
    try {
      resolved = opText
        ? await synthesizeVoiceText(opText, {
          character: body.character ? String(body.character) : '',
          voice: body.voice ? String(body.voice) : '',
          route: body.route ? String(body.route) : '',
        })
        : resolveVoicePathForOperator(body.file ?? body.path ?? '');
    } catch (error) {
      const msg = error?.message ?? String(error);
      sendJson({ ok: false, code: error?.code || '', hint: error?.hint || '', error: msg }, /语音合成|TTS|voice\./.test(msg) ? 502 : 400);
      return;
    }
    // 音量参数先校验（写错了当场告诉你，不要等到发的时候才炸）
    try {
      resolveAudioProcessing({
        volume: body.volume ?? voice.defaultVolume,
        normalize: body.normalize === true,
        loudness: body.loudness ?? voice.loudness,
      });
    } catch (error) {
      sendJson({ ok: false, error: error.message }, 400);
      return;
    }
    const probe = await inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
    if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return; }
    const preview = {
      key,
      file: resolved.path,
      via: resolved.via,
      bytes: probe.size,
      duration: probe.duration,
      codec: probe.codec,
      detail: describeAudio(probe),
      warnings: probe.warnings ?? [],
      limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour },
    };
    if (body.dryRun === true) { sendJson({ ok: true, dryRun: true, ...preview }); return; }
    const now = Date.now();
    try {
      voiceBudgetCheck('operator:cli', voice);
      const sent = await sendVoiceV2(key, resolved.path, {
        guard: false,
        audit: true,
        audio: {
          volume: body.volume ?? voice.defaultVolume,
          normalize: body.normalize === true,
          loudness: body.loudness ?? voice.loudness,
        },
      });
      voiceBudgetCommit('operator:cli', now);
      log(`[voice] (操作者) ${key} 已发送语音 ${path.basename(resolved.path)} (${sent.detail}${sent.audioMode === 'original' ? '' : '，' + sent.audioProcessing}, messageId=${sent.messageId ?? '?'})`);
      appendActivity(`${key} [voice] (操作者) 发送语音 ${path.basename(resolved.path)} (${sent.detail})`);
      const verification = body.verify === false ? null : await verifyVoiceMessageSent(sent.messageId);
      const readbackText = body.readback === true ? await fetchVoiceTranscript(sent.messageId) : null;
      sendJson({
        ok: true,
        ...preview,
        messageId: sent.messageId,
        verified: verification?.confirmed === true,
        readback: readbackText,
        audioProcessing: sent.audioProcessing,
        volume: sent.volume,
        loudness: sent.loudness,
      });
    } catch (error) {
      sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
    }
  }

  return defineComponent({
    id: 'voice',
    routes,
    init() {
      return {
        cfg: voiceCfg,
        listLibrary: voiceLibrary,
        resolvePathForV2: resolveVoicePathForV2,
        resolvePathForOperator: resolveVoicePathForOperator,
        synthesizeText: synthesizeVoiceText,
        synthesizeByRoute,
        triggerBlock: voiceTriggerBlock,
        budgetCheck: voiceBudgetCheck,
        budgetCommit: voiceBudgetCommit,
        sendForV2: sendVoiceForV2,
        verify: verifyVoiceMessageSent,
        markSent: (key, at = Date.now()) => voiceLastSentAt.set(String(key), at),
        lastSentAt: (key) => voiceLastSentAt.get(String(key)) ?? 0,
        noteSpeaker,
      };
    },
  });
}
