/**
 * 人格路由（组件化迁移 #11）。
 *
 * 从 backend/lib/index.js 的 apply(ctx) 闭包里原样搬出，只把闭包依赖改成显式注入：
 *   · /persona          人格四层编辑（核心 / 语气 / 语料 / 日常 / 场景）
 *   · /persona/classify 自然语言 → 分层草稿
 *   · /persona/state    情绪与口头禅的读写（QQ / 桌宠 / 抖音共用）
 *
 * 保留在 index.js：路由分发，以及只读降级/鉴权等全局前置逻辑。
 */
import fs from 'node:fs';
import path from 'node:path';

export function createPersonaRoutes(deps) {
  const {
    API_PREFIX,
    activePersonaLayers, resolvePersonaFile,
    readTextFile, listBackups, mtimeIso, safeBackupName,
    personaPresetStatus, syncPersonaSystemPreset,
    BACKUP_DIR, backupFile, writeTextAtomic,
    readCurrentCharacter, touchCharacter,
    readUnified, readQqConfig, adminSummary,
    personaClassifier, scanText,
    personaSnapshot, setPersonaQuirks, setPersonaMood,
    readJsonBody, json, pluginLog,
  } = deps || {};

  const required = {
    API_PREFIX,
    activePersonaLayers, resolvePersonaFile,
    readTextFile, listBackups, mtimeIso, safeBackupName,
    personaPresetStatus, syncPersonaSystemPreset,
    BACKUP_DIR, backupFile, writeTextAtomic,
    readCurrentCharacter, touchCharacter,
    readUnified, readQqConfig, adminSummary,
    personaClassifier, scanText,
    personaSnapshot, setPersonaQuirks, setPersonaMood,
    readJsonBody, json, pluginLog,
  };
  for (const [name, value] of Object.entries(required)) {
    if (value === undefined || value === null) throw new TypeError(`persona-routes 缺少依赖：${name}`);
  }

  function personaIdentityLine() {
    const cur = readCurrentCharacter();
    const name = String(cur?.name || '').trim() || '这个角色';
    let admin = {};
    try {
      const unified = readUnified();
      const qq = readQqConfig();
      admin = adminSummary(unified?.config?.admin ?? qq?.config?.admin);
    } catch {}
    const owner = String(admin?.displayName || '').trim() || '主人';
    return `你是${name}；你的主人是${owner}。`;
  }

  function withDailyIdentity(text, identity = personaIdentityLine()) {
    const body = String(text ?? '').trim();
    if (!body) return identity;
    if (body.includes(identity)) return body;
    // 已有明确“我是谁/主人是谁”的旧日常也保留，不重复堆。
    if (/你是|我是/.test(body) && /主人/.test(body)) return body;
    return `${identity}

${body}`;
  }

  async function handlePersonaClassify(req, res) {
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, code: 'PERSONA_CLASSIFY_METHOD', error: '只支持 POST' });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const text = String(body.text ?? '');
      const drafts = await personaClassifier.classify(text);
      drafts.daily = withDailyIdentity(drafts.daily);
      json(res, 200, { ok: true, drafts, note: '这是草稿；请检查/编辑后逐层保存。' });
    } catch (error) {
      json(res, 400, {
        ok: false,
        code: String(error?.code || 'PERSONA_CLASSIFY_FAILED'),
        error: String(error?.message ?? error),
        hint: String(error?.code || '').includes('UNAVAILABLE')
          ? '确认 DSH 模型服务已就绪；也可以手动填写各层'
          : '检查人格卡内容，或手动填写各层',
      });
    }
  }

  async function handlePersona(req, res) {
    const layerPaths = () => {
      const layers = activePersonaLayers();
      return layers ? {
        core: layers.core || resolvePersonaFile(),
        daily: layers.daily,
        tone: layers.tone,
        examples: layers.examples,
        scenes: layers.scenes,
        scenesDir: layers.scenesDir,
      } : { core: resolvePersonaFile(), daily: '', tone: '', examples: '', scenes: {}, scenesDir: '' };
    };
    const sceneLabels = { 'qq-group': 'QQ 群聊', 'qq-private': 'QQ 私聊', bili: 'B站', pet: '桌宠' };
    if (req.method === 'GET') {
      const paths = layerPaths();
      const core = readTextFile(paths.core);
      const daily = paths.daily ? withDailyIdentity(readTextFile(paths.daily)) : withDailyIdentity('');
      const scenes = {};
      for (const [id, file] of Object.entries(paths.scenes || {})) {
        scenes[id] = { path: file, text: readTextFile(file), chars: readTextFile(file).length };
      }
      const backups = listBackups(120).filter((item) => /^persona(?:-|$)/.test(item.name));
      json(res, 200, {
        ok: true,
        path: paths.core,
        text: core,
        chars: core.length,
        mtime: mtimeIso(paths.core),
        layers: {
          core: { path: paths.core, text: core, chars: core.length },
          tone: { path: paths.tone, text: readTextFile(paths.tone), chars: readTextFile(paths.tone).length },
          examples: { path: paths.examples, text: readTextFile(paths.examples), chars: readTextFile(paths.examples).length },
          daily: { path: paths.daily, text: daily, chars: daily.length },
          scenes,
        },
        sceneLabels,
        backups,
        // 设置页要显示「人格有没有进 Agent 预设、要不要重启」。
        presetSync: (() => { try { return personaPresetStatus(); } catch (error) { return { ok: false, error: String(error?.message ?? error) }; } })(),
        note: '人格卡分层：persona.md 是核心（身份+底线）；persona.tone.md 是行为规则；persona.examples.md 是对话语料；persona.daily.md 是日常；persona.scenes/* 是场景。所有层都手动编辑，不会自动改写。',
      });
      return;
    }
    const body = await readJsonBody(req);
    if (body.action === 'restore') {
      const name = safeBackupName(body.name);
      if (!name) { json(res, 400, { ok: false, error: '备份名非法' }); return; }
      const source = path.join(BACKUP_DIR, name);
      if (!fs.existsSync(source)) { json(res, 404, { ok: false, code: 'PERSONA_BACKUP_MISSING', error: '备份不存在', hint: '刷新备份列表后重试' }); return; }
      const paths = layerPaths();
      let target = paths.core;
      let label = 'persona';
      if (name.startsWith('persona-daily-')) { target = paths.daily; label = 'persona-daily'; }
      else if (name.startsWith('persona-tone-')) { target = paths.tone; label = 'persona-tone'; }
      else if (name.startsWith('persona-examples-')) { target = paths.examples; label = 'persona-examples'; }
      else if (name.startsWith('persona-scene-')) {
        const scene = Object.keys(sceneLabels).find((id) => name.startsWith(`persona-scene-${id}-`));
        if (!scene) { json(res, 400, { ok: false, code: 'PERSONA_SCENE_UNKNOWN', error: '备份对应的场景未知', hint: '检查备份文件名' }); return; }
        target = paths.scenes?.[scene] || '';
        label = `persona-scene-${scene}`;
      }
      if (!target) { json(res, 400, { ok: false, code: 'PERSONA_LAYER_UNAVAILABLE', error: '这个层在当前角色里没有路径（可能未启用角色系统）', hint: '先创建/加载角色' }); return; }
      backupFile(target, label);
      fs.copyFileSync(source, target);
      const cur = readCurrentCharacter();
      if (cur) touchCharacter(cur.id);
      syncPersonaSystemPreset({ log: pluginLog });
      json(res, 200, { ok: true, restored: name, target, text: readTextFile(target), layers: layerPaths() });
      return;
    }
    const layer = String(body.layer || 'core');
    const scene = String(body.scene || '');
    const paths = layerPaths();
    let target = paths.core;
    let label = 'persona';
    if (layer === 'tone') {
      target = paths.tone;
      label = 'persona-tone';
    } else if (layer === 'examples') {
      target = paths.examples;
      label = 'persona-examples';
    } else if (layer === 'daily') {
      target = paths.daily;
      label = 'persona-daily';
    } else if (layer === 'scene') {
      if (!sceneLabels[scene]) { json(res, 400, { ok: false, code: 'PERSONA_SCENE_UNKNOWN', error: `未知场景：${scene}`, hint: '只支持 qq-group / qq-private / bili / pet' }); return; }
      target = paths.scenes?.[scene] || '';
      label = `persona-scene-${scene}`;
    }
    if (!target) {
      json(res, 400, { ok: false, code: 'PERSONA_LAYER_UNAVAILABLE', error: '这个层在当前角色里没有路径（可能未启用角色系统）', hint: '先创建/加载角色' });
      return;
    }
    const text = String(body.text ?? '');
    if (layer === 'core' && text.length < 50) { json(res, 400, { ok: false, code: 'PERSONA_CORE_TOO_SHORT', error: '人格核心太短（至少 50 字）', hint: '核心卡是每次注入的底座，不能留空' }); return; }
    if (text.length > 64 * 1024) { json(res, 400, { ok: false, code: 'PERSONA_TOO_LARGE', error: '人格内容超过 64KB', hint: '拆成核心/场景/日常层，或精简内容' }); return; }
    const scan = scanText(text);
    const severe = scan.secrets.length > 0 || scan.pii.some((hit) => hit.severe);
    if (severe) {
      json(res, 400, {
        ok: false,
        code: 'PERSONA_SENSITIVE',
        error: '人格内容里命中密钥/密码/身份证/住址规则，拒绝保存',
        hint: '删掉这些内容后再保存；人格卡不应包含凭据',
        labels: [...new Set([...scan.secrets, ...scan.pii.filter((h) => h.severe)].map((h) => h.label))],
      });
      return;
    }
    const backup = backupFile(target, label);
    writeTextAtomic(target, text.endsWith('\n') ? text : `${text}\n`);
    const cur = readCurrentCharacter();
    if (cur) touchCharacter(cur.id);
    // 人格层变更 → 同步烘焙进 Agent 预设的 system prompt（重启 DSH 后生效）。
    const presetSync = syncPersonaSystemPreset({ log: pluginLog });
    json(res, 200, { ok: true, layer, scene: layer === 'scene' ? scene : '', chars: text.length, backup, path: target, layers: layerPaths(), presetSync: { changed: presetSync.changed, restartRequired: presetSync.changed } });
  }

  // ── 人格状态（情绪 / 口头禅）：读改都走这里，QQ/桌宠/抖音共用 ──────────────
  // 注意：不要叫 handlePersona —— 上面已有同名函数（人格四层编辑），同名声明会把它整个覆盖掉，
  //       /persona 就会拿不到 url 参数而报 "reading 'pathname'"（2026-11 实测的读取失败）。
  async function handlePersonaState(req, res, url) {
    const parsed = url && typeof url.pathname === 'string' ? url : new URL(req.url || '/', 'http://127.0.0.1');
    const suffix = parsed.pathname.slice(`${API_PREFIX}/persona`.length) || '/state';
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'GET' && (suffix === '' || suffix === '/state')) {
      json(res, 200, personaSnapshot());
      return;
    }
    if (method === 'POST' && suffix === '/config') {
      let body = {};
      try { body = await readJsonBody(req); } catch { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
      try {
        if (Array.isArray(body.quirks)) setPersonaQuirks(body.quirks);
        if (typeof body.mood === 'string') setPersonaMood(body.mood, String(body.note || ''));
        json(res, 200, personaSnapshot());
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error).slice(0, 160) });
      }
      return;
    }
    json(res, 404, { ok: false, error: `未知人格接口：${suffix}` });
  }

  return { handlePersona, handlePersonaClassify, handlePersonaState, withDailyIdentity };
}
