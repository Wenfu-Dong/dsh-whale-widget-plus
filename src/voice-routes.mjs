/**
 * 语音合成「八音源」唯一实现。
 *
 * 以前 src/bridge.js（QQ 语音条 / 设置页试听）和 backend/lib/pet-chat.js（桌宠朗读 /
 * 消息卡片朗读）各自抄了一份多路 if-else，已经漂移：错误分类、超时口径、音色回退
 * 都不一致 → 用户切换音源后「时好时坏」。这里收敛成一份，两边都只传配置进来。
 *
 * 输入 tts 的形状（两份配置都已对齐）：{ route, timeoutMs, cacheVersion, dir,
 *   edgeVoice, localBaseUrl, localVoice, cloudBaseUrl, cloudVoice,
 *   onlineDesc, onlineLanguage, doubaoApiKey, doubaoResourceId, doubaoAppId,
 *   doubaoToken, doubaoVoice, doubaoEncoding, qwenApiKey, qwenVoice, qwenModel, qwenLanguage,
 *   deepseekApiKey, deepseekVoice, doubaoWebVoice, doubaoWebProfileDir, doubaoWebHeadless }
 *
 * 返回 { path, route, contentType, durationMs, format, cached? }。
 */
import { synthesizeEdgeToFile, DEFAULT_EDGE_VOICE } from './voice-edge-tts.js';
import { synthesizeToFile as synthesizeVoxdToFile } from './voice-tts.js';
import { synthesizeOnlineToFile, DEFAULT_ONLINE_DESC, DEFAULT_ONLINE_LANGUAGE } from './voice-online-tts.js';
import { synthesizeDoubaoToFile } from './voice-doubao-tts.js';
import { synthesizeQwenToFile } from './voice-qwen-tts.js';
import { synthesizeDeepseekToFile, DEEPSEEK_DEFAULT_VOICE } from './voice-deepseek-tts.js';
import { synthesizeDoubaoWebToFile } from './voice-doubao-web.js';

export const VOICE_ROUTES = ['edge', 'local', 'cloud', 'online', 'doubao', 'qwen', 'deepseek', 'doubao-web'];

// 无效 route 一次性告警：显式配置被无痕降级成 edge 是"换音色不生效/声音时好时坏"
// 的另一种形态（2026-11-14 体检），至少要在日志里留个痕。
const warnedRoutes = new Set();

export function normalizeVoiceRoute(route) {
  const value = String(route);
  if (VOICE_ROUTES.includes(value)) return value;
  if (value && !warnedRoutes.has(value)) {
    warnedRoutes.add(value);
    console.warn(`[voice] 未知的音源 route「${value}」，已按 edge 处理（可选值：${VOICE_ROUTES.join(', ')}）`);
  }
  return 'edge';
}

export async function synthesizeToFileByRoute({
  text,
  voice = '',
  rate = '+0%',
  pitch = '+0Hz',
  route = '',
  tts = {},
  timeoutMs,
  outDir,
  // 试听传 false：试听要如实暴露失败，别让用户以为「豆包音色生效了」；
  // 正式发语音条保持 true：私有链路挂掉也必须能出声。
  allowFallback = true,
} = {}) {
  const effective = normalizeVoiceRoute(route || tts.route);
  const timeout = Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : (Number(tts.timeoutMs) > 0 ? Number(tts.timeoutMs) : 60000);
  const cacheVersion = tts.cacheVersion ?? null;
  const dir = outDir ?? tts.dir;
  const base = { route: effective, cacheVersion, outDir: dir };

  if (effective === 'doubao') {
    const r = await synthesizeDoubaoToFile({
      text,
      apiKey: tts.doubaoApiKey,
      resourceId: tts.doubaoResourceId,
      appId: tts.doubaoAppId,
      accessToken: tts.doubaoToken,
      voice: voice || tts.doubaoVoice,
      encoding: tts.doubaoEncoding,
      timeoutMs: timeout,
      ...base,
    });
    return {
      path: r.path,
      cached: r.cached,
      durationMs: r.durationMs,
      route: effective,
      format: r.format,
      contentType: r.format === 'ogg_opus' ? 'audio/ogg' : (r.format === 'wav' ? 'audio/wav' : 'audio/mpeg'),
    };
  }

  if (effective === 'qwen') {
    const r = await synthesizeQwenToFile({
      text,
      apiKey: tts.qwenApiKey,
      voice: voice || tts.qwenVoice,
      model: tts.qwenModel,
      language: tts.qwenLanguage,
      timeoutMs: timeout,
      ...base,
    });
    return { path: r.path, cached: r.cached, durationMs: r.durationMs, route: effective, format: 'wav', contentType: 'audio/wav' };
  }

  if (effective === 'online') {
    // 免费在线模型：不需要音色 id，声音由「声音描述」决定。队列慢，最低给 120s。
    const r = await synthesizeOnlineToFile({
      text,
      description: tts.onlineDesc || DEFAULT_ONLINE_DESC,
      language: tts.onlineLanguage || DEFAULT_ONLINE_LANGUAGE,
      timeoutMs: Math.max(timeout, 120000),
      ...base,
    });
    return { path: r.path, cached: r.cached, durationMs: 0, route: 'online', format: 'wav', contentType: 'audio/wav' };
  }

  if (effective === 'deepseek') {
    const r = await synthesizeDeepseekToFile({
      text,
      apiKey: tts.deepseekApiKey,
      voice: voice || tts.deepseekVoice,
      // requestImpl 仅测试注入用；生产不传，走默认 node:https 直连
      requestImpl: tts.requestImpl,
      timeoutMs: timeout,
      ...base,
    });
    return { path: r.path, cached: r.cached, durationMs: r.durationMs, route: effective, format: 'wav', contentType: 'audio/wav' };
  }

  if (effective === 'doubao-web') {
    // 豆包网页版朗读：音色最全，但每次要开浏览器让豆包复读一遍（8~20 秒），
    // 依赖登录态与页面结构。失败**必须**回落 Edge —— 一个私有链路挂掉不能连带
    // 整条 QQ 语音不可用（用户明确要求）。
    try {
      const r = await synthesizeDoubaoWebToFile({
        text,
        // 留空 = 跟随豆包网页里当前选的音色（在网页换音色后自动生效，不用在这里填名字）。
        voice: tts.doubaoWebVoice || '',
        timeoutMs: Math.max(timeout, 60000),
        profileDir: tts.doubaoWebProfileDir || '',
        headless: tts.doubaoWebHeadless !== false,
        ffmpegPath: tts.ffmpegPath || null,
        ...base,
      });
      return { path: r.path, cached: r.cached, durationMs: r.durationMs, route: effective, format: 'mp3', contentType: 'audio/mpeg' };
    } catch (error) {
      if (allowFallback === false) throw error;
      const reason = String(error?.message ?? error);
      console.warn(`[voice] 豆包网页音源失败，回落到 edge：${reason}`);
      const r = await synthesizeEdgeToFile({
        text,
        voice: tts.edgeVoice || DEFAULT_EDGE_VOICE,
        rate,
        pitch,
        timeoutMs: Math.min(timeout, 30000),
        ...base,
      });
      return {
        path: r.path,
        cached: r.cached,
        durationMs: r.durationMs,
        route: 'edge',
        format: 'mp3',
        contentType: 'audio/mpeg',
        fallbackFrom: effective,
        fallbackReason: reason.slice(0, 200),
      };
    }
  }

  if (effective === 'local' || effective === 'cloud') {
    const baseUrl = effective === 'local' ? tts.localBaseUrl : tts.cloudBaseUrl;
    const character = String(
      voice
      || (effective === 'local' ? tts.localVoice : tts.cloudVoice)
      || tts.character
      || ''
    ).trim();
    const r = await synthesizeVoxdToFile({
      text,
      character,
      voice: character,
      baseUrl,
      timeoutMs: timeout,
      ...base,
    });
    return { path: r.path, cached: r.cached, durationMs: r.durationMs, route: effective, format: 'wav', contentType: 'audio/wav' };
  }

  const r = await synthesizeEdgeToFile({
    text,
    voice: voice || tts.edgeVoice || DEFAULT_EDGE_VOICE,
    rate,
    pitch,
    timeoutMs: timeout,
    ...base,
  });
  return { path: r.path, cached: r.cached, durationMs: r.durationMs, route: 'edge', format: 'mp3', contentType: 'audio/mpeg' };
}
