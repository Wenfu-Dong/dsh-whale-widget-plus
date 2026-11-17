/**
 * 内置 MCP 工具注册（从 backend/lib/index.js 拆出）。
 *
 * 两组工具都属于本插件，不依赖外部插件：
 *   · 表情：sticker_search / sticker_send（大肥鱼表情包）；
 *   · 记忆：memory_search / memory_remember（模型主动检索/写入记忆卡）。
 *
 * 只做工具注册，不持有插件状态；日志与数据目录由调用方注入。
 */
import path from 'node:path';
import { createNekoStickers } from '../../src/nekowhale-stickers.mjs';
import { applyMemoryCardAction, memoryCardSnapshot } from './memory-card.js';

/**
 * 内置表情工具。
 * 参数必须是完整 JSON Schema——之前用简写导致注册阶段抛错、整个插件加载失败，已修正。
 *
 * @param {object} deps
 * @param {object} deps.ctx 插件上下文（提供 inject）
 * @param {string} deps.stateDir 运行数据目录
 * @param {(...args: any[]) => void} deps.log 日志函数
 */
export function registerStickerTools(deps) {
  const { ctx, stateDir, log } = deps || {};
  for (const [name, value] of Object.entries({ ctx, stateDir, log })) {
    if (value === undefined || value === null) throw new TypeError(`registerStickerTools 缺少依赖：${name}`);
  }
  const install = (scope) => {
    try {
      if (!scope?.tools?.register) return;
      const kit = createNekoStickers({ dir: path.join(stateDir, 'nekowhale-cache'), log });
      const output = {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { text: { type: 'string' } }, required: ['text'],
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      };
      scope.tools.register({
        name: 'sticker_search',
        description: '在大肥鱼表情包里按情绪/场景词搜表情，返回名字列表；挑好后用 sticker_send。',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: { query: { type: 'string', description: '情绪/场景词，如 摸鱼 被夸 无语 好累' } },
          required: ['query'],
        },
        output,
        async execute(args) {
          const query = String(args?.query ?? '').trim();
          const { items } = await kit.loadKit();
          const words = query.toLowerCase().split(/\s+/).filter(Boolean);
          const hits = items
            .map((item) => {
              const hay = `${item.name} ${item.emotion || ''} ${(item.tags || []).join(' ')}`.toLowerCase();
              let score = 0;
              for (const word of words) if (word && hay.includes(word)) score += 1;
              return { item, score };
            })
            .filter((row) => row.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 8);
          if (!hits.length) return { text: `没有搜到「${query}」相关表情，换个词。` };
          return { text: hits.map(({ item }) => `${item.name}｜${item.emotion || '—'}｜${(item.tags || []).slice(0, 3).join(' ')}`).join('\n') };
        },
      });
      scope.tools.register({
        name: 'sticker_send',
        description: '发一张大肥鱼表情。返回一行 Markdown 图片，把它原样放进你的回复里即可发到 QQ（不需要 token，也不要用 qq_send_sticker）。',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: { name: { type: 'string', description: 'sticker_search 返回的名字，或情绪词' } },
          required: ['name'],
        },
        output,
        async execute(args) {
          const wanted = String(args?.name ?? '').trim();
          if (!wanted) throw new Error('name 不能为空');
          const { items } = await kit.loadKit();
          const exact = items.find((item) => item.name === wanted || item.name.includes(wanted) || String(item.file || '').includes(wanted));
          const item = exact || await kit.pick(wanted, { minScore: 1 });
          if (!item) throw new Error(`没有匹配「${wanted}」的表情，先用 sticker_search 搜一下`);
          const file = await kit.download(item);
          // 关键：不能把本机绝对路径写进 Markdown。一旦图片行因任何原因降级成文字发出，
          // 就会把「盘符:\Users\用户名\…」这类本机绝对路径公开（2026-11 真实隐私事故）。
          // 只回「不含路径」的引用 token，由桥接在本地缓存目录里解析成图片。
          const safeName = String(item.name || '').replace(/[[\]()]/g, '');
          return { text: `![${safeName}](dshsticker:${encodeURIComponent(path.basename(file))})` };
        },
      });
      log('[sticker] 内置表情工具已注册：sticker_search / sticker_send');
    } catch (error) {
      log('[sticker] 注册表情工具失败：', String(error?.message ?? error));
    }
  };
  try {
    if (typeof ctx?.inject === 'function') ctx.inject(['tools'], install);
    else install(ctx);
  } catch (error) {
    log('[sticker] 延迟注册表情工具失败：', String(error?.message ?? error));
  }
}

/**
 * 内置记忆工具：把「记忆」从被动注入改成模型主动拉取/写入。
 *   · memory_search：按关键词检索她自己的记忆卡（top-k），想不起来就搜；
 *   · memory_remember：把重要的事直接写进记忆卡（走 addManualMemory 的脱敏管线）。
 * 设计（2026-11-09 用户定）：常驻注入只留身份头，细节全部按需检索——
 * 这是 token 减负的最后一环。
 *
 * @param {object} deps
 * @param {object} deps.ctx 插件上下文（提供 inject）
 * @param {(...args: any[]) => void} deps.log 日志函数
 */
export function registerMemoryTools(deps) {
  const { ctx, log } = deps || {};
  for (const [name, value] of Object.entries({ ctx, log })) {
    if (value === undefined || value === null) throw new TypeError(`registerMemoryTools 缺少依赖：${name}`);
  }
  const install = (scope) => {
    try {
      if (!scope?.tools?.register) return;
      const output = {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { text: { type: 'string' } }, required: ['text'],
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      };
      const queryTokens = (q) => {
        const s = String(q ?? '').toLowerCase();
        const out = new Set();
        for (const m of s.matchAll(/[a-z0-9][a-z0-9]+/g)) out.add(m[0]);
        const cjk = s.replace(/[^\u4e00-\u9fff]/g, ' ');
        for (const seg of cjk.split(/\s+/)) {
          if (!seg) continue;
          for (let i = 0; i + 1 < seg.length; i += 1) out.add(seg.slice(i, i + 2));
        }
        return [...out].slice(0, 24);
      };
      scope.tools.register({
        name: 'memory_search',
        description: '检索你自己的长期记忆（记忆卡）。想不起来某件事、或话题涉及过去经历时先用这个查，不要编造记忆。',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            query: { type: 'string', description: '检索词：人名/事件/关键词，如 主人 修复 B站 表情包' },
            limit: { type: 'number', description: '返回条数（默认 5，最多 8）' },
          },
          required: ['query'],
        },
        output,
        async execute(args) {
          const query = String(args?.query ?? '').trim();
          if (!query) return { text: '请给一个检索词。' };
          const tokens = queryTokens(query);
          if (!tokens.length) return { text: '检索词太短，给个具体的关键词。' };
          const snapshot = memoryCardSnapshot(undefined, { recordLimit: 500 });
          const records = Array.isArray(snapshot?.records) ? snapshot.records : [];
          const scored = [];
          for (const rec of records) {
            if (rec.sensitive === true) continue;
            const hay = `${rec.title || ''} ${rec.text || ''} ${(rec.tags || []).join(' ')}`.toLowerCase();
            let score = 0;
            for (const t of tokens) if (t && hay.includes(t)) score += 1;
            if (score > 0) scored.push({ rec, score });
          }
          scored.sort((a, b) => b.score - a.score
            || (b.rec.pinned === true) - (a.rec.pinned === true)
            || String(b.rec.date ?? '').localeCompare(String(a.rec.date ?? '')));
          const limit = Math.max(1, Math.min(8, Number(args?.limit) || 5));
          const top = scored.slice(0, limit);
          if (!top.length) return { text: '记忆里没有找到相关内容。' };
          const lines = top.map(({ rec }) => {
            const day = String(rec.date ?? '').slice(0, 10);
            const scopeTag = rec.scope === 'pet' ? '（仅私下知道）' : '';
            return `- ${day}${rec.pinned ? ' [锚点]' : ''} ${rec.title || ''}：${String(rec.text || '').slice(0, 160)}${scopeTag}`;
          });
          return { text: `【记忆检索 · ${top.length} 条】\n${lines.join('\n')}` };
        },
      });
      scope.tools.register({
        name: 'memory_remember',
        description: '把重要的事写进你自己的长期记忆（会自动脱敏+进整理队列）。明确被要求记住、或出现约定/偏好/计划/重要近况时用。',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            text: { type: 'string', description: '要记住的事实（一句话，具体、可回忆）' },
            title: { type: 'string', description: '可选：短标题' },
            importance: { type: 'number', description: '重要度 20~100，默认 70' },
          },
          required: ['text'],
        },
        output,
        async execute(args) {
          const text = String(args?.text ?? '').trim();
          if (text.length < 2) return { ok: false, text: '内容太短，没有记住。' };
          const importance = Math.max(20, Math.min(100, Math.round(Number(args?.importance) || 70)));
          const result = applyMemoryCardAction('add', {
            text,
            title: String(args?.title ?? text).slice(0, 40),
            importance,
            scope: 'qq',
            tags: ['AI记录'],
          }, {});
          if (result?.ok === false) return { ok: false, text: `没记上：${String(result.error ?? '内容为空或重复')}` };
          log('[memory] 模型写入记忆：', text.slice(0, 60));
          return { ok: true, text: '已记进长期记忆。' };
        },
      });
      log('[memory] 内置记忆工具已注册：memory_search / memory_remember');
    } catch (error) {
      log('[memory] 注册记忆工具失败：', String(error?.message ?? error));
    }
  };
  try {
    if (typeof ctx?.inject === 'function') ctx.inject(['tools'], install);
    else install(ctx);
  } catch (error) {
    log('[memory] 延迟注册记忆工具失败：', String(error?.message ?? error));
  }
}
