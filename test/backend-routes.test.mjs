/**
 * 后端路由功能族（#11）的边界回归：依赖契约 + 路由形状 + 关键副作用。
 * 路由体是从 backend/lib/index.js 原样搬出的，这里只验证搬出后的接口约定。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPersonaRoutes } from '../backend/lib/routes/persona.js';
import { createLearningRoutes } from '../backend/lib/routes/learning.js';
import { createBridgeProxyRoutes } from '../backend/lib/routes/bridge-proxy.js';
import { createPetPurposeRoutes } from '../backend/lib/routes/pet-purpose.js';
import { createDouyinRoutes } from '../backend/lib/routes/douyin.js';
import { createConfigRoutes } from '../backend/lib/routes/config.js';
import { createCharacterRoutes } from '../backend/lib/routes/characters.js';

function makeRes() {
  const out = { status: 0, body: null };
  const json = (res, status, body) => { out.status = status; out.body = body; };
  return { out, json };
}

function makePersonaDeps(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dfy-persona-'));
  const files = {
    [path.join(dir, 'persona.md')]: '核心人格'.repeat(20),
    [path.join(dir, 'tone.md')]: '语气规则',
    [path.join(dir, 'examples.md')]: '语料',
    [path.join(dir, 'daily.md')]: '',
    [path.join(dir, 'group.md')]: '群聊场景',
  };
  let touches = 0;
  let quirks = [];
  let mood = '平静';
  const deps = {
    API_PREFIX: '/api',
    activePersonaLayers: () => ({
      core: path.join(dir, 'persona.md'),
      daily: path.join(dir, 'daily.md'),
      tone: path.join(dir, 'tone.md'),
      examples: path.join(dir, 'examples.md'),
      scenes: { 'qq-group': path.join(dir, 'group.md') },
      scenesDir: dir,
    }),
    resolvePersonaFile: () => path.join(dir, 'persona.md'),
    readTextFile: (file) => files[file] ?? '',
    listBackups: () => [{ name: 'persona-1.md' }, { name: 'other.json' }],
    mtimeIso: () => '2026-11-17T00:00:00.000Z',
    safeBackupName: (name) => String(name ?? ''),
    personaPresetStatus: () => ({ ok: true }),
    syncPersonaSystemPreset: () => ({ changed: false }),
    BACKUP_DIR: dir,
    backupFile: (target, label) => ({ target, label }),
    writeTextAtomic: (target, text) => { files[target] = text; },
    readCurrentCharacter: () => ({ id: 'c1', name: '小鲸鱼' }),
    touchCharacter: () => { touches += 1; },
    readUnified: () => ({ config: { admin: { displayName: '主人甲' } } }),
    readQqConfig: () => ({ config: {} }),
    adminSummary: (admin) => ({ displayName: String(admin?.displayName ?? '') }),
    personaClassifier: { classify: async () => ({ core: '', daily: '日常草稿' }) },
    scanText: () => ({ secrets: [], pii: [] }),
    personaSnapshot: () => ({ quirks, mood }),
    setPersonaQuirks: (next) => { quirks = next; },
    setPersonaMood: (next, note) => { mood = next + (note ? `（${note}）` : ''); },
    readJsonBody: async (req) => req.body ?? {},
    json: null,
    pluginLog: () => {},
    ...overrides,
  };
  return { deps, files, dir, getTouches: () => touches, getState: () => ({ quirks, mood }) };
}

test('路由工厂缺少依赖时构造即失败', () => {
  assert.throws(() => createPersonaRoutes({}), /persona-routes 缺少依赖/);
  assert.throws(() => createLearningRoutes({}), /learning-routes 缺少依赖/);
  assert.throws(() => createBridgeProxyRoutes({}), /bridge-proxy-routes 缺少依赖/);
  assert.throws(() => createPetPurposeRoutes({}), /pet-purpose-routes 缺少依赖/);
  assert.throws(() => createDouyinRoutes({}), /douyin-routes 缺少依赖/);
  assert.throws(() => createConfigRoutes({}), /config-routes 缺少依赖/);
  assert.throws(() => createCharacterRoutes({}), /character-routes 缺少依赖/);
});

test('GET /persona 返回分层内容，日常层自动补身份行', async () => {
  const { deps } = makePersonaDeps();
  const { out, json } = makeRes();
  const routes = createPersonaRoutes({ ...deps, json });
  await routes.handlePersona({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/persona'));
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.match(out.body.layers.daily.text, /你是小鲸鱼；你的主人是主人甲。/);
  assert.equal(out.body.backups.length, 1);
  assert.equal(out.body.backups[0].name, 'persona-1.md');
});

test('POST /persona 保存日常层并触碰角色；核心层过短被拒', async () => {
  const { deps, files, dir, getTouches } = makePersonaDeps();
  const { out, json } = makeRes();
  const routes = createPersonaRoutes({ ...deps, json });
  await routes.handlePersona(
    { method: 'POST', body: { layer: 'daily', text: '今天很安静' } },
    {},
    new URL('http://127.0.0.1/api/persona'),
  );
  assert.equal(out.status, 200);
  assert.equal(files[path.join(dir, 'daily.md')], '今天很安静\n');
  assert.equal(getTouches(), 1);

  await routes.handlePersona(
    { method: 'POST', body: { layer: 'core', text: '太短' } },
    {},
    new URL('http://127.0.0.1/api/persona'),
  );
  assert.equal(out.status, 400);
  assert.equal(out.body.code, 'PERSONA_CORE_TOO_SHORT');
});

test('POST /persona/classify 给草稿补身份行', async () => {
  const { deps } = makePersonaDeps();
  const { out, json } = makeRes();
  const routes = createPersonaRoutes({ ...deps, json });
  await routes.handlePersonaClassify(
    { method: 'POST', body: { text: '随便写写' } },
    {},
  );
  assert.equal(out.status, 200);
  assert.match(out.body.drafts.daily, /你是小鲸鱼/);
});

test('人格状态：GET 读快照，POST /config 改情绪与口头禅', async () => {
  const { deps, getState } = makePersonaDeps();
  const { out, json } = makeRes();
  const routes = createPersonaRoutes({ ...deps, json });
  await routes.handlePersonaState({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/persona/state'));
  assert.equal(out.body.mood, '平静');
  await routes.handlePersonaState(
    { method: 'POST', body: { quirks: ['嗯'], mood: '开心', note: '刚聊完' } },
    {},
    new URL('http://127.0.0.1/api/persona/config'),
  );
  assert.deepEqual(getState(), { quirks: ['嗯'], mood: '开心（刚聊完）' });
  assert.equal(out.status, 200);
});

test('学习路由：状态直读、配置夹取范围并重建定时器', async () => {
  let started = 0;
  let stopped = 0;
  let saved = null;
  const { out, json } = makeRes();
  const routes = createLearningRoutes({
    API_PREFIX: '/api',
    learningLoop: {
      status: () => ({ ok: true, enabled: true }),
      run: async () => ({ ok: true, ran: true }),
      start: () => { started += 1; },
      stop: () => { stopped += 1; },
    },
    rollbackAutoPersona: () => ({ ok: true }),
    saveUnified: (patch) => { saved = patch; },
    readJsonBody: async (req) => req.body ?? {},
    json,
  });
  await routes.handleLearning({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/learning/status'));
  assert.equal(out.body.ok, true);

  await routes.handleLearning(
    { method: 'POST', body: { intervalHours: 999, minItems: 0 } },
    {},
    new URL('http://127.0.0.1/api/learning/config'),
  );
  assert.deepEqual(saved, { learning: { intervalHours: 48, minItems: 1 } });
  assert.equal(stopped, 1);
  assert.equal(started, 1);

  await routes.handleLearning({ method: 'POST' }, {}, new URL('http://127.0.0.1/api/learning/nope'));
  assert.equal(out.status, 404);
});

test('桥接代理：群策略成功透传，桥接不可用时 502', async () => {
  const { out, json } = makeRes();
  const ok = createBridgeProxyRoutes({
    callBridge: async () => ({ ok: true, data: { tiers: ['a'] } }),
    readJsonBody: async (req) => req.body ?? {},
    json,
  });
  await ok.handleGroupPolicy({ method: 'GET' }, {});
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { tiers: ['a'] });

  const down = createBridgeProxyRoutes({
    callBridge: async () => ({ ok: false, error: 'down' }),
    readJsonBody: async (req) => req.body ?? {},
    json,
  });
  await down.handleGroupPolicy({ method: 'GET' }, {});
  assert.equal(out.status, 502);
  assert.equal(out.body.code, 'GROUP_POLICY_BRIDGE');
});

test('桌宠 / 目的路由：状态、测一句话与载体路由', async () => {
  const emitted = [];
  const { out, json } = makeRes();
  const routes = createPetPurposeRoutes({
    API_PREFIX: '/api',
    readQqConfig: () => ({ config: { purpose: { carrier: 'pet', petModality: 'voice' } } }),
    readJsonBody: async (req) => req.body ?? {},
    json,
    petService: { status: () => ({ installed: true, running: true, external: {} }) },
    petChat: {
      setFocus: () => ({ focus: true }),
      chat: async () => ({ ok: true, reply: { text: '嗨', modality: 'text', id: 'm1' } }),
      emit: (event) => { emitted.push(event); return 'ev1'; },
      status: () => ({ presence: { online: true } }),
      online: () => ({ online: true, lastSeenAt: 1 }),
      focusEnabled: () => true,
      roleInfo: () => ({ name: '小鲸鱼' }),
    },
    petPurpose: {
      status: () => ({ enabled: true, modality: 'text', fallbackToQQ: true, ownerName: '主人', config: {}, state: {}, online: true }),
      preview: async () => ({ ok: true, text: '预览' }),
      run: async () => ({ ok: true }),
    },
    bridgeStatus: async () => ({ running: true, ok: true }),
    callBridge: async () => ({ status: 200, data: { ok: true } }),
  });

  await routes.handlePet({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/pet/status'));
  assert.equal(out.body.installed, true);

  await routes.handlePet({ method: 'POST', body: { text: '在吗' } }, {}, new URL('http://127.0.0.1/api/pet/chat-test'));
  assert.equal(out.body.ok, true);
  assert.equal(emitted[0].text, '嗨');
  assert.equal(emitted[0].messageId, 'm1');

  await routes.handlePurpose({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/purpose/status'));
  assert.equal(out.body.source, 'pet');
  assert.equal(out.body.ownerName, '主人');

  await routes.handlePurpose({ method: 'POST', body: {} }, {}, new URL('http://127.0.0.1/api/purpose/pet-chat'));
  assert.equal(out.body.ok, true);
});

test('抖音路由：状态直读、未知动作 400、apply 同步策略', async () => {
  let synced = 0;
  const { out, json } = makeRes();
  const asyncOk = async () => ({ ok: true });
  const deps = {
    readJsonBody: async (req) => req.body ?? {},
    json,
    pluginLog: () => {},
    douyinSyncPolicy: () => { synced += 1; },
    readDouyinHistory: () => ({ videos: [] }),
    douyinStatus: async () => ({ ok: true, config: { enabled: false } }),
    douyinOpen: asyncOk, douyinCurrent: asyncOk, douyinNext: asyncOk, douyinSearch: asyncOk,
    douyinStart: asyncOk, douyinStop: asyncOk, douyinSummary: () => ({ ok: true }),
    douyinComments: asyncOk, douyinNotices: asyncOk, douyinDebrief: asyncOk,
    douyinChatStatus: asyncOk, douyinChatContacts: asyncOk, douyinChatConfigure: asyncOk,
    douyinChatStart: asyncOk, douyinChatStop: asyncOk, douyinChatRead: asyncOk,
    douyinChatMinimize: asyncOk, douyinChatModels: asyncOk, douyinChatSetModel: asyncOk,
    douyinChatSetup: asyncOk, douyinChatEnable: asyncOk, douyinChatRecover: asyncOk,
    douyinImStatus: () => ({ ok: true }), douyinImLoginQr: asyncOk, douyinImLoginSms: asyncOk,
    douyinImSubmitSms: asyncOk, douyinImLogout: asyncOk, douyinImContacts: asyncOk,
    douyinImSaveConfig: () => ({ ok: true }), douyinImStart: asyncOk, douyinImStop: asyncOk,
    douyinImSelftest: asyncOk,
  };
  const routes = createDouyinRoutes(deps);

  await routes.handleDouyin({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/douyin'));
  assert.equal(out.body.config.enabled, false);

  await routes.handleDouyin({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/douyin/history'));
  assert.deepEqual(out.body, { videos: [] });

  await routes.handleDouyin({ method: 'POST', body: { action: 'unknown' } }, {}, new URL('http://127.0.0.1/api/douyin'));
  assert.equal(out.status, 400);

  await routes.handleDouyin({ method: 'POST', body: { action: 'apply' } }, {}, new URL('http://127.0.0.1/api/douyin'));
  assert.equal(synced, 1);
  assert.equal(out.status, 200);
});

function makeConfigDeps(overrides = {}) {
  const calls = [];
  const deps = {
    STATE_DIR: 'C:/state', QQ_CONFIG: 'C:/state/qq.json', BILI_CONFIG: 'C:/state/bili.json',
    readAll: () => ({ qq: {}, bili: {}, unified: {} }),
    configDefaults: () => ({ qq: {} }),
    pathSummary: () => ({ state: 'C:/state' }),
    listBackups: () => [],
    fileStamp: () => 's1',
    isStale: (a, b) => a !== b,
    readQqConfig: () => ({ config: {} }),
    readBiliConfig: () => ({ config: {} }),
    readUnified: () => ({ config: {}, hasAdmin: false }),
    adminFromSources: () => ({}),
    projectAdminSave: ({ unified, qq, bili }) => ({ unified, qq, bili }),
    normalizeAllowlist: ({ allow }) => ({ allow, warnings: [] }),
    saveQqConfig: () => { calls.push('saveQq'); return { config: {}, backup: '' }; },
    saveBiliConfig: () => { calls.push('saveBili'); return { config: {}, backup: '' }; },
    saveUnified: () => { calls.push('saveUnified'); return { config: {} }; },
    writeAlignmentBriefs: () => calls.push('briefs'),
    douyinSyncPolicy: () => calls.push('douyin'),
    douyinChatResume: async () => calls.push('chatResume'),
    startSyncTimer: () => calls.push('syncTimer'),
    runMemoryCardMaintenance: async () => { calls.push('memoryCard'); return { status: 'ok', changed: false }; },
    syncQqToBili: () => ({ ok: true }),
    platformStartState: () => ({ qq: true, bili: true }),
    platformStartEnabled: () => true,
    invalidateScheduler: () => calls.push('invalidate'),
    retireScheduler: async () => calls.push('retire'),
    resetSchedulerIdle: (reason) => ({ running: false, reason }),
    startSchedulerNow: () => ({ running: true }),
    stopBridge: async () => ({ ok: true }),
    startBridge: async () => ({ ok: true }),
    restartBridge: async () => ({ ok: true }),
    currentDshUrl: () => 'http://127.0.0.1',
    readJsonBody: async (req) => req.body ?? {},
    json: null,
    ...overrides,
  };
  return { deps, calls };
}

test('配置路由：GET 带默认值与文件戳，保存触发重渲染副作用', async () => {
  const { deps, calls } = makeConfigDeps();
  const { out, json } = makeRes();
  const routes = createConfigRoutes({ ...deps, json });

  await routes.handleConfig({ method: 'GET' }, {});
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.stamps, { qq: 's1', bili: 's1', unified: 's1' });
  assert.deepEqual(out.body.defaults, { qq: {} });

  await routes.handleConfig(
    { method: 'POST', body: { unified: { admin: { biliMid: '12345' } }, qq: {}, bili: {} } },
    {},
  );
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.saved, { qq: true, bili: true, unified: true });
  for (const name of ['saveQq', 'saveBili', 'saveUnified', 'briefs', 'invalidate', 'douyin', 'syncTimer', 'memoryCard']) {
    assert.ok(calls.includes(name), `缺少副作用：${name}`);
  }
});

test('配置路由：旧文件戳拒绝覆盖，非法 B站 UID 直接 400', async () => {
  const { deps } = makeConfigDeps();
  const { out, json } = makeRes();
  const routes = createConfigRoutes({ ...deps, json });

  await routes.handleConfig(
    { method: 'POST', body: { baseStamp: { qq: 'old', bili: 's1', unified: 's1' }, qq: {} } },
    {},
  );
  assert.equal(out.status, 409);
  assert.equal(out.body.code, 'CONFIG_STALE');

  await routes.handleConfig(
    { method: 'POST', body: { unified: { admin: { biliMid: 'abc' } } } },
    {},
  );
  assert.equal(out.status, 400);
  assert.equal(out.body.code, 'admin.mid-invalid');
});

function makeCharacterDeps(overrides = {}) {
  const calls = [];
  const deps = {
    characterDetail: (id) => ({ ok: true, id }),
    characterOverview: () => ({ characters: [] }),
    getCharacterMigration: () => ({ migrated: true }),
    readCurrentCharacter: () => ({ id: 'c1' }),
    createCharacterFromPayload: () => ({ character: { id: 'c2' } }),
    switchCharacterEverywhere: async (id) => ({ switched: id }),
    updateCharacterFromPayload: (id) => ({ ok: true, id }),
    manualSnapshot: (id) => ({ slot: id }),
    autoSnapshot: (id) => ({ slot: id }),
    restoreCharacterSnapshot: (id, slot) => { calls.push(['restore', id, slot]); return { restored: slot }; },
    writeCharacterRolePointer: () => calls.push('pointer'),
    archiveBridgeRuntimeState: () => calls.push('archive'),
    ensureCharacterSystem: () => ({ ok: true }),
    deleteCharacter: (id) => ({ deleted: id }),
    bridgeStatus: async () => ({ running: true }),
    memoryCardIdle: async () => calls.push('memoryIdle'),
    stopAllBridgeSessions: async () => calls.push('stopSessions'),
    stopBridge: async () => { calls.push('stopBridge'); return { ok: true }; },
    startBridge: async () => { calls.push('startBridge'); return { ok: true }; },
    currentDshUrl: () => 'http://127.0.0.1',
    runMemoryCardMaintenance: async () => ({}),
    prepareSchedulerForRestore: async (skip) => calls.push(['prepare', skip]),
    resetSchedulerIdleForRestore: () => { calls.push('resetIdle'); return { running: false }; },
    getSchedulerStatus: () => ({ running: true }),
    startSchedulerNow: () => { calls.push('startScheduler'); return { running: true }; },
    readJsonBody: async (req) => req.body ?? {},
    json: null,
    pluginLog: () => {},
    ...overrides,
  };
  return { deps, calls };
}

test('角色路由：GET 总览带迁移信息，详情按 id 取', async () => {
  const { deps } = makeCharacterDeps();
  const { out, json } = makeRes();
  const routes = createCharacterRoutes({ ...deps, json });

  await routes.handleCharacters({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/characters'));
  assert.deepEqual(out.body, { characters: [], migration: { migrated: true } });

  await routes.handleCharacters({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/characters?id=c9'));
  assert.deepEqual(out.body, { ok: true, id: 'c9' });
});

test('角色路由：回档按序停桥、回滚、重启并恢复生物钟', async () => {
  const { deps, calls } = makeCharacterDeps();
  const { out, json } = makeRes();
  const routes = createCharacterRoutes({ ...deps, json });

  await routes.handleCharacters(
    { method: 'POST', body: { action: 'restore', id: 'c1', slot: 'slot-a' } },
    {},
  );
  assert.equal(out.status, 200);
  assert.equal(out.body.bridgeRestarted, true);
  assert.deepEqual(out.body.scheduler, { running: true });
  const order = calls.filter((item) => typeof item === 'string');
  assert.deepEqual(order, ['memoryIdle', 'resetIdle', 'stopSessions', 'stopBridge', 'pointer', 'archive', 'startBridge', 'startScheduler']);
  assert.deepEqual(calls.filter((item) => Array.isArray(item)), [['prepare', false], ['restore', 'c1', 'slot-a']]);
});

