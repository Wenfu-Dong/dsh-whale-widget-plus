/**
 * 黑话学习库（组件化迁移 #3）。
 *
 * 从 src/bridge.js 的 main() 里整块搬出：
 *   - 词条库状态（entries / 只读降级）
 *   - 群聊消息窗口、提取/研究冷却与限频
 *   - 学习会话（DSH session）的创建、复用、作废，以及 turn 事件收集
 *   - 控制台管理接口 /api/slang*
 *
 * 留在 bridge 的部分：/api/socialV2/slang/query 与 /submit 的 agent token、
 * 会话白名单、工具开关校验属于协议层，只调用本组件导出的方法。
 */
import fs from 'node:fs';
import path from 'node:path';
import { defineComponent } from '../core/registry.js';
import {
  buildExtractionPrompt,
  buildResearchPrompt,
  buildSlangContext,
  createSlangEntry,
  loadSlang,
  mergeEvidence,
  parseExtractionJson,
  parseResearchJson,
  saveSlang,
  SLANG_MAX_ENTRIES,
  SLANG_STATUS,
  upsertSlangEntry,
} from '../../slang-learner.js';
import { atomicWriteJson, readConfigObject, readJsonSafe } from '../json-io.js';
import { unwrap } from '../../dsh-client.js';
import { truncateText } from '../../md-to-plain.js';

const STATUSES = [SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED];

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * @param {object} deps
 * @param {string} deps.stateFile        slang.json 路径
 * @param {string} deps.sessionFile      学习会话记录文件路径
 * @param {string} deps.configFile       config.json 路径
 * @param {Function} deps.log
 * @param {() => object} deps.getConfig
 * @param {() => boolean} deps.isDshReady
 * @param {() => any} deps.getApi        DSH NodeApiClient（延迟取，避免启动顺序问题）
 * @param {Function} deps.resolvePresetName
 * @param {Function} deps.ensureChatModel
 * @param {Function} deps.learnerBudgetBlock
 * @param {Function} deps.createTurnCollector
 */
export function createSlangComponent(deps) {
  const {
    stateFile, sessionFile, configFile, log, getConfig, isDshReady, getApi,
    resolvePresetName, ensureChatModel, learnerBudgetBlock, createTurnCollector,
  } = deps || {};
  for (const [name, value] of Object.entries({
    stateFile, sessionFile, configFile, log, getConfig, isDshReady, getApi,
    resolvePresetName, ensureChatModel, learnerBudgetBlock, createTurnCollector,
  })) {
    if (value === undefined || value === null) throw new TypeError(`slang 缺少依赖：${name}`);
  }

  // 读失败时（被占用 / 权限 / JSON 损坏）必须**暂停写入**：否则内存里的空数组
  // 会在下一次 saveStore() 时覆盖掉磁盘上那份数据，学到的词条全丢。
  let entries = [];
  let writable = true;
  try {
    entries = loadSlang(stateFile, { onCorrupt: (message) => log(`⚠️ ${message}`) });
  } catch (error) {
    writable = false;
    log(`⚠️ 黑话库加载失败，已暂停写入以免覆盖磁盘数据（修好后重启即可恢复）：${error?.message ?? error}`);
  }

  const windows = new Map();             // key -> [{sender,text,time}]
  const extractionCooldowns = new Map(); // key -> timestamp
  const submitTimes = new Map();         // key -> [timestamp]
  const researchingIds = new Set();      // 正在研究中的候选 id
  const learnerSessions = new Set();     // sessionId -> 学习会话（不映射 QQ，不发送）
  const learnerCollectors = new Map();   // sessionId -> turn collector
  const learnerWaiters = new Map();      // sessionId -> [{resolve,reject,timer}]
  let learnerSessionId = null;
  let taskChain = Promise.resolve();

  function saveStore() {
    if (!writable) {
      log('⚠️ 黑话库处于只读降级状态（启动时加载失败），本次改动不落盘');
      return;
    }
    try {
      const result = saveSlang(stateFile, entries);
      if (result?.dropped > 0) {
        entries = result.entries;
        log(`黑话库超过 ${SLANG_MAX_ENTRIES} 条上限，已按「已确认优先」丢弃 ${result.dropped} 条最不活跃的词条`);
      }
    } catch (error) {
      log('保存黑话库失败:', error?.message ?? error);
    }
  }

  function queueTask(fn) {
    taskChain = taskChain.then(fn).catch((error) => log('黑话学习任务异常:', error?.message ?? error));
    return taskChain;
  }

  async function ensureLearnerSession() {
    const cfg = getConfig();
    const preset = resolvePresetName(cfg.slang?.learnerPreset || cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('黑话学习缺少已验证的安全 preset，拒绝创建或复用会话');
    const saved = readJsonSafe(sessionFile, null);
    // 旧记录没有 preset 元数据，无法证明其权限，必须重新创建。
    if (saved?.preset !== preset) invalidateLearnerSession();
    if (learnerSessionId) {
      learnerSessions.add(learnerSessionId);
      getApi().events.follow(learnerSessionId);
      return learnerSessionId;
    }
    if (saved?.sessionId && saved.preset === preset) {
      // 复用前先确认 DSH 侧那个会话还在：工作区被清理、DSH 重置或归档竞态之后，
      // 这个 id 已经不存在了。以前这里只 follow + selectModel 却**不看返回值**，
      // 于是每个黑话窗口都往一个死会话里发，黑话学习等于永久停摆。
      const candidate = String(saved.sessionId);
      const applied = await ensureChatModel(candidate);
      if (applied === 'not-found') {
        log(`黑话学习会话 ${candidate} 在 DSH 侧已不存在，重建`);
        invalidateLearnerSession();
      } else {
        learnerSessionId = candidate;
        learnerSessions.add(learnerSessionId);
        getApi().events.follow(learnerSessionId);
        return learnerSessionId;
      }
    }
    const api = getApi();
    const dir = path.join(path.dirname(sessionFile), 'slang-agent');
    fs.mkdirSync(dir, { recursive: true });
    const wsValue = unwrap(await api.workspace.create({ path: dir }), 'slang workspace.create');
    const workspaceTitle = cfg.slang?.workspaceTitle || 'QQ 黑话学习';
    if (wsValue.created && workspaceTitle) {
      try { await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: workspaceTitle }); } catch {}
    }
    const params = { workspaceId: wsValue.workspace.workspaceId };
    params.agentPreset = preset;
    const value = unwrap(await api.sessions.create(params), 'slang session.create');
    learnerSessionId = value.sessionId;
    learnerSessions.add(learnerSessionId);
    api.events.follow(learnerSessionId);
    await ensureChatModel(learnerSessionId);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    atomicWriteJson(sessionFile, { sessionId: learnerSessionId, preset });
    log(`黑话学习会话已创建：${learnerSessionId}`);
    return learnerSessionId;
  }

  function invalidateLearnerSession() {
    // 如果在途任务仍在使用旧会话，先保留 learnerSessions 以便事件继续被消费；
    // 没有等待/收集中的旧会话才从集合移除。
    const oldId = learnerSessionId;
    learnerSessionId = null;
    if (oldId && !learnerWaiters.has(oldId) && !learnerCollectors.has(oldId)) {
      learnerSessions.delete(oldId);
    }
    try { fs.unlinkSync(sessionFile); } catch {}
  }

  function waitLearnerTurn(sessionId, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const arr = learnerWaiters.get(sessionId) ?? [];
        const idx = arr.findIndex((w) => w.timer === timer);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) learnerWaiters.delete(sessionId);
        reject(new Error(`等待学习会话 turn 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      const waiter = { resolve, reject, timer };
      const arr = learnerWaiters.get(sessionId) ?? [];
      arr.push(waiter);
      learnerWaiters.set(sessionId, arr);
    });
  }

  async function runExtraction(key) {
    const cfg = getConfig();
    if (cfg.slang?.enabled === false) return;
    if (!isDshReady()) return;
    if (learnerBudgetBlock()) return;
    const messages = windows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;

    let sessionId;
    try {
      sessionId = await ensureLearnerSession();
    } catch (error) {
      log(`黑话学习会话创建失败 (${key}):`, error?.message ?? error);
      return;
    }

    const promptText = buildExtractionPrompt(messages);
    try {
      const accepted = await getApi().sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        const code = String(accepted.result.error?.code ?? '');
        const message = String(accepted.result.error?.message ?? '');
        if (/not[- ]?found/i.test(`${code} ${message}`)) invalidateLearnerSession();
        log(`黑话提取被拒 (${key}): ${code}: ${message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const items = parseExtractionJson(output);
      if (!items.length) {
        log(`黑话提取：${key} 未发现候选`);
        const win = windows.get(key) ?? [];
        windows.set(key, win.slice(messages.length));
        return;
      }
      let added = 0;
      let updated = 0;
      const researchCandidates = [];
      const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
      const seenContents = new Set();
      for (const item of items) {
        if (seenContents.has(item.content)) continue;
        seenContents.add(item.content);
        const idx = Number(item.source_id) - 1;
        const src = Number.isInteger(idx) && idx >= 0 && idx < messages.length ? messages[idx] : null;
        const evidence = src ? [{ key, sender: src.sender, text: src.text, time: src.time }] : [];
        const result = upsertSlangEntry(entries, item.content, { evidence, countIncrement: 1 });
        if (result.created) added += 1; else updated += 1;
        if (result.entry && result.entry.status === SLANG_STATUS.CANDIDATE && thresholds.includes(result.entry.count) && result.entry.count > result.entry.lastInferenceCount) {
          researchCandidates.push(result.entry);
        }
      }
      const win = windows.get(key) ?? [];
      windows.set(key, win.slice(messages.length));
      saveStore();
      log(`黑话提取：${key} 新增 ${added} 条，更新 ${updated} 条`);
      if (researchCandidates.length && cfg.slang?.autoResearch !== false) {
        queueTask(() => runResearch(researchCandidates));
      }
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
        invalidateLearnerSession();
      }
      log(`黑话提取失败 (${key}):`, error?.message ?? error);
    }
  }

  async function runResearch(candidates) {
    const cfg = getConfig();
    if (!candidates || !candidates.length) return;
    if (cfg.slang?.enabled === false) return;
    if (!isDshReady()) return;
    if (learnerBudgetBlock()) return;
    // 过滤掉已经在研究队列里的候选，避免同一批被重复排队研究。
    const targets = candidates.filter((e) => e && !researchingIds.has(e.id));
    if (!targets.length) return;
    for (const e of targets) researchingIds.add(e.id);
    let sessionId;
    try {
      sessionId = await ensureLearnerSession();
    } catch (error) {
      for (const e of targets) researchingIds.delete(e.id);
      log('黑话研究会话创建失败:', error?.message ?? error);
      return;
    }
    const promptText = buildResearchPrompt(targets);
    try {
      const accepted = await getApi().sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        log(`黑话研究被拒: ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const results = parseResearchJson(output);
      for (const r of results) {
        const entry = entries.find((e) => e.content === r.content);
        if (!entry) continue;
        // 只有明确确认（confirmed: true）的结果才写入解释字段；
        // 不确定/未确认的结果保留原状，允许后续再次研究。
        if (r.confirmed !== true) {
          log(`黑话研究：${r.content} 未确认，保留候选待后续研究`);
          continue;
        }
        if (r.meaning) entry.meaning = r.meaning;
        if (r.usage) entry.usage = r.usage;
        if (r.example) entry.example = r.example;
        if (r.risk) entry.risk = r.risk;
        if (Array.isArray(r.sources) && r.sources.length) entry.sources = r.sources.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 10);
        entry.lastInferenceCount = entry.count;
        entry.updatedAt = new Date().toISOString();
      }
      saveStore();
      log(`黑话研究：已更新 ${results.length} 条候选解释`);
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
        invalidateLearnerSession();
      }
      log('黑话研究失败:', error?.message ?? error);
    } finally {
      for (const e of targets) researchingIds.delete(e.id);
    }
  }

  function maybeQueueExtraction(key) {
    const cfg = getConfig();
    if (cfg.slang?.enabled === false) return;
    if (!isDshReady()) return;
    const cooldown = Number(cfg.slang?.extractCooldownMs ?? 300000);
    const last = extractionCooldowns.get(key) ?? 0;
    if (Date.now() - last < cooldown) return;
    const messages = windows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;
    extractionCooldowns.set(key, Date.now());
    queueTask(() => runExtraction(key));
  }

  // 黑话学习素材入口：群聊普通消息进入滚动窗口（命令/角色控制语不学；
  // 只学当前消息自己的文字，不学引用原文）。一代/二代共用。
  function feedWindow(key, sender, plainContent) {
    const cfg = getConfig();
    if (cfg.slang?.enabled === false) return;
    if (!key || !plainContent || typeof plainContent !== 'string') return;
    const text = plainContent.trim();
    if (!text || text.startsWith('/')) return;
    if (/进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(text)) return;
    if (!windows.has(key)) windows.set(key, []);
    const win = windows.get(key);
    win.push({ sender: String(sender || '未知'), text: truncateText(text, 200), time: Date.now() });
    if (win.length > 80) win.splice(0, win.length - 80);
    maybeQueueExtraction(key);
  }

  // AI 提交黑话候选的限频：防止单个会话在短时间内刷大量候选。
  function allowSubmit(key) {
    const now = Date.now();
    const arr = (submitTimes.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    const recentMinute = arr.filter((t) => now - t < 60 * 1000).length;
    const MAX_PER_MINUTE = 2;
    const MAX_PER_HOUR = 10;
    if (recentMinute >= MAX_PER_MINUTE || arr.length >= MAX_PER_HOUR) return false;
    arr.push(now);
    submitTimes.set(key, arr);
    return true;
  }

  // 返回给 AI 的“公开黑话条目”（只含安全展示字段，不泄露内部字段）。
  //
  // 刻意**不含 evidence**：证据行的形状是 `{ key, sender, text, time }`，
  // 其中 text 是提交该词条的那个会话里的消息片段、key 是那个会话的名字。
  // 黑话库是全群共享的，带上 evidence 就等于让 A 群的 AI 读到 B 群的会话名和原话。
  // 控制台要证据走 `GET /api/slang`（原始条目，含 evidence，仅控制台可达）。
  function publicEntry(e) {
    return {
      id: e?.id ?? '',
      content: e?.content ?? '',
      meaning: e?.meaning ?? '',
      usage: e?.usage ?? '',
      example: e?.example ?? '',
      risk: e?.risk ?? '',
      status: e?.status ?? SLANG_STATUS.CANDIDATE,
      source: e?.source ?? 'ai',
      count: Number(e?.count) || 0,
      updatedAt: e?.updatedAt ?? ''
    };
  }

  // 已确认黑话的公开列表（按出现次数排序，最多 injectMax 条）。
  function confirmedList() {
    const max = Math.max(1, Math.min(30, Number(getConfig().slang?.injectMax) || 8));
    return entries
      .filter((e) => e.status === SLANG_STATUS.CONFIRMED && e.content && e.meaning)
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
      .slice(0, max)
      .map(publicEntry);
  }

  function context(max) {
    if (getConfig().slang?.enabled === false) return '';
    return buildSlangContext(entries, max ?? getConfig().slang?.injectMax ?? 8);
  }

  function enabled() {
    return getConfig().slang?.enabled !== false;
  }

  function list(status = '') {
    return status ? entries.filter((e) => e.status === status) : entries;
  }

  function findByContent(content) {
    return entries.find((e) => e.content === content) ?? null;
  }

  /**
   * AI 提交候选（协议层校验通过后调用）。
   * 返回 { ok, statusCode?, ... }，由调用方决定 HTTP 状态与审计日志。
   */
  function submitCandidate({ key, content, context: contextText = '' }) {
    const cfg = getConfig();
    if (!allowSubmit(key)) return { ok: false, error: '黑话提交过于频繁，请稍后再试', statusCode: 429 };
    const existing = entries.find((e) => e.content === content);
    if (existing) {
      if (existing.status === SLANG_STATUS.CONFIRMED) {
        return { ok: true, duplicate: true, status: 'confirmed', entry: publicEntry(existing) };
      }
      if (existing.status === SLANG_STATUS.REJECTED) {
        return { ok: false, error: '该词已被管理员拒绝，如需重新收录请联系管理员', statusCode: 403 };
      }
      existing.count = (Number(existing.count) || 0) + 1;
      if (contextText) {
        existing.evidence = mergeEvidence(existing.evidence, [{ key, sender: 'AI提交', text: contextText.slice(0, 200), time: Date.now() }]);
      }
      existing.updatedAt = new Date().toISOString();
      saveStore();
      if (cfg.slang?.autoResearch !== false) {
        const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
        if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
          queueTask(() => runResearch([existing]));
        }
      }
      log(`[reserved2] AI 再次提交黑话候选「${content}」(${key})，累计 ${existing.count} 次`);
      return { ok: true, duplicate: true, status: 'candidate', entry: publicEntry(existing) };
    }
    const entry = createSlangEntry({
      content,
      source: 'ai',
      status: SLANG_STATUS.CANDIDATE,
      evidence: contextText ? [{ key, sender: 'AI提交', text: contextText.slice(0, 200), time: Date.now() }] : []
    });
    entries.push(entry);
    saveStore();
    if (cfg.slang?.autoResearch !== false) queueTask(() => runResearch([entry]));
    log(`[reserved2] AI 提交黑话候选「${content}」(${key})`);
    return { ok: true, entry: publicEntry(entry) };
  }

  /** 学习会话 turn 事件归集；返回 true 表示该会话归本组件管理。 */
  function collectLearnerEvent(sessionId, event) {
    if (!learnerSessions.has(sessionId)) return false;
    // 与主 collector 同样的道理：**只有 turn/start 才建** collector。
    // 迟到事件（session/end-seed、session/title、model/selection…）不会有 turn/end，
    // 若在这里顺手建一个，它会永远留在 learnerCollectors 里并吞掉后续 turn 事件。
    let collector = learnerCollectors.get(sessionId) ?? null;
    if (!collector && event.type === 'turn/start') {
      collector = createTurnCollector();
      learnerCollectors.set(sessionId, collector);
    }
    const ended = collector ? collector.push(event) : null;
    if (ended) {
      learnerCollectors.delete(sessionId);
      const waiters = learnerWaiters.get(sessionId) ?? [];
      const waiter = waiters.shift();
      if (waiters.length === 0) learnerWaiters.delete(sessionId);
      if (waiter) {
        clearTimeout(waiter.timer);
        if (ended.reason.kind === 'completed' && ended.text.trim()) {
          waiter.resolve(ended.text);
        } else {
          waiter.reject(new Error(`学习会话 turn 未正常完成：${ended.reason.kind}`));
        }
      }
      // 旧学习会话 turn 结束后从集合移除，避免残留
      if (sessionId !== learnerSessionId) learnerSessions.delete(sessionId);
    }
    return true;
  }

  function resetKey(key) {
    windows.delete(key);
    extractionCooldowns.delete(key);
    submitTimes.delete(key);
  }

  function forgetSubmitTimes(key) {
    submitTimes.delete(key);
  }

  function resetAllWindows() {
    windows.clear();
    extractionCooldowns.clear();
    submitTimes.clear();
  }

  function maybeQueueAll() {
    for (const key of [...windows.keys()]) maybeQueueExtraction(key);
  }

  function hasWindow(key) {
    return windows.has(key);
  }

  function firstWindowKey() {
    return windows.keys().next().value ?? '';
  }

  function updateConfig(body) {
    const cfg = getConfig();
    const oldPreset = cfg.slang?.learnerPreset;
    const oldWorkspaceTitle = cfg.slang?.workspaceTitle;
    const file = readConfigObject(configFile);
    const merged = { ...(file.slang ?? {}), ...body };
    if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
    else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
    if (merged.extractMinMessages !== undefined) merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
    if (merged.extractCooldownMs !== undefined) merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
    if (merged.injectMax !== undefined) merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
    if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
    if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
    if (merged.workspaceTitle !== undefined) merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
    if (body.inferenceThresholds !== undefined) {
      const raw = Array.isArray(body.inferenceThresholds)
        ? body.inferenceThresholds
        : String(body.inferenceThresholds).split(/[,，\s]+/);
      merged.inferenceThresholds = [...new Set(raw.map((n) => Math.max(1, Math.round(Number(n) || 1))))].sort((a, b) => a - b);
      if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [2, 4, 8];
    }
    file.slang = merged;
    atomicWriteJson(configFile, file);
    cfg.slang = { ...cfg.slang, ...merged };
    if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
      invalidateLearnerSession();
      log('黑话学习 preset 已变更，已重置学习会话');
    } else if (body.workspaceTitle !== undefined && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
      invalidateLearnerSession();
      log('黑话学习工作区名已变更，已重置学习会话');
    }
    log('控制台：黑话系统配置已更新');
    return cfg.slang;
  }

  function addManual(body) {
    const content = String(body.content ?? '').trim();
    if (!content) throw fail('黑话内容不能为空');
    if (entries.some((e) => e.content === content)) throw fail(`黑话「${content}」已存在`);
    const entry = createSlangEntry({
      content,
      meaning: String(body.meaning ?? '').trim(),
      usage: String(body.usage ?? '').trim(),
      example: String(body.example ?? '').trim(),
      risk: String(body.risk ?? '').trim(),
      sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
      status: body.status === SLANG_STATUS.CANDIDATE ? SLANG_STATUS.CANDIDATE : SLANG_STATUS.CONFIRMED,
      source: 'manual',
      evidence: Array.isArray(body.evidence) ? body.evidence : []
    });
    entries.push(entry);
    saveStore();
    log(`控制台：新增黑话「${content}」`);
    return entry;
  }

  function clear({ status = '' } = {}) {
    if (status && !STATUSES.includes(status)) {
      throw fail(`无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除`);
    }
    let removedCount = 0;
    if (status) {
      removedCount = entries.filter((e) => e.status === status).length;
      entries = entries.filter((e) => e.status !== status);
    } else {
      removedCount = entries.length;
      entries = [];
      // 清空所有时同步清掉待提取窗口和冷却，避免“删了又回来”
      windows.clear();
      extractionCooldowns.clear();
      submitTimes.clear();
      researchingIds.clear();
    }
    saveStore();
    log(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
    return removedCount;
  }

  function batchDelete({ ids = [], status = '' }) {
    const idList = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
    if (idList.length) {
      const idSet = new Set(idList);
      const before = entries.length;
      entries = entries.filter((e) => !idSet.has(e.id));
      const removedCount = before - entries.length;
      if (!removedCount) throw fail('没有匹配到要删除的黑话', 404);
      saveStore();
      log(`控制台：批量删除黑话 ${removedCount} 条`);
      return removedCount;
    }
    if (status && !STATUSES.includes(status)) throw fail(`无效的 status：${status}`);
    if (!status) throw fail('请提供 ids 或 status');
    const removedCount = entries.filter((e) => e.status === status).length;
    entries = entries.filter((e) => e.status !== status);
    saveStore();
    log(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
    return removedCount;
  }

  function batchConfirm(ids = []) {
    const idList = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
    if (!idList.length) throw fail('请选择要确认的黑话');
    let confirmedCount = 0;
    let skippedCount = 0;
    const skipped = [];
    for (const id of idList) {
      const idx = entries.findIndex((e) => e.id === id);
      if (idx < 0) { skippedCount++; skipped.push({ id, reason: '不存在' }); continue; }
      const entry = entries[idx];
      if (entry.status !== SLANG_STATUS.CANDIDATE) { skippedCount++; skipped.push({ id, content: entry.content, reason: '不是候选' }); continue; }
      if (!entry.meaning || !String(entry.meaning).trim()) { skippedCount++; skipped.push({ id, content: entry.content, reason: '缺少含义' }); continue; }
      entry.status = SLANG_STATUS.CONFIRMED;
      entry.updatedAt = new Date().toISOString();
      confirmedCount++;
    }
    if (confirmedCount) saveStore();
    log(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
    return { confirmedCount, skippedCount, skipped: skipped.slice(0, 20) };
  }

  function batchReject(ids = []) {
    const idList = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
    if (!idList.length) throw fail('请选择要拒绝的黑话');
    let rejectedCount = 0;
    for (const id of idList) {
      const idx = entries.findIndex((e) => e.id === id);
      if (idx < 0) continue;
      const entry = entries[idx];
      if (entry.status === SLANG_STATUS.REJECTED) continue;
      entry.status = SLANG_STATUS.REJECTED;
      entry.updatedAt = new Date().toISOString();
      rejectedCount++;
    }
    if (rejectedCount) saveStore();
    log(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
    return rejectedCount;
  }

  function update(id, body) {
    const idx = entries.findIndex((e) => e.id === id);
    if (idx < 0) throw fail('黑话不存在', 404);
    const entry = { ...entries[idx] };
    if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
    if (body.content !== undefined && entries.some((e) => e.id !== id && e.content === entry.content)) {
      throw fail(`黑话「${entry.content}」已存在`);
    }
    if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
    if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
    if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
    if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
    if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
    if (body.status !== undefined && STATUSES.includes(body.status)) entry.status = body.status;
    if (!entry.content) throw fail('黑话内容不能为空');
    entry.updatedAt = new Date().toISOString();
    entries[idx] = entry;
    saveStore();
    log(`控制台：更新黑话「${entry.content}」`);
    return entry;
  }

  function confirm(id, body = {}) {
    const idx = entries.findIndex((e) => e.id === id);
    if (idx < 0) throw fail('黑话不存在', 404);
    const entry = entries[idx];
    if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
    if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
    if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
    if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
    if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
    if (!entry.meaning) throw fail('请先填写含义再确认，否则不会注入 AI 上下文');
    entry.status = SLANG_STATUS.CONFIRMED;
    entry.updatedAt = new Date().toISOString();
    saveStore();
    log(`控制台：确认黑话「${entry.content}」`);
    return entry;
  }

  function reject(id) {
    const idx = entries.findIndex((e) => e.id === id);
    if (idx < 0) throw fail('黑话不存在', 404);
    const entry = entries[idx];
    entry.status = SLANG_STATUS.REJECTED;
    entry.updatedAt = new Date().toISOString();
    saveStore();
    log(`控制台：拒绝黑话「${entry.content}」`);
    return entry;
  }

  function remove(id) {
    const idx = entries.findIndex((e) => e.id === id);
    if (idx < 0) throw fail('黑话不存在', 404);
    const [removed] = entries.splice(idx, 1);
    saveStore();
    log(`控制台：删除黑话「${removed.content}」`);
    return removed;
  }

  function configForClient() {
    return getConfig().slang;
  }

  const api = {
    writable: () => writable,
    enabled,
    entries: () => entries,
    list,
    publicEntry,
    confirmedList,
    findByContent,
    context,
    feedWindow,
    maybeQueueExtraction,
    maybeQueueAll,
    hasWindow,
    firstWindowKey,
    queueExtraction: (key) => queueTask(() => runExtraction(key)),
    researchCandidates: (candidates) => queueTask(() => runResearch(candidates)),
    submitCandidate,
    collectLearnerEvent,
    ownsSession: (sessionId) => learnerSessions.has(sessionId),
    activeSessionId: () => learnerSessionId,
    resetKey,
    forgetSubmitTimes,
    resetAllWindows,
    updateConfig,
    addManual,
    clear,
    batchDelete,
    batchConfirm,
    batchReject,
    update,
    confirm,
    reject,
    remove,
    configForClient,
  };

  const routes = [
    {
      method: 'GET',
      path: '/api/slang',
      handle: (ctx, io) => {
        const status = io.url.searchParams.get('status') || '';
        io.sendJson({ entries: list(status), config: configForClient(), writable });
      },
    },
    {
      method: 'POST',
      path: '/api/slang',
      handle: async (ctx, io) => {
        const entry = addManual(await io.readBody());
        io.sendJson({ ok: true, entry });
      },
    },
    {
      method: 'POST',
      path: '/api/slang/clear',
      handle: async (ctx, io) => {
        const body = await io.readBody();
        io.sendJson({ ok: true, removedCount: clear({ status: String(body.status ?? '').trim() }) });
      },
    },
    {
      method: 'POST',
      path: '/api/slang/batch-delete',
      handle: async (ctx, io) => {
        const body = await io.readBody();
        io.sendJson({ ok: true, removedCount: batchDelete({ ids: body.ids, status: String(body.status ?? '').trim() }) });
      },
    },
    {
      method: 'POST',
      path: '/api/slang/batch-confirm',
      handle: async (ctx, io) => {
        const body = await io.readBody();
        io.sendJson({ ok: true, ...batchConfirm(body.ids) });
      },
    },
    {
      method: 'POST',
      path: '/api/slang/batch-reject',
      handle: async (ctx, io) => {
        const body = await io.readBody();
        io.sendJson({ ok: true, rejectedCount: batchReject(body.ids) });
      },
    },
    {
      method: 'POST',
      path: '/api/slang/extract',
      handle: async (ctx, io) => {
        if (!enabled()) throw fail('黑话学习已关闭（slang.enabled=false）');
        const body = await io.readBody();
        const key = String(body.key ?? '').trim();
        if (key && hasWindow(key)) {
          queueTask(() => runExtraction(key));
          io.sendJson({ ok: true, key });
          return;
        }
        const firstKey = firstWindowKey();
        if (!firstKey) throw fail('当前没有可学习消息窗口');
        queueTask(() => runExtraction(firstKey));
        io.sendJson({ ok: true, key: firstKey });
      },
    },
    {
      method: 'POST',
      path: '/api/slang/research',
      handle: async (ctx, io) => {
        if (!enabled()) throw fail('黑话学习已关闭（slang.enabled=false）');
        const body = await io.readBody();
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        const candidates = ids.length
          ? entries.filter((e) => ids.includes(e.id) && e.status === SLANG_STATUS.CANDIDATE)
          : entries.filter((e) => e.status === SLANG_STATUS.CANDIDATE);
        if (!candidates.length) throw fail('没有可研究的候选黑话');
        queueTask(() => runResearch(candidates));
        io.sendJson({ ok: true, count: candidates.length });
      },
    },
    {
      method: 'POST',
      path: '/api/slang/config',
      handle: async (ctx, io) => {
        const body = await io.readBody();
        io.sendJson({ ok: true, config: updateConfig(body) });
      },
    },
    {
      method: 'PATCH',
      pattern: /^\/api\/slang\/([^/]+)$/,
      handle: async (ctx, io) => {
        const entry = update(io.params[0], await io.readBody());
        io.sendJson({ ok: true, entry });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/slang\/([^/]+)\/confirm$/,
      handle: async (ctx, io) => {
        const entry = confirm(io.params[0], await io.readBody());
        io.sendJson({ ok: true, entry });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/slang\/([^/]+)\/reject$/,
      handle: (ctx, io) => {
        io.sendJson({ ok: true, entry: reject(io.params[0]) });
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/slang\/([^/]+)$/,
      handle: (ctx, io) => {
        io.sendJson({ ok: true, removed: remove(io.params[0]) });
      },
    },
  ];

  return defineComponent({
    id: 'slang',
    init: () => api,
    routes,
  });
}
