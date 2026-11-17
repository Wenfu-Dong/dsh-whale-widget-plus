/**
 * 表情库（组件化迁移 #2）。
 *
 * 从 src/bridge.js 的 main() 里整块搬出：
 *   - 库状态（entries / 可写降级 / 同步时间戳 / 强制刷新节流）
 *   - 与 QQ 收藏表情的同步与合并
 *   - 本地认知标注（note / remark / 使用统计）
 *   - 情绪—表情推荐（rank）
 *   - 控制台管理接口 /api/stickers*
 *
 * 会话侧（reserved2 的 sticker-* 工具）仍留在 bridge：那层要做 agent token、
 * 会话白名单、工具开关校验，属于协议层，不该塞进库里。它只调用本组件导出的方法。
 */
import { defineComponent } from '../core/registry.js';
import {
  applyStickerNote,
  buildStickerContext,
  buildStickerStrategyHint,
  findSticker,
  formatStickerList,
  loadStickerStore,
  markStickerUsed,
  mergeStickerLibrary,
  saveStickerStore,
} from '../../sticker-lib.js';
import { buildStickerMatchHint, detectEmotions, ensureStickerIndex, rankStickers } from '../../sticker-semantics.js';

/**
 * @param {object} deps
 * @param {string} deps.stateFile      sticker-store.json 路径
 * @param {Function} deps.log
 * @param {() => object} deps.getConfig
 * @param {() => any} deps.getBot
 */
export function createStickerComponent(deps) {
  const { stateFile, log, getConfig, getBot } = deps || {};
  for (const [name, value] of Object.entries({ stateFile, log, getConfig, getBot })) {
    if (value === undefined || value === null) {
      throw new TypeError(`stickers 缺少依赖：${name}`);
    }
  }

  // 库文件损坏/读不动时**不能当成空库继续**：任何一次 save 都会把「空库」写回去，
  // 把 AI 学到的 localNote/tags/usage 永久清零。读失败就显式降级为「只读不写」。
  let entries = [];
  let writable = true;
  try {
    entries = loadStickerStore(stateFile);
  } catch (error) {
    writable = false;
    log(`⚠️ 表情库读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
  }
  let syncedAt = 0;
  let lastForcedAgentSync = 0;

  function saveSafe() {
    if (!writable) return;
    try { saveStickerStore(stateFile, entries); } catch (error) { log('保存表情库失败:', error?.message ?? error); }
  }

  // 启动时补编号 + 情绪/内容/关键词（老库没有这些字段）。
  // 只补缺失字段：模型看过图后写下的标注永远优先，自动推断只做兜底。
  try {
    const indexed = ensureStickerIndex(entries);
    entries = indexed.entries;
    if (indexed.changed) {
      saveSafe();
      log(`[sticker] 已补全表情编号/情绪/内容 ${entries.length} 条`);
    }
  } catch (error) {
    log(`[sticker] 表情编号/情绪自动补全失败（不影响发送，仅影响推荐）：${error?.message ?? error}`);
  }

  function enabled() {
    return getConfig().socialV2?.sticker?.enabled !== false;
  }

  /** 从 SnowLuma 拉 QQ 收藏表情并合并进本地库；失败返回 null（调用方用缓存）。 */
  async function sync(force = false) {
    const cfg = getConfig();
    if (cfg.socialV2?.sticker?.enabled === false) return null;
    const rawTtl = Number(cfg.socialV2?.sticker?.syncTtlMs);
    const ttl = Number.isFinite(rawTtl) ? Math.max(0, rawTtl) : 60000;
    const now = Date.now();
    if (!force && syncedAt && now - syncedAt < ttl) {
      return { entries, syncedAt, fromCache: true };
    }
    try {
      const count = Math.min(500, Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100));
      const response = await getBot().request('fetch_custom_face_detail', { count });
      if (!response || response.status !== 'ok' || response.retcode !== 0) {
        throw new Error(`fetch_custom_face_detail 失败: ${response?.wording || response?.retcode || 'unknown'}`);
      }
      // 只有拿到合法数组才允许合并；data 缺失/异常时不能拿空数组清空本地 QQ 表情库。
      if (!Array.isArray(response.data)) {
        throw new Error('fetch_custom_face_detail 返回 data 不是数组，已放弃同步');
      }
      const fetched = response.data;
      entries = mergeStickerLibrary(entries, fetched, { complete: fetched.length < count });
      entries = ensureStickerIndex(entries).entries;
      syncedAt = Date.now();
      saveSafe();
      log(`[sticker] 已同步 QQ 收藏表情 ${fetched.length} 个（本地库 ${entries.length} 条）`);
      return { entries, syncedAt, fromCache: false };
    } catch (error) {
      log(`[sticker] 同步收藏表情失败: ${error?.message ?? error}`);
      return null;
    }
  }

  /** 列表 + 元信息，供控制台/v2 列表接口共用。 */
  async function listMeta(query = '', count = 48, { force = false } = {}) {
    const synced = await sync(force);
    const list = formatStickerList(synced?.entries ?? entries, query, count);
    return { list, syncedAt: synced?.syncedAt ?? syncedAt, fromCache: synced?.fromCache ?? false };
  }

  /** 取单张表情（本地没有时强制刷新一次再找）。 */
  async function getImage(stickerId) {
    const synced = await sync(false);
    const entry = findSticker(synced?.entries ?? entries, stickerId);
    if (entry) return entry;
    const forced = await sync(true);
    const retried = findSticker(forced?.entries ?? entries, stickerId);
    if (!retried) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
    return retried;
  }

  function find(ref) {
    return findSticker(entries, ref);
  }

  /** 更新本地 AI 认知（含义/标签/用法/情绪/内容/关键词）。 */
  function note(stickerId, patch = {}) {
    const clean = {};
    if (patch.note !== undefined && patch.note !== null) clean.note = String(patch.note);
    if (patch.tags !== undefined && patch.tags !== null) clean.tags = Array.isArray(patch.tags) ? patch.tags.map(String) : String(patch.tags).split(/[,，\s]+/);
    if (patch.usage !== undefined && patch.usage !== null) clean.usage = String(patch.usage);
    if (patch.emotion !== undefined && patch.emotion !== null) clean.emotion = String(patch.emotion);
    if (patch.emotionAlt !== undefined && patch.emotionAlt !== null) clean.emotionAlt = Array.isArray(patch.emotionAlt) ? patch.emotionAlt.map(String) : String(patch.emotionAlt).split(/[,，\s]+/);
    if (patch.content !== undefined && patch.content !== null) clean.content = String(patch.content);
    if (patch.keywords !== undefined && patch.keywords !== null) clean.keywords = Array.isArray(patch.keywords) ? patch.keywords.map(String) : String(patch.keywords).split(/[,，\s]+/);
    const updated = applyStickerNote(entries, stickerId, clean);
    if (!updated.entry) return null;
    entries = updated.entries;
    saveSafe();
    return updated.entry;
  }

  function markUsed(stickerId) {
    const updated = markStickerUsed(entries, stickerId, 'sticker');
    entries = updated.entries;
    saveSafe();
    return updated.entry;
  }

  /** 修改 QQ 账号里的收藏表情备注（modify_custom_face），并同步本地 desc。 */
  async function remark(stickerId, text) {
    const synced = await sync(false);
    const entry = findSticker(synced?.entries ?? entries, stickerId);
    if (!entry) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
    const cleanRemark = String(text ?? '').trim().slice(0, 50);
    const response = await getBot().request('modify_custom_face', { emoji_id: entry.id, desc: cleanRemark });
    if (!response || response.status !== 'ok' || response.retcode !== 0) {
      throw new Error(`modify_custom_face 失败: ${response?.wording || response?.retcode || 'unknown'}`);
    }
    const updated = applyStickerNote(entries, entry.id, {});
    const idx = (updated.entries || []).findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      updated.entries[idx] = { ...updated.entries[idx], desc: cleanRemark, updatedAt: new Date().toISOString() };
    }
    entries = updated.entries;
    saveSafe();
    return entries.find((e) => e.id === entry.id) || null;
  }

  /**
   * 给「刚到的消息」算一条表情推荐（编号 + 情绪 + 内容）。
   * wait / unread / 唤醒提示共用，避免三处各推一套。
   */
  function suggest(messages) {
    const stickerCfg = getConfig().socialV2?.sticker ?? {};
    if (stickerCfg.enabled === false || stickerCfg.includeInPrompt === false) return null;
    if (!Array.isArray(entries) || !entries.length) return null;
    // 只看最近 4 条：未读一次可能几十条，全拼进去会把当前情绪稀释掉。
    const list = (Array.isArray(messages) ? messages : []).filter((m) => m && !m.isSelf).slice(-4);
    const windowText = list.map((m) => String(m.text || m.plain || '')).join(' ').replace(/\s+/g, ' ').trim();
    if (!windowText) return null;
    // 优先盯「最新一条」：群聊里要接的通常就是最后这句；太短（「哈哈」「[图片]」）再退回窗口。
    const lastText = String(list[list.length - 1]?.text || list[list.length - 1]?.plain || '').replace(/\s+/g, ' ').trim();
    const focusText = lastText.length >= 4 ? lastText : windowText;
    const matchCfg = stickerCfg.match ?? {};
    const rankOpts = {
      topK: Math.max(1, Math.min(3, Number(matchCfg.topK) || 2)),
      minScore: Number.isFinite(Number(matchCfg.minScore)) ? Number(matchCfg.minScore) : undefined,
    };
    let ranked = rankStickers(entries, focusText, rankOpts);
    let usedText = focusText;
    if (!ranked.length && focusText !== windowText) {
      ranked = rankStickers(entries, windowText, rankOpts);
      usedText = windowText;
    }
    if (!ranked.length) return null;
    const moods = detectEmotions(usedText).slice(0, 2).map((h) => h.label);
    return {
      hint: buildStickerMatchHint(ranked, { moods, max: ranked.length }),
      moods,
      matches: ranked.map((r) => ({
        no: r.no,
        ref: `#${String(r.no).padStart(2, '0')}`,
        emotion: r.emotionLabel,
        content: r.content,
        score: r.score,
      })),
    };
  }

  function context(max = 8) {
    return buildStickerContext(entries, max);
  }

  function strategy() {
    return buildStickerStrategyHint();
  }

  /** AI 强制刷新节流：10 秒内只真正拉一次（返回实际应使用的 force）。 */
  function throttleForce(force, gapMs = 10000) {
    if (!force) return false;
    const now = Date.now();
    if (now - lastForcedAgentSync < gapMs) return false;
    lastForcedAgentSync = now;
    return true;
  }

  // ── 控制台管理接口 ────────────────────────────────────────────────────────
  // 全局鉴权 / CSRF / 只读降级都在 registry 分发之前，组件不重复实现。

  async function handleList(ctx, io) {
    const cfg = getConfig();
    const query = String(io.url.searchParams.get('query') ?? '').trim();
    const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
    const count = Math.min(500, Math.max(1, Math.min(Number(io.url.searchParams.get('count')) || 48, maxCount)));
    // GET 不触发强制同步（写副作用不能挂在读接口上）：请用 POST /api/stickers/sync。
    try {
      const meta = await listMeta(query, count, { force: false });
      io.sendJson({ ok: true, ...meta.list, syncedAt: meta.syncedAt, fromCache: meta.fromCache, writable });
    } catch (error) {
      io.sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
    }
  }

  async function handleSync(ctx, io) {
    try {
      const synced = await sync(true);
      io.sendJson({ ok: true, total: synced?.entries?.length ?? entries.length, syncedAt: synced?.syncedAt ?? syncedAt });
    } catch (error) {
      io.sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
    }
  }

  async function handleNote(ctx, io) {
    const body = await io.readBody();
    const stickerId = String(body.stickerId ?? '').trim();
    if (!stickerId) { io.sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
    const noteText = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
    const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
    const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
    const emotion = body.emotion !== undefined && body.emotion !== null ? String(body.emotion).trim().slice(0, 24) : undefined;
    const emotionAlt = body.emotionAlt !== undefined && body.emotionAlt !== null ? (Array.isArray(body.emotionAlt) ? body.emotionAlt.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 2) : String(body.emotionAlt).split(/[,，\s]+/).filter(Boolean).slice(0, 2)) : undefined;
    const content = body.content !== undefined && body.content !== null ? String(body.content).trim().slice(0, 120) : undefined;
    const keywords = body.keywords !== undefined && body.keywords !== null ? (Array.isArray(body.keywords) ? body.keywords.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 8) : String(body.keywords).split(/[,，\s]+/).filter(Boolean).slice(0, 8)) : undefined;
    const entry = note(stickerId, { note: noteText, tags, usage, emotion, emotionAlt, content, keywords });
    if (!entry) { io.sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
    io.sendJson({ ok: true, sticker: entry });
  }

  async function handleRemark(ctx, io) {
    const body = await io.readBody();
    const stickerId = String(body.stickerId ?? '').trim();
    if (!stickerId) { io.sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
    try {
      const entry = await remark(stickerId, String(body.remark ?? ''));
      io.sendJson({ ok: true, sticker: entry });
    } catch (error) {
      io.sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
    }
  }

  return defineComponent({
    id: 'stickers',
    routes: [
      { method: 'GET', path: '/api/stickers', handle: handleList },
      { method: 'POST', path: '/api/stickers/sync', handle: handleSync },
      { method: 'POST', path: '/api/stickers/note', handle: handleNote },
      { method: 'POST', path: '/api/stickers/remark', handle: handleRemark },
    ],
    init() {
      return {
        enabled,
        writable: () => writable,
        entries: () => entries,
        sync,
        listMeta,
        getImage,
        find,
        note,
        markUsed,
        remark,
        suggest,
        context,
        strategy,
        throttleForce,
      };
    },
  });
}
