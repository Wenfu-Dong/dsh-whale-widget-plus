/**
 * 记忆路由（组件化迁移 #11）。
 *
 * 从 backend/lib/index.js 的 apply(ctx) 闭包里原样搬出，依赖改为显式注入：
 *   · /memory              QQ⇄B站 双向脱敏记忆（同步 / 重建 / 清空 / 扫描对齐）
 *   · /memory-card         角色长期记忆卡（inbox / 整理 / 遗忘 / 备份恢复）
 *   · /memory-card/full    全量存档（只读）
 *   · /align               身份对齐（links / candidates / 导入导出）
 *
 * 路由分发与全局鉴权/只读降级仍留在 index.js。
 */
import fs from 'node:fs';
import path from 'node:path';

export function createMemoryRoutes(deps) {
  const {
    PRIVACY_POLICY_VERSION,
    readJsonBody, json,
    readUnified, saveUnified,
    maskPath, backupFile,
    QQ_STATE_DIR, activeMemoryPaths, readTextFile,
    QQ_ALIGNMENT_BRIEF, BILI_ALIGNMENT_FILE,
    platforms, memoryOrganizer, callBridge,
    memoryStatus, previewQqForBili, biliToQqStatus, auditTail,
    syncQqToBili, refreshBiliToQq, scanQqFeedForCandidates, scanBiliFeedForCandidates, rebuildAllPrompts,
    memoryCardSnapshot, fullMemoryCardSnapshot, applyMemoryCardAction, runMemoryCardMaintenance,
    compactMemoryCardNow, restoreMemoryCardBackup, notifyOwnerIfNeeded,
    listLinks, listCandidates, addLink, updateLink, removeLink,
    approveCandidate, rejectCandidate, importAlignments, exportAlignments, alignStats,
  } = deps || {};

  const required = {
    PRIVACY_POLICY_VERSION,
    readJsonBody, json,
    readUnified, saveUnified,
    maskPath, backupFile,
    QQ_STATE_DIR, activeMemoryPaths, readTextFile,
    QQ_ALIGNMENT_BRIEF, BILI_ALIGNMENT_FILE,
    platforms, memoryOrganizer, callBridge,
    memoryStatus, previewQqForBili, biliToQqStatus, auditTail,
    syncQqToBili, refreshBiliToQq, scanQqFeedForCandidates, scanBiliFeedForCandidates, rebuildAllPrompts,
    memoryCardSnapshot, fullMemoryCardSnapshot, applyMemoryCardAction, runMemoryCardMaintenance,
    compactMemoryCardNow, restoreMemoryCardBackup, notifyOwnerIfNeeded,
    listLinks, listCandidates, addLink, updateLink, removeLink,
    approveCandidate, rejectCandidate, importAlignments, exportAlignments, alignStats,
  };
  for (const [name, value] of Object.entries(required)) {
    if (value === undefined || value === null) throw new TypeError(`memory-routes 缺少依赖：${name}`);
  }

  // ── 记忆 ────────────────────────────────────────────────────────────────
  async function handleMemory(req, res, url) {
    if (req.method === 'GET') {
      const previewChars = Math.max(200, Math.min(20_000, Number(url.searchParams.get('chars')) || 4000));
      json(res, 200, {
        ok: true,
        status: memoryStatus(),
        qqPreview: previewQqForBili({ maxChars: previewChars }),
        biliPreview: biliToQqStatus().briefPreview,
        audit: auditTail(40),
        policyVersion: PRIVACY_POLICY_VERSION,
      });
      return;
    }
    const body = await readJsonBody(req);
    if (body.action === 'sync') {
      const result = syncQqToBili({ force: true });
      json(res, 200, result);
      return;
    }
    if (body.action === 'refresh-bili') {
      const result = await refreshBiliToQq({ callBridge });
      json(res, 200, result);
      return;
    }
    if (body.action === 'scan-align') {
      const qq = scanQqFeedForCandidates({ maxMessages: 1200 });
      const bili = await scanBiliFeedForCandidates({ maxPages: 2 });
      json(res, 200, { ok: true, qq, bili });
      return;
    }
    if (body.action === 'rebuild') {
      json(res, 200, { ok: true, ...rebuildAllPrompts() });
      return;
    }
    if (body.action === 'purge') {
      const feed = path.join(QQ_STATE_DIR(), 'qq-public-feed.jsonl');
      backupFile(activeMemoryPaths().qqForBili, 'qq-memory-before-purge');
      for (const file of [feed, activeMemoryPaths().qqForBili, path.join(activeMemoryPaths().dir, 'sync-state.json')]) {
        try { fs.rmSync(file, { force: true }); } catch {}
      }
      json(res, 200, { ok: true, purged: [feed, activeMemoryPaths().qqForBili].map(maskPath), note: '已清空 QQ→B站 记忆与原始公开 feed；对齐表不受影响。' });
      return;
    }
    json(res, 400, { ok: false, error: '未知 action' });
  }

  // ── 记忆卡（角色的长期记忆）──────────────────────────────────────────────
  // 和上面的「双向脱敏同步」不是一回事：memory 是 QQ⇄B站 的搬运；
  // memory-card 是她自己的记忆（冲浪 + 聊天 + 主人互动），带清晰度/遗忘/容量规则。
  async function handleMemoryCard(req, res, url) {
    const config = readUnified().config.memoryCard;
    // inbox 里「上次整理之后新增」的条数：比总数更有意义（总数会一直涨）。
    const countInboxSince = (since) => {
      try {
        const file = activeMemoryPaths().inbox;
        if (!fs.existsSync(file)) return 0;
        const lines = fs.readFileSync(file, 'utf8').split(String.fromCharCode(10)).filter(Boolean);
        if (!since) return lines.length;
        let count = 0;
        for (const line of lines) {
          try { if ((Date.parse(JSON.parse(line).at) || 0) > since) count += 1; } catch { /* 跳过坏行 */ }
        }
        return count;
      } catch { return 0; }
    };
    if (req.method === 'GET') {
      // 默认 80 条（外壳每 60 秒轮询一次）；「打开记忆文档」传 limit=300 拿更多可编辑记录。
      const recordLimit = Math.max(1, Math.min(500, Number(url?.searchParams?.get('limit')) || 80));
      const organize = config?.organize && typeof config.organize === 'object' ? config.organize : {};
      json(res, 200, {
        ...memoryCardSnapshot(config, { recordLimit }),
        organize: {
          enabled: organize.enabled === true,
          // 未显式写过时按默认（关）；这里必须回读，否则前端「每天自动写日记」开关永远是开的。
          diary: organize.diary === true,
          lastRunAt: Number(organize.lastRunAt) || 0,
          lastMerged: Number(organize.lastMerged) || 0,
          lastDropped: Number(organize.lastDropped) || 0,
          intervalHours: Math.max(6, Math.min(168, Number(organize.intervalHours) || 20)),
          hour: Number.isFinite(Number(organize.hour)) ? Number(organize.hour) : -1,
          minRecords: Math.max(10, Math.min(300, Number(organize.minRecords) || 40)),
          llmReady: memoryOrganizer.llmReady(),
        },
        inboxPending: countInboxSince(Number(organize.lastRunAt) || 0),
        inboxTotal: countInboxSince(0),
      });
      return;
    }
    const body = await readJsonBody(req);
    const action = String(body.action ?? '');
    if (action === 'diary') {
      const result = await memoryOrganizer.diary({ date: String(body.date || ''), force: body.force === true });
      if (!result.ok) { json(res, 400, result); return; }
      json(res, 200, { ...memoryCardSnapshot(config), diary: result });
      return;
    }
    if (action === 'forget-batch') {
      const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 200) : [];
      if (!ids.length) { json(res, 400, { ok: false, error: '没有选中任何记忆' }); return; }
      let removed = 0;
      for (const id of ids) {
        const result = await applyMemoryCardAction('forget', { id }, { config });
        if (result?.ok) removed += 1;
      }
      json(res, 200, { ...memoryCardSnapshot(config), removed });
      return;
    }
    // 清空聊天流水：保留 锚点/初次相遇/日记/手动新增/已合并；其余（旧聊天记录）全部归档掉
    if (action === 'purge-chatlog') {
      const snapshot = memoryCardSnapshot(config, { recordLimit: 500 });
      const keepTags = new Set(['diary', 'merged', 'manual']);
      const ids = (snapshot.records ?? []).filter((record) => !record.pinned && !record.firstMet
        && !(record.tags ?? []).some((tag) => keepTags.has(tag))).map((record) => record.id);
      let removed = 0;
      for (const id of ids) {
        const result = await applyMemoryCardAction('forget', { id }, { config });
        if (result?.ok) removed += 1;
      }
      json(res, 200, { ...memoryCardSnapshot(config), removed });
      return;
    }
    // 整理预览：只做本地规则分析，不调模型、不改数据（告诉你会合并/清掉什么）
    if (action === 'organize-preview') {
      const snapshot = memoryCardSnapshot(config, { recordLimit: 500 });
      const records = Array.isArray(snapshot.records) ? snapshot.records : [];
      const norm = (text) => String(text ?? '').replace(/\s+/g, '').slice(0, 60);
      const byKey = new Map();
      const noOrganizeCount = records.filter((record) => record.noOrganize === true || record.pinned === true || record.firstMet === true).length;
      for (const record of records) {
        if (record.firstMet || record.pinned || record.noOrganize) continue;
        const key = `${record.title || ''}|${norm(record.text)}`;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(record);
      }
      const duplicates = [...byKey.values()].filter((list) => list.length > 1);
      const noisy = records.filter((record) => !record.pinned && !record.firstMet && !record.noOrganize
        && String(record.text || '').length < 14 && /^(嗯|哦|好|好的|哈哈|在吗|收到|行|？|\?)/.test(String(record.text || '').trim()));
      const faded = records.filter((record) => !record.pinned && !record.firstMet && !record.noOrganize && (record.clarity === 'trace' || Number(record.importance) < 35));
      const oldFuzzy = records.filter((record) => !record.pinned && !record.firstMet && !record.noOrganize && record.clarity === 'fuzzy'
        && Date.now() - (Date.parse(record.date || '') || Date.now()) > 30 * 86400_000);
      json(res, 200, {
        ok: true,
        preview: {
          total: records.length,
          duplicates: duplicates.length,
          duplicateSample: duplicates.slice(0, 5).map((list) => ({ title: list[0].title, count: list.length })),
          noisy: noisy.length,
          noisySample: noisy.slice(0, 5).map((record) => String(record.text || '').slice(0, 30)),
          faded: faded.length,
          fadedSample: faded.slice(0, 5).map((record) => String(record.title || record.text || '').slice(0, 30)),
          oldFuzzy: oldFuzzy.length,
          protectedCount: records.filter((record) => record.pinned || record.firstMet).length,
          noOrganizeCount,
          capacity: snapshot.status?.percent ?? 0,
          inboxPending: countInboxSince(Number((config?.organize ?? {}).lastRunAt) || 0),
          inboxTotal: countInboxSince(0),
        },
      });
      return;
    }
    // 批量标记「不参与整理」：整理/合并/遗忘都会跳过这些记录
    if (action === 'protect-batch') {
      const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 300) : [];
      const noOrganize = body.noOrganize !== false;
      if (!ids.length) { json(res, 400, { ok: false, error: '没有选中任何记忆' }); return; }
      let changedCount = 0;
      for (const id of ids) {
        const result = await applyMemoryCardAction('update', { id, patch: { noOrganize } }, { config });
        if (result?.ok) changedCount += 1;
      }
      json(res, 200, { ...memoryCardSnapshot(config, { recordLimit: 300 }), changedCount });
      return;
    }
    if (action === 'organize') {
      const result = await memoryOrganizer.organize({
        ids: Array.isArray(body.ids) ? body.ids : null,
        force: body.force !== false,
      });
      if (!result.ok) { json(res, 400, result); return; }
      json(res, 200, { ...memoryCardSnapshot(config), organized: result });
      return;
    }
    if (action === 'organize-config') {
      // enabled 和 diary 是两个独立开关：前端「每天自动写日记」只发 diary，
      // 之前这里只认 enabled，导致该开关保存后被丢弃、下次读回又显示成开。
      const patch = {};
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      if (typeof body.diary === 'boolean') patch.diary = body.diary;
      if (Number.isFinite(Number(body.intervalHours))) patch.intervalHours = Math.max(6, Math.min(168, Number(body.intervalHours)));
      if (Number.isFinite(Number(body.hour))) patch.hour = Math.max(-1, Math.min(23, Number(body.hour)));
      if (Number.isFinite(Number(body.minRecords))) patch.minRecords = Math.max(10, Math.min(300, Number(body.minRecords)));
      if (Object.keys(patch).length) saveUnified({ memoryCard: { organize: patch } });
      json(res, 200, memoryCardSnapshot(config));
      return;
    }
    if (action === 'maintain') {
      const result = await runMemoryCardMaintenance({ forceDecay: body.forceDecay === true, config });
      const snapshot = memoryCardSnapshot(config);
      json(res, 200, { ...snapshot, changed: result.changed, addedBili: result.addedBili, addedQq: result.addedQq, addedPet: result.addedPet });
      return;
    }
    if (action === 'compact') {
      const result = await compactMemoryCardNow({ targetRatio: Number(body.targetRatio) || 0.8, config });
      json(res, 200, { ...memoryCardSnapshot(config), steps: result.steps });
      return;
    }
    if (action === 'restore') {
      const result = await restoreMemoryCardBackup(String(body.name ?? ''), { config });
      if (!result.ok) { json(res, 400, result); return; }
      json(res, 200, memoryCardSnapshot(config));
      return;
    }
    if (action === 'notify-test') {
      const result = await notifyOwnerIfNeeded({ callBridge, config });
      json(res, 200, result);
      return;
    }
    if (['pin', 'forget', 'ack', 'add', 'update', 'set-first-meet', 'clear-first-meet', 'merge-memories'].includes(action)) {
      const result = await applyMemoryCardAction(action, body, { config });
      if (!result.ok) { json(res, 400, result); return; }
      json(res, 200, memoryCardSnapshot(config));
      return;
    }
    json(res, 400, { ok: false, error: '未知 action' });
  }

  // ── 全量记忆卡（只存档；不参与日常提示词）───────────────────────────────
  async function handleMemoryCardFull(req, res, url) {
    if (req.method !== 'GET') { json(res, 405, { ok: false, error: '只读接口' }); return; }
    const q = String(url.searchParams.get('q') ?? '');
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 40));
    json(res, 200, fullMemoryCardSnapshot({ q, limit, config: readUnified().config.memoryCard }));
  }

  // ── 身份对齐 ────────────────────────────────────────────────────────────
  async function handleAlign(req, res) {
    if (req.method === 'GET') {
      json(res, 200, {
        ok: true,
        labelsSupported: true,
        links: listLinks(),
        candidates: listCandidates(),
        stats: alignStats(),
        platforms: platforms.list(),
        briefs: {
          qqChars: readTextFile(QQ_ALIGNMENT_BRIEF).length,
          biliChars: readTextFile(BILI_ALIGNMENT_FILE).length,
        },
      });
      return;
    }
    const body = await readJsonBody(req);
    const action = String(body.action ?? '');
    if (action === 'add') { json(res, 200, { ok: true, link: addLink(body.link ?? body) }); return; }
    if (action === 'update') { json(res, 200, { ok: true, link: updateLink(String(body.id), body.link ?? body.patch ?? {}) }); return; }
    if (action === 'remove') { json(res, 200, { ok: true, ...removeLink(String(body.id)) }); return; }
    if (action === 'approve') { json(res, 200, { ok: true, link: approveCandidate(String(body.id), body.overrides ?? {}) }); return; }
    if (action === 'reject') { json(res, 200, { ok: true, ...rejectCandidate(String(body.id)) }); return; }
    if (action === 'scan') {
      const qq = scanQqFeedForCandidates({ maxMessages: 1200 });
      const bili = await scanBiliFeedForCandidates({ maxPages: 2 });
      json(res, 200, { ok: true, qq, bili, candidates: listCandidates() });
      return;
    }
    if (action === 'import') { json(res, 200, { ok: true, state: importAlignments(body.payload ?? body.data, { merge: body.merge !== false }) }); return; }
    if (action === 'export') { json(res, 200, { ok: true, ...exportAlignments() }); return; }
    json(res, 400, { ok: false, error: '未知 action' });
  }

  return { handleMemory, handleMemoryCard, handleMemoryCardFull, handleAlign };
}
